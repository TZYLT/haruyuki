import type { Readable } from "node:stream";

/**
 * Shared contract for the embedding download client: options, results, the
 * typed error taxonomy, secret redaction, header projection and failure
 * classification.
 *
 * Kept separate from the transport (`download-http-transport.ts`) and the public
 * entrypoint (`download-http.ts`) so each module stays readable in one pass and
 * under the repository's file-size ceiling. Nothing here touches the network.
 */

/** What went wrong, in the vocabulary the retry policy and UI need. */
export type EmbeddingHttpErrorKind =
  | "aborted"
  | "connection-refused"
  | "connection-reset"
  | "dns"
  | "http-status"
  | "proxy"
  | "timeout"
  | "tls"
  | "unknown";

interface EmbeddingHttpErrorInit {
  kind: EmbeddingHttpErrorKind;
  message: string;
  url: string;
  attempts?: number;
  cause?: unknown;
  retryable?: boolean;
  statusCode?: number;
}

/** Typed download failure. `message` is already redacted and URL-sanitized. */
export class EmbeddingHttpError extends Error {
  readonly kind: EmbeddingHttpErrorKind;
  /** Request URL with userinfo and query string removed. */
  readonly url: string;
  /** Final attempt number this failure belongs to (1-based). */
  readonly attempts: number;
  /** Whether the retry policy considers this failure transient. */
  readonly retryable: boolean;
  readonly statusCode: number | undefined;

  constructor(init: EmbeddingHttpErrorInit) {
    super(init.message, { cause: init.cause });
    this.name = "EmbeddingHttpError";
    this.kind = init.kind;
    this.url = init.url;
    this.attempts = init.attempts ?? 1;
    this.retryable = init.retryable ?? false;
    this.statusCode = init.statusCode;
  }
}

/** Progress reported while a response body is being written to disk. */
export interface DownloadProgress {
  /** Bytes on disk so far, including any resumed prefix. */
  readonly bytesWritten: number;
  /** Final size when the server disclosed it, otherwise `null`. */
  readonly totalBytes: number | null;
}

/** Options shared by {@link requestDownloadHttp} and {@link downloadToFile}. */
export interface DownloadRequestOptions {
  readonly url: string | URL;
  /** Extra request headers. `Host`/`Connection`/framing headers are ignored. */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * Secret values (API keys, tokens) that must never appear in an error message
   * or a returned URL. Values shorter than 3 characters are ignored because
   * replacing them would garble every message without protecting a real key.
   */
  readonly secrets?: readonly (string | null | undefined)[];
  /** Connection and idle timeout. Defaults to 10 s; `0` disables it. */
  readonly timeoutMs?: number;
  /**
   * Proxy URL. `undefined` resolves `HTTPS_PROXY`/`HTTP_PROXY` from `env`;
   * `null` forces a direct connection.
   */
  readonly proxyUrl?: string | null;
  /** Environment used to resolve the proxy when `proxyUrl` is omitted. */
  readonly env?: NodeJS.ProcessEnv;
  /** Abort the request/body. */
  readonly signal?: AbortSignal;
  /** Retries after the first attempt. Defaults to 2; `0` disables retries. */
  readonly maxRetries?: number;
  /** Maximum redirect hops. Defaults to 5. */
  readonly maxRedirects?: number;
  /** Base delay for exponential backoff, in milliseconds. Defaults to 250. */
  readonly retryBaseDelayMs?: number;
  /** Absolute byte offset to resume from; sends a `Range` header when > 0. */
  readonly resumeFrom?: number;
}

/** A streaming download response with the resume information callers need. */
export interface DownloadHttpResponse {
  readonly statusCode: number;
  /** Projected response headers (safe allow-list, redacted, lower-case keys). */
  readonly headers: Readonly<Record<string, string>>;
  /** Response body. The caller owns it and must consume or destroy it. */
  readonly stream: Readable;
  /** Total resource size when disclosed by the server, otherwise `null`. */
  readonly totalBytes: number | null;
  /** Byte offset the body starts at (0 for a fresh `200`, resume offset for `206`). */
  readonly rangeStart: number;
  /** Whether the server advertised range support. */
  readonly resumable: boolean;
  /** Final URL after redirects, with userinfo/query removed. */
  readonly finalUrl: string;
  /** Number of HTTP attempts used (including retries). */
  readonly attempts: number;
}

/** Options for {@link downloadToFile}. */
export interface DownloadFileOptions extends DownloadRequestOptions {
  /** Destination path; its parent directory is created. */
  readonly outputPath: string;
  /** Called as bytes are written. */
  readonly onProgress?: (progress: DownloadProgress) => void;
}

/** Result of {@link downloadToFile}. */
export interface DownloadFileResult {
  readonly outputPath: string;
  /** Bytes written by this call (not counting a resumed prefix). */
  readonly bytesWritten: number;
  /** Final size on disk when known. */
  readonly totalBytes: number | null;
  readonly statusCode: number;
  readonly rangeStart: number;
  readonly resumable: boolean;
  readonly finalUrl: string;
  readonly attempts: number;
}

