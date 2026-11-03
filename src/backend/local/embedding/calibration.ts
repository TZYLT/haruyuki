/**
 * Embedding calibration and GPU gating (C5, 48-2 §3.3 / §4.5).
 *
 * **Why this module is pure logic.** Calibration runs once per hardware/runtime
 * fingerprint inside a hard wall-clock budget (48-1 §6.6: ≤5 s), and its result
 * is cached in settings (`recallEmbeddingCalibration`, D3) and re-used by the
 * worker launcher (C8) and the build runner (A3). Every actual measurement is
 * therefore supplied through injected seams (`EmbeddingCalibrationProbe`,
 * `EmbeddingGpuProbe`): this module owns the schedule, the validation and the
 * derivation, and never loads ONNX Runtime, touches a GPU or reads user data.
 * Tests can drive the whole matrix — p50/p90, tiers, arena, GPU fallback,
 * deadline exhaustion, malformed probes — without any of that.
 *
 * **Budget discipline.** The caller supplies one deadline for the whole pass
 * (`budgetMs`, default {@link EMBEDDING_CALIBRATION_BUDGET_MS}). Each probe call
 * receives the *remaining* milliseconds and is expected to bound itself; the
 * schedule re-checks the clock between stages. A measurement that throws or a
 * deadline that expires leaves the pass incomplete, so the whole result falls
 * back to the documented default budget and is marked `uncalibrated` with a
 * redacted reason. A partially measured budget is worse than an honest default.
 *
 * **GPU is index-only.** The resolved role is never `auto`: a successful probe
 * yields `index-only`, everything else falls back to `off`, and the query path
 * always runs on CPU (`queryExecutionProviders` is fixed to `["cpu"]`). A GPU
 * failure keeps the CPU calibration and records only a redacted reason (K-14).
 *
 * **Fingerprint.** `sha256(platform|arch|cpu|cores|totalmem|EP|runtime|model|
 * quant|chunkerVersion)` after normalization: strings are trimmed, whitespace is
 * folded and lowercased, memory is rounded to MiB, execution providers are
 * deduplicated and sorted. A locale/case difference or a hot-plug byte cannot
 * re-run calibration; a model/quant/chunker change does (48-2 §4.5).
 *
 * **Derivation thresholds (C5 heuristic, recorded in 48-3).**
 * - tier `m3`: (total memory ≥ 16 GiB, or an accepted GPU) and batch throughput
 *   ≥ 8 texts/s; otherwise `small` (48-1 §5.2's 高配 gate).
 * - arena: total memory ≥ 16 GiB **and** measured long-batch RSS < 500 MiB.
 * - threads: 1 below 32 texts/s, otherwise `min(2, cores - 1)`; always ≥ 1.
 * - query budget: `clamp(p90 × 40, 50, 300)` ms (48-2 §4.5).
 * - quantization: `int8` only when explicitly requested; default `float32`.
 *
 * Layer: `backend/local/`. Imports `node:crypto` and types from `@/types` only;
 * no CLI, websocket, reminders or agent imports, no filesystem, no settings
 * writes (D6/A4 own persistence).
 */

import { createHash } from "node:crypto";
import type {
  EmbeddingCalibrationSnapshot,
  EmbeddingGpuRole,
  EmbeddingQuantization,
} from "@/types/embedding-protocol";

// ── Public constants (documented defaults) ──────────────────────────────────

/** Total wall-clock ceiling for one calibration pass (48-1 §6.6). */
export const EMBEDDING_CALIBRATION_BUDGET_MS = 5_000;

/** Number of single-query samples; p50/p90 are derived from them. */
export const QUERY_LATENCY_SAMPLES = 10;

/** Short texts in the batch-throughput measurement. */
export const BATCH_THROUGHPUT_TEXTS = 32;

/** A resident-memory sample is only trusted when taken after a ≥256-token batch. */
export const RSS_BATCH_MIN_TOKENS = 256;

/** Long texts handed to the RSS probe; 8 × 40 CJK chars ≈ ≥320 estimated tokens. */
export const RSS_BATCH_TEXT_COUNT = 8;

/** Query budget = `clamp(p90 × multiplier, min, max)` (48-2 §4.5). */
export const QUERY_BUDGET_LATENCY_MULTIPLIER = 40;
export const QUERY_BUDGET_MIN_MS = 50;
export const QUERY_BUDGET_MAX_MS = 300;

