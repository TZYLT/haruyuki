/**
 * Transport half of the embedding download client: one HTTP request over either
 * the normal `node:http(s)` client (direct) or a CONNECT tunnel that speaks
 * HTTP/1.1 over `node:net`/`node:tls` (proxied).
 *
 * The tunnel path is hand-rolled because Node's
 * `https.request(createConnection)` is honoured but Bun's fetch-backed
 * `node:http` client drops it for TLS-wrapped sockets; speaking HTTP/1.1 over the
 * tunnel works identically on both runtimes. Direct requests keep the normal
 * clients. See `download-http.ts` for the public API and policy layer.
 */

import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import {
  type Duplex,
  PassThrough,
  type Readable,
  Transform,
} from "node:stream";
import * as tls from "node:tls";
import {
  abortedError,
  connectionResetError,
  EmbeddingHttpError,
  errorMessage,
  isRetryableEmbeddingHttpError,
  normalizeResponseHeaders,
  type PreparedRequest,
  type RawHttpResponse,
  redactSecrets,
  sanitizeUrlForLog,
  shapeTransportError,
  timeoutError,
} from "./download-http-types";

const HEAD_END = Buffer.from("\r\n\r\n");
const MAX_RESPONSE_HEAD_BYTES = 64 * 1024;
/**
 * Upper bound on one chunked-encoding header/trailer line. A chunk-size line is
 * normally a handful of bytes; without a bound a hostile server can stream
 * bytes that never contain CRLF and make the decoder buffer grow without limit
 * in the caller's process.
 */
const MAX_CHUNK_HEADER_BYTES = 8 * 1024;

