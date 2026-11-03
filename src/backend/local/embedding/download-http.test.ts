import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import {
  classifyEmbeddingHttpError,
  downloadToFile,
  EmbeddingHttpError,
  redactSecrets,
  requestDownloadHttp,
  resolveProxyUrl,
  sanitizeUrlForLog,
} from "./download-http";

const TOKEN = "hf_test_token_abcdefghijklmnop";
const API_KEY = "sk-test-api-key-0123456789";

const tempDirs: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hryk-w1-c1-download-"));
  tempDirs.push(dir);
  return dir;
}

interface ServerHandle {
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

async function startHttpServer(
  handler: http.RequestListener,
): Promise<ServerHandle> {
  const sockets = new Set<net.Socket>();
  const server = http.createServer(handler);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const handle: ServerHandle = {
    port,
    url: `http://127.0.0.1:${port}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  cleanups.push(() => handle.close());
  return handle;
}

/** Minimal HTTP CONNECT proxy over raw sockets (no `node:http` extension). */
async function startConnectProxy(): Promise<
  ServerHandle & { readonly targets: string[] }
> {
  const sockets = new Set<net.Socket>();
  const targets: string[] = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const headEnd = buffer.indexOf("\r\n\r\n");
      if (headEnd < 0) return;
      socket.off("data", onData);
      const head = buffer.subarray(0, headEnd).toString("latin1");
      const remaining = buffer.subarray(headEnd + 4);
      const requestLine = head.split("\r\n")[0] ?? "";
      const authority = requestLine.split(" ")[1] ?? "";
      targets.push(authority);
      const separator = authority.lastIndexOf(":");
      const host = authority.slice(0, separator);
      const port = Number.parseInt(authority.slice(separator + 1), 10);
      const upstream = net.connect(port, host, () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (remaining.length > 0) upstream.write(remaining);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      upstream.once("error", () => socket.destroy());
      sockets.add(upstream);
      upstream.once("close", () => sockets.delete(upstream));
    };
    socket.on("data", onData);
    socket.once("error", () => {});
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const handle = {
    port,
    url: `http://127.0.0.1:${port}`,
    targets,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  cleanups.push(() => handle.close());
  return handle;
}

async function readAll(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function codedError(code: string, message = ""): Error {
  const error = new Error(message);
  Object.assign(error, { code });
  return error;
}

afterAll(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("requestDownloadHttp streaming", () => {
  test("streams a fixed-length body and reports its size", async () => {
    const server = await startHttpServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "text/plain",
        "content-length": "11",
      });
      response.end("hello world");
    });

    const result = await requestDownloadHttp({
      url: `${server.url}/file.txt`,
      proxyUrl: null,
    });

    expect(result.statusCode).toBe(200);
    expect(await readAll(result.stream)).toBe("hello world");
    expect(result.totalBytes).toBe(11);
    expect(result.rangeStart).toBe(0);
    expect(result.resumable).toBe(false);
    expect(result.finalUrl).toBe(`${server.url}/file.txt`);
    expect(result.attempts).toBe(1);
  });

  test("streams a chunked body when the server sends no length", async () => {
    const server = await startHttpServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("chunk-one ");
      response.end("chunk-two");
    });

    const result = await requestDownloadHttp({
      url: `${server.url}/chunked`,
      proxyUrl: null,
    });

    expect(await readAll(result.stream)).toBe("chunk-one chunk-two");
    expect(result.totalBytes).toBeNull();
  });

  test("projects response headers onto a safe allow-list", async () => {
    const server = await startHttpServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "text/plain",
        authorization: `Bearer ${TOKEN}`,
        "x-internal-header": API_KEY,
        "content-length": "2",
      });
      response.end("ok");
    });

    const result = await requestDownloadHttp({
      url: `${server.url}/headers`,
      proxyUrl: null,
      secrets: [TOKEN, API_KEY],
    });

    expect(result.headers["content-type"]).toBe("text/plain");
    expect(result.headers.authorization).toBeUndefined();
    expect(result.headers["x-internal-header"]).toBeUndefined();
    expect(JSON.stringify(result.headers)).not.toContain(TOKEN);
    expect(JSON.stringify(result.headers)).not.toContain(API_KEY);
  });

  test("strips userinfo and query string from the returned URL", async () => {
    const server = await startHttpServer((_request, response) => {
      response.end("ok");
    });

    const result = await requestDownloadHttp({
      url: `${server.url}/path/adorned?token=${TOKEN}&x=1`,
      proxyUrl: null,
      secrets: [TOKEN],
    });

    expect(result.finalUrl).toBe(`${server.url}/path/adorned`);
    expect(result.finalUrl).not.toContain(TOKEN);
  });
});

