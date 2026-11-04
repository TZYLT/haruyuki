/**
 * External embedding endpoint client (48-1 §6.5, 48-2 §4.6 — package C6).
 *
 * Two wire protocols are supported behind one typed surface:
 * - **OpenAI-compatible**: `GET /v1/models` + `POST /v1/embeddings`;
 * - **Ollama native**: `GET /api/tags` + `GET /api/version` + `POST /api/embed`.
 *
 * The flow the settings wizard drives is {@link verifyEmbeddingEndpoint}:
 * URL allow-list → `net.connect` reachability probe (400 ms default) → model
 * list → one test embedding → dimension and L2-norm validation. Each step is
 * also exported on its own so a UI can show progress between them.
 *
 * **Safety properties** (48-1 §6.5):
 * - Only `https://` or a loopback `http://localhost|127.0.0.1|::1` base URL is
 *   accepted; embedded credentials, query strings and fragments are rejected.
 *   Plain http to a remote host is refused rather than sent in the clear.
 * - The API key only ever travels in the `Authorization: Bearer` header. It is
 *   never put in a URL, never logged, and every message this module produces is
 *   passed through C1's `redactSecrets` before it leaves.
 * - One request times out after 10 s by default (`timeoutMs`); 4xx is never
 *   retried, 429/5xx retry at most twice with exponential backoff, and three
 *   consecutive failed embedding operations trip a breaker that falls back to
 *   lexical recall until a cooldown-gated recovery probe succeeds.
 *
 * **Transport.** The default request implementation speaks `node:http(s)`
 * directly — not global `fetch`, whose proxy/TLS error semantics differ between
 * Bun and Node. C1's streaming download client is GET/HEAD-only and hands back a
 * body stream, so its CONNECT tunnel cannot carry a JSON POST; the transport
 * and error taxonomy live in `./endpoint-client-http.ts`, which reuses C1's
 * failure classification, redaction, URL sanitisation and backoff helpers.
 * Callers that need a proxied transport can inject one through `requestImpl`.
 *
 * Layer: `backend/local/embedding/` — no `cli/`, `websocket/`, `reminders/` or
 * `agent/` imports. Nothing here writes settings or persists a key; D5/D6 own
 * persistence and the permanent egress marker (`egress: true`).
 */

import * as net from "node:net";
import { sanitizeUrlForLog } from "./download-http-types";
import {
  allowlistError,
  asRecord,
  configError,
  defaultEndpointRequest,
  EmbeddingEndpointError,
  type EmbeddingEndpointRequestImpl,
  isEmbeddingEndpointError,
  requestEndpointJson,
  responseError,
  shapeRequestError,
  timeoutEndpointError,
} from "./endpoint-client-http";

export type {
  EmbeddingEndpointErrorKind,
  EmbeddingEndpointHttpRequest,
  EmbeddingEndpointHttpResponse,
  EmbeddingEndpointRequestImpl,
} from "./endpoint-client-http";
export {
  EmbeddingEndpointError,
  isEmbeddingEndpointError,
} from "./endpoint-client-http";

export type EmbeddingEndpointKind = "openai" | "ollama";

/** Default per-request timeout (48-1 §6.5). */
export const DEFAULT_ENDPOINT_TIMEOUT_MS = 10_000;

/** Default TCP reachability probe timeout (48-2 §4.6). */
export const DEFAULT_ENDPOINT_PROBE_TIMEOUT_MS = 400;

/** Retries after the first attempt for 429/5xx (48-1 §6.5: ≤2). */
export const DEFAULT_ENDPOINT_MAX_RETRIES = 2;

/** Base delay for the retry backoff. */
export const DEFAULT_ENDPOINT_RETRY_BASE_DELAY_MS = 250;

/** Consecutive failed operations before the breaker opens. */
export const DEFAULT_ENDPOINT_BREAKER_THRESHOLD = 3;

/** How long the breaker stays open before allowing a recovery probe. */
export const DEFAULT_ENDPOINT_BREAKER_COOLDOWN_MS = 30_000;

/** Allowed deviation of the reply vector's L2 norm from 1. */
export const ENDPOINT_NORM_TOLERANCE = 0.01;

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);
const ENDPOINT_TEST_INPUT = "Haruyuki embedding endpoint connectivity check.";

