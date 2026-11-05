/**
 * Feature ②'s tunables (《26》§6.9).
 *
 * The knobs are read from three layers — the reminder provider in `reminders/`,
 * the `/recall` command in `cli/`, and the CLI subcommand — so they are resolved
 * here, once, instead of each reader re-deriving them from raw settings.
 *
 * They live in this module rather than in `settings-manager.ts` because that file
 * is pinned exactly at its size baseline (it may only shrink). The keys are
 * declared on `Settings` by module augmentation below, so `updateSettings` stays
 * typed and the generic settings path — load, persist, defaults — needs no
 * per-key code. `topic-settings.ts` is the same shape.
 *
 * Scope: **global**, by the user's ruling (《26》§10.2 item 7), and for the same
 * reason the topic knobs are: the provider runs on the turn path, where there is
 * no project scope to read, so a per-project override could not be honoured
 * consistently. Adding the three-level form later means the three interfaces plus
 * the collision routing that `AGENTS.md` lists.
 */

import {
  isRecallDisplay,
  RECALL_DISPLAY_DEFAULT,
  type RecallDisplay,
} from "@/reminders/recall-display";
import {
  isRecallDiversity,
  RECALL_DEFAULTS,
  type RecallDiversity,
  type RecallOptions,
} from "@/reminders/recall-port";
import { settingsManager } from "@/settings-manager";
import type {
  EmbeddingBackendKind,
  EmbeddingEndpointKind,
  EmbeddingGpuRole,
  EmbeddingQuantization,
} from "@/types/embedding-protocol";

declare module "@/settings-manager" {
  interface Settings {
    /** Feature ② off means "never search", not "search and hide". */
    recallEnabled?: boolean;
    /** Wall-clock budget per turn in ms. `0` = no budget. */
    recallTimeoutMs?: number;
    /** User turns a recalled passage stays suppressed for. `0` = no window. */
    recallDedupTurns?: number;
    /** Passages injected per turn, across both sources. */
    recallLimit?: number;
    /** Characters kept per passage before truncation. */
    recallExcerptCharacters?: number;
    /** Hard ceiling on the injected excerpt text. */
    recallTotalCharacters?: number;
    /** Relative score floor, as a share of the best surviving score. */
    recallMinScoreRatio?: number;
    /** How the slots are shared out; see `RecallDiversity`. */
    recallDiversity?: RecallDiversity;
    /** Memory context: lines on each side of the hit line. */
    recallExcerptLines?: number;
    /** How much of an injected block the transcript shows. */
    recallDisplay?: RecallDisplay;

    // Feature ③ (48-1 §8.1). Separate from `recallEnabled`: turning passive
    // recall off must not silently stop the vector index or its build status.
    /** Vector recall master switch; default off, only `true` turns it on. */
    recallEmbeddingEnabled?: boolean;
    /** Where query vectors come from: a bundled model or an external endpoint. */
    recallEmbeddingBackend?: EmbeddingBackendKind;
    /** Model id; the default is the small Chinese model (48-1 §5.2). */
    recallEmbeddingModel?: string;
    /** Endpoint form values; the API key is stored by the secrets store instead. */
    recallEmbeddingEndpoint?: EmbeddingEndpointSettings | null;
    /** Vector-arm weight in `[0, 1]`; `0` = lexical only. */
    recallEmbeddingWeight?: number;
    /** Per-arm candidate depth; both arms are always equal (P-02). */
    recallEmbeddingCandidateDepth?: number;
    /** Target chunk window in estimated tokens (R-29). */
    recallEmbeddingChunkTarget?: number;
    /** Hard chunk ceiling in estimated tokens (R-29). */
    recallEmbeddingChunkMax?: number;
    /** Chunk overlap in estimated tokens (R-29). */
    recallEmbeddingChunkOverlap?: number;
    /** Hard valve: chunks embedded per message (R-29). */
    recallEmbeddingMaxChunksPerMessage?: number;
    /** Build/encode threads; `0` = automatic. */
    recallEmbeddingThreads?: number;
    /** GPU role; `index-only` is the only permitted role (48-1 §5.3). */
    recallEmbeddingGpu?: EmbeddingGpuRole;
    /** Vector storage precision; `int8` is stage ③ (48-2 §4.10). */
    recallEmbeddingQuantization?: EmbeddingQuantization;
    /** Cached bounded-calibration result; re-measured when the fingerprint moves. */
    recallEmbeddingCalibration?: EmbeddingCalibrationSettings | null;
    /** Model spaces kept on disk; older ones are reclaimed (48-1 §6.3). */
    recallEmbeddingKeepSpaces?: number;
  }
}

