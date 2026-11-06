/**
 * Background build loop for the vector index (feature 48, package A3).
 *
 * This module is the orchestration the host starts once a space is configured:
 * it owns the space lock and lease, derives the batch size, walks the units one
 * at a time, and after each unit commits the order that makes a kill safe —
 * **B3 build → B2 write (single pointer rename) → A2 state checkpoint**. It is
 * pure orchestration in the same sense as B3: no UI, no CLI, no network, no
 * model. `embed` (an adapter around C3's worker or C6's endpoint) and the clock
 * are injected, so the loop runs on either runtime and is tested without a
 * model.
 *
 * Rules this loop implements (48-1 §6.8, 48-2 §4.2/§4.4/§4.8):
 *
 * - **Batch size from throughput.** A batch never exceeds 32 chunks and never
 *   exceeds 1,700 estimated tokens (≈200 ms at 8.8k tok/s), because ORT's
 *   `session.run` cannot be preempted: cancellation latency is one batch. When
 *   C5 measured a batch throughput, the token budget is lowered to
 *   `throughput × 200 ms` first; every batch then satisfies the lower bound
 *   because its chunks are capped by the unit's largest chunk.
 * - **Checkpoint per unit.** A unit is "done" when its generation is committed
 *   by B2 and the state file records it. A kill loses at most the unit in
 *   flight; a resumed run reuses the committed vectors through B3's `previous`
 *   snapshot instead of re-embedding them.
 * - **Failure is per unit.** An embed or write error records that unit as a
 *   failure and moves on, never aborting the whole build (48-1 §6.9).
 * - **Cancellation is cooperative.** The signal/predicate is checked between
 *   units and inside B3 between parents/batches. Aborting writes a `cancelled`
 *   checkpoint and keeps every committed generation.
 * - **The lock is the mutex.** A live lock owned by another process is a typed
 *   rejection (`lock_held`), not an exception; a lost lock stops the loop
 *   because another builder may own the space.
 *
 * Rate and ETA are A2's (persisted rolling sample window), exposed through
 * {@link EmbeddingRunResult.state} and the optional `onProgress` hook. Progress
 * throttling (≤0.5 Hz) belongs to the host (A5/D6), not here; this module emits
 * at most one snapshot per checkpoint (initial, per unit, terminal).
 *
 * Resuming recounts instead of trusting the old counters: `state.json` is a
 * witness, the committed index pointer is the checkpoint (A2's contract), so a
 * resumed run reports how many chunks this pass verified/reused rather than
 * carrying the killed process's last counter forward. Reused vectors are still
 * counted as progress, so a finished resumed build reports
 * `embeddedChunks === totalChunks`.
 *
 * Layer: `backend/local/embedding*`. Imports only sibling A2/B2/B3 public API,
 * the C5 budget type and the protocol leaf types; no `cli/`, `websocket/`,
 * `reminders/` or `agent/` import.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { EmbeddingCalibrationBudget } from "@/backend/local/embedding/calibration";
import type { EmbeddingBuildMode } from "@/types/embedding-protocol";
import {
  buildEmbeddingIndex,
  type EmbeddingBuildResult,
  type EmbeddingEmbedCallback,
} from "./embedding-build";
import {
  type EmbeddingBuildDeviceSnapshot,
  type EmbeddingBuildIdentity,
  type EmbeddingBuildProgressUpdate,
  type EmbeddingBuildStateRecord,
  type EmbeddingBuildStateSnapshot,
  embeddingBuildStatePath,
  isTerminalBuildPhase,
  readEmbeddingBuildState,
  snapshotEmbeddingBuildState,
  updateEmbeddingBuildState,
} from "./embedding-build-state";
import {
  clearEmbeddingCrossProcessCancel,
  readEmbeddingCrossProcessCancel,
} from "./embedding-cancel";
import type { EmbeddingChunk, EmbeddingChunkPlan } from "./embedding-chunk";
import {
  type EmbeddingIndexQuant,
  type EmbeddingIndexSnapshot,
  type EmbeddingParentLineSpan,
  type EmbeddingVectorUnit,
  embeddingVectorUnitDir,
  getRecallVectorsRoot,
  readEmbeddingIndex,
  writeEmbeddingIndex,
} from "./embedding-format";
import { pruneEmbeddingGenerations } from "./embedding-generation-prune";
import {
  createEmbeddingLeaseForLock,
  type EmbeddingLeaseHandle,
  heartbeatEmbeddingBuildLockAndLease,
} from "./embedding-lease";
import {
  acquireEmbeddingBuildLock,
  type EmbeddingBuildLockEnvironment,
  type EmbeddingBuildLockHandle,
} from "./embedding-lock";
import {
  type EmbeddingProfile,
  writeEmbeddingProfileBestEffort,
} from "./embedding-profile";
import { dequantizeEmbeddingVectors } from "./embedding-quant";
import {
  type EmbeddingQuantIndexSnapshot,
  readEmbeddingQuantIndex,
  writeEmbeddingQuantIndex,
} from "./embedding-quant-format";
import { maybeWriteAnnSidecar } from "./embedding-runner-ann";

/** Chunks per `embed` call when no other limit applies (48-2 §4.4). */
export const EMBEDDING_RUN_MAX_CHUNKS_PER_BATCH = 32;

