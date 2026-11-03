/**
 * GPU index-build path (48-2 §3.3 C8, 48-1 §5.3/R-24, calibration C5).
 *
 * **What this module is.** C5's calibration decides one thing about the GPU:
 * whether the *index build* may run on a DirectML execution provider
 * (`gpuRole: "index-only"`). Queries never do — a batch-1 GPU encode costs
 * 25ms median / 124ms p90 against ~2ms on CPU (48-1 §5.3), so the query path is
 * fixed to CPU by contract (`queryExecutionProviders: ["cpu"]`).
 *
 * This module is the seam between that decision and the embedding worker:
 *
 * 1. {@link planEmbeddingBuildDevice} turns a C5 budget into the ordered
 *    execution-provider list a build worker should initialise with (CPU always
 *    last, so ONNX Runtime can fall back per node).
 * 2. {@link createEmbeddingDeviceAdapter} starts and initialises a worker with
 *    those providers. If GPU initialisation fails (driver mismatch, antivirus
 *    interception, unsupported provider) it disposes that worker, records a
 *    redacted reason and retries the same init on CPU — a GPU failure must never
 *    block a build (48-1 §5.3 "降级": automatic fallback + recorded reason).
 * 3. {@link createEmbeddingQueryAdapter} is the query-side sibling: it always
 *    initialises on CPU, whatever the budget says.
 * 4. {@link createChunkEmbedCallback} adapts the device to A3/B2's
 *    `EmbeddingEmbedCallback` (`chunks → unit vectors`).
 *
 * **No runtime dependency.** The worker is injected as the small
 * {@link EmbeddingBuildWorker} port; production passes an
 * `EmbeddingWorkerClient`, tests pass fakes. Nothing here imports ORT, spawns a
 * process, touches the network or reads a clock, so the selection/fallback
 * rules are exercised without a GPU.
 *
 * Layer: `backend/local/` (leaf). Imports sibling embedding modules only.
 */

import type { EmbeddingEmbedCallback } from "@/backend/local/embedding-build";
import type { EmbeddingChunk } from "@/backend/local/embedding-chunk";
import type { EmbeddingCalibrationBudget } from "./calibration";
import type {
  EmbeddingWorkerEmbedOptions,
  EmbeddingWorkerEmbedOutput,
} from "./worker-client-types";
import type {
  EmbeddingWorkerInitOptions,
  EmbeddingWorkerInitResult,
} from "./worker-protocol";

/**
 * Execution providers a query encode always uses (48-1 §5.3: GPU is
 * index-only). Not configurable — C5 fixes the budget to the same list.
 */
export const EMBEDDING_QUERY_EXECUTION_PROVIDERS: readonly string[] = ["cpu"];

/** Resolved device role for one adapter: a build may be `index-only`. */
export type EmbeddingDeviceRole = "index-only" | "cpu";

/** Pure provider decision for one build, derived from C5's budget. */
export interface EmbeddingBuildDevicePlan {
  readonly role: EmbeddingDeviceRole;
  /** Providers to initialise with, in order; `cpu` is always last. */
  readonly executionProviders: readonly string[];
  /** The GPU provider the build is expected to use; `null` on the CPU path. */
  readonly gpuExecutionProvider: string | null;
}

/**
 * Decide which execution providers a build worker may use. The role is
 * `index-only` only when C5 resolved it *and* the budget names a non-CPU
 * provider; anything else (no budget, `off`, an empty/garbled list) resolves to
 * CPU, because a build must still finish when calibration data is missing.
 */
export function planEmbeddingBuildDevice(
  budget?: EmbeddingCalibrationBudget | null,
): EmbeddingBuildDevicePlan {
  const cpuOnly: EmbeddingBuildDevicePlan = {
    role: "cpu",
    executionProviders: [...EMBEDDING_QUERY_EXECUTION_PROVIDERS],
    gpuExecutionProvider: null,
  };
  if (budget === undefined || budget === null) return cpuOnly;
  if (budget.gpuRole !== "index-only") return cpuOnly;
  const requested = normalizeProviders(budget.buildExecutionProviders);
  const gpuProviders = requested.filter((provider) => provider !== "cpu");
  if (gpuProviders.length === 0) return cpuOnly;
  const preferred =
    typeof budget.gpuExecutionProvider === "string"
      ? budget.gpuExecutionProvider.trim().toLowerCase()
      : "";
  const gpuExecutionProvider = gpuProviders.includes(preferred)
    ? preferred
    : (gpuProviders[0] ?? null);
  return {
    role: "index-only",
    executionProviders: [
      ...gpuProviders,
      ...EMBEDDING_QUERY_EXECUTION_PROVIDERS,
    ],
    gpuExecutionProvider,
  };
}

