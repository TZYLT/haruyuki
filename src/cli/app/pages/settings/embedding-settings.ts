// src/cli/app/pages/settings/embedding-settings.ts

import {
  type EmbeddingCalibrationSettings,
  type EmbeddingEndpointSettings,
  isEmbeddingBackendKind,
  isEmbeddingEndpointKind,
  isEmbeddingGpuRole,
  isEmbeddingQuantization,
  type ResolvedEmbeddingSettings,
  readEmbeddingSettings,
  resolveEmbeddingCalibration,
  resolveEmbeddingEndpoint,
} from "@/recall-settings";
import { type Settings, settingsManager } from "@/settings-manager";
import type {
  EmbeddingBackendKind,
  EmbeddingGpuRole,
  EmbeddingQuantization,
} from "@/types/embedding-protocol";

/**
 * Feature ③'s single settings writer (48-2 §3.4 D3, 48-1 §8.1).
 *
 * Every surface — the settings rows, the wizard, `/recall embedding`, the CLI
 * and the protocol handler — must persist through {@link updateEmbeddingSettings}
 * rather than calling `settingsManager.updateSettings` itself. Two reasons:
 *
 * - **One validator.** A chunk plan is only runnable while `max ≥ target` and
 *   `overlap < target`; a weight is only meaningful in `[0, 1]`. Splitting that
 *   across call sites is how a page writes a state the chunker then refuses.
 * - **One key map.** The settings keys (`recallEmbedding*`, 48-1 §8.1) and the
 *   resolved field names differ slightly; keeping the translation here means a
 *   new knob cannot be persisted under a typo'd key.
 *
 * A rejected patch throws {@link EmbeddingSettingsError} with an actionable
 * message; nothing is written. The page's error note and the command's reply
 * both print `error.message` as-is.
 */

/** A partial update, in resolved (camelCase) field names. */
export interface EmbeddingSettingsPatch {
  enabled?: boolean;
  backend?: EmbeddingBackendKind;
  model?: string;
  endpoint?: EmbeddingEndpointSettings | null;
  weight?: number;
  candidateDepth?: number;
  chunkTarget?: number;
  chunkMax?: number;
  chunkOverlap?: number;
  maxChunksPerMessage?: number;
  threads?: number;
  gpu?: EmbeddingGpuRole;
  quantization?: EmbeddingQuantization;
  calibration?: EmbeddingCalibrationSettings | null;
  keepSpaces?: number;
}

/** Thrown when a patch cannot be persisted; the message is user-facing. */
export class EmbeddingSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingSettingsError";
  }
}

/** Longest model id the settings store accepts. */
export const EMBEDDING_MODEL_MAX_LENGTH = 128;

const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** `recallEmbeddingWeight`, `recallEmbeddingChunkTarget`, … are written by this map. */
const STORED_KEYS: Record<
  Exclude<keyof EmbeddingSettingsPatch, "enabled">,
  | "recallEmbeddingBackend"
  | "recallEmbeddingModel"
  | "recallEmbeddingEndpoint"
  | "recallEmbeddingWeight"
  | "recallEmbeddingCandidateDepth"
  | "recallEmbeddingChunkTarget"
  | "recallEmbeddingChunkMax"
  | "recallEmbeddingChunkOverlap"
  | "recallEmbeddingMaxChunksPerMessage"
  | "recallEmbeddingThreads"
  | "recallEmbeddingGpu"
  | "recallEmbeddingQuantization"
  | "recallEmbeddingCalibration"
  | "recallEmbeddingKeepSpaces"