function targetPort(url: URL): number {
  if (url.port.length > 0) return Number.parseInt(url.port, 10);
  return url.protocol === "https:" ? 443 : 80;
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

/** `host[:port]` with the port omitted when it is the protocol default. */
function authorityFor(url: URL): string {
  const port = targetPort(url);
  const defaultPort = url.protocol === "https:" ? 443 : 80;
  return port === defaultPort
    ? stripIpv6Brackets(url.hostname)
    : `${stripIpv6Brackets(url.hostname)}:${port}`;
}

/** Fixed-length decoder: exactly `expected` bytes belong to the body. */
class FixedLengthBodyDecoder extends Transform {
  private remaining: number;

  constructor(
    expectedLength: number,
    private readonly onComplete: () => void,
  ) {
    super();
    this.remaining = expectedLength;
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (this.remaining <= 0) {
      callback();
      return;
    }
    const slice =
      chunk.length > this.remaining ? chunk.subarray(0, this.remaining) : chunk;
    this.remaining -= slice.length;
    this.push(slice);
    if (this.remaining === 0) {
      this.onComplete();
      this.push(null);
    }
    callback();
  }

  override _flush(callback: (error?: Error | null) => void): void {
    if (this.remaining !== 0) {
      callback(
        new Error("Response ended before Content-Length bytes were received."),
      );
      return;
    }
    callback();
  }
}

type ChunkedState = "size" | "data" | "data-end" | "trailer" | "done";

/** Incremental `Transfer-Encoding: chunked` decoder. */
class ChunkedBodyDecoder extends Transform {
  private buffer: Buffer = Buffer.alloc(0);
  private state: ChunkedState = "size";
  private remaining = 0;

  constructor(private readonly onComplete: () => void) {
    super();
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.buffer =
      this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    try {
      this.drain();
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  override _flush(callback: (error?: Error | null) => void): void {
    if (this.state !== "done") {
      callback(new Error("Response ended inside a chunked body."));
      return;
    }
    callback();
  }

  private drain(): void {
    for (;;) {
      if (this.state === "data") {
        if (this.buffer.length === 0) return;
        const take = Math.min(this.remaining, this.buffer.length);
        this.push(this.buffer.subarray(0, take));
        this.buffer = this.buffer.subarray(take);
        this.remaining -= take;
        if (this.remaining === 0) this.state = "data-end";
        continue;
      }
      if (this.state === "done") return;

      const lineEnd = this.buffer.indexOf("\r\n");
      if (lineEnd < 0) {
        if (this.buffer.length > MAX_CHUNK_HEADER_BYTES) {
          throw new Error(
            `Malformed chunked response: chunk header line exceeded ${MAX_CHUNK_HEADER_BYTES} bytes.`,
          );
        }
        return;
      }
      const line = this.buffer.subarray(0, lineEnd).toString("latin1");
      this.buffer = this.buffer.subarray(lineEnd + 2);

      if (this.state === "size") {
        const size = Number.parseInt(line.split(";")[0]?.trim() ?? "", 16);
        if (!Number.isSafeInteger(size) || size < 0) {
          throw new Error("Malformed chunk size in chunked response.");
        }
        if (size === 0) {
          this.state = "trailer";
        } else {
          this.remaining = size;
          this.state = "data";
        }
        continue;
      }
      if (this.state === "data-end") {
        this.state = "size";
        continue;
      }
      if (this.state === "trailer") {
        if (line.length === 0) {
          this.state = "done";
          this.onComplete();
          this.push(null);
          return;
        }
      }
    }
  }
}

type Framing = "chunked" | "content-length" | "close";

function framingFor(headers: Readonly<Record<string, string>>): Framing {
  const transferEncoding = (headers["transfer-encoding"] ?? "").toLowerCase();
  if (transferEncoding.includes("chunked")) return "chunked";
  if (headers["content-length"] !== undefined) return "content-length";
  return "close";
}

function createBodyFraming(
  headers: Readonly<Record<string, string>>,
  markComplete: () => void,
): Transform {
  const framing = framingFor(headers);
  if (framing === "chunked") return new ChunkedBodyDecoder(markComplete);
  if (framing === "content-length") {
    const raw = headers["content-length"] ?? "";
    const length = Number.parseInt(raw, 10);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new Error("Malformed Content-Length header.");
    }
    if (length === 0) {
      markComplete();
      const empty = new PassThrough();
      empty.end();
      return empty;
    }
    return new FixedLengthBodyDecoder(length, markComplete);
  }
  return new PassThrough();
}

function parseResponseHead(buffer: Buffer): {
  statusCode: number;
  headers: Record<string, string>;
} {
  const lines = buffer.toString("latin1").split("\r\n");
  const statusLine = lines[0];
  if (!statusLine) throw new Error("Empty status line.");
  const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})\b/.exec(statusLine);
  if (!match?.[1]) throw new Error("Malformed status line.");
  const statusCode = Number.parseInt(match[1], 10);
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    if (line.length === 0) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (name.length === 0) continue;
    const existing = headers[name];
    headers[name] = existing ? `${existing}, ${value}` : value;
  }
  return { statusCode, headers };
}

/**
 * Read status line + headers and hand back bytes already buffered for the body.
 * Pauses the socket so no data can slip between this read and the body consumer
 * taking over; callers resume it after wiring the body.
 */
