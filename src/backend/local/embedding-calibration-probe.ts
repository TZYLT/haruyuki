/**
 * Production probes for the embedding calibration pass (feature 48, rework A2).
 *
 * C5's `calibration.ts` deliberately owns no measurement: it takes an
 * `EmbeddingCalibrationProbe` (CPU latency / batch throughput / RSS / disk
 * free) and an `EmbeddingGpuProbe` (a DirectML trial). This module supplies the
 * two real implementations, plus the environment descriptor the fingerprint is
 * computed from:
 *
 * 1. {@link buildEmbeddingCalibrationEnvironment} reads the static facts
 *    (`process.platform/arch`, `os.cpus()`/`os.totalmem()`, the runtime name,
 *    the configured model/quantization) and the execution-provider list this
 *    platform may offer. On Windows it advertises `["cpu","dml"]` unless the
 *    user turned the GPU off; everywhere else it advertises CPU only, so
 *    calibration can never invent a GPU path the machine does not have.
 * 2. {@link createWorkerCalibrationProbe} lazily starts C3's worker on CPU with
 *    the installed runtime/model/tokenizer and times real encodes. The same
 *    handle answers all four measurements; `dispose()` stops the worker. Every
 *    call is bounded by the caller's remaining budget, because a probe that
 *    overruns the 5-second pass is worse than a failed measurement (48-1 §6.6).
 * 3. {@link createDirectMlCalibrationProbe} is the GPU trial. It builds the
 *    index-build device adapter with an `index-only` budget, so ONNX Runtime is
 *    asked for DirectML first and the adapter falls back to CPU by itself; a
 *    GPU refusal becomes `ok: false` with a redacted reason. The adapter is
 *    disposed before the probe returns, so a failed trial cannot leak a worker.
 * 4. {@link runEmbeddingCalibration} wires 1–3 into C5 and returns both the
 *    result and the probe that produced it (the caller disposes it). It writes
 *    nothing: persisting the snapshot is D3/D6's contract.
 *
 * `diskFreeBytes` prefers `fs.statfsSync`; Bun builds that lack it (or a probe
 * that fails) answer `MAX_SAFE_INTEGER` instead of blocking the pass, and the
 * reason is visible as "unsupported". A missing disk measurement must not read
 * as "no space".
 *
 * Layer: `backend/local/embedding*`. Imports sibling embedding modules and
 * `node:os`/`node:fs` only; no CLI, websocket, reminders or agent imports.
 */

import * as nodeFs from "node:fs";
import * as os from "node:os";
import {
  BATCH_THROUGHPUT_TEXTS,
  calibrateEmbedding,
  DEFAULT_BUILD_THREADS,
  DEFAULT_QUERY_BUDGET_MS,
  type EmbeddingBatchSample,
  type EmbeddingCalibrationBudget,
  type EmbeddingCalibrationEnvironment,
  type EmbeddingCalibrationProbe,
  type EmbeddingCalibrationResult,
  type EmbeddingGpuProbe,
  type EmbeddingGpuProbeResult,
  type EmbeddingProbeLimits,
  RSS_BATCH_MIN_TOKENS,
  RSS_BATCH_TEXT_COUNT,
} from "@/backend/local/embedding/calibration";
import {
  type CreateEmbeddingDeviceAdapterOptions,
  createEmbeddingDeviceAdapter,
  type EmbeddingBuildWorker,
  type EmbeddingDeviceAdapter,
} from "@/backend/local/embedding/gpu-build-path";
import { EmbeddingWorkerClient } from "@/backend/local/embedding/worker-client";
import type { EmbeddingWorkerEmbedOutput } from "@/backend/local/embedding/worker-client-types";
import type { EmbeddingBuiltinAssets } from "@/backend/local/embedding-assets";
import { resolveEmbeddingWorkerEntryForRuntime } from "@/backend/local/embedding-encoder";
import { EMBEDDING_INDEX_CHUNKER_VERSION } from "@/backend/local/embedding-format";
import type { ResolvedEmbeddingSettings } from "@/recall-settings";
import type { EmbeddingQuantization } from "@/types/embedding-protocol";

/** Short text handed to the single-query latency measurement. */
const QUERY_SAMPLE_TEXT = "上一次部署窗口定在什么时候？";

/** One batch-throughput text; short on purpose (the batch is 32 of them). */
const BATCH_SAMPLE_TEXT = "embedding calibration batch sample";

/**
 * Long texts for the RSS measurement; 8 × 64 CJK characters is comfortably
 * above {@link RSS_BATCH_MIN_TOKENS} even under the conservative estimator.
 */