export type RecallSettingKey =
  | "recallEnabled"
  | "recallTimeoutMs"
  | "recallDedupTurns"
  | "recallLimit"
  | "recallExcerptCharacters"
  | "recallTotalCharacters"
  | "recallMinScoreRatio"
  | "recallDiversity"
  | "recallExcerptLines"
  | "recallDisplay";

/** Every knob resolved; the shape the rest of the app consumes. */
export interface ResolvedRecallSettings {
  enabled: boolean;
  timeoutMs: number;
  dedupTurns: number;
  limit: number;
  excerptCharacters: number;
  totalCharacters: number;
  minScoreRatio: number;
  diversity: RecallDiversity;
  excerptLines: number;
  display: RecallDisplay;
}

export const RECALL_SETTING_DEFAULTS: ResolvedRecallSettings = {
  enabled: true,
  timeoutMs: RECALL_DEFAULTS.timeoutMs,
  dedupTurns: RECALL_DEFAULTS.dedupTurns,
  limit: RECALL_DEFAULTS.limit,
  excerptCharacters: RECALL_DEFAULTS.excerptCharacters,
  totalCharacters: RECALL_DEFAULTS.totalCharacters,
  minScoreRatio: RECALL_DEFAULTS.minScoreRatio,
  diversity: RECALL_DEFAULTS.diversity,
  excerptLines: RECALL_DEFAULTS.excerptLines,
  display: RECALL_DISPLAY_DEFAULT,
};

/**
 * A count: `undefined` or unusable falls back to the default, `0` is kept
 * because for every count here it means "off" rather than "unset".
 */
function resolveCount(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.trunc(value);
}

export function resolveRecallSettings(
  record: Partial<Record<RecallSettingKey, unknown>> | undefined,
): ResolvedRecallSettings {
  if (!record) return { ...RECALL_SETTING_DEFAULTS };
  const diversity = record.recallDiversity;
  const display = record.recallDisplay;
  return {
    // Only an explicit `false` switches recall off: a hand-edited settings file
    // with `"false"` (or anything else non-boolean) must not silently disable a
    // feature the user never turned off.
    enabled: record.recallEnabled !== false,
    timeoutMs: resolveCount(
      record.recallTimeoutMs,
      RECALL_SETTING_DEFAULTS.timeoutMs,
    ),
    dedupTurns: resolveCount(
      record.recallDedupTurns,
      RECALL_SETTING_DEFAULTS.dedupTurns,
    ),
    limit: resolveCount(record.recallLimit, RECALL_SETTING_DEFAULTS.limit),
    excerptCharacters: resolveCount(
      record.recallExcerptCharacters,
      RECALL_SETTING_DEFAULTS.excerptCharacters,
    ),
    totalCharacters: resolveCount(
      record.recallTotalCharacters,
      RECALL_SETTING_DEFAULTS.totalCharacters,
    ),
    // `[0, 1]` rather than `>= 0`: above 1 no score can clear the floor, so the
    // feature would search every turn and silently never inject — a state
    // `/recall ratio` refuses to write, and a reader must not accept what its own
    // writer will not produce.
    minScoreRatio:
      typeof record.recallMinScoreRatio === "number" &&
      Number.isFinite(record.recallMinScoreRatio) &&
      record.recallMinScoreRatio >= 0 &&
      record.recallMinScoreRatio <= 1
        ? record.recallMinScoreRatio
        : RECALL_SETTING_DEFAULTS.minScoreRatio,
    diversity: isRecallDiversity(diversity)
      ? diversity
      : RECALL_SETTING_DEFAULTS.diversity,
    excerptLines: resolveCount(
      record.recallExcerptLines,
      RECALL_SETTING_DEFAULTS.excerptLines,
    ),
    display: isRecallDisplay(display)
      ? display
      : RECALL_SETTING_DEFAULTS.display,
  };
}

/**
 * The knobs as the search itself wants them.
 *
 * `candidateLimit` and `neighbors` are not user-facing (no command reaches
 * them), so they stay at the port defaults — but they travel with the rest so
 * this is the single place that builds a full option record.
 */
