/**
 * Short-lived dream host (F-06 M1, route §2.3 proviso / §2.2 data flow).
 *
 * `haruyuki dream run --task <id>` is the only place a dream run happens. This
 * module is the thin wiring between the CLI and the frozen S1 controller:
 *
 * 1. resolve the task, refuse a malformed dream record (F1),
 * 2. repair a previously crashed run (`recoverStaleDreamRuns`) — the only
 *    production call site of M2's crash recovery (R-5.8.4); it runs before S1
 *    because S1 owns the dream lock and the baseline (see the comment there),
 * 3. enforce the explicit-configuration hard gate (R-5.9.4),
 * 4. for an automatic occurrence, re-check the trigger (route §2.2 "二次校验")
 *    and record `nextEligibleAt` when the conditions went away,
 * 5. advance the dream signal's attempt counter (the daily budget/cooldown),
 * 6. hand the lifecycle to S1 `runDreamTask` — locks, baseline, hidden session,
 *    subagent, budget, finishing, **and the in-flight run marker** are all M2's.
 *    The host deliberately does not touch `running`/`lastOutcome`: S1 records the
 *    precise dream status (`succeeded` / `budget_exhausted` / `cancelled` /
 *    `timeout` / `failed`) that the signal and `/dream status` read, and a
 *    coarse `RunOutcome` written here would overwrite it (Lead ruling, T1 M1).
 *
 * The run itself is executed under the shared F-05 run envelope
 * (`runScheduledTaskWithHost`), so a dream run gets the same timeout/cancel
 * semantics as every other task and S1 never has to reimplement them. With
 * `timeout_minutes: 0` the envelope arms no timer; the time limit that matters
 * is `dreamTimeLimitMinutes`, owned by S1.
 */

import { readDreamActivity } from "@/agent/dream/dream-activity";
import { isDreamRunLive } from "@/agent/dream/dream-liveness";
import { readDreamPressure } from "@/agent/dream/dream-pressure";
import { recoverDreamRuns } from "@/agent/dream/dream-recovery";
import { runDreamTask } from "@/agent/dream/dream-run";
import {
  getScheduleTask,
  getTask,
  serializeDreamTaskPayload,
  updateTask,
} from "@/cron";
import type {
  RunOutcome,
  ScheduleTaskV2,
  TaskRunnerPort,
} from "@/cron/cron-types";
import {
  deferDreamSignal,
  evaluateDreamEligibility,
  markDreamAttempt,
  readDreamSignalState,
  validateDreamTaskForRun,
} from "@/cron/dream-signal";
import {
  isScheduledTaskPreflightError,
  runScheduledTaskWithHost,
  type ScheduledTaskHostPort,
  ScheduledTaskPreflightError,
} from "@/cron/task-run";
import {
  type ResolvedDreamSettings,
  readDreamSettings,
} from "@/dream-settings";
import { debugWarn } from "@/utils/debug";

export interface DreamRunTaskResultLike {
  outcome: RunOutcome;
  error?: string;
}

/** Seams so M1 can be tested with a fake controller and a frozen clock. */
export interface DreamHostDeps {
  /** Defaults to the S1 seam (`agent/dream/dream-run`); M2 replaces the body. */
  runDreamTask?: (input: {
    task: ScheduleTaskV2;
    runId: string;
    occurrence: string;
    signal: AbortSignal;
    /** T2's S1 input gained this optional flag (manual /dream run). */
    manual?: boolean;
  }) => Promise<DreamRunTaskResultLike>;
  readSettings?: (agentId: string) => ResolvedDreamSettings;
  readPressure?: (agentId: string) => number;
  readLastActiveAt?: (agentId: string) => number | null;
  /**
   * Crash recovery (R-5.8.4). Defaults to T2's production entry
   * `recoverDreamRuns()`; the seam lets tests assert the call order without
   * touching git, the memory lock or a real backend.
   */
  recoverStaleRuns?: () => Promise<unknown>;
  now?: () => Date;
}