/** Estimated tokens per `embed` call: ≈200 ms at the measured 8.8k tok/s. */
export const EMBEDDING_RUN_MAX_TOKENS_PER_BATCH = 1_700;

/** Batch latency the throughput inference targets, in ms. */
export const EMBEDDING_RUN_TARGET_BATCH_MS = 200;

/** Lock/lease heartbeat cadence while units run (lock stale window is 120s). */
export const EMBEDDING_RUN_HEARTBEAT_INTERVAL_MS = 30_000;

/** Upper bound on a persisted failure message; callers must already redact. */
const MAX_FAILURE_MESSAGE_CHARS = 300;

/**
 * Thrown from the heartbeat-wrapped `embed` when the space lock is no longer
 * ours; the unit loop turns it into the typed `lock_lost` rejection.
 */
class EmbeddingLockLostError extends Error {
  constructor() {
    super("The build lost the space lock while embedding.");
    this.name = "EmbeddingLockLostError";
  }
}

/** Same component rule B2 applies to path segments; keeps space dirs inside. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** One unit of work: one conversation or one memory file. */
export type EmbeddingRunUnit = {
  /** B2 unit identity; its `agentId`/`spaceId` must match the run identity. */
  unit: EmbeddingVectorUnit;
  /** B1 plans for the unit; input order is preserved (determinism). */
  plans: readonly EmbeddingChunkPlan[];
  /** Memory units only: line-span resolver forwarded to B2's record mapper. */
  parentLineSpan?: (
    chunk: EmbeddingChunk,
  ) => EmbeddingParentLineSpan | undefined;
};

/** Inputs that decide the chunk/token size of one batch. */
export type EmbeddingRunBatchOptions = {
  /** Chunk ceiling; explicit callers may exceed 32. Default 32. */
  batchSize?: number;
  /** Token ceiling. Default 1,700; never raised by throughput inference. */
  tokenBudgetPerBatch?: number;
  /** Latency the throughput inference targets. Default 200 ms. */
  targetBatchLatencyMs?: number;
  /** C5's measured batch throughput; 0/absent means "unmeasured". */
  batchTokensPerSec?: number;
};

/** The derived batch shape plus the inputs it was derived from. */
export type EmbeddingRunBatchPlan = {
  chunkBatchSize: number;
  tokenBudget: number;
  /** Largest `estimatedTokens` among the unit's chunks (0 for no chunks). */
  maxChunkTokens: number;
};

/**
 * Derives the chunks-per-call for one unit. Size is
 * `min(chunk ceiling, floor(tokenBudget / largestChunkTokens))`, so a batch of
 * that many chunks is guaranteed to stay inside the token budget even though
 * B3 batches by count only.
 */