export function recallOptionsFromSettings(
  settings: ResolvedRecallSettings,
): RecallOptions {
  return {
    ...RECALL_DEFAULTS,
    limit: settings.limit,
    excerptCharacters: settings.excerptCharacters,
    totalCharacters: settings.totalCharacters,
    minScoreRatio: settings.minScoreRatio,
    diversity: settings.diversity,
    excerptLines: settings.excerptLines,
    dedupTurns: settings.dedupTurns,
    timeoutMs: settings.timeoutMs,
  };
}

/**
 * The knobs as configured. Settings unavailable (early startup, tests without an
 * initialized manager) falls back to the defaults rather than throwing: every
 * reader runs on a path that must not fail because of a preference.
 */
export function readRecallSettings(): ResolvedRecallSettings {
  try {
    return resolveRecallSettings(settingsManager.getSettings());
  } catch {
    return { ...RECALL_SETTING_DEFAULTS };
  }
}

/**
 * One line naming every effective knob.
 *
 * Lives here rather than beside a caller because three surfaces print it — the
 * `/recall` receipt, the settings picker, and `/recall status` — and they are in
 * two layers: the reminders layer may not import a CLI command module, so a line
 * they share has to sit below both. This is also the only place that resolves the
 * knobs, so it is the only place that can describe them without a second opinion.
 */
export function formatRecallSettingsLine(
  settings: ResolvedRecallSettings,
): string {
  return `limit ${settings.limit} · excerpt ${settings.excerptCharacters}/${settings.totalCharacters} chars · ratio ${settings.minScoreRatio} · diversity ${settings.diversity} · dedup ${settings.dedupTurns} turns · timeout ${
    settings.timeoutMs === 0 ? "none" : `${settings.timeoutMs}ms`
  } · display ${settings.display}`;
}

// ── Feature ③: vector-recall tunables (48-1 §8.1, 48-2 §3.4 D3) ─────────
//
// Same contract as the recall knobs above: the keys are declared on `Settings`
// by module augmentation (never in the pinned `settings-manager.ts`), they are
// global-only, and every reader goes through one resolver so an unreadable value
// cannot be interpreted two ways. The writer is
// `cli/app/pages/settings/embedding-settings.ts`; nothing else may persist these.