export interface DreamHostRunInput {
  taskId: string;
  runId: string;
  /** Occurrence the run owns; `manual:<iso>` for a `/dream run`. */
  occurrence: string;
  signal: AbortSignal;
  /** Manual runs bypass the trigger checks but still need explicit config. */
  manual: boolean;
  /** `/dream run --budget`: one run only, restored afterwards. */
  budgetOverrideTokens?: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface AppliedBudgetOverride {
  /** Payload this run wrote; the CAS restore only acts while it is still current. */
  appliedPayload: string;
  /** Payload that was there before (may be `undefined` = no payload field). */
  previousPayload: string | undefined;
}

/**
 * Apply a one-run budget override to the persisted payload (temporarily).
 *
 * The payload is the only channel S1 has for a per-run budget (frozen input
 * shape), so the override is written before the run and removed after it. Kept
 * separate from the restore so the restore can be compare-and-set: a crash
 * between the two used to leave the override behind forever.
 */
function applyBudgetOverride(
  taskId: string,
  budgetOverrideTokens: number | undefined,
): AppliedBudgetOverride | null {
  if (
    budgetOverrideTokens === undefined ||
    !Number.isFinite(budgetOverrideTokens) ||
    budgetOverrideTokens <= 0
  ) {
    return null;
  }
  const record = getTask(taskId);
  if (!record) return null;
  const appliedPayload = serializeDreamTaskPayload({
    version: 1,
    budgetOverrideTokens: Math.trunc(budgetOverrideTokens),
  });
  updateTask(taskId, (task) => {
    task.payload = appliedPayload;
  });
  return { appliedPayload, previousPayload: record.payload };
}

/**
 * Compare-and-set restore (Lead fix): only put the old payload back if the
 * record still holds the override this run wrote. A user or another command
 * that edited the task during the run keeps its edit instead of being silently
 * overwritten; a leftover override is cleaned by T2's stale-state recovery.
 */
function restoreBudgetOverride(
  taskId: string,
  override: AppliedBudgetOverride | null,
): void {
  if (!override) return;
  try {
    updateTask(taskId, (task) => {
      if (task.payload !== override.appliedPayload) return;
      task.payload = override.previousPayload;
    });
  } catch {
    // The run's outcome must not be replaced by a cleanup failure; the stale
    // override is cleared by the dream recovery pass.
  }
}

/**
 * Run one dream task. Throws `ScheduledTaskPreflightError` for a record that
 * cannot be run at all (F1); every other failure is a result (F2/F3) so the
 * scheduler core can apply the normal failure accounting.
 */
export async function runDreamHost(
  input: DreamHostRunInput,
  deps: DreamHostDeps = {},
): Promise<DreamRunTaskResultLike> {
  const now = deps.now?.() ?? new Date();
  const task = getScheduleTask(input.taskId);
  if (!task) {
    throw new ScheduledTaskPreflightError(
      `dream task ${input.taskId} does not exist`,
    );
  }
  if (task.type !== "dream") {
    throw new ScheduledTaskPreflightError(
      `task ${input.taskId} is not a dream task`,
    );
  }
  const malformed = validateDreamTaskForRun(task);
  if (malformed) throw new ScheduledTaskPreflightError(malformed);

  // ── Crash recovery, before this run builds anything (R-5.8.4) ───────
  // A run that died leaves a dead dream lease + a stale conversation record;
  // `recoverStaleDreamRuns` rolls the memory checkout back to that run's
  // baseline, writes `unfinished`, drops the lease and clears the signal marker.
  //
  // Placement: at the host entry, i.e. **before** S1 takes the dream lock and
  // creates the baseline. T1 cannot interpose *after* the lock — S1 owns the
  // lock order (dream → memory) and the baseline, and T1 must not take the
  // dream lock itself (it is not reentrant). Recovery is safe here because it
  // only acts on leases whose owner process is dead, it is idempotent, and it
  // repairs the previous run before S1 creates this run's baseline, so the
  // rollback target can never be the new run. It never throws; a broken harness
  // home must not stop the run.
  try {
    await (deps.recoverStaleRuns ?? recoverDreamRuns)();
  } catch (error) {
    debugWarn(
      "dream",
      `stale dream run recovery failed: ${errorMessage(error)}`,
    );
  }

  const settings = (deps.readSettings ?? readDreamSettings)(task.agentId);
  // R-5.9.4 / Q-09: explicit configuration is a hard gate for every trigger,
  // including `/dream run`.
  if (!settings.enabled) {
    return {
      outcome: "skipped",
      error:
        "dream is not enabled: finish the dream configuration first (/dream config)",
    };
  }

  if (!input.manual) {
    // Route §2.2: the long-lived host already judged the trigger due, and this
    // is the second, authoritative check in the process that owns the run.
    // Liveness is T2's `isDreamRunLive` (marker + lease + owner + age bound), not
    // a bare marker: this process has not created its own lease yet, so a live
    // answer means another child for this agent is genuinely running (F3 skip),
    // and a crash remnant no longer counts as one.
    const state = readDreamSignalState(task.agentId);
    const eligibility = evaluateDreamEligibility({
      task,
      settings,
      state,
      now,
      pressure: (deps.readPressure ?? readDreamPressure)(task.agentId),
      lastActiveAt: (deps.readLastActiveAt ?? readDreamActivity)(task.agentId),
      isRunning: isDreamRunLive(task.agentId, now),
    });
    if (!eligibility.eligible) {
      deferDreamSignal({
        agentId: task.agentId,
        now,
        reason: eligibility.reason,
        settings,
      });
      return {
        outcome: "skipped",
        error: `dream is not due right now (${eligibility.reason})`,
      };
    }
  }

  const budgetOverride = applyBudgetOverride(
    input.taskId,
    input.budgetOverrideTokens,
  );
  const effectiveTask =
    budgetOverride === null ? task : (getScheduleTask(input.taskId) ?? task);

  markDreamAttempt({
    agentId: effectiveTask.agentId,
    now,
    occurrence: input.occurrence,
    manual: input.manual,
  });

  let result: DreamRunTaskResultLike;
  try {
    // T2's S1 input gained an optional `manual` flag; the seam's type carries it
    // so the two tracks can change at the same time without a signature break.
    const controller: NonNullable<DreamHostDeps["runDreamTask"]> =
      deps.runDreamTask ?? ((controllerInput) => runDreamTask(controllerInput));
    result = await controller({
      task: effectiveTask,
      runId: input.runId,
      occurrence: input.occurrence,
      signal: input.signal,
      manual: input.manual,
    });
  } catch (error) {
    // F1 must stay F1: `ScheduledTaskPreflightError` is how the scheduler core
    // tells "nothing this run could start" (no streak-pausing F2) from a real
    // mid-run failure. Flattening it into a plain `failed` result downgraded an
    // F1 to F2 and counted it toward auto-pause (Lead fix).
    if (error instanceof ScheduledTaskPreflightError) throw error;
    if (isScheduledTaskPreflightError(error)) throw error;
    result = { outcome: "failed", error: errorMessage(error) };
  } finally {
    restoreBudgetOverride(input.taskId, budgetOverride);
  }

  if (input.signal.aborted && result.outcome !== "success") {
    result = {
      outcome: "cancelled",
      ...(result.error ? { error: result.error } : {}),
    };
  }
  // The in-flight marker and `lastOutcome` are S1's (Lead ruling, T1 M1): it
  // writes the precise dream status around this call and clears the marker in
  // its own `finally`. Writing them here would overwrite that status.
  return result;
}

export interface DreamTaskRunnerOptions {
  /** `/dream run`: skip the trigger checks. */
  manual: boolean;
  budgetOverrideTokens?: number;
  /** Test seams (failed controller, frozen clock). */
  deps?: DreamHostDeps;
  now?: () => number;
}

/**
 * The `TaskRunnerPort` of the short-lived dream host.
 *
 * The scheduler core still drives the run (lease, occurrence consumption,
 * run-log row, failure streak); this port only answers "run this dream". A
 * `canRun` of `type === "dream"` means the core treats the task as runnable,
 * and `task-run`'s dream branch routes the body to `runDream` — it can never
 * fall through to `runPrompt` (route C-13).
 */
export function createDreamTaskRunner(
  options: DreamTaskRunnerOptions,
): TaskRunnerPort {
  const now = options.now ?? Date.now;
  const controllers = new Map<string, AbortController>();

  const host: ScheduledTaskHostPort = {
    // A dream run creates its own hidden session, so there is no conversation
    // to wait for; the dream lock (S1) is the real single-instance gate.
    isTargetBusy: () => false,
    // Defence in depth: task-run throws before ever reaching this for a dream.
    runPrompt: async () => {
      throw new ScheduledTaskPreflightError(
        "a dream task must never run through the prompt runner",
      );
    },
    runDream: async ({ task, runId, occurrence, signal }) => {
      const result = await runDreamHost(
        {
          taskId: task.id,
          runId,
          occurrence,
          signal,
          manual: options.manual,
          ...(options.budgetOverrideTokens !== undefined
            ? { budgetOverrideTokens: options.budgetOverrideTokens }
            : {}),
        },
        options.deps ?? {},
      );
      return {
        outcome: result.outcome,
        ...(result.error !== undefined ? { error: result.error } : {}),
      };
    },
  };

  return {
    host: "short-lived",
    canRun: (task) => task.type === "dream",
    async run({ task, runId, occurrence, signal }) {
      const controller = new AbortController();
      const onOuterAbort = () => controller.abort();
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onOuterAbort, { once: true });
      controllers.set(runId, controller);
      try {
        return await runScheduledTaskWithHost({
          task,
          runId,
          occurrence,
          signal: controller.signal,
          host,
          now,
        });
      } finally {
        controllers.delete(runId);
        signal.removeEventListener("abort", onOuterAbort);
      }
    },
    cancel(runId) {
      controllers.get(runId)?.abort();
    },
  };
}