async function readResponseHead(
  socket: Duplex,
  url: URL,
  prepared: PreparedRequest,
  attempts: number,
): Promise<{
  statusCode: number;
  headers: Record<string, string>;
  leftover: Buffer;
}> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      prepared.signal?.removeEventListener("abort", onAbort);
    };
    const fail = (error: EmbeddingHttpError) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(error);
    };
    const onAbort = () => fail(abortedError(url, attempts));
    const onError = (error: Error) =>
      fail(shapeTransportError(error, url, prepared.secrets, attempts));
    const onClose = () =>
      fail(connectionResetError(url, "socket closed", attempts));
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_RESPONSE_HEAD_BYTES) {
        fail(
          new EmbeddingHttpError({
            kind: "unknown",
            attempts,
            message: `Response headers exceeded ${MAX_RESPONSE_HEAD_BYTES} bytes: ${sanitizeUrlForLog(url)}`,
            url: sanitizeUrlForLog(url),
          }),
        );
        return;
      }
      const headEnd = buffer.indexOf(HEAD_END);
      if (headEnd < 0) return;
      socket.pause();
      settled = true;
      cleanup();
      try {
        const parsed = parseResponseHead(buffer.subarray(0, headEnd));
        resolve({
          statusCode: parsed.statusCode,
          headers: parsed.headers,
          leftover: buffer.subarray(headEnd + 4),
        });
      } catch (error) {
        socket.destroy();
        reject(
          new EmbeddingHttpError({
            kind: "unknown",
            attempts,
            message: redactSecrets(
              `Malformed HTTP response from ${sanitizeUrlForLog(url)}: ${errorMessage(error)}`,
              prepared.secrets,
            ),
            url: sanitizeUrlForLog(url),
            cause: error,
          }),
        );
      }
    };
    if (prepared.timeoutMs > 0) {
      timer = setTimeout(() => {
        fail(timeoutError(url, prepared.timeoutMs, attempts));
      }, prepared.timeoutMs);
    }
    if (prepared.signal) {
      if (prepared.signal.aborted) {
        fail(abortedError(url, attempts));
        return;
      }
      prepared.signal.addEventListener("abort", onAbort, { once: true });
    }
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
    // A paused socket (the tunnel hand-off pauses it) does not resume merely
    // because a `data` listener was attached; the caller of this helper is the
    // new consumer of the stream.
    socket.resume();
  });
}

/** Manual HTTP/1.1 request over an established tunnel socket. */
async function startTunneledResponse(
  socket: Duplex,
  url: URL,
  headers: Readonly<Record<string, string>>,
  prepared: PreparedRequest,
  attempts: number,
): Promise<RawHttpResponse> {
  socket.write(
    [
      `${prepared.method} ${url.pathname || "/"}${url.search} HTTP/1.1`,
      `Host: ${authorityFor(url)}`,
      ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
      "Connection: close",
      "",
      "",
    ].join("\r\n"),
  );
  const head = await readResponseHead(socket, url, prepared, attempts);
  const body = createTunneledBody(
    socket,
    head.leftover,
    head.headers,
    url,
    prepared,
    attempts,
  );
  return { statusCode: head.statusCode, headers: head.headers, body };
}

function createTunneledBody(
  socket: Duplex,
  leftover: Buffer,
  headers: Readonly<Record<string, string>>,
  url: URL,
  prepared: PreparedRequest,
  attempts: number,
): Readable {
  const output = new PassThrough();
  let complete = false;
  const markComplete = () => {
    complete = true;
  };
  const framing = createBodyFraming(headers, markComplete);
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const clearIdle = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  };
  const armIdle = () => {
    if (prepared.timeoutMs <= 0) return;
    clearIdle();
    idleTimer = setTimeout(() => {
      clearIdle();
      socket.destroy();
      framing.destroy(timeoutError(url, prepared.timeoutMs, attempts));
    }, prepared.timeoutMs);
  };
  const feed = (chunk: Buffer) => {
    armIdle();
    if (!framing.write(chunk)) socket.pause();
  };
  const onAbort = () => {
    socket.destroy();
    framing.destroy(abortedError(url, attempts));
  };

  framing.on("drain", () => socket.resume());
  framing.once("error", (error: Error) => {
    clearIdle();
    output.destroy(
      error instanceof EmbeddingHttpError
        ? error
        : shapeTransportError(error, url, prepared.secrets, attempts),
    );
  });
  socket.on("data", feed);
  socket.once("end", () => {
    clearIdle();
    if (framingFor(headers) === "close") markComplete();
    framing.end();
  });
  socket.once("close", () => {
    clearIdle();
    if (!complete) {
      framing.destroy(connectionResetError(url, "connection closed", attempts));
    }
  });
  socket.once("error", (error: Error) => {
    clearIdle();
    framing.destroy(error);
  });
  framing.pipe(output);
  output.once("close", () => {
    clearIdle();
    socket.destroy();
    prepared.signal?.removeEventListener("abort", onAbort);
  });
  if (prepared.signal) {
    if (prepared.signal.aborted) onAbort();
    else prepared.signal.addEventListener("abort", onAbort, { once: true });
  }
  armIdle();
  socket.resume();
  if (leftover.length > 0) feed(leftover);
  return output;
}