/** Highest tier the machine may run (`small` = bge-small, `m3` = bge-m3). */
export type EmbeddingCalibrationTier = "small" | "m3";

/** `m3` needs a 16 GiB-class machine (or an accepted GPU) — 48-1 §5.2. */
export const M3_MIN_TOTAL_MEMORY_BYTES = 16 * 1024 ** 3;

/** …and it must not be catastrophically slow: 761 tok/s m3 batch floor. */
export const M3_MIN_THROUGHPUT_PER_SEC = 8;

/** ORT CPU arena is opt-in only on a roomy machine with a small measured RSS. */
export const ARENA_MIN_TOTAL_MEMORY_BYTES = 16 * 1024 ** 3;
export const ARENA_MAX_RSS_BYTES = 500 * 1024 ** 2;

/** Build threads: 1 while slow, up to 2 when the batch sustains throughput. */
export const THREAD_SCALE_MIN_THROUGHPUT_PER_SEC = 32;
export const MAX_BUILD_THREADS = 2;

/** Download/runtime+model+index headroom; below this a download is refused. */
export const MIN_DISK_FREE_BYTES = 512 * 1024 ** 2;

/** Fallbacks used when a measurement is missing (48-1 §6.6 defaults). */
export const DEFAULT_QUERY_BUDGET_MS = 100;
export const DEFAULT_BUILD_THREADS = 1;
export const DEFAULT_CALIBRATION_TIER: EmbeddingCalibrationTier = "small";
export const DEFAULT_CALIBRATION_REASON = "calibration skipped";

// ── Errors ──────────────────────────────────────────────────────────────────

/** Why a calibration input or measurement was rejected. */
export type EmbeddingCalibrationErrorCode =
  | "invalid-environment"
  | "invalid-measurement"
  | "deadline";

/** Typed failure; a rejected measurement never silently becomes a number. */
export class EmbeddingCalibrationError extends Error {
  readonly code: EmbeddingCalibrationErrorCode;

  constructor(code: EmbeddingCalibrationErrorCode, message: string) {
    super(message);
    this.name = "EmbeddingCalibrationError";
    this.code = code;
  }
}

// ── Injected measurement seams ──────────────────────────────────────────────

/** Time a probe may spend on one call; it must bound itself. */
export interface EmbeddingProbeLimits {
  readonly remainingMs: number;
}

/** Counters from one batch embed; enough to derive texts/s and tokens/s. */
export interface EmbeddingBatchSample {
  /** Texts actually embedded; must equal the number requested. */
  readonly texts: number;
  readonly tokens: number;
  readonly elapsedMs: number;
}

/**
 * The CPU-side measurements calibration needs. Implementations wrap the
 * worker client (C3) and the OS; they are injected so tests and platforms
 * without a runtime can supply deterministic values.
 */
export interface EmbeddingCalibrationProbe {
  /** Embed one short query text; resolve its wall-clock latency in ms. */
  queryLatencyMs(
    text: string,
    limits: EmbeddingProbeLimits,
  ): number | Promise<number>;
  /** Embed a batch of short texts once; resolve counters for throughput. */
  batchEmbed(
    texts: readonly string[],
    limits: EmbeddingProbeLimits,
  ): EmbeddingBatchSample | Promise<EmbeddingBatchSample>;
  /**
   * Embed `longBatchTexts` (≥{@link RSS_BATCH_MIN_TOKENS} tokens in total) and
   * then resolve the process RSS in bytes. Short batches underestimate RSS by
   * ~8×, so the long batch is part of the probe contract, not an optimization.
   */
  rssBytes(
    longBatchTexts: readonly string[],
    limits: EmbeddingProbeLimits,
  ): number | Promise<number>;
  /** Free bytes on the embedding cache volume (`statfs`/`statvfs`). */
  diskFreeBytes(limits: EmbeddingProbeLimits): number | Promise<number>;
}

/** Outcome of the DirectML (or other EP) trial: initialize plus one batch. */
export interface EmbeddingGpuProbeResult {
  readonly ok: boolean;
  /** Accepted execution provider, e.g. `"dml"`. */
  readonly executionProvider?: string;
  /** Raw failure (Error/message/anything); calibration redacts it. */
  readonly failure?: unknown;
}

/** GPU trial seam; absent = no GPU path on this platform (CPU only). */
export interface EmbeddingGpuProbe {
  probe(
    limits: EmbeddingProbeLimits,
  ): EmbeddingGpuProbeResult | Promise<EmbeddingGpuProbeResult>;
}

