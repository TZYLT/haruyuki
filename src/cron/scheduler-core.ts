/**
 * Scheduler core (F-05, M1).
 *
 * The one place that turns "signals say these occurrences are due" into at most
 * one started run per tick: de-dup by occurrence, delegate the run to
 * `scheduler-run`, record via `scheduler-recovery`, and leave the rest for the
 * following ticks (Q-42).
 *
 * Both hosts call this. Nothing here knows about the listener, the TUI, or any
 * concrete feature: a host supplies a runner, the core supplies the policy.
 */

import { ensureCronSignalSourceRegistered } from "./cron-signal";
import {
  getScheduleTask,
  readScheduleFile,
  toScheduleTaskV2,
} from "./cron-store";
import type {
  CronTask,
  DueOccurrence,
  RunOutcome,
  ScheduleTaskV2,
  TaskRunnerPort,
} from "./cron-types";
import { cronMatchesTime } from "./parse-interval";
import type { CronPromptTiming } from "./prompt";
import { formatCronPrompt } from "./prompt";
import {
  applyInvalidRecurringTask,
  applyMissedOneShot,
  MISSED_GRACE_MS,
  persistSignalCursors,
  recordMissedRecurring,
  recordMissingScheduleRunner,
  recoverExpiredLeases,
  resetMissingRunnerDedup,
} from "./scheduler-recovery";
import { executeRun } from "./scheduler-run";
import { evaluateSignalsWithCursors, nextSignalDueAt } from "./signal";

export { classifyRunFailure } from "./scheduler-run";
export {
  applyInvalidRecurringTask,
  applyMissedOneShot,
  recordMissingScheduleRunner,
};

// ── Tick input/result ───────────────────────────────────────────────

export interface SchedulerTickInput {
  now: Date;
  /** Which host is ticking — it decides the lease's `host` field. */
  runner: TaskRunnerPort;
  /**
   * Host-side task filter (the listener's backend scope). Every task passes
   * when omitted; the TUI host runs `"all"` and omits it.
   */
  includeTask?: (task: ScheduleTaskV2) => boolean;
}

export interface SchedulerTickResult {
  /** The task this tick started, or null when nothing was due. */
  started: ScheduleTaskV2 | null;
  /** Occurrences that were due but left for the following ticks (Q-42). */
  deferred: number;
  /**
   * Tasks whose due occurrence this host cannot run (`TaskRunnerPort.canRun`
   * said no) — the delegating host spawns a short-lived child for each of them
   * (P1-2). They are neither claimed nor consumed.
   */
  deferredTaskIds: string[];
  /** Missed occurrences recorded (no run). */
  missed: number;
  /** Occurrences skipped because the task lease belonged to another run. */
  skipped: number;
  /** Earliest instant the next tick has work (jitter / one-shot precision). */
  nextDueAt: Date | null;
}

// ── Legacy frozen helpers ───────────────────────────────────────────
//
// The v1 tick exported these from `scheduler.ts`. They are policy, not host
// wiring, so they live here now and `scheduler.ts` keeps the frozen names.

export function minuteKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function wrapCronPrompt(
  task: CronTask,
  timing: CronPromptTiming,
): string {
  return formatCronPrompt(task, timing);
}

export function shouldFireTask(task: CronTask, now: Date): boolean {
  if (!task.recurring && task.scheduled_for) {
    const scheduledMs =
      new Date(task.scheduled_for).getTime() + task.jitter_offset_ms;
    return scheduledMs <= now.getTime();
  }
  return cronMatchesTime(task.cron, now, task.timezone);
}

export function handleInvalidRecurringTask(task: CronTask, now: Date): boolean {
  return applyInvalidRecurringTask(toScheduleTaskV2(task), now);
}

export function handleMissedOneShot(task: CronTask, now: Date): boolean {
  return applyMissedOneShot(toScheduleTaskV2(task), now);
}

export function handleTaskPreflight(task: CronTask, now: Date): boolean {
  return (
    handleInvalidRecurringTask(task, now) || handleMissedOneShot(task, now)
  );
}

// ── Tick ────────────────────────────────────────────────────────────

function dueOrder(a: DueOccurrence, b: DueOccurrence): number {
  const diff = Date.parse(a.intendedAt) - Date.parse(b.intendedAt);
  if (diff !== 0) return diff;
  return (
    a.occurrence.localeCompare(b.occurrence) || a.taskId.localeCompare(b.taskId)
  );
}

/**
 * Occurrences this process already saw due but could not start (Q-42 queue
 * delay, M1 #6). A slot observed by a continuously ticking host was delayed by
 * the host itself, not missed by an absent one; a fresh process (after real
 * downtime) has no entry, so that occurrence is still recorded as missed.
 */
const observedDue = new Map<string, number>();

/** Forget tick-local memory (tests; a real host keeps it across ticks). */
export function __resetSchedulerTickState(): void {
  observedDue.clear();
  resetMissingRunnerDedup();
}