> = {
  backend: "recallEmbeddingBackend",
  model: "recallEmbeddingModel",
  endpoint: "recallEmbeddingEndpoint",
  weight: "recallEmbeddingWeight",
  candidateDepth: "recallEmbeddingCandidateDepth",
  chunkTarget: "recallEmbeddingChunkTarget",
  chunkMax: "recallEmbeddingChunkMax",
  chunkOverlap: "recallEmbeddingChunkOverlap",
  maxChunksPerMessage: "recallEmbeddingMaxChunksPerMessage",
  threads: "recallEmbeddingThreads",
  gpu: "recallEmbeddingGpu",
  quantization: "recallEmbeddingQuantization",
  calibration: "recallEmbeddingCalibration",
  keepSpaces: "recallEmbeddingKeepSpaces",
};

/**
 * The patch keys that change the chunk plan or the vector space. Changing any of
 * them means the stored spaces no longer match the settings (48-1 §8.1: a
 * chunk-window change is a chunker-version change), so the caller must offer a
 * rebuild rather than pretend a hot-swap happened.
 */
const SPACE_SHAPING_KEYS = [
  "backend",
  "model",
  "endpoint",
  "quantization",
  "chunkTarget",
  "chunkMax",
  "chunkOverlap",
] as const satisfies readonly (keyof EmbeddingSettingsPatch)[];

/** Whether applying this patch invalidates the stored vector spaces. */
export function embeddingPatchInvalidatesSpace(
  patch: EmbeddingSettingsPatch,
): boolean {
  return SPACE_SHAPING_KEYS.some((key) => patch[key] !== undefined);
}

/** A model id the page may type: non-empty, bounded, no whitespace. */
export function validateEmbeddingModelInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "needs a model id";
  if (trimmed.length > EMBEDDING_MODEL_MAX_LENGTH) {
    return `must be at most ${EMBEDDING_MODEL_MAX_LENGTH} characters`;
  }
  if (!MODEL_PATTERN.test(trimmed)) {
    return "use letters, digits, '.', '_', ':', '/' or '-'";
  }
  return null;
}

/**
 * 48-2 §4.6's endpoint gate: `https`, or plain `http` only for a loopback
 * address, and never with embedded credentials (they would be logged by a proxy
 * before the key store could redact them).
 */
function validateEndpointBaseUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "needs an absolute http(s) URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "needs an http(s) URL";
  }
  if (url.username.length > 0 || url.password.length > 0) {
    return "must not embed credentials; the API key is stored separately";
  }
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    return "plain http is only allowed for a loopback endpoint";
  }
  return null;
}

function checkInteger(
  name: string,
  value: unknown,
  min: number,
  max: number,
): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return `${name} needs a number`;
  }
  if (!Number.isInteger(value)) return `${name} needs a whole number`;
  if (value < min || value > max) {
    return `${name} must be between ${min} and ${max}`;
  }
  return null;
}

function validateEndpoint(value: EmbeddingEndpointSettings): string | null {
  if (!isEmbeddingEndpointKind(value.kind)) {
    return "endpoint kind must be openai or ollama";
  }
  if (typeof value.baseUrl !== "string") return "endpoint needs a base URL";
  const urlError = validateEndpointBaseUrl(value.baseUrl);
  if (urlError !== null) return urlError;
  const modelError = validateEmbeddingModelInput(value.model);
  if (modelError !== null) return `endpoint model ${modelError}`;
  const dimensionsError = checkInteger(
    "endpoint dimensions",
    value.dimensions,
    1,
    65_536,
  );
  if (dimensionsError !== null) return dimensionsError;
  if (value.timeoutMs !== undefined) {
    const timeoutError = checkInteger(
      "endpoint timeout",
      value.timeoutMs,
      100,
      600_000,
    );
    if (timeoutError !== null) return timeoutError;
  }
  return null;
}