/** Endpoint form values; `apiKey` is stored by the secrets store, never here. */
export interface EmbeddingEndpointSettings {
  kind: EmbeddingEndpointKind;
  baseUrl: string;
  model: string;
  dimensions: number;
  /** Request timeout in ms; omitted = {@link EMBEDDING_ENDPOINT_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** The bounded calibration result kept in settings (48-2 §4.5). */
export interface EmbeddingCalibrationSettings {
  fingerprint: string;
  measuredAt: string;
  queryLatencyP50Ms: number;
  queryLatencyP90Ms: number;
  batchThroughputPerSec: number;
  gpuRole: EmbeddingGpuRole;
  threads: number;
  quantization: EmbeddingQuantization;
}

/** Every embedding knob resolved; the shape readers consume. */
export interface ResolvedEmbeddingSettings {
  enabled: boolean;
  backend: EmbeddingBackendKind;
  model: string;
  endpoint: EmbeddingEndpointSettings | null;
  weight: number;
  candidateDepth: number;
  chunkTarget: number;
  chunkMax: number;
  chunkOverlap: number;
  maxChunksPerMessage: number;
  threads: number;
  gpu: EmbeddingGpuRole;
  quantization: EmbeddingQuantization;
  calibration: EmbeddingCalibrationSettings | null;
  keepSpaces: number;
}

/** The stored key names, so a writer cannot miss or rename one by typo. */
export type EmbeddingSettingKey =
  | "recallEmbeddingEnabled"
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
  | "recallEmbeddingKeepSpaces";

/**
 * The requirement's defaults (48-1 §8.1). `enabled` is **false**: enabling
 * downloads weights and builds an index, so only an explicit `true` may turn it
 * on — a hand-edited settings file must not start that work by accident.
 */
export const EMBEDDING_SETTING_DEFAULTS: ResolvedEmbeddingSettings = {
  enabled: false,
  backend: "builtin",
  model: "bge-small-zh-v1.5",
  endpoint: null,
  weight: 0.5,
  candidateDepth: 50,
  chunkTarget: 200,
  chunkMax: 256,
  chunkOverlap: 32,
  maxChunksPerMessage: 1024,
  threads: 0,
  gpu: "auto",
  quantization: "float32",
  calibration: null,
  keepSpaces: 2,
};

export const EMBEDDING_SETTING_KEYS: readonly EmbeddingSettingKey[] = [
  "recallEmbeddingEnabled",
  "recallEmbeddingBackend",
  "recallEmbeddingModel",
  "recallEmbeddingEndpoint",
  "recallEmbeddingWeight",
  "recallEmbeddingCandidateDepth",
  "recallEmbeddingChunkTarget",
  "recallEmbeddingChunkMax",
  "recallEmbeddingChunkOverlap",
  "recallEmbeddingMaxChunksPerMessage",
  "recallEmbeddingThreads",
  "recallEmbeddingGpu",
  "recallEmbeddingQuantization",
  "recallEmbeddingCalibration",
  "recallEmbeddingKeepSpaces",
];

/** Endpoint timeout when the stored form carries none. */
export const EMBEDDING_ENDPOINT_TIMEOUT_MS = 10_000;

const EMBEDDING_BACKENDS: readonly EmbeddingBackendKind[] = [
  "builtin",
  "endpoint",
];
const EMBEDDING_ENDPOINT_KINDS: readonly EmbeddingEndpointKind[] = [
  "openai",
  "ollama",
];
const EMBEDDING_GPU_ROLES: readonly EmbeddingGpuRole[] = [
  "auto",
  "off",
  "index-only",
];
const EMBEDDING_QUANTIZATIONS: readonly EmbeddingQuantization[] = [
  "float32",
  "int8",
];

export function isEmbeddingBackendKind(
  value: unknown,
): value is EmbeddingBackendKind {
  return (
    typeof value === "string" &&
    (EMBEDDING_BACKENDS as readonly string[]).includes(value)
  );
}

export function isEmbeddingEndpointKind(
  value: unknown,
): value is EmbeddingEndpointKind {
  return (
    typeof value === "string" &&
    (EMBEDDING_ENDPOINT_KINDS as readonly string[]).includes(value)
  );
}

export function isEmbeddingGpuRole(value: unknown): value is EmbeddingGpuRole {
  return (
    typeof value === "string" &&
    (EMBEDDING_GPU_ROLES as readonly string[]).includes(value)
  );
}

export function isEmbeddingQuantization(
  value: unknown,
): value is EmbeddingQuantization {
  return (
    typeof value === "string" &&
    (EMBEDDING_QUANTIZATIONS as readonly string[]).includes(value)
  );
}

function normalizeGpuRole(role: EmbeddingGpuRole): EmbeddingGpuRole {
  return role === "index-only" ? "auto" : role;
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === "string" &&
    (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function integerSetting(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const rounded = Math.trunc(value);
  return rounded < min || rounded > max ? fallback : rounded;
}

function unitInterval(value: unknown, fallback: number): number {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
    ? value
    : fallback;
}

function modelId(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 128 && !/\s/.test(trimmed)
    ? trimmed
    : fallback;
}

function nonNegativeNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

/**
 * Normalize the stored endpoint form. A half-written endpoint (a dangling URL,
 * no model, a non-positive dimension) is `null` rather than a guess: half an
 * endpoint would fail at query time, and the reader must not promise otherwise.
 */
export function resolveEmbeddingEndpoint(
  value: unknown,
): EmbeddingEndpointSettings | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (!isEmbeddingEndpointKind(record.kind)) return null;
  const baseUrl =
    typeof record.baseUrl === "string" ? record.baseUrl.trim() : "";
  if (baseUrl.length === 0) return null;
  const model = modelId(record.model, "");
  if (model.length === 0) return null;
  const dimensions = integerSetting(record.dimensions, 0, 1, 65_536);
  if (dimensions === 0) return null;
  return {
    kind: record.kind,
    baseUrl,
    model,
    dimensions,
    timeoutMs: integerSetting(
      record.timeoutMs,
      EMBEDDING_ENDPOINT_TIMEOUT_MS,
      100,
      600_000,
    ),
  };
}

/** Normalize a stored calibration result; an incomplete one is `null`. */
export function resolveEmbeddingCalibration(
  value: unknown,
): EmbeddingCalibrationSettings | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const fingerprint =
    typeof record.fingerprint === "string" ? record.fingerprint.trim() : "";
  const measuredAt =
    typeof record.measuredAt === "string" ? record.measuredAt.trim() : "";
  if (fingerprint.length === 0 || measuredAt.length === 0) return null;
  return {
    fingerprint,
    measuredAt,
    queryLatencyP50Ms: nonNegativeNumber(record.queryLatencyP50Ms, 0),
    queryLatencyP90Ms: nonNegativeNumber(record.queryLatencyP90Ms, 0),
    batchThroughputPerSec: nonNegativeNumber(record.batchThroughputPerSec, 0),
    gpuRole: oneOf(record.gpuRole, EMBEDDING_GPU_ROLES, "auto"),
    threads: integerSetting(record.threads, 0, 0, 256),
    quantization: oneOf(
      record.quantization,
      EMBEDDING_QUANTIZATIONS,
      "float32",
    ),
  };
}

/**
 * The knobs as stored, with every unusable value replaced by its default.
 *
 * The chunk window is resolved as a set: `max < target` or `overlap >= target`
 * describes a plan no chunker can run, so both fall back together instead of
 * leaving the reader to pick which half to believe.
 */
export function resolveEmbeddingSettings(
  record: Partial<Record<EmbeddingSettingKey, unknown>> | undefined,
): ResolvedEmbeddingSettings {
  const defaults = EMBEDDING_SETTING_DEFAULTS;
  if (!record) return { ...defaults };
  const chunkTarget = integerSetting(
    record.recallEmbeddingChunkTarget,
    defaults.chunkTarget,
    1,
    4_096,
  );
  const chunkMax = integerSetting(
    record.recallEmbeddingChunkMax,
    defaults.chunkMax,
    1,
    4_096,
  );
  const chunkOverlap = integerSetting(
    record.recallEmbeddingChunkOverlap,
    defaults.chunkOverlap,
    0,
    4_096,
  );
  const chunksConsistent =
    chunkMax >= chunkTarget && chunkOverlap < chunkTarget;
  return {
    enabled: record.recallEmbeddingEnabled === true,
    backend: oneOf(
      record.recallEmbeddingBackend,
      EMBEDDING_BACKENDS,
      defaults.backend,
    ),
    model: modelId(record.recallEmbeddingModel, defaults.model),
    endpoint: resolveEmbeddingEndpoint(record.recallEmbeddingEndpoint),
    weight: unitInterval(record.recallEmbeddingWeight, defaults.weight),
    candidateDepth: integerSetting(
      record.recallEmbeddingCandidateDepth,
      defaults.candidateDepth,
      1,
      1_000,
    ),
    chunkTarget: chunksConsistent ? chunkTarget : defaults.chunkTarget,
    chunkMax: chunksConsistent ? chunkMax : defaults.chunkMax,
    chunkOverlap: chunksConsistent ? chunkOverlap : defaults.chunkOverlap,
    maxChunksPerMessage: integerSetting(
      record.recallEmbeddingMaxChunksPerMessage,
      defaults.maxChunksPerMessage,
      1,
      1_024,
    ),
    threads: integerSetting(
      record.recallEmbeddingThreads,
      defaults.threads,
      0,
      256,
    ),
    // 48-4 D-01: the UI only offers `auto | off`. `index-only` was the same
    // behaviour as `auto` in every code path, so an old value is read as `auto`.
    gpu: normalizeGpuRole(
      oneOf(record.recallEmbeddingGpu, EMBEDDING_GPU_ROLES, defaults.gpu),
    ),
    quantization: oneOf(
      record.recallEmbeddingQuantization,
      EMBEDDING_QUANTIZATIONS,
      defaults.quantization,
    ),
    calibration: resolveEmbeddingCalibration(record.recallEmbeddingCalibration),
    keepSpaces: integerSetting(
      record.recallEmbeddingKeepSpaces,
      defaults.keepSpaces,
      1,
      16,
    ),
  };
}

/**
 * The knobs as configured. Settings unavailable (early startup, tests without an
 * initialized manager) falls back to the defaults rather than throwing: a
 * settings-page row or a status surface must not fail because of a preference.
 */
export function readEmbeddingSettings(): ResolvedEmbeddingSettings {
  try {
    return resolveEmbeddingSettings(settingsManager.getSettings());
  } catch {
    return { ...EMBEDDING_SETTING_DEFAULTS };
  }
}
