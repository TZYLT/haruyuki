/**
 * Transport and typed-error half of the external embedding endpoint client
 * (48-1 §6.5, 48-2 §4.6 — package C6). `endpoint-client.ts` owns the URL
 * allow-list, both wire protocols and the public API; this module owns the
 * request seam, the default `node:http(s)` transport and the retry/status
 * policy so each file stays readable in one pass.
 *
 * The default transport speaks `node:http`/`node:https` directly rather than
 * global `fetch`, whose proxy/TLS failure semantics differ between Bun and
 * Node. It is injectable (`EmbeddingEndpointRequestImpl`) so tests and callers
 * that need a proxied transport can replace it. C1's streaming download client
 * is GET/HEAD-only and hands back a body stream, so its CONNECT tunnel cannot
 * carry a JSON POST; this module reuses C1's failure classification, redaction,
 * URL sanitisation and backoff helpers (`./download-http-types`) instead of
 * re-implementing that vocabulary.
 *
 * Every message produced here is redacted with the API key before it leaves the
 * module, and the key only travels in the `Authorization` header.
 */

import * as http from "node:http";
import * as https from "node:https";
import {
  backoffDelay,
  classifyEmbeddingHttpError,
  delay,
  errorMessage,
  redactSecrets,
  sanitizeUrlForLog,
} from "./download-http-types";

/** Everything that can go wrong, in the vocabulary the settings UI needs. */
export type EmbeddingEndpointErrorKind =
  | "aborted"
  | "allowlist"
  | "auth"
  | "circuit-open"
  | "config"
  | "dimension"
  | "http-4xx"
  | "http-5xx"
  | "http-status"
  | "network"
  | "norm"
  | "rate-limit"
  | "response"
  | "timeout";

interface EmbeddingEndpointErrorInit {
  kind: EmbeddingEndpointErrorKind;
  message: string;
  url?: string;
  statusCode?: number;
  attempts?: number;
  retryable?: boolean;
  cause?: unknown;
}

/** Typed endpoint failure. `message` is already redacted and URL-sanitised. */
export class EmbeddingEndpointError extends Error {
  readonly kind: EmbeddingEndpointErrorKind;
  /** Request URL with userinfo and query string removed. */
  readonly url: string;
  readonly statusCode: number | undefined;
  readonly attempts: number;
  readonly retryable: boolean;

  constructor(init: EmbeddingEndpointErrorInit) {
    super(init.message, { cause: init.cause });
    this.name = "EmbeddingEndpointError";
    this.kind = init.kind;
    this.url = init.url ?? "";
    this.statusCode = init.statusCode;
    this.attempts = init.attempts ?? 1;
    this.retryable = init.retryable ?? false;
  }
}

export function isEmbeddingEndpointError(
  value: unknown,
): value is EmbeddingEndpointError {
  return value instanceof EmbeddingEndpointError;
}