function validateCalibration(
  value: EmbeddingCalibrationSettings,
): string | null {
  if (
    typeof value.fingerprint !== "string" ||
    value.fingerprint.trim() === ""
  ) {
    return "calibration needs a fingerprint";
  }
  if (typeof value.measuredAt !== "string" || value.measuredAt.trim() === "") {
    return "calibration needs a measured time";
  }
  for (const [name, field] of [
    ["p50", value.queryLatencyP50Ms],
    ["p90", value.queryLatencyP90Ms],
    ["throughput", value.batchThroughputPerSec],
  ] as const) {
    if (typeof field !== "number" || !Number.isFinite(field) || field < 0) {
      return `calibration ${name} must be a non-negative number`;
    }
  }
  if (!isEmbeddingGpuRole(value.gpuRole)) {
    return "calibration gpu role must be auto, off or index-only";
  }
  const threadsError = checkInteger(
    "calibration threads",
    value.threads,
    0,
    256,
  );
  if (threadsError !== null) return threadsError;
  if (!isEmbeddingQuantization(value.quantization)) {
    return "calibration quantization must be float32 or int8";
  }
  return null;
}

/** The settings a patch would produce, without writing anything. */
export function previewEmbeddingSettings(
  patch: EmbeddingSettingsPatch,
  current: ResolvedEmbeddingSettings = readEmbeddingSettings(),
): ResolvedEmbeddingSettings {
  return {
    enabled: patch.enabled ?? current.enabled,
    backend: patch.backend ?? current.backend,
    model: patch.model ?? current.model,
    endpoint: patch.endpoint !== undefined ? patch.endpoint : current.endpoint,
    weight: patch.weight ?? current.weight,
    candidateDepth: patch.candidateDepth ?? current.candidateDepth,
    chunkTarget: patch.chunkTarget ?? current.chunkTarget,
    chunkMax: patch.chunkMax ?? current.chunkMax,
    chunkOverlap: patch.chunkOverlap ?? current.chunkOverlap,
    maxChunksPerMessage:
      patch.maxChunksPerMessage ?? current.maxChunksPerMessage,
    threads: patch.threads ?? current.threads,
    gpu: patch.gpu ?? current.gpu,
    quantization: patch.quantization ?? current.quantization,
    calibration:
      patch.calibration !== undefined ? patch.calibration : current.calibration,
    keepSpaces: patch.keepSpaces ?? current.keepSpaces,
  };
}

/**
 * Validate a patch against the current settings; returns the first error or
 * `null`. Exported so tests and command handlers can refuse a value without
 * building a throw/catch path.
 */
export function validateEmbeddingSettingsPatch(
  patch: EmbeddingSettingsPatch,
  current: ResolvedEmbeddingSettings = readEmbeddingSettings(),
): string | null {
  if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") {
    return "enabled needs true or false";
  }
  if (patch.backend !== undefined && !isEmbeddingBackendKind(patch.backend)) {
    return "backend must be builtin or endpoint";
  }
  if (patch.model !== undefined) {
    if (typeof patch.model !== "string") return "model needs a model id";
    const modelError = validateEmbeddingModelInput(patch.model);
    if (modelError !== null) return modelError;
  }
  if (patch.endpoint !== undefined && patch.endpoint !== null) {
    const endpointError = validateEndpoint(patch.endpoint);
    if (endpointError !== null) return endpointError;
  }
  if (patch.weight !== undefined) {
    if (
      typeof patch.weight !== "number" ||
      !Number.isFinite(patch.weight) ||
      patch.weight < 0 ||
      patch.weight > 1
    ) {
      return "weight must be between 0 and 1";
    }
  }
  const integerChecks: ReadonlyArray<
    readonly [string, keyof EmbeddingSettingsPatch, number, number]
  > = [
    ["candidate depth", "candidateDepth", 1, 1_000],
    ["chunk target", "chunkTarget", 1, 4_096],
    ["chunk max", "chunkMax", 1, 4_096],
    ["chunk overlap", "chunkOverlap", 0, 4_096],
    ["max chunks per message", "maxChunksPerMessage", 1, 1_024],
    ["threads", "threads", 0, 256],
    ["keep spaces", "keepSpaces", 1, 16],
  ];
  for (const [name, key, min, max] of integerChecks) {
    const value = patch[key];
    if (value === undefined) continue;
    const integerError = checkInteger(name, value, min, max);
    if (integerError !== null) return integerError;
  }
  if (patch.gpu !== undefined && !isEmbeddingGpuRole(patch.gpu)) {
    return "gpu must be auto, off or index-only";
  }
  if (
    patch.quantization !== undefined &&
    !isEmbeddingQuantization(patch.quantization)
  ) {
    return "quantization must be float32 or int8";
  }
  if (patch.calibration !== undefined && patch.calibration !== null) {
    const calibrationError = validateCalibration(patch.calibration);
    if (calibrationError !== null) return calibrationError;
  }

  // Cross-field: the plan the patch would produce must be runnable.
  const next = previewEmbeddingSettings(patch, current);
  if (next.chunkMax < next.chunkTarget) {
    return "chunk max must be at least the chunk target";
  }
  if (next.chunkOverlap >= next.chunkTarget) {
    return "chunk overlap must be smaller than the chunk target";
  }
  return null;
}