/** Configuration for every operation in this module. */
export interface EmbeddingEndpointOptions {
  readonly kind: EmbeddingEndpointKind;
  /** Base URL: `https://…` or loopback `http://…`. A `/v1` suffix is optional. */
  readonly baseUrl: string;
  readonly model: string;
  /**
   * Declared vector dimension. Omit (or leave `undefined`) while the wizard is
   * still discovering it; when present, every returned vector must match.
   */
  readonly dimensions?: number;
  /** API key; kept in memory only and redacted from every message. */
  readonly apiKey?: string | null;
  /** Per-request timeout in ms. Defaults to {@link DEFAULT_ENDPOINT_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** TCP probe timeout in ms. Defaults to {@link DEFAULT_ENDPOINT_PROBE_TIMEOUT_MS}. */
  readonly probeTimeoutMs?: number;
  /** Retries after the first attempt. Defaults to {@link DEFAULT_ENDPOINT_MAX_RETRIES}. */
  readonly maxRetries?: number;
  /** Backoff base delay. Defaults to {@link DEFAULT_ENDPOINT_RETRY_BASE_DELAY_MS}. */
  readonly retryBaseDelayMs?: number;
  /** Consecutive failures before the breaker opens. */
  readonly breakerThreshold?: number;
  /** Breaker cooldown before a recovery probe is allowed. */
  readonly breakerCooldownMs?: number;
  /** Transport seam; defaults to the direct `node:http(s)` implementation. */
  readonly requestImpl?: EmbeddingEndpointRequestImpl;
  /** Injectable clock for breaker tests. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/** One model advertised by the endpoint. */
export interface EmbeddingEndpointModel {
  readonly id: string;
  readonly ownedBy?: string;
}

/** Result of listing an endpoint's models. */
export interface EmbeddingEndpointModels {
  readonly models: readonly EmbeddingEndpointModel[];
  /** Ollama daemon version (`/api/version`) when advertised. */
  readonly version?: string;
}

/** Result of the TCP reachability probe. */
export interface EmbeddingEndpointProbe {
  readonly reachable: true;
  readonly latencyMs: number;
  /** Origin + path, never the query string or userinfo. */
  readonly url: string;
}

/** Result of the one-shot test embedding. */
export interface EmbeddingEndpointTestResult {
  readonly model: string;
  readonly dimensions: number;
  readonly norm: number;
  readonly latencyMs: number;
}

/** Full wizard result: probe + list + test embedding, all validated. */
export interface EmbeddingEndpointVerification
  extends EmbeddingEndpointTestResult {
  readonly kind: EmbeddingEndpointKind;
  readonly baseUrl: string;
  readonly probeLatencyMs: number;
  readonly models: readonly EmbeddingEndpointModel[];
  readonly version?: string;
  /** Always `true`: this backend sends query text to an external endpoint. */
  readonly egress: true;
}

export type EmbeddingEndpointCircuitState = "closed" | "open" | "half-open";

/** Long-lived client used at query time; owns the breaker state. */
export interface EmbeddingEndpointClient {
  readonly kind: EmbeddingEndpointKind;
  readonly baseUrl: string;
  readonly model: string;
  readonly dimensions: number | null;
  /** Always `true`; the caller renders this as the permanent egress marker. */
  readonly egress: true;
  probe(): Promise<EmbeddingEndpointProbe>;
  listModels(): Promise<EmbeddingEndpointModels>;
  test(): Promise<EmbeddingEndpointTestResult>;
  embed(
    texts: readonly string[],
    options?: { readonly signal?: AbortSignal },
  ): Promise<readonly Float32Array[]>;
  circuitState(): EmbeddingEndpointCircuitState;
  resetCircuit(): void;
}

// ---------------------------------------------------------------------------
// URL policy
// ---------------------------------------------------------------------------

/**
 * Validate and normalise an endpoint base URL. Throws an `allowlist` error
 * unless the URL is `https://` or loopback `http://` without credentials,
 * query string or fragment. Returns the normalised URL string.
 */
export function normalizeEndpointBaseUrl(raw: string): string {
  const candidate = typeof raw === "string" ? raw.trim() : "";
  if (candidate.length === 0) {
    throw allowlistError("Endpoint base URL must not be empty.");
  }
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw allowlistError("Endpoint base URL is not a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw allowlistError(
      `Endpoint base URL must use http(s); received ${url.protocol}`,
    );
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw allowlistError(
      "Endpoint base URL must not embed credentials; store the API key separately.",
    );
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    throw allowlistError(
      "Endpoint base URL must not carry a query string or fragment.",
    );
  }
  if (url.hostname.length === 0) {
    throw allowlistError("Endpoint base URL is missing a host.");
  }
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
    throw allowlistError(
      "Plain http:// is only allowed for loopback endpoints (localhost, 127.0.0.1, ::1); use https:// for remote hosts.",
    );
  }
  return url.toString();
}