// ── Inputs and outputs ──────────────────────────────────────────────────────

/**
 * Static facts that identify the measurement environment. The caller reads them
 * once (`process.platform/arch`, `os.cpus()`, `os.totalmem()`, ORT's provider
 * list); they are also the fingerprint inputs.
 */
export interface EmbeddingCalibrationEnvironment {
  platform: string;
  arch: string;
  /** CPU model string, e.g. `os.cpus()[0]?.model`. */
  cpuModel: string;
  /** Logical core count. */
  cores: number;
  totalMemoryBytes: number;
  /** ORT execution providers available on this machine, e.g. `["cpu","dml"]`. */
  executionProviders: readonly string[];
  /** Host runtime name/version, e.g. `"bun"` or `"node-22.19.0"`. */
  runtime: string;
  modelId: string;
  /** Requested quantization; `int8` is honored only because it is explicit. */
  quantization: EmbeddingQuantization;
  /** Index chunker version this calibration's vectors belong to. */
  chunkerVersion: number;
}

/** Everything one bounded calibration pass needs. */
export interface EmbeddingCalibrationInput {
  readonly environment: EmbeddingCalibrationEnvironment;
  readonly probe: EmbeddingCalibrationProbe;
  /** Omit when the platform has no GPU path (role resolves to `off`). */
  readonly gpuProbe?: EmbeddingGpuProbe;
  /** Total pass budget in ms; default {@link EMBEDDING_CALIBRATION_BUDGET_MS}. */
  readonly budgetMs?: number;
  /** User setting; `auto`/`index-only` probe, `off` never probes. */
  readonly requestedGpuRole?: EmbeddingGpuRole;
  /** Injectable epoch clock (tests advance it to exhaust the budget). */
  readonly now?: () => number;
  /** Injectable ISO timestamp; defaults to the wall clock. */
  readonly measuredAt?: string;
}

/**
 * The derived runtime budget. Never persisted as-is (settings keep only the
 * {@link EmbeddingCalibrationSnapshot} fields D3 declared); consumers (C8, A3)
 * read it in-process. `calibrated: false` is the authoritative "numbers below
 * are documented defaults, not measurements" flag.
 */
export interface EmbeddingCalibrationBudget {
  tier: EmbeddingCalibrationTier;
  calibrated: boolean;
  /** Redacted reason the pass is uncalibrated; absent when calibrated. */
  reason?: string;
  /** True when the deadline ran out before a measurement completed. */
  timedOut: boolean;
  /** Query-arm extra latency budget in ms: `clamp(p90 × 40, 50, 300)`. */
  queryBudgetMs: number;
  threads: number;
  cpuArena: boolean;
  /** Resolved role: `off` or `index-only`; never `auto`. */
  gpuRole: EmbeddingGpuRole;
  /** Accepted GPU provider for builds; only set with `index-only`. */
  gpuExecutionProvider?: string;
  quantization: EmbeddingQuantization;
  /** RSS measured after the long batch, bytes; `0` when uncalibrated. */
  rssBytes: number;
  /** Free bytes on the cache volume; `0` when uncalibrated. */
  diskFreeBytes: number;
  /** `false` only when the disk measurement succeeded and is below the floor. */
  diskHeadroomOk: boolean;
  totalMemoryBytes: number;
  batchTokensPerSec: number;
  /** Query encodes always run on CPU, whatever the build path uses. */
  queryExecutionProviders: readonly string[];
  /** Execution providers the index build may use (`["cpu"]` unless GPU gated in). */
  buildExecutionProviders: readonly string[];
}

/** The wire snapshot (D1) plus the in-process budget. */
export interface EmbeddingCalibrationResult {
  snapshot: EmbeddingCalibrationSnapshot;
  budget: EmbeddingCalibrationBudget;
}

/** Options for a caller-chosen skip (wizard "skip" step, 48-1 §6.6). */
export interface SkippedCalibrationOptions {
  readonly measuredAt?: string;
  readonly reason?: string;
}

// ── Fingerprint ─────────────────────────────────────────────────────────────

/**
 * Stable `sha256` fingerprint of the measurement environment. Equal inputs
 * always hash equal (case/whitespace/EP order/byte-level memory jitter are
 * folded); any effective hardware/runtime/model/quantization change moves it.
 */
