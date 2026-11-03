/**
 * Streaming HTTP(S) downloads for the embedding runtime/model fetchers.
 *
 * **Why not `fetch`.** Under Node, `fetch` ignores `HTTPS_PROXY`/`HTTP_PROXY`, so
 * a machine that can only reach the internet through a CONNECT proxy cannot
 * download anything. This module speaks `node:http`/`node:https` directly, opens
 * a CONNECT tunnel itself when a proxy is configured, and streams the body with
 * backpressure instead of buffering it.
 *
 * **Why a hand-rolled tunnel.** Node's `https.request(createConnection)` can ride
 * a tunnel, but Bun's fetch-based `node:http` client drops that option for
 * TLS-wrapped sockets. The tunnel therefore wraps the socket in `node:tls` and
 * speaks HTTP/1.1 over it, which behaves identically on both runtimes; direct
 * requests keep the normal `node:http(s)` clients. Implementation lives in
 * `download-http-transport.ts`; the shared contract and redaction helpers in
 * `download-http-types.ts`.
 *
 * **Failure classification.** Bun's `fetch` collapses `ECONNREFUSED` into an
 * abort/timeout, which makes "the endpoint is not running" look like "the
 * network is slow". Every failure is an {@link EmbeddingHttpError} whose `kind`
 * distinguishes DNS, refused/reset connections, timeouts, TLS, proxy and plain
 * HTTP status failures, so callers retry only what is retryable.
 *
 * **Retry policy** (48-2 §4.6): 4xx never; 429/5xx at most two retries with
 * exponential backoff; deterministic network failures (DNS, ECONNREFUSED, TLS)
 * never. Redirects are followed up to a small limit, and credentials are dropped
 * on a cross-origin hop.
 *
 * **Redaction.** Secrets handed in `secrets` are replaced with `[REDACTED]` in
 * every message this module produces, URLs in messages keep origin+path only
 * (never the query string, never userinfo), and the module never logs anything
 * itself. Returned response headers are projected onto a small allow-list.
 */

import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { performRawRequest } from "./download-http-transport";
import {
  abortedError,
  backoffDelay,
  buildRequestHeaders,
  type DownloadFileOptions,
  type DownloadFileResult,
  type DownloadHttpResponse,
  type DownloadRequestOptions,
  delay,
  EmbeddingHttpError,
  httpStatusError,
  type PreparedRequest,
  parseContentLength,
  parseContentRange,
  projectSafeHeaders,
  type RawHttpResponse,
  sanitizeUrlForLog,
  shapeTransportError,
  stripSensitiveHeaders,
} from "./download-http-types";

export type {
  DownloadFileOptions,
  DownloadFileResult,
  DownloadHttpResponse,
  DownloadProgress,
  DownloadRequestOptions,
  EmbeddingHttpErrorKind,
} from "./download-http-types";
export {
  classifyEmbeddingHttpError,
  EmbeddingHttpError,
  isRetryableEmbeddingHttpError,
  redactSecrets,
  sanitizeUrlForLog,
} from "./download-http-types";

/** Default connection/idle timeout for one request, in milliseconds. */
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 10_000;

/** Default number of retries after the initial attempt (48-2 §4.6: ≤2). */
export const DEFAULT_DOWNLOAD_RETRIES = 2;

const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_RETRY_BASE_DELAY_MS = 250;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Resolve the proxy URL from the conventional environment variables, in the
 * order `HTTPS_PROXY`, `HTTP_PROXY` (upper- then lower-case). Returns `null`
 * when none is set. A malformed or unsupported value throws a typed `proxy`
 * error rather than silently connecting directly — an operator who set a proxy
 * expects traffic to use it.
 */
export function resolveProxyUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw =
    env.HTTPS_PROXY?.trim() ||
    env.https_proxy?.trim() ||
    env.HTTP_PROXY?.trim() ||
    env.http_proxy?.trim();
  if (!raw) return null;
  return normalizeProxyUrl(raw);
}

