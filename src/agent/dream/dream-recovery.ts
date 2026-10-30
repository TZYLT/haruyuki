/**
 * Crash recovery for dream runs (F-06 M2, requirement R-5.8.4 / route §2.6).
 *
 * A run that dies without reaching a terminal path leaves two pieces of state
 * behind: the dream lease (breadcrumb with the run id, baseline SHA and hidden
 * conversation) and the conversation's `dream` record, which still says
 * `running`. Recovery turns that into a bounded, idempotent repair:
 *
 * 1. only leases whose owner process is **dead** are touched — a live owner is
 *    a running run (F3 territory, not recovery);
 * 2. roll the memory checkout back to the baseline **if** the baseline is known
 *    and the memory lock can be taken (otherwise leave the lease for the next
 *    attempt: a busy checkout means a writer is alive, and rolling back under it
 *    would corrupt its work);
 * 3. write the run record as `unfinished`, with a handoff saying the run
 *    crashed and was rolled back (or that repair needs a human);
 * 4. write the one-sentence report and the zero-token ledger marker, clear the
 *    signal "running" marker and delete the lease.
 *
 * **Failure counting is not done here.** The F-05 task-lease recovery
 * (`scheduler-recovery.ts`) already classifies a crashed *task* lease as F2 and
 * updates the task's streak; counting again here would double-penalise the same
 * crash. This module only repairs the dream-specific state.
 */

import { writeDreamRunMetadata } from "@/agent/dream-run-metadata";
import { getScopedMemoryFilesystemRoot } from "@/agent/memory-filesystem";
import { claimMemoryOperation } from "@/agent/memory-operation";
import { getBackend } from "@/backend";
import { markDreamRunFinished } from "@/cron/dream-signal";
import type { DreamRunMetadata } from "@/types/dream-run-metadata";
import { readDreamRunMetadata } from "@/types/dream-run-metadata";
import { recordAutomatedRunMarker } from "@/usage/automated";
import { debugWarn } from "@/utils/debug";
import { getErrorMessage } from "@/utils/error";
import { rollbackDreamBaseline } from "./dream-baseline";
import { clearDreamBudgetOverride } from "./dream-budget-override";
import {
  type DreamRunLease,
  deleteDreamLease,
  isDreamLeaseOwnerAlive,
  listDreamLeases,
} from "./dream-lease";
import { writeDreamReport } from "./dream-report";

export interface DreamRecoveryDeps {
  listLeases(): DreamRunLease[];
  isOwnerAlive(lease: DreamRunLease): boolean;
  deleteLease(agentId: string): void;
  memoryDir(agentId: string): string;
  acquireMemoryLock(memoryDir: string): Promise<(() => Promise<void>) | null>;
  rollbackBaseline(input: {
    memoryDir: string;
    baselineSha: string;
  }): Promise<{ changed: boolean }>;
  readRunMetadata(
    conversationId: string,
  ): Promise<DreamRunMetadata | undefined>;
  writeRunMetadata(input: {
    conversationId: string;
    metadata: DreamRunMetadata;
  }): Promise<void>;
  writeReport(input: {
    agentId: string;
    conversationId: string;
    metadata: DreamRunMetadata;
    body: string;
  }): Promise<{ reportPath: string | null; committed: boolean }>;
  recordMarker(input: {
    runId: string;
    agentId: string;
    sessionId: string;
  }): Promise<void>;
  markRunFinished(agentId: string, outcome: string, at: Date): void;
  /**
   * Clear a stale `/dream run --budget` override left on the task record by the
   * crashed run. Optional so the repair loop is testable without the schedule
   * store; production wires it to `clearDreamBudgetOverride`.
   */
  clearBudgetOverride?(taskId: string): void;
  now(): Date;
}

export interface DreamRecoveryResult {
  /** Leases repaired into `unfinished`. */
  recovered: number;
  /** Live leases: a run is in progress (or paused) and recovery must not touch it. */
  live: number;
  /** Dead leases that could not be repaired yet (busy memory lock, broken repo). */
  deferred: number;
  /** Lease files that could not be parsed at all (counted, then ignored). */
  unreadable: number;
}