describe("redirect handling", () => {
  test("follows a redirect and drops credentials on a cross-origin hop", async () => {
    let observedAuthorization: string | undefined;
    const target = await startHttpServer((request, response) => {
      observedAuthorization = request.headers.authorization;
      response.end("redirected-body");
    });
    const origin = await startHttpServer((_request, response) => {
      response.writeHead(302, { location: `${target.url}/final` });
      response.end();
    });

    const result = await requestDownloadHttp({
      url: `${origin.url}/start`,
      proxyUrl: null,
      headers: { Authorization: `Bearer ${TOKEN}` },
      secrets: [TOKEN],
    });

    expect(await readAll(result.stream)).toBe("redirected-body");
    expect(observedAuthorization).toBeUndefined();
    expect(result.finalUrl).toBe(`${target.url}/final`);
  });

  test("keeps credentials on a same-origin redirect", async () => {
    let secondAuthorization: string | undefined;
    let hits = 0;
    const server = await startHttpServer((request, response) => {
      hits += 1;
      if (hits === 1) {
        response.writeHead(307, { location: "/final" });
        response.end();
        return;
      }
      secondAuthorization = request.headers.authorization;
      response.end("same-origin");
    });

    const result = await requestDownloadHttp({
      url: `${server.url}/start`,
      proxyUrl: null,
      headers: { Authorization: `Bearer ${TOKEN}` },
      secrets: [TOKEN],
    });

    expect(await readAll(result.stream)).toBe("same-origin");
    expect(secondAuthorization).toBe(`Bearer ${TOKEN}`);
  });

  test("stops after the redirect limit", async () => {
    const server = await startHttpServer((_request, response) => {
      response.writeHead(302, { location: "/loop" });
      response.end();
    });

    await expect(
      requestDownloadHttp({
        url: `${server.url}/loop`,
        proxyUrl: null,
        maxRedirects: 2,
      }),
    ).rejects.toMatchObject({ kind: "http-status", statusCode: 302 });
  });
});