export function resolveEmbeddingRunBatchSize(
  plans: readonly EmbeddingChunkPlan[],
  options: EmbeddingRunBatchOptions = {},
): EmbeddingRunBatchPlan {
  let maxChunkTokens = 0;
  for (const plan of plans) {
    for (const chunk of plan.chunks) {
      if (chunk.estimatedTokens > maxChunkTokens) {
        maxChunkTokens = chunk.estimatedTokens;
      }
    }
  }
  const hardTokenCap = positiveIntegerOr(
    options.tokenBudgetPerBatch,
    EMBEDDING_RUN_MAX_TOKENS_PER_BATCH,
  );
  const latencyMs = positiveIntegerOr(
    options.targetBatchLatencyMs,
    EMBEDDING_RUN_TARGET_BATCH_MS,
  );
  let tokenBudget = hardTokenCap;
  const throughput = options.batchTokensPerSec;
  if (
    throughput !== undefined &&
    Number.isFinite(throughput) &&
    throughput > 0
  ) {
    const measured = Math.floor((throughput * latencyMs) / 1_000);
    tokenBudget = Math.min(hardTokenCap, Math.max(1, measured));
  }
  const chunkCap = positiveIntegerOr(
    options.batchSize,
    EMBEDDING_RUN_MAX_CHUNKS_PER_BATCH,
  );
  const tokensPerChunk = Math.max(1, maxChunkTokens);
  const chunksByTokens = Math.max(1, Math.floor(tokenBudget / tokensPerChunk));
  return {
    chunkBatchSize: Math.max(1, Math.min(chunkCap, chunksByTokens)),
    tokenBudget,
    maxChunkTokens,
  };
}

/** Why the whole run could not proceed; none of these are exceptions. */
export type EmbeddingRunErrorCode =
  | "invalid_input"
  | "lock_held"
  | "lock_busy"
  | "lock_failed"
  | "lease_held"
  | "lease_failed"
  | "lock_lost"
  | "state_failed";

/** Why one unit was skipped; the run continues with the next unit. */
export type EmbeddingRunUnitFailureCode =
  | "invalid_unit"
  | "embed_failed"
  | "write_failed";

/** One unit that failed in this run (mirrored into the A2 failure list). */
export type EmbeddingRunUnitFailure = {
  unitId: string;
  kind: "conversation" | "memory";
  code: EmbeddingRunUnitFailureCode;
  message: string;
};

/** Fatal rejection of the whole run. */
export type EmbeddingRunError = {
  code: EmbeddingRunErrorCode;
  message: string;
  unitId?: string;
};

export type EmbeddingRunStatus = "completed" | "aborted" | "failed";

/** Everything a host needs to report a finished, cancelled or rejected run. */
export type EmbeddingRunResult = {
  status: EmbeddingRunStatus;
  aborted: boolean;
  buildId: string;
  mode: EmbeddingBuildMode;
  totalUnits: number;
  completedUnits: number;
  failedUnits: number;
  /** Chunks whose previous vector was reused (no `embed` call). */
  reusedChunks: number;
  /** Chunks embedded by this run. */
  embeddedChunks: number;
  elapsedMs: number;
  /** Frozen A2 projection after the last checkpoint write; `null` if rejected early. */
  state: EmbeddingBuildStateSnapshot | null;
  /** Unit failures from this run (A2's state also keeps its bounded list). */
  unitFailures: readonly EmbeddingRunUnitFailure[];
  /** Present only when `status === "failed"`. */
  error?: EmbeddingRunError;
};