function reportBodyFor(lease: DreamRunLease, rolledBack: boolean): string {
  const lines = [
    `The dream run did not finish: its process died before the run reached a terminal state.`,
    rolledBack
      ? `The memory checkout was rolled back to the run's baseline (${lease.baselineSha ?? "unknown"}).`
      : `The memory checkout could not be rolled back and was left in place for inspection.`,
    `No further work was done for this run; the next run starts from the same tier plan.`,
  ];
  return `${lines.join("\n\n")}\n`;
}

/**
 * Repair every dead dream run. Never throws: recovery runs on the startup path
 * and a single broken lease must not prevent the others from being repaired.
 */
export async function recoverStaleDreamRuns(
  deps: DreamRecoveryDeps,
): Promise<DreamRecoveryResult> {
  const result: DreamRecoveryResult = {
    recovered: 0,
    live: 0,
    deferred: 0,
    unreadable: 0,
  };
  let leases: DreamRunLease[];
  try {
    leases = deps.listLeases();
  } catch (error) {
    debugWarn(
      "memory",
      `dream recovery: could not list leases: ${getErrorMessage(error)}`,
    );
    return { ...result, unreadable: result.unreadable + 1 };
  }
  for (const lease of leases) {
    if (deps.isOwnerAlive(lease)) {
      result.live += 1;
      continue;
    }
    if (!lease.conversationId) {
      // Crashed before the hidden session existed: the only durable effects are
      // the baseline commit and (possibly) a half-written record. Nothing to
      // roll back to a conversation; a baseline with no session has no record
      // the user can see, so drop the lease.
      if (lease.taskId) {
        try {
          deps.clearBudgetOverride?.(lease.taskId);
        } catch (error) {
          debugWarn(
            "memory",
            `dream recovery: could not clear the budget override for ${lease.taskId}: ${getErrorMessage(error)}`,
          );
        }
      }
      deps.deleteLease(lease.agentId);
      result.recovered += 1;
      continue;
    }

    // ── Already terminal? Just clean up ───────────────────────────────
    // The run may have finished (or been cancelled) and died between the
    // terminal record write and the lease delete. Rolling back then would
    // discard committed work and rewrite a correct record (R-5.8.2 / R-5.8.3).
    let existing: DreamRunMetadata | undefined;
    try {
      existing = await deps.readRunMetadata(lease.conversationId);
    } catch (error) {
      result.deferred += 1;
      debugWarn(
        "memory",
        `dream recovery: could not read the record for ${lease.runId}: ${getErrorMessage(error)}`,
      );
      continue;
    }
    if (existing && existing.status !== "running") {
      const now = deps.now();
      deps.markRunFinished(lease.agentId, existing.status, now);
      if (lease.taskId) {
        try {
          deps.clearBudgetOverride?.(lease.taskId);
        } catch (error) {
          debugWarn(
            "memory",
            `dream recovery: could not clear the budget override for ${lease.taskId}: ${getErrorMessage(error)}`,
          );
        }
      }
      deps.deleteLease(lease.agentId);
      result.recovered += 1;
      continue;
    }

    let releaseLock: (() => Promise<void>) | null = null;
    try {
      const memoryDir = deps.memoryDir(lease.agentId);
      releaseLock = await deps.acquireMemoryLock(memoryDir);
      if (!releaseLock) {
        // A live writer (reflection / memory worker) owns the checkout. Leave
        // the lease; retry on the next startup or tick.
        result.deferred += 1;
        continue;
      }

      let rolledBack = false;
      let rollbackError: string | undefined;
      if (lease.baselineSha) {
        try {
          const rollback = await deps.rollbackBaseline({
            memoryDir,
            baselineSha: lease.baselineSha,
          });
          rolledBack = true;
          void rollback;
        } catch (error) {
          rollbackError = getErrorMessage(error);
        }
      }

      const now = deps.now();
      const metadata: DreamRunMetadata = existing
        ? {
            ...existing,
            status: "unfinished",
            endedAt: now.getTime(),
            reportPath: existing.reportPath,
            handoff: rolledBack
              ? "The run crashed and its memory changes were rolled back. Start again from the same tier plan."
              : "The run crashed; its memory checkout could not be rolled back and needs inspection.",
          }
        : {
            runId: lease.runId,
            triggerSource: "scheduled",
            agentId: lease.agentId,
            conversationId: lease.conversationId,
            tierPlan: [],
            tierReached: null,
            startedAt: lease.startedAt,
            endedAt: now.getTime(),
            baselineSha: lease.baselineSha ?? "",
            budgetTokens: 0,
            spentTokens: 0,
            timeLimitMinutes: null,
            status: "unfinished",
            reportPath: null,
            handoff: "The run crashed before its record was written.",
          };

      try {
        const report = await deps.writeReport({
          agentId: lease.agentId,
          conversationId: lease.conversationId,
          metadata,
          body: reportBodyFor(lease, rolledBack),
        });
        // The viewer and `/dream status` find the report through the record.
        if (report.reportPath !== null) {
          metadata.reportPath = report.reportPath;
        }
      } catch (error) {
        debugWarn(
          "memory",
          `dream recovery: report write failed for ${lease.runId}: ${getErrorMessage(error)}`,
        );
      }

      try {
        await deps.writeRunMetadata({
          conversationId: lease.conversationId,
          metadata,
        });
      } catch (error) {
        debugWarn(
          "memory",
          `dream recovery: metadata write failed for ${lease.runId}: ${getErrorMessage(error)}`,
        );
        // The record is the only durable truth; without it the repair is not
        // complete, so keep the lease and try again.
        result.deferred += 1;
        continue;
      }

      try {
        await deps.recordMarker({
          runId: lease.runId,
          agentId: lease.agentId,
          sessionId: lease.conversationId,
        });
      } catch (error) {
        debugWarn(
          "usage",
          `dream recovery: ledger marker failed for ${lease.runId}: ${getErrorMessage(error)}`,
        );
      }

      deps.markRunFinished(lease.agentId, "unfinished", now);
      if (lease.taskId) {
        try {
          deps.clearBudgetOverride?.(lease.taskId);
        } catch (error) {
          debugWarn(
            "memory",
            `dream recovery: could not clear the budget override for ${lease.taskId}: ${getErrorMessage(error)}`,
          );
        }
      }
      deps.deleteLease(lease.agentId);
      result.recovered += 1;
      if (rollbackError) {
        debugWarn(
          "memory",
          `dream recovery: rollback failed for ${lease.runId} (left in place): ${rollbackError}`,
        );
      }
    } catch (error) {
      result.deferred += 1;
      debugWarn(
        "memory",
        `dream recovery: lease ${lease.runId} deferred: ${getErrorMessage(error)}`,
      );
    } finally {
      if (releaseLock) {
        try {
          await releaseLock();
        } catch {
          // Best effort.
        }
      }
    }
  }
  return result;
}