describe("retry policy and failure classification", () => {
  test("does not retry a 4xx and redacts the token in the message", async () => {
    let hits = 0;
    const server = await startHttpServer((_request, response) => {
      hits += 1;
      response.writeHead(401, { "content-type": "text/plain" });
      response.end("unauthorized");
    });

    try {
      await requestDownloadHttp({
        url: `${server.url}/private?token=${TOKEN}`,
        proxyUrl: null,
        secrets: [TOKEN],
      });
      throw new Error("expected the request to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(EmbeddingHttpError);
      const failure = error as EmbeddingHttpError;
      expect(failure.kind).toBe("http-status");
      expect(failure.statusCode).toBe(401);
      expect(failure.retryable).toBe(false);
      expect(failure.attempts).toBe(1);
      expect(failure.message).not.toContain(TOKEN);
      expect(failure.url).not.toContain(TOKEN);
    }
    expect(hits).toBe(1);
  });

  test("retries a 503 twice at most and then succeeds", async () => {
    let hits = 0;
    const server = await startHttpServer((_request, response) => {
      hits += 1;
      if (hits === 1) {
        response.writeHead(503);
        response.end();
        return;
      }
      response.end("recovered");
    });

    const result = await requestDownloadHttp({
      url: `${server.url}/flaky`,
      proxyUrl: null,
      retryBaseDelayMs: 1,
    });

    expect(result.attempts).toBe(2);
    expect(await readAll(result.stream)).toBe("recovered");
  });

  test("gives up after two retries on persistent 5xx", async () => {
    let hits = 0;
    const server = await startHttpServer((_request, response) => {
      hits += 1;
      response.writeHead(500);
      response.end();
    });

    await expect(
      requestDownloadHttp({
        url: `${server.url}/broken`,
        proxyUrl: null,
        retryBaseDelayMs: 1,
      }),
    ).rejects.toMatchObject({
      kind: "http-status",
      statusCode: 500,
      retryable: true,
      attempts: 3,
    });
    expect(hits).toBe(3);
  });

  test("retries 429 once and succeeds", async () => {
    let hits = 0;
    const server = await startHttpServer((_request, response) => {
      hits += 1;
      if (hits === 1) {
        response.writeHead(429);
        response.end();
        return;
      }
      response.end("ok-after-429");
    });

    const result = await requestDownloadHttp({
      url: `${server.url}/throttled`,
      proxyUrl: null,
      retryBaseDelayMs: 1,
    });

    expect(result.attempts).toBe(2);
    expect(await readAll(result.stream)).toBe("ok-after-429");
  });

  test("maxRetries: 0 disables retrying", async () => {
    let hits = 0;
    const server = await startHttpServer((_request, response) => {
      hits += 1;
      response.writeHead(502);
      response.end();
    });

    await expect(
      requestDownloadHttp({
        url: `${server.url}/no-retry`,
        proxyUrl: null,
        maxRetries: 0,
      }),
    ).rejects.toMatchObject({ kind: "http-status", attempts: 1 });
    expect(hits).toBe(1);
  });

  test("classifies a refused connection as non-retryable", async () => {
    const server = await startHttpServer((_request, response) =>
      response.end("unused"),
    );
    await server.close();
    cleanups.pop();

    try {
      await requestDownloadHttp({
        url: `${server.url}/anything`,
        proxyUrl: null,
      });
      throw new Error("expected the request to fail");
    } catch (error) {
      const failure = error as EmbeddingHttpError;
      expect(failure.kind).toBe("connection-refused");
      expect(failure.retryable).toBe(false);
    }
  });

  test("reports a setup timeout", async () => {
    const server = await startHttpServer(() => {
      /* never responds */
    });

    await expect(
      requestDownloadHttp({
        url: `${server.url}/mute`,
        proxyUrl: null,
        timeoutMs: 120,
        maxRetries: 0,
      }),
    ).rejects.toMatchObject({ kind: "timeout", retryable: true, attempts: 1 });
  });

  test("reports an idle timeout during the body", async () => {
    const server = await startHttpServer((_request, response) => {
      response.writeHead(200, { "content-length": "100" });
      response.write("partial");
      // never end: the body stalls after the head
    });
    const output = join(makeTempDir(), "idle.part");

    await expect(
      downloadToFile({
        url: `${server.url}/stall`,
        proxyUrl: null,
        outputPath: output,
        timeoutMs: 150,
        maxRetries: 0,
      }),
    ).rejects.toMatchObject({ kind: "timeout" });
  });

  test("aborts when the caller signal is already aborted", async () => {
    const server = await startHttpServer((_request, response) =>
      response.end("unused"),
    );
    const controller = new AbortController();
    controller.abort();

    await expect(
      requestDownloadHttp({
        url: `${server.url}/aborted`,
        proxyUrl: null,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ kind: "aborted" });
  });

  test("classifies synthetic transport errors", () => {
    expect(classifyEmbeddingHttpError(codedError("ENOTFOUND"))).toBe("dns");
    expect(classifyEmbeddingHttpError(codedError("ECONNREFUSED"))).toBe(
      "connection-refused",
    );
    expect(classifyEmbeddingHttpError(codedError("ECONNRESET"))).toBe(
      "connection-reset",
    );
    expect(classifyEmbeddingHttpError(codedError("ETIMEDOUT"))).toBe("timeout");
    expect(classifyEmbeddingHttpError(codedError("EPROTO"))).toBe("tls");
    expect(classifyEmbeddingHttpError(codedError("ABORT_ERR"))).toBe("aborted");
    expect(classifyEmbeddingHttpError(codedError("SOMETHING_ELSE"))).toBe(
      "unknown",
    );
    expect(
      classifyEmbeddingHttpError(
        new Error("unable to verify the first certificate"),
      ),
    ).toBe("tls");
  });
});

describe("Range resume", () => {
  test("appends when the server honours the Range request", async () => {
    let observedRange: string | undefined;
    const server = await startHttpServer((request, response) => {
      observedRange = request.headers.range;
      response.writeHead(206, {
        "content-range": "bytes 6-10/11",
        "content-length": "5",
        "accept-ranges": "bytes",
      });
      response.end("world");
    });
    const output = join(makeTempDir(), "resume.part");
    writeFileSync(output, "hello ");

    const result = await downloadToFile({
      url: `${server.url}/weights.bin`,
      proxyUrl: null,
      outputPath: output,
      resumeFrom: 6,
    });

    expect(observedRange).toBe("bytes=6-");
    expect(result.rangeStart).toBe(6);
    expect(result.bytesWritten).toBe(5);
    expect(result.totalBytes).toBe(11);
    expect(result.resumable).toBe(true);
    expect(readFileSync(output, "utf8")).toBe("hello world");
  });

  test("rewrites from byte 0 when the server ignores Range", async () => {
    const server = await startHttpServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": "11",
      });
      response.end("hello world");
    });
    const output = join(makeTempDir(), "restart.part");
    writeFileSync(output, "stale-stale");

    const result = await downloadToFile({
      url: `${server.url}/weights.bin`,
      proxyUrl: null,
      outputPath: output,
      resumeFrom: 6,
    });

    expect(result.rangeStart).toBe(0);
    expect(result.bytesWritten).toBe(11);
    expect(readFileSync(output, "utf8")).toBe("hello world");
  });

  test("rejects a partial response that starts at the wrong offset", async () => {
    const server = await startHttpServer((_request, response) => {
      response.writeHead(206, {
        "content-range": "bytes 0-4/11",
        "content-length": "5",
      });
      response.end("hello");
    });

    await expect(
      requestDownloadHttp({
        url: `${server.url}/wrong-range.bin`,
        proxyUrl: null,
        resumeFrom: 6,
      }),
    ).rejects.toMatchObject({ kind: "http-status" });
  });

  test("reports progress while writing", async () => {
    const server = await startHttpServer((_request, response) => {
      response.writeHead(200, { "content-length": "11" });
      response.end("hello world");
    });
    const output = join(makeTempDir(), "progress.bin");
    const progress: number[] = [];

    await downloadToFile({
      url: `${server.url}/progress.bin`,
      proxyUrl: null,
      outputPath: output,
      onProgress: (value) => progress.push(value.bytesWritten),
    });

    expect(progress.length).toBeGreaterThan(0);
    expect(progress.at(-1)).toBe(11);
    expect(existsSync(output)).toBe(true);
  });
});