/** A response head plus a stream, before policy (status/redirect) handling. */
export interface RawHttpResponse {
  readonly statusCode: number;
  readonly headers: Record<string, string>;
  readonly body: Readable;
}

/** Everything the transport needs that does not change per attempt. */
export interface PreparedRequest {
  readonly method: "GET" | "HEAD";
  readonly timeoutMs: number;
  readonly retries: number;
  readonly maxRedirects: number;
  readonly retryBaseDelayMs: number;
  readonly signal: AbortSignal | undefined;
  readonly secrets: readonly string[];
  readonly proxyUrl: string | null;
}

/** Response headers that are safe and useful to hand back to callers. */
export const SAFE_RESPONSE_HEADERS = new Set([
  "accept-ranges",
  "content-length",
  "content-range",
  "content-type",
  "etag",
  "last-modified",
]);

/** Request headers that must not follow a cross-origin redirect. */
export const SENSITIVE_REQUEST_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
]);

const REDACTED = "[REDACTED]";

/**
 * Replace every occurrence of the supplied secret values with `[REDACTED]`.
 * Both the raw value and its URI-encoded form are replaced so a token that went
 * through `encodeURIComponent` cannot slip out of a URL-shaped message.
 */
export function redactSecrets(
  text: string,
  secrets: readonly (string | null | undefined)[] = [],
): string {
  let result = text;
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length < 3) continue;
    result = result.split(secret).join(REDACTED);
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) {
      result = result.split(encoded).join(REDACTED);
    }
  }
  return result;
}

/**
 * URL form safe to put in an error message or log: scheme, host and path only.
 * Userinfo (proxy credentials), query strings and fragments are dropped so a
 * token passed as a query parameter cannot leak.
 */
export function sanitizeUrlForLog(input: string | URL): string {
  let url: URL;
  try {
    url = typeof input === "string" ? new URL(input) : input;
  } catch {
    return "<invalid-url>";
  }
  const path = url.pathname.length > 0 ? url.pathname : "/";
  return `${url.protocol}//${url.host}${path}`;
}

/** Node-style error code (`ENOTFOUND`, `ECONNREFUSED`, …) when present. */
export function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/** Message text of an unknown thrown value. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Classify a thrown transport error. Exported because callers classify errors
 * raised outside the request path too (for example a manual `.part` file read).
 */
export function classifyEmbeddingHttpError(
  error: unknown,
): EmbeddingHttpErrorKind {
  if (error instanceof EmbeddingHttpError) return error.kind;
  const code = errorCode(error);
  switch (code) {
    case "ENOTFOUND":
    case "EAI_AGAIN":
    case "EAI_FAIL":
      return "dns";
    case "ECONNREFUSED":
      return "connection-refused";
    case "ECONNRESET":
    case "ECONNABORTED":
    case "EPIPE":
      return "connection-reset";
    case "ETIMEDOUT":
    case "ESOCKETTIMEDOUT":
    case "UND_ERR_CONNECT_TIMEOUT":
      return "timeout";
    case "ABORT_ERR":
    case "ERR_CANCELED":
      return "aborted";
    case "EPROTO":
    case "CERT_HAS_EXPIRED":
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "SELF_SIGNED_CERT_IN_CHAIN":
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "ERR_TLS_CERT_ALTNAME_INVALID":
    case "ERR_SSL_WRONG_VERSION_NUMBER":
      return "tls";
    default:
      break;
  }
  if (code?.startsWith("ERR_SSL") || code?.startsWith("ERR_TLS")) {
    return "tls";
  }
  const message = errorMessage(error).toLowerCase();
  if (
    message.includes("certificate") ||
    message.includes("ssl") ||
    message.includes("tls") ||
    message.includes("handshake") ||
    message.includes("wrong version number")
  ) {
    return "tls";
  }
  if (message.includes("timed out") || message.includes("timeout")) {
    return "timeout";
  }
  if (message.includes("socket hang up")) {
    return "connection-reset";
  }
  return "unknown";
}

/**
 * Whether a classified failure is worth retrying. Explicit HTTP retry decisions
 * live with the status handling; this covers transport failures only (transient
 * DNS resolver errors and timeouts/resets, not deterministic refusals/TLS).
 */
export function isRetryableEmbeddingHttpError(
  error: EmbeddingHttpError | unknown,
): boolean {
  if (error instanceof EmbeddingHttpError) return error.retryable;
  const kind = classifyEmbeddingHttpError(error);
  if (kind === "timeout" || kind === "connection-reset") return true;
  if (kind === "dns") return errorCode(error) === "EAI_AGAIN";
  return false;
}

export function timeoutError(
  url: URL,
  timeoutMs: number,
  attempts: number,
): EmbeddingHttpError {
  return new EmbeddingHttpError({
    kind: "timeout",
    attempts,
    retryable: true,
    message: `Request timed out after ${timeoutMs} ms: ${sanitizeUrlForLog(url)}`,
    url: sanitizeUrlForLog(url),
  });
}