export function computeEmbeddingFingerprint(
  environment: EmbeddingCalibrationEnvironment,
): string {
  if (typeof environment !== "object" || environment === null) {
    throw new EmbeddingCalibrationError(
      "invalid-environment",
      "calibration environment must be an object",
    );
  }
  const canonical = [
    normalizeToken(environment.platform, "platform"),
    normalizeToken(environment.arch, "arch"),
    normalizeToken(environment.cpuModel, "cpuModel"),
    String(requirePositiveInteger(environment.cores, "cores")),
    String(memoryInMiB(environment.totalMemoryBytes)),
    normalizeProviders(environment.executionProviders).join(","),
    normalizeToken(environment.runtime, "runtime"),
    normalizeToken(environment.modelId, "modelId"),
    requireQuantization(environment.quantization),
    String(
      requirePositiveInteger(environment.chunkerVersion, "chunkerVersion"),
    ),
  ].join("|");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Re-run calibration when the stored result has no fingerprint, belongs to a
 * different environment, or the current fingerprint is unusable (fail-safe).
 */
export function shouldRecalibrate(
  previous: { readonly fingerprint?: unknown } | null | undefined,
  fingerprint: string,
): boolean {
  const next = normalizeFingerprint(fingerprint);
  if (next.length === 0 || previous === null || previous === undefined) {
    return true;
  }
  const stored =
    typeof previous.fingerprint === "string"
      ? normalizeFingerprint(previous.fingerprint)
      : "";
  return stored.length === 0 || stored !== next;
}

// ── Bounded measurements ────────────────────────────────────────────────────

/** Linear-interpolation percentiles over validated latency samples. */
export function latencyPercentiles(samples: readonly number[]): {
  p50: number;
  p90: number;
} {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new EmbeddingCalibrationError(
      "invalid-measurement",
      "latency percentiles need at least one sample",
    );
  }
  samples.forEach((sample, index) => {
    requireNonNegativeNumber(sample, `latency sample ${index + 1}`);
  });
  const sorted = [...samples].sort((left, right) => left - right);
  return { p50: percentileOf(sorted, 50), p90: percentileOf(sorted, 90) };
}

/** Query-arm latency budget from the measured p90 (48-2 §4.5). */
export function queryBudgetFromP90(p90Ms: number): number {
  const latency = requireNonNegativeNumber(p90Ms, "query p90 latency");
  return clamp(
    Math.round(latency * QUERY_BUDGET_LATENCY_MULTIPLIER),
    QUERY_BUDGET_MIN_MS,
    QUERY_BUDGET_MAX_MS,
  );
}

/** Derive the highest model tier the machine can sustain (48-1 §5.2). */
export function deriveEmbeddingTier(input: {
  readonly totalMemoryBytes: number;
  readonly throughputPerSec: number;
  readonly gpuRole?: EmbeddingGpuRole;
}): EmbeddingCalibrationTier {
  const memoryRoom =
    Number.isFinite(input.totalMemoryBytes) &&
    input.totalMemoryBytes >= M3_MIN_TOTAL_MEMORY_BYTES;
  const gpuRoom = input.gpuRole === "index-only";
  const fastEnough =
    Number.isFinite(input.throughputPerSec) &&
    input.throughputPerSec >= M3_MIN_THROUGHPUT_PER_SEC;
  return (memoryRoom || gpuRoom) && fastEnough
    ? "m3"
    : DEFAULT_CALIBRATION_TIER;
}

/** Build threads: 1 while slow, otherwise `min(2, cores - 1)` (48-1 §6.6). */
export function deriveBuildThreads(input: {
  readonly cores: number;
  readonly throughputPerSec: number;
}): number {
  if (!Number.isFinite(input.cores) || input.cores < 1) {
    return DEFAULT_BUILD_THREADS;
  }
  if (
    !Number.isFinite(input.throughputPerSec) ||
    input.throughputPerSec < THREAD_SCALE_MIN_THROUGHPUT_PER_SEC
  ) {
    return DEFAULT_BUILD_THREADS;
  }
  const usableCores = Math.max(1, Math.floor(input.cores) - 1);
  return Math.min(MAX_BUILD_THREADS, usableCores);
}

