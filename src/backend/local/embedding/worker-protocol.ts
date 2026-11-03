/**
 * The embedding worker's JSON Lines wire contract (C3).
 *
 * **Why this file exists.** The worker (`worker-entry.ts`) and the main-process
 * client (`worker-client.ts`) must agree on frame shapes byte for byte. Keeping
 * the types, the parser and the request validators in one module means the
 * contract is frozen in one place (48-2 §3.3 C3, gate 1 "契约冻结"), the client
 * does not drag the worker's implementation in, and the worker does not import
 * the client. Both sides import this module; this module imports neither.
 *
 * **Grammar.** One JSON object per line, `\n`-terminated:
 *
 * - startup: `{type:"ready", protocol, pid, runtime, startedAt}`;
 * - request: `{type:"init"|"embed"|"cancel"|"stats"|"shutdown", id, ...}` where
 *   `id` is a positive integer unique per request;
 * - reply: `{type:"result", id, result}` or
 *   `{type:"error", id, error:{code, message, requestType?}}`.
 *
 * `cancel` is answered out of band by the worker (see `worker-entry.ts`); the
 * frame shape is the same. Error frames are typed: `code` is stable API, the
 * client re-exposes it and C7 maps it onto restart/degrade decisions, so callers
 * never parse messages. A frame that does not match the grammar is a protocol
 * failure — the stream cannot be resynchronized, so the client kills the worker.
 *
 * **No side effects.** Parsing never reads the clock, the environment or the
 * filesystem. Line splitting accepts arbitrary chunks (including a multi-byte
 * UTF-8 character split across two chunks) so tests can feed bytes directly.
 *
 * Layer: `backend/local/`. Imports `node:string_decoder` only.
 */

import { StringDecoder } from "node:string_decoder";

/** Wire protocol version; bumped only for incompatible frame changes. */
export const EMBEDDING_WORKER_PROTOCOL_VERSION = 1;

/** Upper bound on one inbound JSON line, in characters. */
export const MAX_FRAME_CHARS = 1_000_000;

/** Upper bound on texts per `embed` request; larger jobs belong in a build. */
export const MAX_TEXTS_PER_REQUEST = 256;

/** Upper bound on one input text, in UTF-16 code units. */
export const MAX_TEXT_CHARS = 32_768;

/** Which runtime hosts the worker (both Bun and Node are real paths). */
export type EmbeddingWorkerRuntimeName = "bun" | "node";

/** Request kinds the worker accepts. */
export type EmbeddingWorkerRequestType =
  | "init"
  | "embed"
  | "cancel"
  | "stats"
  | "shutdown";

/**
 * Stable error-frame codes. `protocol`/`invalid-request` mean the caller's frame
 * was wrong; `not-initialized` means `embed` arrived first; the `*-failed` codes
 * name the stage that failed; `internal` is a worker-side invariant violation.
 */
export type EmbeddingWorkerErrorCode =
  | "protocol"
  | "invalid-request"
  | "not-initialized"
  | "init-failed"
  | "tokenizer-failed"
  | "runtime-failed"
  | "embed-failed"
  | "featurize-failed"
  | "internal";

/** Startup handshake, emitted once before any request is read. */
export interface EmbeddingWorkerReadyFrame {
  readonly type: "ready";
  readonly protocol: number;
  readonly pid: number;
  readonly runtime: EmbeddingWorkerRuntimeName;
  readonly startedAt: number;
}

/** `{type:"result"}` frame; `result` is narrowed by the originating request. */
export interface EmbeddingWorkerResultFrame<TResult = unknown> {
  readonly type: "result";
  readonly id: number;
  readonly result: TResult;
}

/** Typed failure frame: every failed request gets one, nothing is silent. */
export interface EmbeddingWorkerErrorFrame {
  readonly type: "error";
  readonly id: number | null;
  readonly error: {
    readonly code: EmbeddingWorkerErrorCode;
    readonly message: string;
    readonly requestType?: EmbeddingWorkerRequestType;
  };
}

/** Any frame the worker may emit. */
export type EmbeddingWorkerFrame =
  | EmbeddingWorkerReadyFrame
  | EmbeddingWorkerResultFrame
  | EmbeddingWorkerErrorFrame;

/**
 * `init` payload without the envelope. `runtimeDir` holds the installed
 * `node_modules` closure; `modelPath`/`tokenizerPath` are absolute. Threads and
 * execution providers are decided by C5's calibration.
 */
export interface EmbeddingWorkerInitOptions {
  readonly runtimeDir: string;
  readonly modelPath: string;
  readonly tokenizerPath: string;
  readonly maxTokens?: number;
  readonly maxBatchSize?: number;
  readonly maxBatchTokens?: number;
  readonly intraOpThreads?: number;
  readonly executionProviders?: readonly string[];
  readonly warmupText?: string;
}