/** Everything the host injects into one build. */
export type EmbeddingRunnerOptions = {
  /** One `(agentId, spaceId)` per run; the state file and lock live here. */
  identity: EmbeddingBuildIdentity;
  /** Units to build, in order. Materialized once, so pass an array in production. */
  units: Iterable<EmbeddingRunUnit>;
  /** A3's adapter around C3's worker or C6's endpoint. Required. */
  embed: EmbeddingEmbedCallback;
  /** Model id recorded in every index generation. Required. */
  modelId: string;
  /** `full` forces reuse off through `reuse: false`; default `incremental`. */
  mode?: EmbeddingBuildMode;
  /** Resume hint; on an interrupted state (running/cancelling) it is preserved. */
  buildId?: string;
  /** Recall-vectors root; defaults to A2/B2's `getRecallVectorsRoot()`. */
  root?: string;
  /** Space directory; defaults to `<root>/<agentId>/<spaceId>`. */
  spaceDir?: string;
  /** Space width; learned from the previous snapshot or the first vector. */
  dimensions?: number;
  /** C5's derived budget: `batchTokensPerSec` lowers the batch token budget. */
  budget?: EmbeddingCalibrationBudget;
  /** Explicit chunk ceiling (wins over the default 32; token cap still applies). */
  batchSize?: number;
  /** Explicit token ceiling; defaults to 1,700. */
  tokenBudgetPerBatch?: number;
  /** Explicit target latency for the throughput inference. */
  targetBatchLatencyMs?: number;
  /**
   * Storage precision of the space being built. `int8` writes codes only (no
   * float32 originals: the `int8-only` mode chosen for 0.6.0), so an existing
   * int8 generation is dequantized for reuse. Defaults to `f32`.
   */
  quant?: EmbeddingIndexQuant;
  /**
   * `false` forces a full rebuild (`--full`, model/space switch). Defaults to
   * `true`, except under `mode: "full"` where it defaults to `false`.
   */
  reuse?: boolean;
  /** Heartbeat cadence; ≤0 heartbeats before every unit (tests). */
  heartbeatIntervalMs?: number;
  /** Lease TTL; default 120s (matches the lock stale window). */
  leaseTtlMs?: number;
  /** Injectable clock for elapsed/state/lock/lease. Defaults to `Date.now`. */
  clock?: () => number;
  /** Cooperative cancellation, checked between units and inside B3. */
  signal?: AbortSignal;
  /** Predicate form of cancellation (host's cancel sentinel). */
  isAborted?: () => boolean;
  /** Called after every checkpoint with the frozen A2 projection. */
  onProgress?: (snapshot: EmbeddingBuildStateSnapshot) => void;
  /**
   * Test seam for 48-2 §4.10's ANN sidecar trigger (200,000 chunks). Production
   * leaves it unset; only the sidecar write consults it.
   */
  annTriggerChunkCount?: number;
  /** Injectable lock environment (clock/pid/host/token/isPidAlive). */
  lockEnvironment?: EmbeddingBuildLockEnvironment;
  /**
   * Device facts of this run (48-4 D-02). Written with every checkpoint so a
   * status read can prove which execution providers the worker accepted.
   */
  device?: EmbeddingBuildDeviceSnapshot;
  /**
   * The space profile (48-4 D-10). Written once this run owns the lock, so a
   * build that never started cannot leave a profile describing a space it did
   * not touch.
   */
  profile?: EmbeddingProfile;
};

/**
 * Runs one build to completion, cancellation or a fatal rejection.
 *
 * Never throws for expected failures (lock held, embed failure, write failure):
 * they come back in the typed result. On abort the committed generations are
 * untouched and the state file holds a `cancelled` checkpoint.
 */