/** ORT CPU arena: roomy machine *and* a small measured long-batch RSS only. */
export function shouldEnableCpuArena(input: {
  readonly totalMemoryBytes: number;
  readonly rssBytes: number;
}): boolean {
  return (
    Number.isFinite(input.totalMemoryBytes) &&
    input.totalMemoryBytes >= ARENA_MIN_TOTAL_MEMORY_BYTES &&
    Number.isFinite(input.rssBytes) &&
    input.rssBytes > 0 &&
    input.rssBytes < ARENA_MAX_RSS_BYTES
  );
}

// ── Calibration pass ────────────────────────────────────────────────────────

/**
 * Run the bounded calibration pass and derive the runtime budget.
 *
 * Never throws for a failed measurement: an incomplete pass returns the default
 * budget with `calibrated: false` and a redacted reason. It does throw
 * {@link EmbeddingCalibrationError} when the *inputs* are unusable (bad
 * environment, malformed budget/timestamp) — those are caller bugs, and a
 * fingerprint computed from garbage would poison the cache.
 */
export async function calibrateEmbedding(
  input: EmbeddingCalibrationInput,
): Promise<EmbeddingCalibrationResult> {
  const environment = input.environment;
  const fingerprint = computeEmbeddingFingerprint(environment);
  const quantization = resolveQuantization(environment.quantization);
  const measuredAt = resolveMeasuredAt(input.measuredAt);
  const budgetMs = resolveBudgetMs(input.budgetMs);
  const clock = input.now ?? (() => Date.now());
  const deadlineAt = clock() + budgetMs;
  const remainingMs = (): number => Math.max(0, deadlineAt - clock());
  const requestedGpuRole = input.requestedGpuRole ?? "auto";

  let p50Ms = 0;
  let p90Ms = 0;
  let textsPerSec = 0;
  let tokensPerSec = 0;
  let rssBytes = 0;
  let diskFreeBytes = 0;
  let stage = "query latency";

  try {
    const latencies: number[] = [];
    for (let index = 0; index < QUERY_LATENCY_SAMPLES; index += 1) {
      ensureBudget(remainingMs(), stage);
      const sample = await input.probe.queryLatencyMs(QUERY_SAMPLE_TEXT, {
        remainingMs: remainingMs(),
      });
      latencies.push(
        requireNonNegativeNumber(sample, `query latency sample ${index + 1}`),
      );
    }
    const percentiles = latencyPercentiles(latencies);
    p50Ms = percentiles.p50;
    p90Ms = percentiles.p90;

    stage = "batch throughput";
    ensureBudget(remainingMs(), stage);
    const batch = validateBatchSample(
      await input.probe.batchEmbed(BATCH_TEXTS, {
        remainingMs: remainingMs(),
      }),
      BATCH_TEXTS.length,
    );
    textsPerSec = batch.textsPerSec;
    tokensPerSec = batch.tokensPerSec;

    stage = "resident memory";
    ensureBudget(remainingMs(), stage);
    rssBytes = requirePositiveNumber(
      await input.probe.rssBytes(createLongBatchTexts(), {
        remainingMs: remainingMs(),
      }),
      "rss measurement",
    );

    stage = "disk free space";
    ensureBudget(remainingMs(), stage);
    diskFreeBytes = requireNonNegativeNumber(
      await input.probe.diskFreeBytes({ remainingMs: remainingMs() }),
      "disk free space",
    );
  } catch (error) {
    return fallbackResult({
      fingerprint,
      measuredAt,
      quantization,
      totalMemoryBytes: environment.totalMemoryBytes,
      reason: `${stage}: ${sanitizeCalibrationReason(error)}`,
      timedOut:
        error instanceof EmbeddingCalibrationError && error.code === "deadline",
      ...(requestedGpuRole !== "off"
        ? { gpuReason: "GPU probe skipped: CPU calibration did not complete" }
        : {}),
    });
  }

  const gpu = await resolveGpuRole({
    requestedGpuRole,
    gpuProbe: input.gpuProbe,
    remainingMs,
  });

  const normalizedProviders = normalizeProviders(
    environment.executionProviders,
  );
  const buildExecutionProviders =
    gpu.role === "index-only" ? withCpuProvider(normalizedProviders) : ["cpu"];
  const tier = deriveEmbeddingTier({
    totalMemoryBytes: environment.totalMemoryBytes,
    throughputPerSec: textsPerSec,
    gpuRole: gpu.role,
  });

  return {
    snapshot: {
      fingerprint,
      measured_at: measuredAt,
      query_latency_p50_ms: round3(p50Ms),
      query_latency_p90_ms: round3(p90Ms),
      batch_throughput_per_s: round3(textsPerSec),
      gpu_role: gpu.role,
      threads: deriveBuildThreads({
        cores: environment.cores,
        throughputPerSec: textsPerSec,
      }),
      quantization,
      ...(gpu.reason !== undefined ? { gpu_reason: gpu.reason } : {}),
    },
    budget: {
      tier,
      calibrated: true,
      timedOut: false,
      queryBudgetMs: queryBudgetFromP90(p90Ms),
      threads: deriveBuildThreads({
        cores: environment.cores,
        throughputPerSec: textsPerSec,
      }),
      cpuArena: shouldEnableCpuArena({
        totalMemoryBytes: environment.totalMemoryBytes,
        rssBytes,
      }),
      gpuRole: gpu.role,
      ...(gpu.executionProvider !== undefined
        ? { gpuExecutionProvider: gpu.executionProvider }
        : {}),
      quantization,
      rssBytes,
      diskFreeBytes,
      diskHeadroomOk: diskFreeBytes >= MIN_DISK_FREE_BYTES,
      totalMemoryBytes: environment.totalMemoryBytes,
      batchTokensPerSec: round3(tokensPerSec),
      queryExecutionProviders: ["cpu"],
      buildExecutionProviders,
    },
  };
}