/** Any frame the client may send. */
export type EmbeddingWorkerRequest =
  | ({
      readonly id: number;
      readonly type: "init";
    } & EmbeddingWorkerInitOptions)
  | {
      readonly id: number;
      readonly type: "embed";
      readonly texts: readonly string[];
    }
  | {
      readonly id: number;
      readonly type: "cancel";
      readonly requestId?: number;
    }
  | { readonly id: number; readonly type: "stats" }
  | { readonly id: number; readonly type: "shutdown" };

const REQUEST_TYPES: ReadonlySet<string> = new Set([
  "init",
  "embed",
  "cancel",
  "stats",
  "shutdown",
]);

/** Guard for an untrusted frame's `type` field. */
export function isEmbeddingWorkerRequestType(
  value: unknown,
): value is EmbeddingWorkerRequestType {
  return typeof value === "string" && REQUEST_TYPES.has(value);
}

/** Reply to `init`. */
export interface EmbeddingWorkerInitResult {
  readonly dim: number;
  readonly runtime: EmbeddingWorkerRuntimeName;
  readonly maxTokens: number;
  /** Time spent on the warmup inference, in milliseconds. */
  readonly warmupMs: number;
}

/**
 * Reply to `embed`. `vectors[i]` is base64 float32 (`featurize.ts`) or `null`
 * when cancellation stopped work before that text was embedded.
 */
export interface EmbeddingWorkerEmbedResult {
  readonly vectors: readonly (string | null)[];
  readonly dim: number;
  readonly cancelled: boolean;
  readonly texts: number;
  readonly tokens: number;
  readonly batches: number;
  readonly elapsedMs: number;
}

/** Reply to `cancel`: how many requests were stopped and which ids. */
export interface EmbeddingWorkerCancelResult {
  readonly cancelled: number;
  readonly targets: readonly number[];
}

/** Reply to `stats`; C5 derives threads/throughput from these counters. */
export interface EmbeddingWorkerStats {
  readonly initialized: boolean;
  readonly modelPath: string | null;
  readonly tokenizerPath: string | null;
  readonly runtime: EmbeddingWorkerRuntimeName;
  readonly dim: number | null;
  readonly maxTokens: number;
  readonly maxBatchSize: number;
  readonly maxBatchTokens: number;
  readonly inits: number;
  readonly embeds: number;
  readonly texts: number;
  readonly tokens: number;
  readonly batches: number;
  readonly errors: number;
  readonly cancelled: number;
  readonly totalEmbedMs: number;
  readonly lastEmbedMs: number;
  readonly textsPerSecond: number;
  readonly tokensPerSecond: number;
  readonly uptimeMs: number;
  readonly queueDepth: number;
  readonly pendingRequestId: number | null;
}

/** Reply to `shutdown`. */
export interface EmbeddingWorkerShutdownResult {
  readonly uptimeMs: number;
  readonly embeds: number;
}

/** Shared `unknown` → object narrowing (frame parser and loader adapters). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Shorten a message for a frame/error carry without dropping the start. */
export function truncateMessage(message: string, limit = 200): string {
  return message.length <= limit ? message : `${message.slice(0, limit)}…`;
}

/**
 * Internal: a request that failed validation or execution. The worker maps
 * `code` straight onto the error frame; the reason is never a bare string.
 */
export class WorkerRequestError extends Error {
  readonly code: EmbeddingWorkerErrorCode;

  constructor(code: EmbeddingWorkerErrorCode, message: string) {
    super(message);
    this.name = "WorkerRequestError";
    this.code = code;
  }
}

/**
 * Parse one frame line. Throws on anything that is not a well-formed
 * ready/result/error frame; the client turns that into a protocol failure and a
 * worker crash (a desynced stream cannot be resynchronized).
 */