describe("CONNECT proxy", () => {
  test("downloads over a CONNECT tunnel", async () => {
    const target = await startHttpServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("through-the-tunnel");
    });
    const proxy = await startConnectProxy();

    const result = await requestDownloadHttp({
      url: `${target.url}/asset.bin`,
      proxyUrl: proxy.url,
    });

    expect(await readAll(result.stream)).toBe("through-the-tunnel");
    expect(proxy.targets).toEqual([`127.0.0.1:${target.port}`]);
  });

  test("handles a fixed-length body over the tunnel", async () => {
    const target = await startHttpServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": "9",
      });
      response.end("tunnelled");
    });
    const proxy = await startConnectProxy();

    const result = await requestDownloadHttp({
      url: `${target.url}/fixed.bin`,
      proxyUrl: proxy.url,
    });

    expect(await readAll(result.stream)).toBe("tunnelled");
    expect(result.totalBytes).toBe(9);
  });

  test("reports a non-200 CONNECT as a proxy failure", async () => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.write("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    cleanups.push(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    await expect(
      requestDownloadHttp({
        url: `http://example.invalid/asset.bin`,
        proxyUrl: `http://127.0.0.1:${port}`,
      }),
    ).rejects.toMatchObject({ kind: "proxy", statusCode: 403 });
  });

  test("rejects an unsupported proxy protocol", async () => {
    await expect(
      requestDownloadHttp({
        url: "http://example.invalid/asset.bin",
        proxyUrl: "ftp://proxy.example:21",
      }),
    ).rejects.toMatchObject({ kind: "proxy" });
  });
});

describe("proxy resolution and redaction helpers", () => {
  test("resolves proxy env vars in precedence order", () => {
    expect(resolveProxyUrl({})).toBeNull();
    expect(resolveProxyUrl({ HTTP_PROXY: "http://proxy:8080" })).toBe(
      "http://proxy:8080/",
    );
    expect(resolveProxyUrl({ HTTPS_PROXY: "proxy:3128" })).toBe(
      "http://proxy:3128/",
    );
    expect(
      resolveProxyUrl({
        HTTP_PROXY: "http://fallback:8080",
        HTTPS_PROXY: "http://preferred:3128",
      }),
    ).toBe("http://preferred:3128/");
    expect(resolveProxyUrl({ http_proxy: "http://lowercase:8080" })).toBe(
      "http://lowercase:8080/",
    );
  });

  test("rejects malformed proxy values", () => {
    expect(() => resolveProxyUrl({ HTTPS_PROXY: "ftp://proxy:21" })).toThrow(
      /Unsupported proxy protocol/,
    );
    expect(() => resolveProxyUrl({ HTTPS_PROXY: "http://[bad" })).toThrow(
      /not a valid URL/,
    );
  });

  test("redacts raw and URI-encoded secret values", () => {
    const raw = `token=${TOKEN} failed for ${API_KEY}`;
    const encoded = encodeURIComponent(TOKEN);
    const text = `${raw} encoded=${encoded}`;
    const redacted = redactSecrets(text, [TOKEN, API_KEY]);
    expect(redacted).not.toContain(TOKEN);
    expect(redacted).not.toContain(encoded);
    expect(redacted).not.toContain(API_KEY);
    expect(redacted).toContain("[REDACTED]");
    // Very short values are left alone so messages stay readable.
    expect(redactSecrets("abc", ["a"])).toBe("abc");
  });

  test("sanitizes URLs for logs and messages", () => {
    expect(
      sanitizeUrlForLog(
        `https://user:pass@example.com:8443/path/x?token=${TOKEN}#frag`,
      ),
    ).toBe("https://example.com:8443/path/x");
    expect(sanitizeUrlForLog("not a url")).toBe("<invalid-url>");
  });

  test("exposes a typed error class", () => {
    const error = new EmbeddingHttpError({
      kind: "timeout",
      message: "timed out",
      url: "https://example.com/x",
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("EmbeddingHttpError");
    expect(error.retryable).toBe(false);
    expect(error.attempts).toBe(1);
  });
});