function startDirectResponse(
  url: URL,
  headers: Readonly<Record<string, string>>,
  prepared: PreparedRequest,
  attempts: number,
): Promise<RawHttpResponse> {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === "https:";
    const options: http.RequestOptions = {
      hostname: stripIpv6Brackets(url.hostname),
      port: targetPort(url),
      method: prepared.method,
      path: `${url.pathname || "/"}${url.search}`,
      headers,
    };
    const request = isHttps ? https.request(options) : http.request(options);
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      request.off("error", onError);
      request.off("response", onResponse);
      prepared.signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      request.destroy();
      reject(abortedError(url, attempts));
    };
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(shapeTransportError(error, url, prepared.secrets, attempts));
    };
    const onResponse = (response: http.IncomingMessage) => {
      if (settled) {
        response.resume();
        return;
      }
      settled = true;
      cleanup();
      const body = wrapDirectBody(response, url, prepared, attempts);
      resolve({
        statusCode: response.statusCode ?? 0,
        headers: normalizeResponseHeaders(response.headers),
        body,
      });
    };
    if (prepared.timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        request.destroy();
        reject(timeoutError(url, prepared.timeoutMs, attempts));
      }, prepared.timeoutMs);
    }
    if (prepared.signal) {
      if (prepared.signal.aborted) {
        onAbort();
        return;
      }
      prepared.signal.addEventListener("abort", onAbort, { once: true });
    }
    request.once("response", onResponse);
    request.once("error", onError);
    request.end();
  });
}

/**
 * Wrap a direct `IncomingMessage` with an idle timeout and premature-close
 * detection. An explicit pump (not a socket timeout) keeps the behavior
 * identical on Node and on Bun's fetch-backed `node:http` client.
 */
function wrapDirectBody(
  source: http.IncomingMessage,
  url: URL,
  prepared: PreparedRequest,
  attempts: number,
): Readable {
  const output = new PassThrough();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let ended = false;
  const clearIdle = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  };
  const armIdle = () => {
    if (prepared.timeoutMs <= 0) return;
    clearIdle();
    idleTimer = setTimeout(() => {
      clearIdle();
      source.destroy();
      output.destroy(timeoutError(url, prepared.timeoutMs, attempts));
    }, prepared.timeoutMs);
  };
  const onAbort = () => {
    source.destroy();
    output.destroy(abortedError(url, attempts));
  };

  source.on("data", (chunk: Buffer) => {
    armIdle();
    if (!output.write(chunk)) source.pause();
  });
  output.on("drain", () => source.resume());
  source.once("end", () => {
    ended = true;
    clearIdle();
    output.end();
  });
  source.once("error", (error: Error) => {
    clearIdle();
    output.destroy(
      error instanceof EmbeddingHttpError
        ? error
        : shapeTransportError(error, url, prepared.secrets, attempts),
    );
  });
  source.once("close", () => {
    clearIdle();
    if (!ended) {
      output.destroy(connectionResetError(url, "connection closed", attempts));
    }
  });
  output.once("close", () => {
    clearIdle();
    source.destroy();
    prepared.signal?.removeEventListener("abort", onAbort);
  });
  if (prepared.signal) {
    if (prepared.signal.aborted) onAbort();
    else prepared.signal.addEventListener("abort", onAbort, { once: true });
  }
  armIdle();
  return output;
}