/** One HTTP request handed to the transport seam. */
export interface EmbeddingEndpointHttpRequest {
  readonly url: string;
  readonly method: "GET" | "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  /** Whole-exchange timeout in ms; `0` disables the client-side timer. */
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

/** The part of an HTTP response the client policy needs. */
export interface EmbeddingEndpointHttpResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/**
 * Injectable transport (the "fetchImpl" seam). Defaults to
 * {@link defaultEndpointRequest} (`node:http`/`node:https`).
 */
export type EmbeddingEndpointRequestImpl = (
  request: EmbeddingEndpointHttpRequest,
) => Promise<EmbeddingEndpointHttpResponse>;

/** The resolved knobs the request policy consumes. */
export interface EndpointRequestPolicy {
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly retryBaseDelayMs: number;
  readonly apiKey: string | null;
  readonly requestImpl: EmbeddingEndpointRequestImpl;
}

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_SERVER_MESSAGE_CHARS = 300;

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

export function allowlistError(message: string): EmbeddingEndpointError {
  return new EmbeddingEndpointError({ kind: "allowlist", message });
}

export function configError(message: string): EmbeddingEndpointError {
  return new EmbeddingEndpointError({ kind: "config", message });
}

export function timeoutEndpointError(
  url: URL | string,
  timeoutMs: number,
): EmbeddingEndpointError {
  const sanitized = sanitizeUrlForLog(url);
  return new EmbeddingEndpointError({
    kind: "timeout",
    message: `Endpoint request timed out after ${timeoutMs} ms: ${sanitized}`,
    url: sanitized,
  });
}

export function abortedEndpointError(
  url: URL | string,
): EmbeddingEndpointError {
  const sanitized = sanitizeUrlForLog(url);
  return new EmbeddingEndpointError({
    kind: "aborted",
    message: `Endpoint request was aborted: ${sanitized}`,
    url: sanitized,
  });
}

export function responseError(
  url: URL | string,
  message: string,
  cause?: unknown,
): EmbeddingEndpointError {
  const sanitized = sanitizeUrlForLog(url);
  return new EmbeddingEndpointError({
    kind: "response",
    message: `${message} (${sanitized})`,
    url: sanitized,
    cause,
  });
}

/**
 * Map a transport failure (raw `node:` error or an injected implementation's
 * error) onto the endpoint taxonomy, reusing C1's classifier.
 */
export function shapeRequestError(
  error: unknown,
  url: URL | string,
  secrets: readonly (string | null | undefined)[],
  attempts: number,
): EmbeddingEndpointError {
  const sanitized = sanitizeUrlForLog(url);
  if (error instanceof EmbeddingEndpointError) {
    error.message = redactSecrets(error.message, secrets);
    return error;
  }
  const transportKind = classifyEmbeddingHttpError(error);
  const kind: EmbeddingEndpointErrorKind =
    transportKind === "timeout"
      ? "timeout"
      : transportKind === "aborted"
        ? "aborted"
        : "network";
  const detail = redactSecrets(errorMessage(error), secrets);
  return new EmbeddingEndpointError({
    kind,
    message: redactSecrets(
      `Endpoint request to ${sanitized} failed (${kind}): ${detail}`,
      secrets,
    ),
    url: sanitized,
    attempts,
    cause: error,
  });
}

/** Shared JSON object narrowing used by response parsing and error details. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function serverMessageDetail(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length === 0) return "";
  let text = trimmed;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const record = asRecord(parsed);
    const errorValue = record?.error;
    if (typeof errorValue === "string") {
      text = errorValue;
    } else {
      const errorRecord = asRecord(errorValue);
      if (typeof errorRecord?.message === "string") {
        text = errorRecord.message;
      } else if (typeof record?.message === "string") {
        text = record.message;
      }
    }
  } catch {
    // Not JSON: fall back to the raw (truncated, redacted) body.
  }
  const compact = text.replace(/\s+/gu, " ").trim();
  return compact.length > MAX_SERVER_MESSAGE_CHARS
    ? `${compact.slice(0, MAX_SERVER_MESSAGE_CHARS)}…`
    : compact;
}

function statusError(
  statusCode: number,
  url: string,
  secrets: readonly (string | null | undefined)[],
  attempts: number,
  body: string,
): EmbeddingEndpointError {
  const kind: EmbeddingEndpointErrorKind =
    statusCode === 401 || statusCode === 403
      ? "auth"
      : statusCode === 429
        ? "rate-limit"
        : statusCode >= 500 && statusCode <= 599
          ? "http-5xx"
          : statusCode >= 400 && statusCode <= 499
            ? "http-4xx"
            : "http-status";
  const retryable = kind === "rate-limit" || kind === "http-5xx";
  const detail = serverMessageDetail(body);
  const sanitized = sanitizeUrlForLog(url);
  return new EmbeddingEndpointError({
    kind,
    statusCode,
    attempts,
    retryable,
    message: redactSecrets(
      `Endpoint request failed with HTTP ${statusCode} for ${sanitized}${detail.length > 0 ? `: ${detail}` : ""}`,
      secrets,
    ),
    url: sanitized,
  });
}

// ---------------------------------------------------------------------------
// Default transport: node:http(s) directly (never global fetch)
// ---------------------------------------------------------------------------

function normalizeResponseHeaders(
  headers: http.IncomingHttpHeaders,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      result[name.toLowerCase()] = value;
    } else if (Array.isArray(value)) {
      result[name.toLowerCase()] = value.join(", ");
    }
  }
  return result;
}

/**
 * Direct HTTP(S) request used unless the caller injects `requestImpl`. A single
 * timer bounds the whole exchange (connect, headers and body); the response
 * body is capped so a hostile endpoint cannot exhaust memory.
 */
export async function defaultEndpointRequest(
  request: EmbeddingEndpointHttpRequest,
): Promise<EmbeddingEndpointHttpResponse> {
  const url = new URL(request.url);
  const transport = url.protocol === "https:" ? https : http;
  const payload =
    request.body === undefined ? undefined : Buffer.from(request.body, "utf8");
  const headers: Record<string, string> = { ...request.headers };
  if (payload !== undefined) {
    headers["content-length"] = String(payload.byteLength);
  }

  return await new Promise<EmbeddingEndpointHttpResponse>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    let clientRequest: http.ClientRequest | undefined;

    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (request.signal && onAbort) {
        request.signal.removeEventListener("abort", onAbort);
      }
      action();
    };
    const fail = (error: unknown) => {
      settle(() => {
        clientRequest?.destroy();
        reject(error);
      });
    };
    const succeed = (response: EmbeddingEndpointHttpResponse) => {
      settle(() => resolve(response));
    };