export function parseEmbeddingWorkerFrame(line: string): EmbeddingWorkerFrame {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    throw new Error("The embedding worker emitted an empty frame.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(
      `The embedding worker emitted a frame that is not JSON: ${truncateMessage(trimmed)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new Error(
      "The embedding worker emitted a frame that is not an object.",
    );
  }
  if (parsed.type === "ready") {
    if (
      typeof parsed.protocol !== "number" ||
      typeof parsed.pid !== "number" ||
      (parsed.runtime !== "bun" && parsed.runtime !== "node") ||
      typeof parsed.startedAt !== "number"
    ) {
      throw new Error("The embedding worker emitted a malformed ready frame.");
    }
    return {
      type: "ready",
      protocol: parsed.protocol,
      pid: parsed.pid,
      runtime: parsed.runtime,
      startedAt: parsed.startedAt,
    };
  }
  if (parsed.type === "result") {
    if (typeof parsed.id !== "number") {
      throw new Error(
        "The embedding worker emitted a result frame without an id.",
      );
    }
    return { type: "result", id: parsed.id, result: parsed.result };
  }
  if (parsed.type === "error") {
    const error = parsed.error;
    if (parsed.id !== null && typeof parsed.id !== "number") {
      throw new Error(
        "The embedding worker emitted an error frame with a bad id.",
      );
    }
    if (!isRecord(error) || typeof error.code !== "string") {
      throw new Error(
        "The embedding worker emitted an error frame without a code.",
      );
    }
    return {
      type: "error",
      id: parsed.id as number | null,
      error: {
        code: error.code as EmbeddingWorkerErrorCode,
        message:
          typeof error.message === "string" ? error.message : "unknown error",
        ...(typeof error.requestType === "string"
          ? { requestType: error.requestType as EmbeddingWorkerRequestType }
          : {}),
      },
    };
  }
  throw new Error(
    `The embedding worker emitted an unknown frame type: ${String(parsed.type)}`,
  );
}

/**
 * Split arbitrary chunks into frame lines. Does not use `readline`, so tests and
 * the client can feed bytes (including split multi-byte characters) directly.
 * A trailing line without `\n` is emitted at end of stream.
 */
export async function* splitEmbeddingWorkerLines(
  source: AsyncIterable<string | Uint8Array>,
): AsyncGenerator<string> {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  for await (const chunk of source) {
    buffer +=
      typeof chunk === "string" ? chunk : decoder.write(Buffer.from(chunk));
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      yield stripCarriageReturn(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
    if (buffer.length > MAX_FRAME_CHARS) {
      throw new Error(
        `An embedding worker frame exceeded ${MAX_FRAME_CHARS} characters.`,
      );
    }
  }
  buffer += decoder.end();
  if (buffer.length > 0) yield stripCarriageReturn(buffer);
}

function stripCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/** Validate an optional positive-integer field, falling back when absent. */
export function optionalPositiveInteger(
  value: unknown,
  label: string,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new WorkerRequestError(
      "invalid-request",
      `${label} must be a positive integer.`,
    );
  }
  return value;
}

/** Validate a required non-empty string field. */
export function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new WorkerRequestError(
      "invalid-request",
      `${label} must be a non-empty string.`,
    );
  }
  return value;
}

/** Validate an `embed` request's text list (count and per-text bounds). */
export function requireEmbedTexts(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new WorkerRequestError(
      "invalid-request",
      "texts must be a non-empty array of strings.",
    );
  }
  if (value.length > MAX_TEXTS_PER_REQUEST) {
    throw new WorkerRequestError(
      "invalid-request",
      `A request may embed at most ${MAX_TEXTS_PER_REQUEST} texts.`,
    );
  }
  for (let index = 0; index < value.length; index += 1) {
    const text: unknown = value[index];
    if (typeof text !== "string") {
      throw new WorkerRequestError(
        "invalid-request",
        `texts[${index}] is not a string.`,
      );
    }
    if (text.length > MAX_TEXT_CHARS) {
      throw new WorkerRequestError(
        "invalid-request",
        `texts[${index}] exceeds ${MAX_TEXT_CHARS} characters.`,
      );
    }
  }
  return value as readonly string[];
}

/** Validate a non-empty string array (e.g. execution providers). */
export function requireStringArray(
  value: unknown,
  label: string,
): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new WorkerRequestError(
      "invalid-request",
      `${label} must be a non-empty array.`,
    );
  }
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new WorkerRequestError(
        "invalid-request",
        `${label} entries must be non-empty strings.`,
      );
    }
  }
  return value as readonly string[];
}

/** Defaults a worker applies when an `init` request omits a tuning field. */
export interface WorkerInitDefaults {
  readonly maxTokens: number;
  readonly maxBatchSize: number;
  readonly maxBatchTokens: number;
  readonly warmupText: string;
}

/** Validated `init` options with every default resolved. */
export interface NormalizedWorkerInitOptions {
  readonly runtimeDir: string;
  readonly modelPath: string;
  readonly tokenizerPath: string;
  readonly maxTokens: number;
  readonly maxBatchSize: number;
  readonly maxBatchTokens: number;
  readonly intraOpThreads: number | undefined;
  readonly executionProviders: readonly string[] | undefined;
  readonly warmupText: string;
}

/** Validate an `init` payload once, at the boundary, instead of field by field. */
export function normalizeInitOptions(
  options: EmbeddingWorkerInitOptions,
  defaults: WorkerInitDefaults,
): NormalizedWorkerInitOptions {
  return {
    runtimeDir: requireText(options.runtimeDir, "runtimeDir"),
    modelPath: requireText(options.modelPath, "modelPath"),
    tokenizerPath: requireText(options.tokenizerPath, "tokenizerPath"),
    maxTokens: optionalPositiveInteger(
      options.maxTokens,
      "maxTokens",
      defaults.maxTokens,
    ),
    maxBatchSize: optionalPositiveInteger(
      options.maxBatchSize,
      "maxBatchSize",
      defaults.maxBatchSize,
    ),
    maxBatchTokens: optionalPositiveInteger(
      options.maxBatchTokens,
      "maxBatchTokens",
      defaults.maxBatchTokens,
    ),
    intraOpThreads:
      options.intraOpThreads === undefined
        ? undefined
        : optionalPositiveInteger(options.intraOpThreads, "intraOpThreads", 0),
    executionProviders:
      options.executionProviders === undefined
        ? undefined
        : requireStringArray(options.executionProviders, "executionProviders"),
    warmupText:
      options.warmupText === undefined
        ? defaults.warmupText
        : requireText(options.warmupText, "warmupText"),
  };
}