export async function runSchedulerTick(
  input: SchedulerTickInput,
): Promise<SchedulerTickResult> {
  const now = input.now;
  const include = input.includeTask ?? (() => true);
  ensureCronSignalSourceRegistered();

  const data = readScheduleFile();
  const tasks = data.tasks.map(toScheduleTaskV2).filter(include);

  // Kept from the v1 tick: legacy persisted crons surface one durable failure.
  for (const task of tasks) {
    if (task.status === "active") applyInvalidRecurringTask(task, now);
  }
  // Q-58: a dead executor is recorded as F2 and its occurrence is never rerun.
  recoverExpiredLeases(tasks, now);

  const active = tasks.filter((task) => task.status === "active");
  const byId = new Map(active.map((task) => [task.id, task]));
  const evaluation = evaluateSignalsWithCursors({
    now,
    tasks: active,
    state: data.signal_state,
  });
  persistSignalCursors(evaluation.cursors);
  const due = evaluation.occurrences
    .filter((occurrence) => byId.has(occurrence.taskId))
    .toSorted(dueOrder);

  // M1 #6: prune the queue-delay memory down to the occurrences still pending.
  const dueKeys = new Set(
    due.map((occurrence) => `${occurrence.taskId}|${occurrence.occurrence}`),
  );
  for (const key of [...observedDue.keys()]) {
    if (!dueKeys.has(key)) observedDue.delete(key);
  }

  let missed = 0;
  let cannotRun = 0;
  const deferredTaskIds = new Set<string>();
  const runnable: DueOccurrence[] = [];
  for (const occurrence of due) {
    const task = byId.get(occurrence.taskId);
    if (!task) continue;
    // P1-2: a task this host cannot run is delegated to the owning host; leave
    // the occurrence untouched (no claim, no consume, no failure, no event).
    if (input.runner.canRun && input.runner.canRun(task) === false) {
      deferredTaskIds.add(task.id);
      cannotRun += 1;
      continue;
    }
    const key = `${occurrence.taskId}|${occurrence.occurrence}`;
    const seenBefore = observedDue.has(key);
    if (!seenBefore) observedDue.set(key, now.getTime());
    const late =
      now.getTime() - Date.parse(occurrence.intendedAt) > MISSED_GRACE_MS;
    // Q-42 only delays recurring slots: a one-shot has a single retry window,
    // after which it is a real miss (M1 #5 retries it inside the grace window).
    const queued = task.recurring && seenBefore;
    if (!late || task.catchUp || queued) {
      // `queued` is the Q-42 distinction: the host was alive and busy when the
      // slot came due, so the slot is delayed rather than missed.
      runnable.push(occurrence);
      continue;
    }
    try {
      if (!task.recurring) {
        if (applyMissedOneShot(task, now)) missed += 1;
      } else if (recordMissedRecurring(task, occurrence, now)) {
        missed += 1;
      }
    } catch {
      // Lock contention: leave the slot for the next tick instead of crashing.
    }
  }

  let started: ScheduleTaskV2 | null = null;
  let skipped = 0;
  let deferred = cannotRun + (runnable.length > 0 ? runnable.length - 1 : 0);

  const chosen = runnable[0];
  if (chosen) {
    const task = byId.get(chosen.taskId);
    if (task) {
      const result = await executeRun({
        task,
        occurrence: chosen.occurrence,
        runner: input.runner,
        now,
        consume: true,
      });
      if (result.started) {
        started = getScheduleTask(task.id);
      } else if (result.leaseHeld) {
        skipped += 1;
        deferred += 1;
      }
    }
  }

  const after = readScheduleFile();
  const remaining = after.tasks.map(toScheduleTaskV2).filter(include);
  const nextDueAt = nextSignalDueAt({
    now,
    tasks: remaining.filter((task) => task.status === "active"),
  });

  return {
    started,
    deferred,
    deferredTaskIds: [...deferredTaskIds],
    missed,
    skipped,
    nextDueAt,
  };
}

/**
 * "Run now" from a host UI (T3's `/schedule run`).
 * Same lease, accounting and events as the automatic path, but it never
 * consumes the occurrence — a manual run must not swallow the next scheduled
 * fire (v1 behaviour, preserved).
 */

export async function runScheduledTaskNow(input: {
  taskId: string;
  runner: TaskRunnerPort;
  now?: Date;
}): Promise<{ started: boolean; outcome?: RunOutcome; error?: string }> {
  const task = getScheduleTask(input.taskId);
  if (!task) return { started: false, error: "Schedule not found" };
  if (task.status !== "active" && task.status !== "paused") {
    return {
      started: false,
      error: "Completed schedules cannot run again",
    };
  }
  const now = input.now ?? new Date();
  const occurrence = `manual:${now.toISOString()}`;
  const result = await executeRun({
    task,
    occurrence,
    runner: input.runner,
    now,
    consume: false,
  });
  if (result.started) {
    return {
      started: true,
      outcome: result.outcome,
      ...(result.error ? { error: result.error } : {}),
    };
  }
  if (result.leaseHeld) {
    return { started: false, error: "Task is already running" };
  }
  return {
    started: false,
    error: result.error ?? "Failed to run schedule",
  };
}