/** The `settingsManager.updateSettings` record for the keys this patch sets. */
function storedUpdates(patch: EmbeddingSettingsPatch): Partial<Settings> {
  const updates: Partial<Settings> = {};
  // The stored names are a single table, so the computed-key write needs one
  // widening cast: TypeScript cannot index a partial interface by a key union.
  const stored = updates as Record<string, unknown>;
  if (patch.enabled !== undefined)
    stored.recallEmbeddingEnabled = patch.enabled;
  if (patch.backend !== undefined) {
    stored[STORED_KEYS.backend] = patch.backend;
  }
  if (patch.model !== undefined) {
    stored[STORED_KEYS.model] = patch.model.trim();
  }
  if (patch.endpoint !== undefined) {
    stored[STORED_KEYS.endpoint] =
      patch.endpoint === null ? null : resolveEmbeddingEndpoint(patch.endpoint);
  }
  if (patch.weight !== undefined) stored[STORED_KEYS.weight] = patch.weight;
  if (patch.candidateDepth !== undefined) {
    stored[STORED_KEYS.candidateDepth] = patch.candidateDepth;
  }
  if (patch.chunkTarget !== undefined) {
    stored[STORED_KEYS.chunkTarget] = patch.chunkTarget;
  }
  if (patch.chunkMax !== undefined) {
    stored[STORED_KEYS.chunkMax] = patch.chunkMax;
  }
  if (patch.chunkOverlap !== undefined) {
    stored[STORED_KEYS.chunkOverlap] = patch.chunkOverlap;
  }
  if (patch.maxChunksPerMessage !== undefined) {
    stored[STORED_KEYS.maxChunksPerMessage] = patch.maxChunksPerMessage;
  }
  if (patch.threads !== undefined) stored[STORED_KEYS.threads] = patch.threads;
  if (patch.gpu !== undefined) stored[STORED_KEYS.gpu] = patch.gpu;
  if (patch.quantization !== undefined) {
    stored[STORED_KEYS.quantization] = patch.quantization;
  }
  if (patch.calibration !== undefined) {
    stored[STORED_KEYS.calibration] =
      patch.calibration === null
        ? null
        : resolveEmbeddingCalibration(patch.calibration);
  }
  if (patch.keepSpaces !== undefined) {
    stored[STORED_KEYS.keepSpaces] = patch.keepSpaces;
  }
  return updates;
}

/**
 * Persist one embedding-settings patch and return the settings as stored.
 *
 * Throws {@link EmbeddingSettingsError} when the patch is unusable; nothing is
 * written in that case, so a rejected row leaves the previous value in force.
 */
export function updateEmbeddingSettings(
  patch: EmbeddingSettingsPatch,
): ResolvedEmbeddingSettings {
  const error = validateEmbeddingSettingsPatch(patch);
  if (error !== null) throw new EmbeddingSettingsError(error);
  settingsManager.updateSettings(storedUpdates(patch));
  return readEmbeddingSettings();
}