/** Non-throwing form of {@link normalizeEndpointBaseUrl}. */
export function isAllowedEndpointUrl(raw: string): boolean {
  try {
    normalizeEndpointBaseUrl(raw);
    return true;
  } catch {
    return false;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[/u, "")
    .replace(/\]$/u, "")
    .replace(/\.$/u, "");
  return LOOPBACK_HOSTNAMES.has(host);
}

// ---------------------------------------------------------------------------
// Options and API roots
// ---------------------------------------------------------------------------

interface ResolvedEndpointOptions {
  readonly kind: EmbeddingEndpointKind;
  readonly baseUrl: URL;
  readonly model: string;
  readonly dimensions: number | null;
  readonly apiKey: string | null;
  readonly timeoutMs: number;
  readonly probeTimeoutMs: number;
  readonly maxRetries: number;
  readonly retryBaseDelayMs: number;
  readonly breakerThreshold: number;
  readonly breakerCooldownMs: number;
  readonly requestImpl: EmbeddingEndpointRequestImpl;
  readonly now: () => number;
}

function integerOption(
  value: number | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw configError(
      `${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

function resolveEndpointOptions(
  options: EmbeddingEndpointOptions,
): ResolvedEndpointOptions {
  if (options.kind !== "openai" && options.kind !== "ollama") {
    throw configError(
      `Unknown embedding endpoint kind: ${String(options.kind)}`,
    );
  }
  const baseUrl = new URL(normalizeEndpointBaseUrl(options.baseUrl));
  const model = typeof options.model === "string" ? options.model.trim() : "";
  if (model.length === 0) {
    throw configError("Embedding endpoint model must not be empty.");
  }
  let dimensions: number | null = null;
  if (options.dimensions !== undefined) {
    if (!Number.isSafeInteger(options.dimensions) || options.dimensions <= 0) {
      throw configError(
        "Embedding endpoint dimensions must be a positive integer.",
      );
    }
    dimensions = options.dimensions;
  }
  const rawKey =
    typeof options.apiKey === "string" ? options.apiKey.trim() : "";
  return {
    kind: options.kind,
    baseUrl,
    model,
    dimensions,
    apiKey: rawKey.length > 0 ? rawKey : null,
    timeoutMs: integerOption(
      options.timeoutMs,
      DEFAULT_ENDPOINT_TIMEOUT_MS,
      "timeoutMs",
      0,
    ),
    probeTimeoutMs: integerOption(
      options.probeTimeoutMs,
      DEFAULT_ENDPOINT_PROBE_TIMEOUT_MS,
      "probeTimeoutMs",
      1,
    ),
    maxRetries: integerOption(
      options.maxRetries,
      DEFAULT_ENDPOINT_MAX_RETRIES,
      "maxRetries",
      0,
      5,
    ),
    retryBaseDelayMs: integerOption(
      options.retryBaseDelayMs,
      DEFAULT_ENDPOINT_RETRY_BASE_DELAY_MS,
      "retryBaseDelayMs",
      0,
    ),
    breakerThreshold: integerOption(
      options.breakerThreshold,
      DEFAULT_ENDPOINT_BREAKER_THRESHOLD,
      "breakerThreshold",
      1,
    ),
    breakerCooldownMs: integerOption(
      options.breakerCooldownMs,
      DEFAULT_ENDPOINT_BREAKER_COOLDOWN_MS,
      "breakerCooldownMs",
      0,
    ),
    requestImpl: options.requestImpl ?? defaultEndpointRequest,
    now: options.now ?? Date.now,
  };
}

function withPath(url: URL, pathname: string): URL {
  const next = new URL(url.toString());
  next.pathname = pathname;
  return next;
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/u, "");
}

/** OpenAI root: keep an existing `/v1` suffix, otherwise append one. */
function openAiRoot(baseUrl: URL): URL {
  const path = stripTrailingSlashes(baseUrl.pathname);
  if (path.length === 0) return withPath(baseUrl, "/v1");
  if (/\/v1$/iu.test(path)) return withPath(baseUrl, path);
  return withPath(baseUrl, `${path}/v1`);
}

/** Ollama root: drop a trailing `/api` so paths are not doubled. */
function ollamaRoot(baseUrl: URL): URL {
  const path = stripTrailingSlashes(baseUrl.pathname);
  if (path.length === 0) return withPath(baseUrl, "/");
  if (/\/api$/iu.test(path)) return withPath(baseUrl, path.slice(0, -4) || "/");
  return withPath(baseUrl, path);
}

function apiUrl(root: URL, suffix: string): string {
  return `${stripTrailingSlashes(root.toString())}${suffix}`;
}

function modelsUrl(resolved: ResolvedEndpointOptions): string {
  return resolved.kind === "openai"
    ? apiUrl(openAiRoot(resolved.baseUrl), "/models")
    : apiUrl(ollamaRoot(resolved.baseUrl), "/api/tags");
}

function embeddingsUrl(resolved: ResolvedEndpointOptions): string {
  return resolved.kind === "openai"
    ? apiUrl(openAiRoot(resolved.baseUrl), "/embeddings")
    : apiUrl(ollamaRoot(resolved.baseUrl), "/api/embed");
}

function versionUrl(resolved: ResolvedEndpointOptions): string {
  return apiUrl(ollamaRoot(resolved.baseUrl), "/api/version");
}

// ---------------------------------------------------------------------------
// Protocol parsing (OpenAI-compatible and Ollama native)
// ---------------------------------------------------------------------------

function parseVector(value: unknown, url: string): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw responseError(
      url,
      "Endpoint returned an embedding that is not an array of numbers",
    );
  }
  const vector: number[] = [];
  for (const component of value) {
    if (typeof component !== "number" || !Number.isFinite(component)) {
      throw responseError(
        url,
        "Endpoint returned an embedding with a non-finite component",
      );
    }
    vector.push(component);
  }
  return vector;
}

function parseOpenAiModels(
  payload: unknown,
  url: string,
): EmbeddingEndpointModel[] {
  const data = asRecord(payload)?.data;
  if (!Array.isArray(data)) {
    throw responseError(
      url,
      "OpenAI model list response is missing a `data` array",
    );
  }
  const models: EmbeddingEndpointModel[] = [];
  for (const entry of data) {
    const record = asRecord(entry);
    const id = typeof record?.id === "string" ? record.id : undefined;
    if (id === undefined || id.length === 0) continue;
    const ownedBy =
      typeof record?.owned_by === "string" ? record.owned_by : undefined;
    models.push(ownedBy === undefined ? { id } : { id, ownedBy });
  }
  if (models.length === 0) {
    throw responseError(
      url,
      "OpenAI model list response contained no model ids",
    );
  }
  return models;
}

function parseOllamaModels(
  payload: unknown,
  url: string,
): EmbeddingEndpointModel[] {
  const data = asRecord(payload)?.models;
  if (!Array.isArray(data)) {
    throw responseError(
      url,
      "Ollama tags response is missing a `models` array",
    );
  }
  const models: EmbeddingEndpointModel[] = [];
  for (const entry of data) {
    const record = asRecord(entry);
    const id =
      typeof record?.name === "string"
        ? record.name
        : typeof record?.model === "string"
          ? record.model
          : undefined;
    if (id === undefined || id.length === 0) continue;
    const family = asRecord(record?.details)?.family;
    models.push(typeof family === "string" ? { id, ownedBy: family } : { id });
  }
  if (models.length === 0) {
    throw responseError(url, "Ollama tags response contained no model names");
  }
  return models;
}

function parseOpenAiEmbeddings(payload: unknown, url: string): number[][] {
  const data = asRecord(payload)?.data;
  if (!Array.isArray(data)) {
    throw responseError(
      url,
      "OpenAI embeddings response is missing a `data` array",
    );
  }
  const entries = data.map((entry, position) => {
    const record = asRecord(entry);
    const index =
      typeof record?.index === "number" && Number.isInteger(record.index)
        ? record.index
        : position;
    return { index, vector: parseVector(record?.embedding, url) };
  });
  entries.sort((left, right) => left.index - right.index);
  return entries.map((entry) => entry.vector);
}

function parseOllamaEmbeddings(payload: unknown, url: string): number[][] {
  const data = asRecord(payload)?.embeddings;
  if (!Array.isArray(data)) {
    throw responseError(
      url,
      "Ollama embed response is missing an `embeddings` array",
    );
  }
  return data.map((entry) => parseVector(entry, url));
}

function vectorNorm(vector: ArrayLike<number>): number {
  let sum = 0;
  for (let index = 0; index < vector.length; index += 1) {
    const value = vector[index];
    if (value !== undefined) sum += value * value;
  }
  return Math.sqrt(sum);
}

function validateEmbeddingVector(
  vector: readonly number[],
  resolved: ResolvedEndpointOptions,
  url: string,
  position: number,
): Float32Array {
  const label = `Embedding ${position + 1}`;
  if (resolved.dimensions !== null && vector.length !== resolved.dimensions) {
    throw new EmbeddingEndpointError({
      kind: "dimension",
      message: `${label} has ${vector.length} dimensions but ${resolved.dimensions} were declared for model ${resolved.model}.`,
      url: sanitizeUrlForLog(url),
    });
  }
  const norm = vectorNorm(vector);
  if (Math.abs(norm - 1) > ENDPOINT_NORM_TOLERANCE) {
    throw new EmbeddingEndpointError({
      kind: "norm",
      message: `${label} has L2 norm ${norm.toFixed(4)}, outside 1±${ENDPOINT_NORM_TOLERANCE} (model ${resolved.model}).`,
      url: sanitizeUrlForLog(url),
    });
  }
  return Float32Array.from(vector);
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

function probeTcp(url: URL, timeoutMs: number): Promise<number> {
  const host = url.hostname.replace(/^\[/u, "").replace(/\]$/u, "");
  const port =
    url.port.length > 0
      ? Number.parseInt(url.port, 10)
      : url.protocol === "https:"
        ? 443
        : 80;
  const startedAt = Date.now();
  return new Promise<number>((resolve, reject) => {
    let settled = false;
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(timeoutEndpointError(url, timeoutMs));
    }, timeoutMs);
    const finish = () => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      return true;
    };
    socket.once("connect", () => {
      if (!finish()) return;
      const latencyMs = Date.now() - startedAt;
      socket.destroy();
      resolve(latencyMs);
    });
    socket.once("error", (error: Error) => {
      if (!finish()) return;
      socket.destroy();
      reject(shapeRequestError(error, url, [], 1));
    });
  });
}

async function runProbe(
  resolved: ResolvedEndpointOptions,
): Promise<EmbeddingEndpointProbe> {
  const latencyMs = await probeTcp(resolved.baseUrl, resolved.probeTimeoutMs);
  return {
    reachable: true,
    latencyMs,
    url: sanitizeUrlForLog(resolved.baseUrl),
  };
}

async function runList(
  resolved: ResolvedEndpointOptions,
): Promise<EmbeddingEndpointModels> {
  const url = modelsUrl(resolved);
  const payload = await requestEndpointJson(resolved, url, undefined);
  if (resolved.kind === "openai") {
    return { models: parseOpenAiModels(payload, url) };
  }
  const models = parseOllamaModels(payload, url);
  const version = await readOllamaVersion(resolved);
  return version === undefined ? { models } : { models, version };
}

/** Best effort: an older Ollama without `/api/version` still lists models. */
async function readOllamaVersion(
  resolved: ResolvedEndpointOptions,
): Promise<string | undefined> {
  try {
    const url = versionUrl(resolved);
    const payload = await requestEndpointJson(resolved, url, undefined);
    const version = asRecord(payload)?.version;
    return typeof version === "string" && version.length > 0
      ? version
      : undefined;
  } catch {
    return undefined;
  }
}

async function runEmbeddings(
  resolved: ResolvedEndpointOptions,
  texts: readonly string[],
  signal?: AbortSignal,
): Promise<readonly Float32Array[]> {
  if (texts.length === 0) return [];
  const url = embeddingsUrl(resolved);
  const payload = await requestEndpointJson(
    resolved,
    url,
    { model: resolved.model, input: [...texts] },
    signal,
  );
  const vectors =
    resolved.kind === "openai"
      ? parseOpenAiEmbeddings(payload, url)
      : parseOllamaEmbeddings(payload, url);
  if (vectors.length !== texts.length) {
    throw responseError(
      url,
      `Endpoint returned ${vectors.length} embedding(s) for ${texts.length} input(s)`,
    );
  }
  return vectors.map((vector, position) =>
    validateEmbeddingVector(vector, resolved, url, position),
  );
}

async function runTest(
  resolved: ResolvedEndpointOptions,
): Promise<EmbeddingEndpointTestResult> {
  const startedAt = Date.now();
  const vectors = await runEmbeddings(resolved, [ENDPOINT_TEST_INPUT]);
  const vector = vectors[0];
  if (vector === undefined) {
    throw responseError(
      modelsUrl(resolved),
      "Endpoint returned no test embedding",
    );
  }
  return {
    model: resolved.model,
    dimensions: vector.length,
    norm: vectorNorm(vector),
    latencyMs: Date.now() - startedAt,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** TCP reachability probe (default 400 ms). */
export async function probeEmbeddingEndpoint(
  options: EmbeddingEndpointOptions,
): Promise<EmbeddingEndpointProbe> {
  return await runProbe(resolveEndpointOptions(options));
}

/** List the endpoint's embedding models (plus the Ollama version, if any). */
export async function listEmbeddingEndpointModels(
  options: EmbeddingEndpointOptions,
): Promise<EmbeddingEndpointModels> {
  return await runList(resolveEndpointOptions(options));
}

/**
 * Send one test embedding and validate its dimension and L2 norm. The declared
 * `dimensions` is optional: omit it while the wizard is still discovering it.
 */
export async function testEmbeddingEndpoint(
  options: EmbeddingEndpointOptions,
): Promise<EmbeddingEndpointTestResult> {
  return await runTest(resolveEndpointOptions(options));
}

/**
 * Full wizard check: allow-list → probe → list → test embedding. Returns only
 * after the endpoint is proven usable; every failure is a typed error whose
 * message is already safe to render.
 */
export async function verifyEmbeddingEndpoint(
  options: EmbeddingEndpointOptions,
): Promise<EmbeddingEndpointVerification> {
  const resolved = resolveEndpointOptions(options);
  const probe = await runProbe(resolved);
  const listed = await runList(resolved);
  const tested = await runTest(resolved);
  return {
    ...tested,
    kind: resolved.kind,
    baseUrl: sanitizeUrlForLog(resolved.baseUrl),
    probeLatencyMs: probe.latencyMs,
    models: listed.models,
    ...(listed.version === undefined ? {} : { version: listed.version }),
    egress: true,
  };
}

/**
 * Create the long-lived client used at query time. The breaker counts failed
 * `embed` operations (after retries): three in a row open it, and the first
 * operation after the cooldown acts as the recovery probe.
 */
export function createEmbeddingEndpointClient(
  options: EmbeddingEndpointOptions,
): EmbeddingEndpointClient {
  const resolved = resolveEndpointOptions(options);
  let consecutiveFailures = 0;
  let state: EmbeddingEndpointCircuitState = "closed";
  let openUntil = 0;

  const circuitState = (): EmbeddingEndpointCircuitState => {
    if (state === "open" && resolved.now() >= openUntil) return "half-open";
    return state;
  };

  return {
    kind: resolved.kind,
    baseUrl: sanitizeUrlForLog(resolved.baseUrl),
    model: resolved.model,
    dimensions: resolved.dimensions,
    egress: true,
    probe: async () => await runProbe(resolved),
    listModels: async () => await runList(resolved),
    test: async () => await runTest(resolved),
    circuitState,
    resetCircuit: () => {
      consecutiveFailures = 0;
      state = "closed";
      openUntil = 0;
    },
    embed: async (texts, embedOptions) => {
      if (state === "open") {
        if (resolved.now() < openUntil) {
          throw new EmbeddingEndpointError({
            kind: "circuit-open",
            message: `Embedding endpoint circuit is open after ${consecutiveFailures} consecutive failure(s); falling back to lexical recall.`,
            url: sanitizeUrlForLog(resolved.baseUrl),
            attempts: 0,
          });
        }
        state = "half-open";
      }
      try {
        const vectors = await runEmbeddings(
          resolved,
          texts,
          embedOptions?.signal,
        );
        consecutiveFailures = 0;
        state = "closed";
        openUntil = 0;
        return vectors;
      } catch (error) {
        // A caller-side abort is the query-budget fallback, not an endpoint
        // failure: 48-1 §6.9 says an encode that overruns its budget degrades
        // this turn and is not counted by the breaker. Counting it would let
        // three merely slow turns disable the vector arm.
        if (isEmbeddingEndpointError(error) && error.kind === "aborted") {
          throw error;
        }
        consecutiveFailures += 1;
        if (
          state === "half-open" ||
          consecutiveFailures >= resolved.breakerThreshold
        ) {
          state = "open";
          openUntil = resolved.now() + resolved.breakerCooldownMs;
        }
        throw error;
      }
    },
  };
}