export async function runEmbeddingBuild(
  options: EmbeddingRunnerOptions,
): Promise<EmbeddingRunResult> {
  const clock = options.clock ?? Date.now;
  const startedAtMs = clock();
  let mode: EmbeddingBuildMode = options.mode ?? "incremental";
  let buildId = options.buildId ?? randomUUID();
  const failures: EmbeddingRunUnitFailure[] = [];
  let completedUnits = 0;
  let failedUnits = 0;
  let reusedChunks = 0;
  let embeddedChunks = 0;
  let embeddedChars = 0;
  let totalUnits = 0;
  let totalChunks = 0;
  let totalRecallableChars = 0;
  let lastState: EmbeddingBuildStateRecord | null = null;
  /** Chunks whose vector exists in the committed index (reused + embedded). */
  const progressChunks = (): number => reusedChunks + embeddedChunks;

  const result = (
    status: EmbeddingRunStatus,
    extra: { aborted?: boolean; error?: EmbeddingRunError } = {},
  ): EmbeddingRunResult => ({
    status,
    aborted: extra.aborted ?? status === "aborted",
    buildId,
    mode,
    totalUnits,
    completedUnits,
    failedUnits,
    reusedChunks,
    embeddedChunks,
    elapsedMs: Math.max(0, clock() - startedAtMs),
    state: lastState === null ? null : snapshotEmbeddingBuildState(lastState),
    unitFailures: [...failures],
    ...(extra.error === undefined ? {} : { error: extra.error }),
  });
  const reject = (
    code: EmbeddingRunErrorCode,
    message: string,
    unitId?: string,
  ): EmbeddingRunResult =>
    result("failed", {
      error: { code, message, ...(unitId === undefined ? {} : { unitId }) },
    });

  // ── Construction ────────────────────────────────────────────────────────
  const identity = options.identity;
  if (
    !identity ||
    !isSafeSegment(identity.agentId) ||
    !isSafeSegment(identity.spaceId)
  ) {
    return reject(
      "invalid_input",
      "The run identity needs a safe non-empty agentId and spaceId.",
    );
  }
  if (typeof options.modelId !== "string" || options.modelId.length === 0) {
    return reject("invalid_input", "The run needs a non-empty modelId.");
  }
  if (typeof options.embed !== "function") {
    return reject("invalid_input", "The run needs an embed callback.");
  }
  let units: EmbeddingRunUnit[];
  try {
    units = Array.from(options.units);
  } catch {
    return reject("invalid_input", "The units input is not iterable.");
  }

  const root = options.root ?? getRecallVectorsRoot();
  const spaceDir =
    options.spaceDir ?? join(root, identity.agentId, identity.spaceId);
  const statePath = embeddingBuildStatePath(spaceDir);

  try {
    for (const runUnit of units) {
      totalUnits += 1;
      if (!Array.isArray(runUnit?.plans)) continue;
      for (const plan of runUnit.plans) {
        totalChunks += plan.chunks.length;
        totalRecallableChars += plan.coverage.recallableChars;
      }
    }
  } catch {
    return reject(
      "invalid_input",
      "The units input has a malformed plan; fix the chunker output before building.",
    );
  }

  // ── Resume marker ───────────────────────────────────────────────────────
  let resumeState: EmbeddingBuildStateRecord | null = null;
  try {
    const read = await readEmbeddingBuildState(statePath, {
      agentId: identity.agentId,
      spaceId: identity.spaceId,
      clock,
    });
    if (read.status === "ok") resumeState = read.state;
  } catch {
    // A2's reader never throws for file problems; a synchronous failure here
    // means the path itself is unusable and the first checkpoint will report it.
    resumeState = null;
  }
  if (resumeState !== null) {
    if (options.mode === undefined) mode = resumeState.mode;
    if (
      options.buildId === undefined &&
      resumeState.buildId !== null &&
      !isTerminalBuildPhase(resumeState.phase)
    ) {
      buildId = resumeState.buildId;
    }
  }

  // ── Lock + lease ────────────────────────────────────────────────────────
  const lockEnvironment: EmbeddingBuildLockEnvironment = {
    ...options.lockEnvironment,
    clock: options.lockEnvironment?.clock ?? clock,
  };
  let lock: EmbeddingBuildLockHandle;
  try {
    const acquired = await acquireEmbeddingBuildLock(
      spaceDir,
      { agentId: identity.agentId, spaceId: identity.spaceId },
      lockEnvironment,
    );
    if (!acquired.ok) {
      const code: EmbeddingRunErrorCode =
        acquired.reason === "busy" ? "lock_busy" : "lock_held";
      const holder = acquired.record;
      const detail =
        holder === null
          ? "a contender is reaping a stale lock"
          : `${holder.host} pid ${holder.pid}`;
      return reject(
        code,
        acquired.reason === "held_by_self"
          ? "This process already owns the space build lock."
          : `Another builder owns the space lock (${detail}).`,
      );
    }
    lock = acquired.handle;
  } catch (error) {
    return reject(
      "lock_failed",
      `The space build lock could not be acquired: ${errorMessage(error)}`,
    );
  }

  let lease: EmbeddingLeaseHandle;
  try {
    const acquiredLease = await createEmbeddingLeaseForLock(lock, {
      clock,
      ...(options.leaseTtlMs === undefined
        ? {}
        : { ttlMs: options.leaseTtlMs }),
      ...(options.lockEnvironment?.isPidAlive === undefined
        ? {}
        : { isPidAlive: options.lockEnvironment.isPidAlive }),
    });
    if (!acquiredLease.ok) {
      await lock.release().catch(() => false);
      return reject(
        "lease_held",
        `Another builder holds the space lease (${acquiredLease.record.host} pid ${acquiredLease.record.pid}).`,
      );
    }
    lease = acquiredLease.handle;
  } catch (error) {
    await lock.release().catch(() => false);
    return reject(
      "lease_failed",
      `The space lease could not be acquired: ${errorMessage(error)}`,
    );
  }

  // A request left by a previous owner must not cancel this run; once the lock
  // and lease are ours, the space has no other builder to address.
  clearEmbeddingCrossProcessCancel(spaceDir);
  // The profile describes the space this run owns; writing it before the lock
  // would leave a description behind when another builder owns the space.
  if (options.profile !== undefined) {
    await writeEmbeddingProfileBestEffort(spaceDir, options.profile);
  }

  try {
    /** Read → merge → write one checkpoint; a null return means it worked. */
    const checkpoint = async (
      update: EmbeddingBuildProgressUpdate,
    ): Promise<EmbeddingRunError | null> => {
      try {
        const updated = await updateEmbeddingBuildState(
          statePath,
          { agentId: identity.agentId, spaceId: identity.spaceId, clock },
          options.device === undefined
            ? update
            : { ...update, device: options.device },
          { clock },
        );
        lastState = updated.state;
        options.onProgress?.(snapshotEmbeddingBuildState(updated.state));
        return null;
      } catch (error) {
        return {
          code: "state_failed",
          message: `The build checkpoint could not be written: ${errorMessage(error)}`,
        };
      }
    };
    const unitFailure = async (
      unitId: string,
      kind: EmbeddingRunUnitFailure["kind"],
      code: EmbeddingRunUnitFailureCode,
      message: string,
    ): Promise<EmbeddingRunError | null> => {
      const failure: EmbeddingRunUnitFailure = {
        unitId,
        kind,
        code,
        message: truncateMessage(message),
      };
      failures.push(failure);
      failedUnits += 1;
      return checkpoint({
        embeddedChunks: progressChunks(),
        totalChunks,
        processedConversations: completedUnits + failedUnits,
        totalConversations: totalUnits,
        embeddedChars,
        recallableChars: totalRecallableChars,
        failure: {
          conversationId: unitId,
          code,
          message: failure.message,
        },
      });
    };

    const resumeStartedAt =
      resumeState !== null && !isTerminalBuildPhase(resumeState.phase)
        ? (resumeState.startedAt ?? undefined)
        : undefined;
    const initialError = await checkpoint({
      buildId,
      mode,
      phase: "running",
      embeddedChunks: 0,
      totalChunks,
      processedConversations: 0,
      totalConversations: totalUnits,
      embeddedChars: 0,
      recallableChars: totalRecallableChars,
      ...(resumeStartedAt === undefined ? {} : { startedAt: resumeStartedAt }),
    });
    if (initialError !== null) return result("failed", { error: initialError });

    const batchOptions: EmbeddingRunBatchOptions = {
      batchSize: options.batchSize,
      tokenBudgetPerBatch: options.tokenBudgetPerBatch,
      targetBatchLatencyMs: options.targetBatchLatencyMs,
      batchTokensPerSec: options.budget?.batchTokensPerSec,
    };
    const heartbeatIntervalMs =
      options.heartbeatIntervalMs ?? EMBEDDING_RUN_HEARTBEAT_INTERVAL_MS;
    let lastHeartbeatAt = clock();
    let aborted = false;
    let lockLost = false;

    /** Refreshes the lock/lease when due; `false` means the lock is no longer ours. */
    const refreshLockIfDue = async (): Promise<boolean> => {
      const now = clock();
      if (now - lastHeartbeatAt < heartbeatIntervalMs) return true;
      let alive = false;
      try {
        alive = await heartbeatEmbeddingBuildLockAndLease(lock, lease);
      } catch {
        alive = false;
      }
      lastHeartbeatAt = now;
      return alive;
    };

    /**
     * `embed` with a heartbeat between batches. A single unit may embed for
     * longer than the lock's stale window (a slow endpoint, a large
     * conversation); heartbeating only between units would let the lock go
     * stale mid-unit and a second builder could reap it while this one still
     * writes. The wrapper keeps the lock fresh at the same granularity as
     * cancellation (one batch).
     */
    const embedWithHeartbeat: EmbeddingEmbedCallback = async (chunks) => {
      if (!(await refreshLockIfDue())) {
        lockLost = true;
        throw new EmbeddingLockLostError();
      }
      return options.embed(chunks);
    };

    for (const runUnit of units) {
      if (
        abortRequested(options) ||
        readEmbeddingCrossProcessCancel(spaceDir) !== null
      ) {
        aborted = true;
        break;
      }
      if (!(await refreshLockIfDue())) {
        lockLost = true;
        break;
      }

      if (!runUnit || !runUnit.unit) {
        const stateError = await unitFailure(
          "unknown",
          "conversation",
          "invalid_unit",
          "The unit has no B2 identity.",
        );
        if (stateError !== null) return result("failed", { error: stateError });
        continue;
      }
      const unit = runUnit.unit;
      const unitId = unitKeyOf(unit);
      const kind = unitKindOf(unit);
      if (
        !Array.isArray(runUnit.plans) ||
        unit.agentId !== identity.agentId ||
        unit.spaceId !== identity.spaceId
      ) {
        const stateError = await unitFailure(
          unitId,
          kind,
          "invalid_unit",
          "The unit's identity or plans do not belong to this space.",
        );
        if (stateError !== null) return result("failed", { error: stateError });
        continue;
      }

      let unitDir: string;
      try {
        unitDir = embeddingVectorUnitDir(unit, { root });
      } catch (error) {
        const stateError = await unitFailure(
          unitId,
          kind,
          "invalid_unit",
          errorMessage(error),
        );
        if (stateError !== null) return result("failed", { error: stateError });
        continue;
      }

      // A previous generation is a reuse source; a damaged one is ignored and
      // the unit is simply rebuilt (never guessed, 48-1 §6.3).
      let previous: EmbeddingIndexSnapshot | null = null;
      try {
        if ((options.quant ?? "f32") === "int8") {
          // Int8-only storage keeps no float32 originals; the reuse lookup still
          // needs row vectors, so this unit's codes are decoded here (one unit,
          // not the space). The approximation is bounded by the same quantizer
          // the query path uses.
          const loaded = readEmbeddingQuantIndex(unitDir, {
            includeFloat32: false,
          });
          if (loaded.ok) previous = floatSnapshotFromQuant(loaded.snapshot);
        } else {
          const loaded = readEmbeddingIndex(unitDir);
          if (loaded.ok) previous = loaded.snapshot;
        }
      } catch {
        previous = null;
      }

      const batch = resolveEmbeddingRunBatchSize(runUnit.plans, batchOptions);
      let built: EmbeddingBuildResult;
      try {
        built = await buildEmbeddingIndex(runUnit.plans, {
          embed: embedWithHeartbeat,
          previous,
          reuse: options.reuse ?? mode !== "full",
          batchSize: batch.chunkBatchSize,
          ...(options.dimensions === undefined
            ? {}
            : { dimensions: options.dimensions }),
          ...(runUnit.parentLineSpan === undefined
            ? {}
            : { parentLineSpan: runUnit.parentLineSpan }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...(options.isAborted === undefined
            ? {}
            : { isAborted: options.isAborted }),
        });
      } catch (error) {
        // The heartbeat-wrapped `embed` aborted the unit because the space
        // lock is gone; that is not an embed failure and must not be recorded
        // as one.
        if (lockLost) break;
        const stateError = await unitFailure(
          unitId,
          kind,
          "embed_failed",
          errorMessage(error),
        );
        if (stateError !== null) return result("failed", { error: stateError });
        continue;
      }

      if (built.aborted) {
        // B3 keeps a contiguous prefix in memory only; the committed generation
        // is still the previous one, so nothing is written for this unit.
        aborted = true;
        break;
      }

      const dimensions =
        options.dimensions ??
        built.vectors[0]?.length ??
        previous?.meta.dimensions;
      try {
        const writeGeneration = (
          width: number,
          records: typeof built.records,
          vectors: typeof built.vectors,
        ): void => {
          if ((options.quant ?? "f32") === "int8") {
            writeEmbeddingQuantIndex({
              unitDir,
              unit,
              modelId: options.modelId,
              dimensions: width,
              records,
              vectors,
              coverage: built.coverage,
              rescore: false,
            });
            return;
          }
          writeEmbeddingIndex({
            unitDir,
            unit,
            modelId: options.modelId,
            dimensions: width,
            records,
            vectors,
            coverage: built.coverage,
          });
        };
        if (built.records.length > 0) {
          if (dimensions === undefined || !isPositiveInteger(dimensions)) {
            throw new Error(
              "Cannot write an index without the space dimensions.",
            );
          }
          writeGeneration(dimensions, built.records, built.vectors);
        } else if (dimensions !== undefined && isPositiveInteger(dimensions)) {
          // A now lexical-only unit still gets an empty generation so the old
          // vectors cannot be mistaken for current ones.
          writeGeneration(dimensions, [], []);
        }
      } catch (error) {
        const stateError = await unitFailure(
          unitId,
          kind,
          "write_failed",
          errorMessage(error),
        );
        if (stateError !== null) return result("failed", { error: stateError });
        continue;
      }

      // Bound disk growth: the commit above makes the older generations
      // unreachable, except for the immediate previous one a concurrent query
      // may still be reading. Cleanup is best effort and never fails a build.
      pruneEmbeddingGenerations(unitDir);

      completedUnits += 1;
      reusedChunks += built.reusedChunks;
      embeddedChunks += built.embeddedChunks;
      embeddedChars += built.coverage.embeddedChars;
      const stateError = await checkpoint({
        phase: "running",
        embeddedChunks: progressChunks(),
        totalChunks,
        processedConversations: completedUnits + failedUnits,
        totalConversations: totalUnits,
        embeddedChars,
        recallableChars: totalRecallableChars,
      });
      if (stateError !== null) return result("failed", { error: stateError });
    }

    if (lockLost) {
      const lost: EmbeddingRunError = {
        code: "lock_lost",
        message:
          "The build lost the space lock; another builder may own the space now.",
      };
      await checkpoint({
        phase: "failed",
        embeddedChunks: progressChunks(),
        totalChunks,
        processedConversations: completedUnits + failedUnits,
        totalConversations: totalUnits,
        embeddedChars,
        recallableChars: totalRecallableChars,
      });
      return result("failed", { error: lost });
    }

    const terminalPhase = aborted ? "cancelled" : "completed";
    const terminalError = await checkpoint({
      phase: terminalPhase,
      embeddedChunks: progressChunks(),
      totalChunks,
      processedConversations: completedUnits + failedUnits,
      totalConversations: totalUnits,
      embeddedChars,
      recallableChars: totalRecallableChars,
    });
    if (terminalError !== null) {
      return result("failed", { error: terminalError });
    }
    if (!aborted) {
      maybeWriteAnnSidecar(options, units, root, identity, totalChunks);
    }
    return result(aborted ? "aborted" : "completed");
  } finally {
    clearEmbeddingCrossProcessCancel(spaceDir);
    await lease.release().catch(() => false);
    await lock.release().catch(() => false);
  }
}

/** True when either cancellation form has fired. */
function abortRequested(options: EmbeddingRunnerOptions): boolean {
  if (options.signal?.aborted === true) return true;
  return options.isAborted?.() === true;
}

function unitKeyOf(unit: EmbeddingVectorUnit): string {
  if ("memoryFileKey" in unit) {
    return typeof unit.memoryFileKey === "string"
      ? unit.memoryFileKey
      : "unknown";
  }
  return typeof unit.conversationKey === "string"
    ? unit.conversationKey
    : "unknown";
}

function unitKindOf(
  unit: EmbeddingVectorUnit,
): EmbeddingRunUnitFailure["kind"] {
  return "memoryFileKey" in unit ? "memory" : "conversation";
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function positiveIntegerOr(value: unknown, fallback: number): number {
  return isPositiveInteger(value) ? value : fallback;
}

function isSafeSegment(value: unknown): value is string {
  return (
    typeof value === "string" &&
    SAFE_SEGMENT.test(value) &&
    value !== "." &&
    value !== ".."
  );
}

/** Collapse and bound a message before it reaches `state.json`. */
function truncateMessage(message: string): string {
  const collapsed = message.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return "unknown error";
  return collapsed.length > MAX_FAILURE_MESSAGE_CHARS
    ? `${collapsed.slice(0, MAX_FAILURE_MESSAGE_CHARS)}…`
    : collapsed;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return truncateMessage(error.message);
  if (typeof error === "string") return truncateMessage(error);
  return "unknown error";
}

/**
 * A float32 view of an int8-only generation, for B3's reuse lookup.
 *
 * The lookup's contract is "same parent, same textHash, same spans → copy the
 * old vector". The row is decoded from its codes and scale; the approximation
 * is the storage format's own, and a reused vector is immediately re-quantized
 * by the writer, so no exactness is lost beyond what int8-only already chose.
 */
function floatSnapshotFromQuant(
  index: EmbeddingQuantIndexSnapshot,
): EmbeddingIndexSnapshot {
  const dimensions = index.meta.dimensions;
  return {
    unitDir: index.unitDir,
    generation: index.generation,
    pointer: index.pointer,
    meta: { ...index.meta, quant: "f32" },
    records: index.records.map(({ vectorScale: _scale, ...record }) => record),
    vectors: dequantizeEmbeddingVectors({
      dimensions,
      count: index.records.length,
      codes: index.codes,
      scales: index.scales,
    }),
  };
}