    if (request.signal?.aborted) {
      reject(abortedEndpointError(url));
      return;
    }
    if (request.signal) {
      onAbort = () => fail(abortedEndpointError(url));
      request.signal.addEventListener("abort", onAbort, { once: true });
    }
    if (request.timeoutMs > 0) {
      timer = setTimeout(() => {
        fail(timeoutEndpointError(url, request.timeoutMs));
      }, request.timeoutMs);
    }

    clientRequest = transport.request(
      url,
      { method: request.method, headers },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        const statusCode = response.statusCode ?? 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.byteLength;
          if (bytes > MAX_RESPONSE_BYTES) {
            response.destroy();
            fail(
              responseError(
                url,
                `Endpoint response exceeded ${MAX_RESPONSE_BYTES} bytes`,
              ),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", (error: Error) => {
          fail(error);
        });
        response.on("end", () => {
          succeed({
            statusCode,
            headers: normalizeResponseHeaders(response.headers),
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    clientRequest.on("error", (error: Error) => {
      fail(error);
    });
    clientRequest.end(payload);
  });
}

// ---------------------------------------------------------------------------
// Request policy: 4xx never retries; 429/5xx at most `maxRetries` times
// ---------------------------------------------------------------------------

function requestHeaders(
  policy: EndpointRequestPolicy,
  hasBody: boolean,
): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (hasBody) headers["content-type"] = "application/json";
  if (policy.apiKey) headers.authorization = `Bearer ${policy.apiKey}`;
  return headers;
}

async function requestWithRetry(
  policy: EndpointRequestPolicy,
  url: string,
  body: string | undefined,
  signal: AbortSignal | undefined,
): Promise<EmbeddingEndpointHttpResponse> {
  for (let attempt = 1; attempt <= policy.maxRetries + 1; attempt += 1) {
    let response: EmbeddingEndpointHttpResponse;
    try {
      response = await policy.requestImpl({
        url,
        method: body === undefined ? "GET" : "POST",
        headers: requestHeaders(policy, body !== undefined),
        body,
        timeoutMs: policy.timeoutMs,
        signal,
      });
    } catch (error) {
      throw shapeRequestError(error, url, [policy.apiKey], attempt);
    }

    if (response.statusCode >= 200 && response.statusCode <= 299) {
      return response;
    }
    if (response.statusCode < 100) {
      throw responseError(
        url,
        "Endpoint returned a response without a status line",
      );
    }
    const error = statusError(
      response.statusCode,
      url,
      [policy.apiKey],
      attempt,
      response.body,
    );
    if (!error.retryable || attempt > policy.maxRetries) throw error;
    await delay(backoffDelay(attempt, policy.retryBaseDelayMs));
    if (signal?.aborted) {
      throw abortedEndpointError(url);
    }
  }
  throw responseError(url, "Endpoint request exhausted its retry budget");
}

/**
 * Send one JSON request through the policy and parse the reply. `body ===
 * undefined` issues a GET; everything else is a POST. JSON parse failures are
 * reported as `response` errors with a redacted body excerpt.
 */
export async function requestEndpointJson(
  policy: EndpointRequestPolicy,
  url: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const response = await requestWithRetry(policy, url, payload, signal);
  try {
    return JSON.parse(response.body) as unknown;
  } catch (error) {
    const detail = serverMessageDetail(response.body);
    const redactedDetail = redactSecrets(detail, [policy.apiKey]);
    throw responseError(
      url,
      `Endpoint returned invalid JSON${redactedDetail.length > 0 ? `: ${redactedDetail}` : ""}`,
      error,
    );
  }
}