export function abortedError(url: URL, attempts: number): EmbeddingHttpError {
  return new EmbeddingHttpError({
    kind: "aborted",
    attempts,
    message: `Request was aborted: ${sanitizeUrlForLog(url)}`,
    url: sanitizeUrlForLog(url),
  });
}

export function connectionResetError(
  url: URL,
  detail: string,
  attempts: number,
): EmbeddingHttpError {
  return new EmbeddingHttpError({
    kind: "connection-reset",
    attempts,
    retryable: true,
    message: `Connection closed before the response completed (${detail}): ${sanitizeUrlForLog(url)}`,
    url: sanitizeUrlForLog(url),
  });
}

export function httpStatusError(
  statusCode: number,
  url: URL,
  secrets: readonly string[],
  attempts: number,
): EmbeddingHttpError {
  const retryable =
    statusCode === 429 || (statusCode >= 500 && statusCode <= 599);
  return new EmbeddingHttpError({
    kind: "http-status",
    statusCode,
    attempts,
    retryable,
    message: redactSecrets(
      `HTTP ${statusCode} response for ${sanitizeUrlForLog(url)}`,
      secrets,
    ),
    url: sanitizeUrlForLog(url),
  });
}

/** Normalize an unexpected transport/parser error into the typed taxonomy. */
export function shapeTransportError(
  error: unknown,
  url: URL,
  secrets: readonly string[],
  attempts: number,
): EmbeddingHttpError {
  if (error instanceof EmbeddingHttpError) return error;
  const kind = classifyEmbeddingHttpError(error);
  const code = errorCode(error);
  const detail = redactSecrets(errorMessage(error), secrets);
  return new EmbeddingHttpError({
    kind,
    attempts,
    retryable: isRetryableEmbeddingHttpError(error),
    message: redactSecrets(
      `Download request failed (${kind}${code ? ` ${code}` : ""}): ${detail}`,
      secrets,
    ),
    url: sanitizeUrlForLog(url),
    cause: error,
  });
}

/** Exponential backoff for retry number `attempt` (1-based). */
export function backoffDelay(attempt: number, baseMs: number): number {
  return baseMs * 2 ** Math.max(0, attempt - 1);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasHeader(
  headers: Readonly<Record<string, string>>,
  name: string,
): boolean {
  const target = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === target);
}

/**
 * Request headers for a download. Framing and host headers are owned by the
 * transport; `Accept-Encoding: identity` keeps byte offsets aligned with the
 * on-disk file so Range resumes stay valid.
 */
export function buildRequestHeaders(
  headers: Readonly<Record<string, string>> | undefined,
  resumeFrom: number,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    switch (name.toLowerCase()) {
      case "host":
      case "connection":
      case "content-length":
      case "transfer-encoding":
        break;
      default:
        result[name] = value;
    }
  }
  if (!hasHeader(result, "accept")) result.Accept = "*/*";
  if (!hasHeader(result, "accept-encoding")) {
    result["Accept-Encoding"] = "identity";
  }
  if (!hasHeader(result, "user-agent")) {
    result["User-Agent"] = "haruyuki-embedding-download";
  }
  if (resumeFrom > 0) result.Range = `bytes=${resumeFrom}-`;
  return result;
}

/** Drop credentials before following a cross-origin redirect. */
export function stripSensitiveHeaders(
  headers: Readonly<Record<string, string>>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (SENSITIVE_REQUEST_HEADERS.has(name.toLowerCase())) continue;
    result[name] = value;
  }
  return result;
}

/** Flatten Node's header shape into lower-cased single strings. */
export function normalizeResponseHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    result[name.toLowerCase()] = Array.isArray(value)
      ? value.join(", ")
      : value;
  }
  return result;
}

/** Project a response's headers onto the safe allow-list, redacting values. */
export function projectSafeHeaders(
  headers: Readonly<Record<string, string>>,
  secrets: readonly string[],
): Record<string, string> {
  const projected: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!SAFE_RESPONSE_HEADERS.has(name)) continue;
    projected[name] = redactSecrets(value, secrets);
  }
  return projected;
}

export interface ContentRange {
  readonly start: number;
  readonly end: number | null;
  readonly total: number | null;
}

/** Parse `Content-Range: bytes start-end/total`. */
export function parseContentRange(
  value: string | undefined,
): ContentRange | null {
  if (!value) return null;
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(value.trim());
  if (!match?.[1] || !match[2]) return null;
  const start = Number.parseInt(match[1], 10);
  const end = Number.parseInt(match[2], 10);
  const total =
    match[3] && match[3] !== "*" ? Number.parseInt(match[3], 10) : null;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
  return { start, end, total };
}

/** Parse `Content-Length`, returning `null` when absent or malformed. */
export function parseContentLength(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