const RSS_SAMPLE_TEXT = "记忆检索校准样本".repeat(8);

/** Reported by a platform whose filesystem statistics are unavailable. */
export const EMBEDDING_DISK_FREE_UNSUPPORTED_BYTES = Number.MAX_SAFE_INTEGER;

/** Minimal `statfsSync` shape; declared locally so Bun/Node both type-check. */
interface StatfsLike {
  readonly bsize: number;
  readonly bavail?: number;
  readonly free?: number;
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/**
 * Overrides for {@link buildEmbeddingCalibrationEnvironment}; production passes
 * none and lets the process facts win. Tests (and a future `--platform` probe)
 * use them to drive the provider matrix without a GPU.
 */
export interface EmbeddingCalibrationEnvironmentOptions {
  /** Defaults to `process.platform`. */
  readonly platform?: string;
  /** Defaults to `process.arch`. */
  readonly arch?: string;
  /** Defaults to the first CPU model `os.cpus()` reports. */
  readonly cpuModel?: string;
  /** Defaults to the logical core count. */
  readonly cores?: number;
  /** Defaults to `os.totalmem()`. */
  readonly totalMemoryBytes?: number;
  /** Overrides the platform-derived provider list. */
  readonly executionProviders?: readonly string[];
  /** Overrides the detected host runtime (`bun-…` / `node-…`). */
  readonly runtime?: string;
  /** Overrides the model id recorded in the fingerprint. */
  readonly modelId?: string;
  /** Overrides the quantization recorded in the fingerprint. */
  readonly quantization?: EmbeddingQuantization;
  /** Overrides the chunker version recorded in the fingerprint. */
  readonly chunkerVersion?: number;
}

/**
 * Static facts about this measurement environment, plus the providers this
 * platform may offer. `win32` adds DirectML unless the user asked for CPU only;
 * every other platform advertises CPU only.
 */
export function buildEmbeddingCalibrationEnvironment(
  settings: ResolvedEmbeddingSettings,
  assets: EmbeddingBuiltinAssets,
  options: EmbeddingCalibrationEnvironmentOptions = {},
): EmbeddingCalibrationEnvironment {
  const platform = options.platform ?? process.platform;
  const cpus = os.cpus();
  const gpuAllowed = platform === "win32" && settings.gpu !== "off";
  return {
    platform,
    arch: options.arch ?? process.arch,
    cpuModel: options.cpuModel ?? cpus[0]?.model ?? "unknown",
    cores: options.cores ?? (cpus.length > 0 ? cpus.length : 1),
    totalMemoryBytes: options.totalMemoryBytes ?? os.totalmem(),
    executionProviders:
      options.executionProviders ?? (gpuAllowed ? ["cpu", "dml"] : ["cpu"]),
    runtime: options.runtime ?? detectRuntimeLabel(),
    modelId: options.modelId ?? assets.modelId,
    quantization: options.quantization ?? settings.quantization,
    chunkerVersion: options.chunkerVersion ?? EMBEDDING_INDEX_CHUNKER_VERSION,
  };
}

function detectRuntimeLabel(): string {
  const bun = (globalThis as { Bun?: { version?: string } }).Bun;
  if (typeof bun?.version === "string" && bun.version.length > 0) {
    return `bun-${bun.version}`;
  }
  return `node-${process.versions.node}`;
}

// ---------------------------------------------------------------------------
// Worker probe
// ---------------------------------------------------------------------------

/** Options for {@link createWorkerCalibrationProbe}. */
export interface WorkerCalibrationProbeOptions {
  /** Installed model + runtime paths; the worker is initialised from these. */
  readonly assets: EmbeddingBuiltinAssets;
  /** Intra-op threads; `0`/absent lets the runtime decide. */
  readonly threads?: number;
  /** Test seam: a prebuilt (already or not yet started) worker. */
  readonly worker?: EmbeddingBuildWorker;
  /** Test seam: create the worker lazily instead of the real client. */
  readonly workerFactory?: () => EmbeddingBuildWorker;
  /** Explicit worker script path; defaults to the package-root resolution. */
  readonly workerPath?: string;
  /** Clock for elapsed measurements; defaults to `performance.now`. */
  readonly now?: () => number;
  /** RSS reader seam; defaults to `process.memoryUsage().rss`. */
  readonly readRssBytes?: () => number;
  /** Disk-free reader seam; defaults to `statfsSync` (or "unsupported"). */
  readonly readDiskFreeBytes?: () => number;
}

/** A worker probe whose worker must be stopped when the pass is over. */
export interface EmbeddingWorkerCalibrationProbe
  extends EmbeddingCalibrationProbe {
  /** Stop the worker if it ever started; safe to call more than once. */
  dispose(): Promise<void>;
}

interface WorkerSession {
  readonly worker: EmbeddingBuildWorker;
  readonly dim: number;
}

/** A clock that works under both Bun and Node. */
function defaultNow(): () => number {
  if (
    typeof performance !== "undefined" &&
    typeof performance.now === "function"
  ) {
    return () => performance.now();
  }
  return () => Date.now();
}

function boundedTimeoutMs(limits: EmbeddingProbeLimits): number {
  return Math.max(1, Math.ceil(limits.remainingMs));
}

/**
 * Lazily start one CPU worker and measure through it.
 *
 * The worker is created on the first measurement (not at construction) so a
 * calibration that is skipped by the caller never spawns a process. A failed
 * start/init does not poison the handle: the next measurement retries, because
 * a transient spawn failure is recoverable.
 */
export function createWorkerCalibrationProbe(
  options: WorkerCalibrationProbeOptions,
): EmbeddingWorkerCalibrationProbe {
  const now = options.now ?? defaultNow();
  let session: Promise<WorkerSession> | null = null;
  let disposed = false;

  const open = (): Promise<WorkerSession> => {
    if (session === null) {
      session = (async (): Promise<WorkerSession> => {
        const worker =
          options.worker ??
          (options.workerFactory ?? defaultWorkerFactory(options))();
        await worker.start();
        const initialization = await worker.init({
          runtimeDir: options.assets.runtimeDir,
          modelPath: options.assets.modelPath,
          tokenizerPath: options.assets.tokenizerPath,
          maxTokens: options.assets.manifest.maxTokens,
          // Calibration measures the CPU path the query arm will actually use.
          executionProviders: ["cpu"],
          ...(options.threads !== undefined && options.threads > 0
            ? { intraOpThreads: options.threads }
            : {}),
        });
        return { worker, dim: initialization.dim };
      })().catch((error: unknown) => {
        session = null;
        throw error;
      });
    }
    return session;
  };

  const embed = async (
    texts: readonly string[],
    limits: EmbeddingProbeLimits,
  ): Promise<EmbeddingWorkerEmbedOutput> => {
    const { worker } = await open();
    return await worker.embed(texts, { timeoutMs: boundedTimeoutMs(limits) });
  };

  return {
    async queryLatencyMs(
      text: string,
      limits: EmbeddingProbeLimits,
    ): Promise<number> {
      const sample = text.length > 0 ? text : QUERY_SAMPLE_TEXT;
      const started = now();
      const output = await embed([sample], limits);
      const elapsed = now() - started;
      if (!output.cancelled && output.vectors[0] === null) {
        throw new Error("The embedding worker returned no query vector.");
      }
      return Math.max(0, elapsed);
    },
    async batchEmbed(
      texts: readonly string[],
      limits: EmbeddingProbeLimits,
    ): Promise<EmbeddingBatchSample> {
      const requested =
        texts.length > 0
          ? texts
          : Array.from(
              { length: BATCH_THROUGHPUT_TEXTS },
              (_, index) => `${BATCH_SAMPLE_TEXT} ${index + 1}`,
            );
      const started = now();
      const output = await embed(requested, limits);
      const elapsedMs = Math.max(0, now() - started);
      if (output.cancelled || output.vectors.length !== requested.length) {
        throw new Error(
          `The embedding worker cancelled or short-answered the calibration batch (${output.vectors.length}/${requested.length}).`,
        );
      }
      return {
        texts: requested.length,
        tokens: Math.max(0, output.tokens),
        elapsedMs,
      };
    },
    async rssBytes(
      longBatchTexts: readonly string[],
      limits: EmbeddingProbeLimits,
    ): Promise<number> {
      const texts =
        longBatchTexts.length > 0
          ? longBatchTexts
          : Array.from({ length: RSS_BATCH_TEXT_COUNT }, () => RSS_SAMPLE_TEXT);
      const output = await embed(texts, limits);
      if (output.cancelled) {
        throw new Error("The embedding worker cancelled the RSS batch.");
      }
      if (output.tokens < RSS_BATCH_MIN_TOKENS) {
        throw new Error(
          `The RSS batch only covered ${output.tokens} token(s); a short batch underestimates resident memory.`,
        );
      }
      const readRss =
        options.readRssBytes ?? ((): number => process.memoryUsage().rss);
      return readRss();
    },
    async diskFreeBytes(_limits: EmbeddingProbeLimits): Promise<number> {
      const reader = options.readDiskFreeBytes ?? readDiskFreeBytesDefault;
      return reader();
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      const pending = session;
      session = null;
      if (pending === null) return;
      let worker: EmbeddingBuildWorker | null = null;
      try {
        worker = (await pending).worker;
      } catch {
        // The worker never reached readiness; its failed start already cleaned up.
        return;
      }
      try {
        await worker.shutdown?.({ timeoutMs: 1_000 });
      } catch {
        // A worker that already died has nothing to shut down.
      }
      try {
        worker.dispose?.();
      } catch {
        // Best effort: dispose is local cleanup, never a calibration failure.
      }
    },
  };
}

function defaultWorkerFactory(
  options: WorkerCalibrationProbeOptions,
): () => EmbeddingBuildWorker {
  return () => {
    const workerPath =
      options.workerPath ?? resolveEmbeddingWorkerEntryForRuntime().path;
    return new EmbeddingWorkerClient({ workerPath });
  };
}

/**
 * Free bytes on the cache volume. `statfsSync` is a Node API that Bun builds
 * may not implement; either absence or a failed call answers
 * {@link EMBEDDING_DISK_FREE_UNSUPPORTED_BYTES} so an unsupported probe does
 * not read as a full disk (48-1 §6.6 keeps the pass non-blocking).
 */
export function readDiskFreeBytesDefault(): number {
  const statfs = (
    nodeFs as unknown as { statfsSync?: (path: string) => StatfsLike }
  ).statfsSync;
  if (typeof statfs !== "function")
    return EMBEDDING_DISK_FREE_UNSUPPORTED_BYTES;
  try {
    const stats = statfs(os.tmpdir());
    const availableBytes = stats.bavail ?? stats.free;
    if (
      typeof availableBytes !== "number" ||
      !Number.isFinite(availableBytes)
    ) {
      return EMBEDDING_DISK_FREE_UNSUPPORTED_BYTES;
    }
    const free = availableBytes * stats.bsize;
    return Number.isFinite(free) && free >= 0
      ? free
      : EMBEDDING_DISK_FREE_UNSUPPORTED_BYTES;
  } catch {
    return EMBEDDING_DISK_FREE_UNSUPPORTED_BYTES;
  }
}

// ---------------------------------------------------------------------------
// GPU probe (DirectML trial)
// ---------------------------------------------------------------------------

/**
 * The synthetic budget that grants the index build a GPU path. Only the three
 * fields `planEmbeddingBuildDevice` reads are meaningful; the rest are the
 * documented defaults so the object is a valid `EmbeddingCalibrationBudget`.
 */
export function createGpuTrialBudget(
  options: {
    readonly quantization?: EmbeddingQuantization;
    readonly totalMemoryBytes?: number;
    readonly threads?: number;
    readonly queryBudgetMs?: number;
  } = {},
): EmbeddingCalibrationBudget {
  return {
    tier: "small",
    calibrated: false,
    reason: "GPU trial budget: providers only, no measurements",
    timedOut: false,
    queryBudgetMs: options.queryBudgetMs ?? DEFAULT_QUERY_BUDGET_MS,
    threads: options.threads ?? DEFAULT_BUILD_THREADS,
    cpuArena: false,
    gpuRole: "index-only",
    gpuExecutionProvider: "dml",
    quantization: options.quantization ?? "float32",
    rssBytes: 0,
    diskFreeBytes: 0,
    diskHeadroomOk: true,
    totalMemoryBytes: options.totalMemoryBytes ?? os.totalmem(),
    batchTokensPerSec: 0,
    queryExecutionProviders: ["cpu"],
    buildExecutionProviders: ["dml", "cpu"],
  };
}

/** Options for {@link createDirectMlCalibrationProbe}. */
export interface DirectMlCalibrationProbeOptions {
  readonly assets: EmbeddingBuiltinAssets;
  /** Intra-op threads for the trial worker; `0`/absent lets the runtime decide. */
  readonly threads?: number;
  /** Budget that grants the GPU path; defaults to {@link createGpuTrialBudget}. */
  readonly budget?: EmbeddingCalibrationBudget;
  /** Worker factory for the real adapter; defaults to C3's client. */
  readonly createWorker?: () => EmbeddingBuildWorker;
  /** Test seam: replace the device adapter (never touches DirectML). */
  readonly createDeviceAdapter?: (
    options: CreateEmbeddingDeviceAdapterOptions,
  ) => Promise<EmbeddingDeviceAdapter>;
  /** Override the cold model-load window for the trial `init`. */
  readonly initTimeoutMs?: number;
  /** Called once when the GPU trial degraded to CPU. */
  readonly onDegrade?: CreateEmbeddingDeviceAdapterOptions["onDegrade"];
}

/**
 * The Windows/DirectML trial: initialise the build worker with `dml` first and
 * report whether the provider was accepted. The adapter falls back to CPU on
 * its own, so this probe distinguishes "GPU works" from "GPU refused" without
 * ever failing the calibration pass. The adapter is disposed before returning.
 */
export function createDirectMlCalibrationProbe(
  options: DirectMlCalibrationProbeOptions,
): EmbeddingGpuProbe {
  return {
    async probe(): Promise<EmbeddingGpuProbeResult> {
      const budget = options.budget ?? createGpuTrialBudget();
      const createDeviceAdapter =
        options.createDeviceAdapter ?? createEmbeddingDeviceAdapter;
      let adapter: EmbeddingDeviceAdapter | null = null;
      try {
        adapter = await createDeviceAdapter({
          budget,
          createWorker:
            options.createWorker ??
            (() =>
              new EmbeddingWorkerClient({
                workerPath: resolveEmbeddingWorkerEntryForRuntime().path,
              })),
          init: {
            runtimeDir: options.assets.runtimeDir,
            modelPath: options.assets.modelPath,
            tokenizerPath: options.assets.tokenizerPath,
            maxTokens: options.assets.manifest.maxTokens,
            ...(options.threads !== undefined && options.threads > 0
              ? { intraOpThreads: options.threads }
              : {}),
          },
          ...(options.initTimeoutMs === undefined
            ? {}
            : { initTimeoutMs: options.initTimeoutMs }),
          ...(options.onDegrade === undefined
            ? {}
            : { onDegrade: options.onDegrade }),
        });
        if (adapter.gpu) {
          return {
            ok: true,
            executionProvider:
              adapter.executionProviders.find(
                (provider) => provider !== "cpu",
              ) ?? "dml",
          };
        }
        return {
          ok: false,
          failure:
            adapter.degradedReason ??
            "DirectML initialisation did not accept the GPU execution provider.",
        };
      } catch (error) {
        // C5 redacts the reason; keep the raw error here.
        return { ok: false, failure: error };
      } finally {
        if (adapter !== null) {
          try {
            await adapter.dispose();
          } catch {
            // A trial worker that cannot be disposed must not fail calibration.
          }
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Pass wiring
// ---------------------------------------------------------------------------

/** Options for {@link runEmbeddingCalibration}. */
export interface RunEmbeddingCalibrationOptions {
  readonly settings: ResolvedEmbeddingSettings;
  readonly assets: EmbeddingBuiltinAssets;
  /** Prebuilt CPU probe (tests); otherwise a worker probe is created. */
  readonly probe?: EmbeddingWorkerCalibrationProbe;
  /** Prebuilt GPU probe; absent (or `off`) skips the trial. */
  readonly gpuProbe?: EmbeddingGpuProbe;
  /** Environment overrides (platform/core/memory/runtime). */
  readonly environment?: EmbeddingCalibrationEnvironmentOptions;
  /** Total pass budget; C5's default applies when omitted. */
  readonly budgetMs?: number;
  /** Injectable epoch clock for the pass deadline. */
  readonly now?: () => number;
  /** Injectable ISO timestamp for the snapshot. */
  readonly measuredAt?: string;
  /** Worker probe options when {@link probe} is absent. */
  readonly probeOptions?: Omit<WorkerCalibrationProbeOptions, "assets">;
}

/**
 * Run one bounded calibration pass and return its result plus the probe that
 * produced it. The caller owns `probe.dispose()`; nothing is persisted here
 * (D3/D6 write the snapshot).
 */
export async function runEmbeddingCalibration(
  options: RunEmbeddingCalibrationOptions,
): Promise<{
  result: EmbeddingCalibrationResult;
  probe: EmbeddingWorkerCalibrationProbe;
}> {
  const probe =
    options.probe ??
    createWorkerCalibrationProbe({
      assets: options.assets,
      ...(options.probeOptions ?? {}),
    });
  const result = await calibrateEmbedding({
    environment: buildEmbeddingCalibrationEnvironment(
      options.settings,
      options.assets,
      options.environment ?? {},
    ),
    probe,
    ...(options.gpuProbe === undefined ? {} : { gpuProbe: options.gpuProbe }),
    requestedGpuRole: options.settings.gpu,
    ...(options.budgetMs === undefined ? {} : { budgetMs: options.budgetMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.measuredAt === undefined
      ? {}
      : { measuredAt: options.measuredAt }),
  });
  return { result, probe };
}