/** Validate/normalize a proxy URL (`host:port` gets `http://` prepended). */
export function normalizeProxyUrl(raw: string): string {
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
    ? raw
    : `http://${raw}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new EmbeddingHttpError({
      kind: "proxy",
      message: "The configured proxy URL is not a valid URL.",
      url: "<invalid-url>",
    });
  }
  if (url.protocol !== "http:") {
    throw new EmbeddingHttpError({
      kind: "proxy",
      message: `Unsupported proxy protocol: ${url.protocol} (CONNECT requires an http proxy).`,
      url: sanitizeUrlForLog(url),
    });
  }
  return url.toString();
}

function prepareRequest(options: DownloadRequestOptions): {
  url: URL;
  prepared: PreparedRequest;
  resumeFrom: number;
  headers: Record<string, string>;
} {
  const url =
    typeof options.url === "string" ? new URL(options.url) : options.url;
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new EmbeddingHttpError({
      kind: "unknown",
      message: `Unsupported download protocol: ${url.protocol}`,
      url: sanitizeUrlForLog(url),
    });
  }
  const env = options.env ?? process.env;
  let proxyUrl: string | null;
  if (options.proxyUrl === undefined) {
    proxyUrl = resolveProxyUrl(env);
  } else if (options.proxyUrl === null) {
    proxyUrl = null;
  } else {
    proxyUrl = normalizeProxyUrl(options.proxyUrl);
  }
  const resumeFrom =
    options.resumeFrom !== undefined && options.resumeFrom > 0
      ? Math.floor(options.resumeFrom)
      : 0;
  return {
    url,
    resumeFrom,
    headers: buildRequestHeaders(options.headers, resumeFrom),
    prepared: {
      method: "GET",
      timeoutMs: options.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS,
      retries: options.maxRetries ?? DEFAULT_DOWNLOAD_RETRIES,
      maxRedirects: options.maxRedirects ?? DEFAULT_MAX_REDIRECTS,
      retryBaseDelayMs: options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS,
      signal: options.signal,
      secrets: (options.secrets ?? []).filter(
        (value): value is string =>
          typeof value === "string" && value.length >= 3,
      ),
      proxyUrl,
    },
  };
}

interface PolicyResult extends RawHttpResponse {
  readonly finalUrl: URL;
  readonly attempts: number;
}

async function requestWithPolicy(
  initialUrl: URL,
  headers: Readonly<Record<string, string>>,
  prepared: PreparedRequest,
): Promise<PolicyResult> {
  for (let attempt = 1; attempt <= prepared.retries + 1; attempt += 1) {
    let currentUrl = initialUrl;
    let currentHeaders = headers;
    let redirects = 0;
    let attemptError: EmbeddingHttpError | null = null;

    for (;;) {
      let response: RawHttpResponse;
      try {
        response = await performRawRequest(
          currentUrl,
          currentHeaders,
          prepared,
          attempt,
        );
      } catch (error) {
        attemptError = shapeTransportError(
          error,
          currentUrl,
          prepared.secrets,
          attempt,
        );
        break;
      }

      const statusCode = response.statusCode;
      if (REDIRECT_STATUSES.has(statusCode)) {
        response.body.resume();
        const location = response.headers.location;
        if (!location || redirects >= prepared.maxRedirects) {
          attemptError = httpStatusError(
            statusCode,
            currentUrl,
            prepared.secrets,
            attempt,
          );
          break;
        }
        let redirectUrl: URL;
        try {
          redirectUrl = new URL(location, currentUrl);
        } catch {
          attemptError = httpStatusError(
            statusCode,
            currentUrl,
            prepared.secrets,
            attempt,
          );
          break;
        }
        if (
          redirectUrl.protocol !== "http:" &&
          redirectUrl.protocol !== "https:"
        ) {
          attemptError = httpStatusError(
            statusCode,
            currentUrl,
            prepared.secrets,
            attempt,
          );
          break;
        }
        if (redirectUrl.origin !== currentUrl.origin) {
          currentHeaders = stripSensitiveHeaders(currentHeaders);
        }
        currentUrl = redirectUrl;
        redirects += 1;
        continue;
      }

      if (statusCode === 429 || (statusCode >= 500 && statusCode <= 599)) {
        response.body.resume();
        attemptError = httpStatusError(
          statusCode,
          currentUrl,
          prepared.secrets,
          attempt,
        );
        break;
      }

      if (statusCode < 200 || statusCode >= 300) {
        response.body.resume();
        throw httpStatusError(
          statusCode,
          currentUrl,
          prepared.secrets,
          attempt,
        );
      }

      return {
        statusCode,
        headers: response.headers,
        body: response.body,
        finalUrl: currentUrl,
        attempts: attempt,
      };
    }

    const failure =
      attemptError ??
      new EmbeddingHttpError({
        kind: "unknown",
        message: `Download request failed: ${sanitizeUrlForLog(currentUrl)}`,
        url: sanitizeUrlForLog(currentUrl),
        attempts: attempt,
      });
    if (!failure.retryable || attempt > prepared.retries) throw failure;
    await delay(backoffDelay(attempt, prepared.retryBaseDelayMs));
    if (prepared.signal?.aborted) {
      throw abortedError(currentUrl, attempt);
    }
  }
  throw new EmbeddingHttpError({
    kind: "unknown",
    message: "Download request exhausted its retry budget.",
    url: sanitizeUrlForLog(initialUrl),
    attempts: prepared.retries + 1,
  });
}

/**
 * Start a streaming download and resolve once the response head is available.
 * The body stream enforces the idle timeout and reports redacted, classified
 * errors. The caller must consume or destroy it.
 */
export async function requestDownloadHttp(
  options: DownloadRequestOptions,
): Promise<DownloadHttpResponse> {
  const { url, prepared, resumeFrom, headers } = prepareRequest(options);
  const result = await requestWithPolicy(url, headers, prepared);
  const contentRange = parseContentRange(result.headers["content-range"]);
  const contentLength = parseContentLength(result.headers["content-length"]);
  const statusCode = result.statusCode;

  if (statusCode === 206) {
    const start = contentRange?.start;
    if (start === undefined) {
      result.body.resume();
      throw new EmbeddingHttpError({
        kind: "http-status",
        statusCode,
        attempts: result.attempts,
        message: `Partial response without a usable Content-Range header: ${sanitizeUrlForLog(result.finalUrl)}`,
        url: sanitizeUrlForLog(result.finalUrl),
      });
    }
    if (start !== resumeFrom) {
      result.body.resume();
      throw new EmbeddingHttpError({
        kind: "http-status",
        statusCode,
        attempts: result.attempts,
        message: `Server resumed at byte ${start} instead of ${resumeFrom}: ${sanitizeUrlForLog(result.finalUrl)}`,
        url: sanitizeUrlForLog(result.finalUrl),
      });
    }
  }

  const rangeStart =
    statusCode === 206 ? (contentRange?.start ?? resumeFrom) : 0;
  const totalBytes =
    contentRange?.total ??
    (contentLength !== null ? rangeStart + contentLength : null);
  const resumable =
    statusCode === 206 ||
    (result.headers["accept-ranges"] ?? "").toLowerCase().includes("bytes");

  return {
    statusCode,
    headers: projectSafeHeaders(result.headers, prepared.secrets),
    stream: result.body,
    totalBytes,
    rangeStart,
    resumable,
    finalUrl: sanitizeUrlForLog(result.finalUrl),
    attempts: result.attempts,
  };
}

/**
 * Stream a URL into `outputPath`, appending when the server honours a Range
 * request and rewriting from byte 0 when it does not (a server that ignores
 * `Range` must never corrupt an existing partial file with an append).
 */
export async function downloadToFile(
  options: DownloadFileOptions,
): Promise<DownloadFileResult> {
  const response = await requestDownloadHttp(options);
  const startByte = response.rangeStart;
  mkdirSync(dirname(options.outputPath), { recursive: true });

  let written = 0;
  const counter = new Transform({
    transform(
      chunk: Buffer,
      _encoding: BufferEncoding,
      callback: (error?: Error | null, data?: Buffer) => void,
    ): void {
      written += chunk.length;
      options.onProgress?.({
        bytesWritten: startByte + written,
        totalBytes: response.totalBytes,
      });
      callback(null, chunk);
    },
  });

  try {
    await pipeline(
      response.stream,
      counter,
      createWriteStream(options.outputPath, {
        flags: startByte > 0 ? "a" : "w",
      }),
    );
  } finally {
    counter.destroy();
  }

  return {
    outputPath: options.outputPath,
    bytesWritten: written,
    totalBytes: response.totalBytes ?? startByte + written,
    statusCode: response.statusCode,
    rangeStart: startByte,
    resumable: response.resumable,
    finalUrl: response.finalUrl,
    attempts: response.attempts,
  };
}