/**
 * The wizard's "skip calibration" path (48-1 §6.6): the documented default
 * budget with the current fingerprint, no measurements taken.
 */
export function skipEmbeddingCalibration(
  environment: EmbeddingCalibrationEnvironment,
  options: SkippedCalibrationOptions = {},
): EmbeddingCalibrationResult {
  const fingerprint = computeEmbeddingFingerprint(environment);
  const requested =
    typeof options.reason === "string" && options.reason.trim().length > 0
      ? options.reason
      : DEFAULT_CALIBRATION_REASON;
  return fallbackResult({
    fingerprint,
    measuredAt: resolveMeasuredAt(options.measuredAt),
    quantization: resolveQuantization(environment.quantization),
    totalMemoryBytes: environment.totalMemoryBytes,
    reason: sanitizeCalibrationReason(requested),
    timedOut: false,
    gpuReason: "GPU probe skipped: calibration skipped by the user",
  });
}

// ── Internals ───────────────────────────────────────────────────────────────

/** Short query text: latency measures per-call overhead, not model quality. */
const QUERY_SAMPLE_TEXT = "校准查询样本：向量检索延迟测量。";

/** 32 short, distinct texts: a batch whose throughput is comparable run to run. */
const BATCH_TEXTS: readonly string[] = Array.from(
  { length: BATCH_THROUGHPUT_TEXTS },
  (_, index) => `批量吞吐测量样本 ${index + 1}`,
);

/** CJK-heavy filler: 40 chars/text × 8 texts ≈ ≥320 token estimates (B1 rule). */
const LONG_BATCH_FILLER =
  "嵌入校准需要一段足够长的中文样本来触发真实的注意力计算与内存分配，短文本会严重低估常驻内存，因此长批测量必须足够长。";
const LONG_BATCH_CHARS_PER_TEXT = 40;
const MAX_REASON_CHARS = 200;