/** Production deps: real backend, real lock, real git. */
export function createDefaultDreamRecoveryDeps(): DreamRecoveryDeps {
  return {
    listLeases: () => {
      try {
        return listDreamLeases();
      } catch {
        return [];
      }
    },
    isOwnerAlive: (lease) => isDreamLeaseOwnerAlive(lease),
    deleteLease: (agentId) => deleteDreamLease(agentId),
    memoryDir: (agentId) => getScopedMemoryFilesystemRoot(agentId),
    acquireMemoryLock: (memoryDir) => claimMemoryOperation(memoryDir),
    async rollbackBaseline({ memoryDir, baselineSha }) {
      const result = await rollbackDreamBaseline({ memoryDir, baselineSha });
      return { changed: result.changed };
    },
    async readRunMetadata(conversationId) {
      const conversation = (await getBackend().retrieveConversation(
        conversationId,
      )) as unknown as { dream?: unknown };
      return readDreamRunMetadata(conversation.dream);
    },
    writeRunMetadata: ({ conversationId, metadata }) =>
      writeDreamRunMetadata({ conversationId, metadata }),
    writeReport: ({ agentId, conversationId, metadata, body }) =>
      writeDreamReport({ agentId, conversationId, metadata, body }),
    async recordMarker({ runId, agentId, sessionId }) {
      await recordAutomatedRunMarker({
        source: "dream",
        outcome: "failed",
        runId,
        agentId,
        sessionId,
        model: "unknown",
        wallMs: 0,
      });
    },
    markRunFinished: (agentId, outcome, at) =>
      markDreamRunFinished(agentId, outcome, at),
    clearBudgetOverride: (taskId) => {
      clearDreamBudgetOverride(taskId);
    },
    now: () => new Date(),
  };
}

/** Startup entry: repair whatever crashed runs are findable right now. */
export async function recoverDreamRuns(
  deps: DreamRecoveryDeps = createDefaultDreamRecoveryDeps(),
): Promise<DreamRecoveryResult> {
  return recoverStaleDreamRuns(deps);
}