/**
 * Providers a query encode uses. Always CPU (C5 contract); the budget is
 * accepted so callers can pass the same object to both paths, and deliberately
 * ignored so a mis-set budget cannot move queries onto the GPU.
 */
export function resolveQueryExecutionProviders(
  _budget?: EmbeddingCalibrationBudget | null,
): readonly string[] {
  return [...EMBEDDING_QUERY_EXECUTION_PROVIDERS];
}

function normalizeProviders(
  providers: readonly unknown[] | undefined,
): string[] {
  if (!Array.isArray(providers)) return [];
  const normalized: string[] = [];
  for (const provider of providers) {
    if (typeof provider !== "string") continue;
    const token = provider.trim().toLowerCase();
    if (token.length === 0 || normalized.includes(token)) continue;
    normalized.push(token);
  }
  return normalized;
}

/**
 * The small worker surface this module needs. `EmbeddingWorkerClient` satisfies
 * it structurally (its `embed` already decodes the worker's base64 payload into
 * `Float32Array`); tests inject a fake so no process is spawned.
 */
export interface EmbeddingBuildWorker {
  start(): Promise<unknown>;
  init(
    options: EmbeddingWorkerInitOptions,
    timeoutMs?: number,
  ): Promise<EmbeddingWorkerInitResult>;
  embed(
    texts: readonly string[],
    options?: EmbeddingWorkerEmbedOptions,
  ): Promise<EmbeddingWorkerEmbedOutput>;
  shutdown?(options?: { timeoutMs?: number }): Promise<void>;
  dispose?(): void;
}

/** Why the device adapter could not be created at all. */
export type EmbeddingGpuBuildPathErrorKind = "cpu-init-failed";

/** Typed failure: the GPU path degraded *and* the CPU retry also failed. */
export class EmbeddingGpuBuildPathError extends Error {
  readonly kind: EmbeddingGpuBuildPathErrorKind;
  /** Redacted GPU failure that triggered the fallback. */
  readonly gpuReason: string;
  /** Redacted CPU failure that ended the build path. */
  readonly cpuReason: string;

  constructor(
    kind: EmbeddingGpuBuildPathErrorKind,
    message: string,
    options: { gpuReason: string; cpuReason: string },
  ) {
    super(message);
    this.name = "EmbeddingGpuBuildPathError";
    this.kind = kind;
    this.gpuReason = options.gpuReason;
    this.cpuReason = options.cpuReason;
  }
}

/** Emitted when the GPU path failed and the CPU retry took over. */
export interface EmbeddingDeviceDegradeEvent {
  readonly requestedExecutionProviders: readonly string[];
  readonly fallbackExecutionProviders: readonly string[];
  /** Redacted, bounded reason safe to show in a status line. */
  readonly reason: string;
}

/** Options for {@link createEmbeddingDeviceAdapter}. */
export interface CreateEmbeddingDeviceAdapterOptions {
  /** C5's in-process budget; absent/`off` resolves to CPU. */
  readonly budget?: EmbeddingCalibrationBudget | null;
  /** Creates the (unstarted) worker; production passes `EmbeddingWorkerClient`. */
  readonly createWorker: () => EmbeddingBuildWorker;
  /** `init` payload minus `executionProviders` (the device plan decides them). */
  readonly init: Omit<EmbeddingWorkerInitOptions, "executionProviders">;
  /** Override the cold model-load window for `init`. */
  readonly initTimeoutMs?: number;
  /** Called once when the GPU path degrades, before the adapter is returned. */
  readonly onDegrade?: (event: EmbeddingDeviceDegradeEvent) => void;
}