const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-[a-z0-9_-]{8,}/gi,
  /bearer\s+[a-z0-9._~+/=-]{8,}/gi,
  /(api[_-]?key|token|secret|password)\s*[=:]\s*\S+/gi,
];
const ABSOLUTE_PATH_PATTERN = /(?:[a-z]:\\|\/)[^\s"']+/gi;

interface GpuResolution {
  role: EmbeddingGpuRole;
  reason?: string;
  executionProvider?: string;
}

async function resolveGpuRole(input: {
  requestedGpuRole: EmbeddingGpuRole;
  gpuProbe: EmbeddingGpuProbe | undefined;
  remainingMs: () => number;
}): Promise<GpuResolution> {
  if (input.requestedGpuRole === "off") {
    return { role: "off" };
  }
  if (input.gpuProbe === undefined) {
    return { role: "off", reason: "GPU probe not available" };
  }
  if (input.remainingMs() <= 0) {
    return {
      role: "off",
      reason: "GPU probe skipped: calibration budget exhausted",
    };
  }
  try {
    const outcome = validateGpuProbeOutcome(
      await input.gpuProbe.probe({ remainingMs: input.remainingMs() }),
    );
    if (!outcome.ok) {
      return {
        role: "off",
        reason: `GPU initialization failed: ${sanitizeCalibrationReason(
          outcome.failure,
        )}`,
      };
    }
    return {
      role: "index-only",
      ...(outcome.executionProvider !== undefined
        ? { executionProvider: outcome.executionProvider }
        : {}),
    };
  } catch (error) {
    return {
      role: "off",
      reason: `GPU initialization failed: ${sanitizeCalibrationReason(error)}`,
    };
  }
}

function validateGpuProbeOutcome(value: unknown): EmbeddingGpuProbeResult {
  if (typeof value !== "object" || value === null) {
    throw new EmbeddingCalibrationError(
      "invalid-measurement",
      "GPU probe returned no result object",
    );
  }
  const record = value as Record<string, unknown>;
  if (typeof record.ok !== "boolean") {
    throw new EmbeddingCalibrationError(
      "invalid-measurement",
      "GPU probe returned no boolean `ok`",
    );
  }
  const executionProvider =
    typeof record.executionProvider === "string" &&
    record.executionProvider.trim().length > 0
      ? record.executionProvider.trim().toLowerCase()
      : undefined;
  return {
    ok: record.ok,
    executionProvider,
    failure: record.failure,
  };
}

interface FallbackInput {
  readonly fingerprint: string;
  readonly measuredAt: string;
  readonly quantization: EmbeddingQuantization;
  readonly totalMemoryBytes: number;
  readonly reason: string;
  readonly timedOut: boolean;
  readonly gpuReason?: string;
}

function fallbackResult(input: FallbackInput): EmbeddingCalibrationResult {
  return {
    snapshot: {
      fingerprint: input.fingerprint,
      measured_at: input.measuredAt,
      query_latency_p50_ms: 0,
      query_latency_p90_ms: 0,
      batch_throughput_per_s: 0,
      gpu_role: "off",
      threads: DEFAULT_BUILD_THREADS,
      quantization: input.quantization,
      ...(input.gpuReason !== undefined ? { gpu_reason: input.gpuReason } : {}),
    },
    budget: {
      tier: DEFAULT_CALIBRATION_TIER,
      calibrated: false,
      reason: input.reason,
      timedOut: input.timedOut,
      queryBudgetMs: DEFAULT_QUERY_BUDGET_MS,
      threads: DEFAULT_BUILD_THREADS,
      cpuArena: false,
      gpuRole: "off",
      quantization: input.quantization,
      rssBytes: 0,
      diskFreeBytes: 0,
      // Unknown disk is not a reason to block a download; the download path
      // reports ENOSPC/statfs failures itself.
      diskHeadroomOk: true,
      totalMemoryBytes: input.totalMemoryBytes,
      batchTokensPerSec: 0,
      queryExecutionProviders: ["cpu"],
      buildExecutionProviders: ["cpu"],
    },
  };
}

function resolveQuantization(
  requested: EmbeddingQuantization,
): EmbeddingQuantization {
  // int8 is honored only because it was explicitly requested (C9 owns the
  // rescore path); a measured/derived auto-quantization is out of scope.
  return requested === "int8" ? "int8" : "float32";
}

function resolveMeasuredAt(value: string | undefined): string {
  if (value === undefined) {
    return new Date().toISOString();
  }
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed.length === 0 || !Number.isFinite(Date.parse(trimmed))) {
    throw new EmbeddingCalibrationError(
      "invalid-environment",
      "measuredAt must be a non-empty parseable timestamp",
    );
  }
  return trimmed;
}

function resolveBudgetMs(value: number | undefined): number {
  if (value === undefined) {
    return EMBEDDING_CALIBRATION_BUDGET_MS;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new EmbeddingCalibrationError(
      "invalid-environment",
      "budgetMs must be a positive finite number",
    );
  }
  return value;
}

function ensureBudget(remainingMs: number, stage: string): void {
  if (remainingMs <= 0) {
    throw new EmbeddingCalibrationError(
      "deadline",
      `calibration budget exhausted before the ${stage} measurement`,
    );
  }
}