function waitForSocket(
  socket: Duplex,
  url: URL,
  prepared: PreparedRequest,
  attempts: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      socket.off("connect", onConnect);
      socket.off("error", onError);
      prepared.signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(abortedError(url, attempts));
    };
    const onConnect = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new EmbeddingHttpError({
          kind: "proxy",
          attempts,
          retryable: isRetryableEmbeddingHttpError(error),
          message: redactSecrets(
            `Proxy connection failed: ${errorMessage(error)}`,
            prepared.secrets,
          ),
          url: sanitizeUrlForLog(url),
          cause: error,
        }),
      );
    };
    if (prepared.timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.destroy();
        reject(timeoutError(url, prepared.timeoutMs, attempts));
      }, prepared.timeoutMs);
    }
    if (prepared.signal) {
      if (prepared.signal.aborted) {
        onAbort();
        return;
      }
      prepared.signal.addEventListener("abort", onAbort, { once: true });
    }
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}

/** Open a CONNECT tunnel through `proxyUrl`, TLS-wrapping it for https targets. */
async function openProxyTunnel(
  proxyUrl: string,
  target: URL,
  prepared: PreparedRequest,
  attempts: number,
): Promise<Duplex> {
  const proxy = new URL(proxyUrl);
  const socket = net.connect({
    host: stripIpv6Brackets(proxy.hostname),
    port: targetPort(proxy),
  });
  await waitForSocket(socket, target, prepared, attempts);

  const authority = authorityFor(target);
  const proxyAuth =
    proxy.username.length > 0 || proxy.password.length > 0
      ? `Basic ${Buffer.from(
          `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`,
        ).toString("base64")}`
      : null;
  socket.write(
    [
      `CONNECT ${authority} HTTP/1.1`,
      `Host: ${authority}`,
      ...(proxyAuth ? [`Proxy-Authorization: ${proxyAuth}`] : []),
      "Connection: keep-alive",
      "",
      "",
    ].join("\r\n"),
  );

  const head = await readResponseHead(socket, target, prepared, attempts);
  if (head.statusCode !== 200) {
    socket.destroy();
    throw new EmbeddingHttpError({
      kind: "proxy",
      attempts,
      statusCode: head.statusCode,
      retryable: false,
      message: `Proxy CONNECT to ${sanitizeUrlForLog(target)} failed with HTTP ${head.statusCode}`,
      url: sanitizeUrlForLog(target),
    });
  }
  if (head.leftover.length > 0) socket.unshift(head.leftover);
  if (target.protocol !== "https:") return socket;

  const hostname = stripIpv6Brackets(target.hostname);
  return await new Promise<tls.TLSSocket>((resolve, reject) => {
    const secure = tls.connect({
      socket,
      servername: net.isIP(hostname) === 0 ? hostname : undefined,
      rejectUnauthorized: true,
    });
    let settled = false;
    const timer =
      prepared.timeoutMs > 0
        ? setTimeout(() => {
            if (settled) return;
            settled = true;
            secure.destroy();
            reject(timeoutError(target, prepared.timeoutMs, attempts));
          }, prepared.timeoutMs)
        : undefined;
    secure.once("secureConnect", () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(secure);
    });
    secure.once("error", (error: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(
        new EmbeddingHttpError({
          kind: "tls",
          attempts,
          retryable: false,
          message: redactSecrets(
            `TLS handshake with ${sanitizeUrlForLog(target)} failed: ${errorMessage(error)}`,
            prepared.secrets,
          ),
          url: sanitizeUrlForLog(target),
          cause: error,
        }),
      );
    });
  });
}

/**
 * Perform one HTTP attempt, direct or through the proxy. Resolves once the
 * response head is available; the returned body stream carries the idle timeout
 * and classified errors.
 */
export async function performRawRequest(
  url: URL,
  headers: Readonly<Record<string, string>>,
  prepared: PreparedRequest,
  attempts: number,
): Promise<RawHttpResponse> {
  if (prepared.proxyUrl === null) {
    return await startDirectResponse(url, headers, prepared, attempts);
  }
  const socket = await openProxyTunnel(
    prepared.proxyUrl,
    url,
    prepared,
    attempts,
  );
  return await startTunneledResponse(socket, url, headers, prepared, attempts);
}