/** One initialised worker plus the device decision that produced it. */
export interface EmbeddingDeviceAdapter {
  readonly role: EmbeddingDeviceRole;
  readonly executionProviders: readonly string[];
  /** True when `init` accepted the GPU providers. */
  readonly gpu: boolean;
  /** True when the requested GPU path failed and CPU took over. */
  readonly degraded: boolean;
  /** Redacted reason; present only when {@link degraded}. */
  readonly degradedReason?: string;
  /** The worker's `init` reply (dimension/runtime/warmup timing). */
  readonly initialization: EmbeddingWorkerInitResult;
  /**
   * Embed texts through the worker. `null` entries mean cancellation stopped
   * work before that text was encoded (same contract as the worker protocol).
   */
  embedTexts(
    texts: readonly string[],
    options?: EmbeddingWorkerEmbedOptions,
  ): Promise<readonly (Float32Array | null)[]>;
  /** Stop the worker (best effort: shutdown then dispose). */
  dispose(): Promise<void>;
}

interface AdapterState {
  readonly role: EmbeddingDeviceRole;
  readonly gpu: boolean;
  readonly degraded?: boolean;
  readonly degradedReason?: string;
}

/**
 * Create the index-build adapter. GPU providers are tried first only when C5
 * resolved `index-only`; on failure the worker is replaced and re-initialised on
 * CPU, the redacted reason is reported through `onDegrade`, and the returned
 * adapter still embeds (a GPU failure never blocks the build). Only when the
 * CPU retry also fails does this throw {@link EmbeddingGpuBuildPathError}.
 */
export async function createEmbeddingDeviceAdapter(
  options: CreateEmbeddingDeviceAdapterOptions,
): Promise<EmbeddingDeviceAdapter> {
  const plan = planEmbeddingBuildDevice(options.budget);
  if (plan.role === "cpu") {
    return initializeAdapter(options, plan.executionProviders, {
      role: "cpu",
      gpu: false,
    });
  }
  try {
    return await initializeAdapter(options, plan.executionProviders, {
      role: "index-only",
      gpu: true,
    });
  } catch (error) {
    const reason = sanitizeDeviceFailureReason(error);
    try {
      options.onDegrade?.({
        requestedExecutionProviders: plan.executionProviders,
        fallbackExecutionProviders: resolveQueryExecutionProviders(),
        reason,
      });
    } catch {
      // A status callback must never block the CPU fallback.
    }
    try {
      return await initializeAdapter(
        options,
        resolveQueryExecutionProviders(),
        { role: "cpu", gpu: false, degraded: true, degradedReason: reason },
      );
    } catch (cpuError) {
      const cpuReason = sanitizeDeviceFailureReason(cpuError);
      throw new EmbeddingGpuBuildPathError(
        "cpu-init-failed",
        `The embedding worker could not initialise on GPU (${reason}) or CPU (${cpuReason}).`,
        { gpuReason: reason, cpuReason },
      );
    }
  }
}

/**
 * Create the query-side adapter: always CPU (48-1 §5.3), regardless of what the
 * budget's build path resolved. No degrade event is emitted because the GPU path
 * is never attempted.
 */
export async function createEmbeddingQueryAdapter(
  options: CreateEmbeddingDeviceAdapterOptions,
): Promise<EmbeddingDeviceAdapter> {
  return initializeAdapter(
    options,
    resolveQueryExecutionProviders(options.budget),
    {
      role: "cpu",
      gpu: false,
    },
  );
}