function validateBatchSample(
  value: unknown,
  expectedTexts: number,
): { textsPerSec: number; tokensPerSec: number } {
  if (typeof value !== "object" || value === null) {
    throw new EmbeddingCalibrationError(
      "invalid-measurement",
      "batch measurement must be an object",
    );
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.texts !== "number" ||
    !Number.isInteger(record.texts) ||
    record.texts !== expectedTexts
  ) {
    throw new EmbeddingCalibrationError(
      "invalid-measurement",
      `batch measurement embedded ${describeValue(
        record.texts,
      )} texts, expected ${expectedTexts}`,
    );
  }
  const tokens = requirePositiveNumber(record.tokens, "batch token count");
  const elapsedMs = requirePositiveNumber(
    record.elapsedMs,
    "batch elapsed time",
  );
  const seconds = elapsedMs / 1000;
  return {
    textsPerSec: record.texts / seconds,
    tokensPerSec: tokens / seconds,
  };
}

function createLongBatchTexts(): readonly string[] {
  const filler = LONG_BATCH_FILLER.slice(0, LONG_BATCH_CHARS_PER_TEXT);
  return Array.from(
    { length: RSS_BATCH_TEXT_COUNT },
    (_, index) => `${filler}${index}`,
  );
}

function percentileOf(sorted: readonly number[], percentile: number): number {
  const position = ((sorted.length - 1) * percentile) / 100;
  const lower = Math.floor(position);
  const upper = Math.min(sorted.length - 1, lower + 1);
  const weight = position - lower;
  const low = sorted[lower] ?? 0;
  const high = sorted[upper] ?? low;
  return low + (high - low) * weight;
}

function normalizeToken(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new EmbeddingCalibrationError(
      "invalid-environment",
      `${field} must be a string`,
    );
  }
  const normalized = value.replace(/\s+/g, " ").trim().toLowerCase();
  if (normalized.length === 0) {
    throw new EmbeddingCalibrationError(
      "invalid-environment",
      `${field} must not be empty`,
    );
  }
  return normalized;
}

function normalizeFingerprint(value: string): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizeProviders(providers: unknown): string[] {
  if (!Array.isArray(providers)) {
    throw new EmbeddingCalibrationError(
      "invalid-environment",
      "executionProviders must be an array",
    );
  }
  const normalized: string[] = [];
  for (const provider of providers) {
    const token = normalizeToken(provider, "executionProviders entry");
    if (!normalized.includes(token)) {
      normalized.push(token);
    }
  }
  return normalized.sort();
}

function withCpuProvider(providers: readonly string[]): string[] {
  return providers.includes("cpu") ? [...providers] : ["cpu", ...providers];
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new EmbeddingCalibrationError(
      "invalid-environment",
      `${field} must be a positive integer`,
    );
  }
  return value;
}

function requireQuantization(value: unknown): EmbeddingQuantization {
  if (value !== "float32" && value !== "int8") {
    throw new EmbeddingCalibrationError(
      "invalid-environment",
      "quantization must be float32 or int8",
    );
  }
  return value;
}

function memoryInMiB(bytes: unknown): number {
  const total = requirePositiveInteger(bytes, "totalMemoryBytes");
  return Math.round(total / (1024 * 1024));
}

function requireNonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new EmbeddingCalibrationError(
      "invalid-measurement",
      `${label} must be a finite non-negative number, got ${describeValue(
        value,
      )}`,
    );
  }
  return value;
}

function requirePositiveNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new EmbeddingCalibrationError(
      "invalid-measurement",
      `${label} must be a finite positive number, got ${describeValue(value)}`,
    );
  }
  return value;
}

function describeValue(value: unknown): string {
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value === "string") {
    return value.length <= 40
      ? JSON.stringify(value)
      : `${JSON.stringify(value.slice(0, 40))}…`;
  }
  if (value === null) {
    return "null";
  }
  return typeof value;
}

/** Redact secrets and absolute paths, fold whitespace, cap the length. */
function sanitizeCalibrationReason(value: unknown): string {
  const raw =
    value instanceof Error
      ? value.message
      : typeof value === "string"
        ? value
        : value === undefined || value === null
          ? ""
          : String(value);
  let text = foldControlCharacters(raw).replace(/\s+/g, " ").trim();
  if (text.length === 0) {
    return "GPU probe failed";
  }
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, "[redacted]");
  }
  text = text.replace(ABSOLUTE_PATH_PATTERN, "[path]");
  return text.length <= MAX_REASON_CHARS
    ? text
    : `${text.slice(0, MAX_REASON_CHARS - 1)}…`;
}

/** Replace C0/C1 control characters with spaces without a control-char regex. */
function foldControlCharacters(value: string): string {
  let folded = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    folded += code < 0x20 || code === 0x7f ? " " : character;
  }
  return folded;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