async function initializeAdapter(
  options: CreateEmbeddingDeviceAdapterOptions,
  executionProviders: readonly string[],
  state: AdapterState,
): Promise<EmbeddingDeviceAdapter> {
  const worker = options.createWorker();
  try {
    await worker.start();
    const initialization = await worker.init(
      { ...options.init, executionProviders: [...executionProviders] },
      options.initTimeoutMs,
    );
    return {
      role: state.role,
      executionProviders: [...executionProviders],
      gpu: state.gpu,
      degraded: state.degraded === true,
      ...(state.degradedReason === undefined
        ? {}
        : { degradedReason: state.degradedReason }),
      initialization,
      async embedTexts(
        texts,
        embedOptions,
      ): Promise<readonly (Float32Array | null)[]> {
        const output = await worker.embed(texts, embedOptions);
        if (output.vectors.length !== texts.length) {
          throw new Error(
            `The embedding worker returned ${output.vectors.length} vectors for ${texts.length} texts.`,
          );
        }
        for (const vector of output.vectors) {
          if (vector !== null && vector.length !== initialization.dim) {
            throw new Error(
              `The embedding worker returned a ${vector.length}-dimensional vector for a ${initialization.dim}-dimensional model.`,
            );
          }
        }
        return output.vectors;
      },
      async dispose(): Promise<void> {
        await disposeWorker(worker);
      },
    };
  } catch (error) {
    await disposeWorker(worker);
    throw error;
  }
}

async function disposeWorker(worker: EmbeddingBuildWorker): Promise<void> {
  try {
    await worker.shutdown?.({ timeoutMs: 1_000 });
  } catch {
    // Best effort: the worker may already be gone.
  }
  try {
    worker.dispose?.();
  } catch {
    // Best effort: dispose is a local cleanup, never a build failure.
  }
}

/**
 * Adapter for A3/B2's chunk-based embed callback. Each chunk's text is encoded
 * through the device adapter; a cancelled (`null`) vector is an error because
 * the builder treats a short result as a failed unit and retries/skips it.
 */
const DEFAULT_CHUNK_TEXT = (chunk: EmbeddingChunk): string => chunk.text;

/** Options for {@link createChunkEmbedCallback}. */
export interface CreateChunkEmbedCallbackOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Override which chunk field is embedded (defaults to `chunk.text`). */
  readonly textOf?: (chunk: EmbeddingChunk) => string;
}

export function createChunkEmbedCallback(
  adapter: EmbeddingDeviceAdapter,
  options: CreateChunkEmbedCallbackOptions = {},
): EmbeddingEmbedCallback {
  const textOf = options.textOf ?? DEFAULT_CHUNK_TEXT;
  return async (chunks): Promise<readonly Float32Array[]> => {
    const embedOptions: EmbeddingWorkerEmbedOptions = {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs }),
    };
    const vectors = await adapter.embedTexts(
      chunks.map((chunk) => textOf(chunk)),
      embedOptions,
    );
    const resolved: Float32Array[] = [];
    for (let index = 0; index < vectors.length; index += 1) {
      const vector = vectors[index];
      if (vector === null || vector === undefined) {
        throw new Error(
          `The embedding worker cancelled before encoding chunk ${index}.`,
        );
      }
      resolved.push(vector);
    }
    return resolved;
  };
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bapi[_-]?key\s*[=:]\s*[^\s,;]+/gi,
];

const PATH_PATTERNS: readonly RegExp[] = [
  /[A-Za-z]:\\[^\s"'<>|]+/g,
  /\/(?:home|Users|tmp|var|opt|root|private)\/[^\s"'<>|]+/g,
];

/**
 * Turn a device failure into a short, safe reason for a status line / state
 * file: credentials, bearer tokens and absolute paths are stripped, newlines
 * collapsed, and the result bounded. Never throws — it is only diagnostics.
 */
export function sanitizeDeviceFailureReason(
  error: unknown,
  limit = 200,
): string {
  if (error === undefined || error === null) return "unknown device failure";
  let message: string;
  if (error instanceof Error) {
    message = error.message.length > 0 ? error.message : error.name;
  } else if (typeof error === "string") {
    message = error;
  } else {
    message = String(error);
  }
  let sanitized = message;
  for (const pattern of SECRET_PATTERNS)
    sanitized = sanitized.replace(pattern, "<redacted>");
  for (const pattern of PATH_PATTERNS)
    sanitized = sanitized.replace(pattern, "<path>");
  sanitized = sanitized.replace(/\s+/g, " ").trim();
  if (sanitized.length === 0) return "unknown device failure";
  if (sanitized.length <= limit) return sanitized;
  return `${sanitized.slice(0, Math.max(0, limit - 1))}…`;
}
