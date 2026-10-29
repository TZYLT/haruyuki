/**
 * Recovery, miss accounting and missing-runner accounting (F-05, M1).
 *
 * These paths decide what a due occurrence becomes when it was not run: a
 * crashed lease is recovered (P0-4), a stale recurring slot is a miss, a
 * skipped one-shot is retried until its grace window closes (M1 #5), and a host
 * without a runner reports one visible failure per occurrence (M1 #12).
 *
 * Every path rechecks under the store lock and delegates the failure counters to
 * `scheduler-run`'s `applyRunOutcome`, so two hosts cannot double-count.
 */

import { updateTask } from "./cron-file";
import {
  isTaskLeaseLive,
  recoverExpiredTaskLease,
  withLock,
} from "./cron-lease";
import { ensureCronSignalSourceRegistered } from "./cron-signal";
import {
  applyScheduleTaskV2,
  isCronRunReason,
  readScheduleFile,
  toScheduleTaskV2,
  writeScheduleFile,
} from "./cron-store";
import type {
  CronRunReason,
  DueOccurrence,
  ScheduleTaskV2,
} from "./cron-types";
import { isValidCron } from "./parse-interval";
import { safeAppendCronRunLogForTask } from "./run-log";
import { emitScheduleEvent } from "./schedule-events";
import {
  applyRunOutcome,
  hasTerminalRunLine,
  recordFor,
} from "./scheduler-run";
import { evaluateSignalsWithCursors } from "./signal";

/** R-5.10.3: a slot older than this is a miss, not a late on-time hit. */
export const MISSED_GRACE_MS = 90_000;
/** Occurrences already reported as "no runner" by this process (M1 #12). */
const missingRunnerRecorded = new Set<string>();

/** Test hook: a real host keeps the dedupe set for its whole lifetime. */
export function resetMissingRunnerDedup(): void {
  missingRunnerRecorded.clear();
}

// ── Legacy durability (kept from the v1 tick) ───────────────────────

function invalidCronError(cron: string): string {
  return `Invalid cron expression "${cron}". Delete and recreate this schedule.`;
}

function hasReportedInvalidCron(task: ScheduleTaskV2): boolean {
  return (
    task.lastOutcome === "failed" &&
    task.lastReason === "invalid_cron" &&
    task.lastError === invalidCronError(task.cron)
  );
}

/**
 * Persist a visible failure for legacy recurring tasks that predate current
 * cron validation, once. Kept task-active so the user can inspect and replace it
 * instead of silently dropping the definition.
 */
export function applyInvalidRecurringTask(
  task: ScheduleTaskV2,
  now: Date,
): boolean {
  if (!task.recurring || isValidCron(task.cron)) return false;
  if (hasReportedInvalidCron(task)) return true;

  const error = invalidCronError(task.cron);
  const runAtIso = now.toISOString();
  updateTask(task.id, (record) => {
    record.last_run_at = runAtIso;
    record.last_run_outcome = "failed";
    record.last_run_reason = "invalid_cron";
    record.last_run_error = error;
    record.failed_count = (record.failed_count ?? 0) + 1;
    record.consecutive_failures = (record.consecutive_failures ?? 0) + 1;
  });
  const record = recordFor(task.id);
  if (record) {
    safeAppendCronRunLogForTask(record, {
      status: "error",
      outcome: "failed",
      reason: "invalid_cron",
      error,
      runAtMs: now.getTime(),
    });
  }
  return true;
}

/** Record one missed one-shot exactly as the v1 tick did (R-5.10.4). */
export function applyMissedOneShot(task: ScheduleTaskV2, now: Date): boolean {
  if (task.recurring || !task.scheduledFor || task.status !== "active") {
    return false;
  }
  const scheduledMs = Date.parse(task.scheduledFor);
  if (!Number.isFinite(scheduledMs)) return false;
  if (now.getTime() <= scheduledMs + MISSED_GRACE_MS) return false;

  const candidateReason =
    task.lastOutcome === "failed"
      ? (task.lastReason ?? "scheduler_error")
      : "scheduler_inactive";
  const reason: CronRunReason = isCronRunReason(candidateReason)
    ? candidateReason
    : "scheduler_inactive";
  const error = task.lastOutcome === "failed" ? task.lastError : null;
  const scheduledFor = task.scheduledFor;
  const nowIso = now.toISOString();
  // M1 #4: the miss is recorded only if it is still the truth under the lock —
  // two hosts ticking together must not double-count the same slot.
  const recorded = withLock(() => {
    const data = readScheduleFile();
    const index = data.tasks.findIndex((candidate) => candidate.id === task.id);
    const record = index === -1 ? null : data.tasks[index];
    if (!record || record.status !== "active" || record.recurring) return false;
    const consumed = record.last_consumed_occurrence ?? null;
    if (consumed !== null && scheduledFor <= consumed) return false;

    const next = { ...record };
    next.status = "missed";
    next.missed_at = nowIso;
    next.last_missed_at = scheduledFor;
    next.last_run_at = nowIso;
    next.last_run_outcome = "missed";
    next.last_run_reason = reason;
    next.last_run_error = error ?? null;
    next.missed_count = (next.missed_count ?? 0) + 1;
    next.last_consumed_occurrence = scheduledFor;
    data.tasks[index] = next;
    writeScheduleFile(data);
    return true;
  });
  if (!recorded) return false;

  const record = recordFor(task.id);
  if (record) {
    safeAppendCronRunLogForTask(record, {
      status: "skipped",
      outcome: "missed",
      reason,
      summary: "missed",
      error: error ?? undefined,
      runAtMs: now.getTime(),
      scheduledFor: scheduledFor,
      missedCount: 1,
    });
  }
  emitScheduleEvent({
    kind: "task-missed",
    at: nowIso,
    taskId: task.id,
    taskName: task.name,
    agentId: task.agentId,
    occurrence: scheduledFor,
    missedCount: 1,
  });
  return true;
}

/**
 * Q-58 recovery: a lease whose holder is gone is an executor failure.
 *
 * `recoverExpiredTaskLease` clears the lease and consumes the occurrence it was
 * holding in one lock (P0-4), so a crashed run is never replayed — not even for
 * `catch_up` tasks — and two racing hosts recover it only once. The accounting
 * itself goes through the same helper as a live run (M1 #9), which is what gives
 * recovery its three-strike auto-pause and visible last outcome.
 */
export function recoverExpiredLeases(
  tasks: ScheduleTaskV2[],
  now: Date,
): number {
  let recovered = 0;
  for (const task of tasks) {
    const lease = task.lease;
    if (!lease || isTaskLeaseLive(lease, now)) continue;
    // A crashed run may have written its terminal line before dying without
    // releasing the lease: that line is the record, so do not count it twice.
    const alreadyRecorded = hasTerminalRunLine(task.id, lease.runId);
    let paused = false;
    const recoveredLease = recoverExpiredTaskLease(
      task.id,
      now,
      (view, deadLease) => {
        if (alreadyRecorded) return;
        paused = applyRunOutcome(view, {
          occurrence: deadLease.occurrence ?? "",
          runId: deadLease.runId,
          host: deadLease.host,
          outcome: "failed",
          failure: "F2",
          error: "lease_expired",
          conversationId: null,
          // The helper already consumed the leased occurrence.
          consume: false,
          dispatched: false,
          startedAt: Date.parse(deadLease.startedAt) || now.getTime(),
          finishedAt: now,
        });
      },
    );
    if (!recoveredLease) continue;
    if (alreadyRecorded) continue;

    const finishedIso = now.toISOString();
    const startedAtMs = Date.parse(recoveredLease.startedAt) || now.getTime();
    const record = recordFor(task.id);
    if (record) {
      safeAppendCronRunLogForTask(record, {
        status: "error",
        runOutcome: "failed",
        outcome: "failed",
        reason: "scheduler_error",
        error: "lease_expired",
        runId: recoveredLease.runId,
        host: recoveredLease.host,
        durationMs: Math.max(0, now.getTime() - startedAtMs),
        runAtMs: startedAtMs,
        firedAt: finishedIso,
      });
    }
    emitScheduleEvent({
      kind: "run-finished",
      at: finishedIso,
      taskId: task.id,
      taskName: task.name,
      agentId: task.agentId,
      runId: recoveredLease.runId,
      occurrence: recoveredLease.occurrence ?? undefined,
      outcome: "failed",
      error: "lease_expired",
      durationMs: Math.max(0, now.getTime() - startedAtMs),
    });
    if (paused) {
      emitScheduleEvent({
        kind: "task-paused",
        at: finishedIso,
        taskId: task.id,
        taskName: task.name,
        agentId: task.agentId,
        pausedReason: "auto_failures",
        error: "lease_expired",
      });
    }
    recovered += 1;
  }
  return recovered;
}

/** Missed recurring slots: no run, one log line, counted by slots (R-5.10.2). */
export function recordMissedRecurring(
  task: ScheduleTaskV2,
  occurrence: DueOccurrence,
  now: Date,
): boolean {
  const cycles = Math.max(1, occurrence.missedCycles ?? 1);
  const nowIso = now.toISOString();
  // M1 #4: recheck under the lock; the slot may already be consumed/recorded by
  // a racing host.
  const recorded = withLock(() => {
    const data = readScheduleFile();
    const index = data.tasks.findIndex((candidate) => candidate.id === task.id);
    const record = index === -1 ? null : data.tasks[index];
    if (!record || record.status !== "active" || !record.recurring)
      return false;
    const consumed = record.last_consumed_occurrence ?? null;
    if (consumed !== null && occurrence.occurrence <= consumed) return false;

    const next = { ...record };
    next.last_run_at = nowIso;
    next.last_run_outcome = "missed";
    next.last_run_reason = "scheduler_inactive";
    next.last_run_error = null;
    next.last_missed_at = occurrence.intendedAt;
    next.missed_count = (next.missed_count ?? 0) + cycles;
    next.last_consumed_occurrence = occurrence.occurrence;
    data.tasks[index] = next;
    writeScheduleFile(data);
    return true;
  });
  if (!recorded) return false;

  const record = recordFor(task.id);
  if (record) {
    safeAppendCronRunLogForTask(record, {
      status: "skipped",
      outcome: "missed",
      reason: "scheduler_inactive",
      // M1 #16: the count is capped by the source; say so instead of silently
      // under-reporting.
      summary: occurrence.missedTruncated ? "missed (capped at 100)" : "missed",
      runAtMs: now.getTime(),
      scheduledFor: task.scheduledFor,
      missedCount: cycles,
    });
  }
  emitScheduleEvent({
    kind: "task-missed",
    at: nowIso,
    taskId: task.id,
    taskName: task.name,
    agentId: task.agentId,
    occurrence: occurrence.occurrence,
    missedCount: cycles,
  });
  return true;
}

/**
 * Persist the cursors the sources advanced to (R-5.4.2). One locked store write,
 * only when a value actually changed; a lost cursor merely re-evaluates.
 */
export function persistSignalCursors(cursors: Record<string, string>): void {
  const entries = Object.entries(cursors);
  if (entries.length === 0) return;
  try {
    withLock(() => {
      const data = readScheduleFile();
      let changed = false;
      for (const [sourceId, cursor] of entries) {
        if (data.signal_state.cursor[sourceId] === cursor) continue;
        data.signal_state.cursor[sourceId] = cursor;
        changed = true;
      }
      if (changed) writeScheduleFile(data);
    });
  } catch {
    // Lock contention: the next tick will offer the same cursor again.
  }
}

/**
 * No runner is registered (host wiring bug, or a tick that outlived its
 * listener). A due task is an F1 here — never silence: R-5.7.8 wants the failure
 * visible, and the occurrence is left unconsumed so the next host can still run
 * it. No lease is taken (Lead ruling).
 *
 * M1 #12: one line per occurrence per process (no per-tick spam), and the
 * failures go through the shared accounting helper so the three-strike
 * auto-pause applies here too.
 */
export function recordMissingScheduleRunner(input: {
  now: Date;
  includeTask?: (task: ScheduleTaskV2) => boolean;
}): number {
  ensureCronSignalSourceRegistered();
  const include = input.includeTask ?? (() => true);
  const data = readScheduleFile();
  const active = data.tasks
    .map(toScheduleTaskV2)
    .filter(include)
    .filter((task) => task.status === "active");
  const evaluation = evaluateSignalsWithCursors({
    now: input.now,
    tasks: active,
    state: data.signal_state,
  });
  persistSignalCursors(evaluation.cursors);
  const byId = new Map(active.map((task) => [task.id, task]));
  const error = "No host runner is registered";
  const nowIso = input.now.toISOString();
  let recorded = 0;
  for (const occurrence of evaluation.occurrences) {
    const task = byId.get(occurrence.taskId);
    if (!task) continue;
    const key = `${task.id}|${occurrence.occurrence}`;
    if (missingRunnerRecorded.has(key)) continue;

    let paused = false;
    let applied = false;
    try {
      applied = withLock(() => {
        const data = readScheduleFile();
        const index = data.tasks.findIndex(
          (candidate) => candidate.id === task.id,
        );
        const record = index === -1 ? null : data.tasks[index];
        if (!record || record.status !== "active") return false;
        const consumed = record.last_consumed_occurrence ?? null;
        if (consumed !== null && occurrence.occurrence <= consumed) {
          return false;
        }
        const view = toScheduleTaskV2(record);
        paused = applyRunOutcome(view, {
          occurrence: occurrence.occurrence,
          runId: `missing-runner:${occurrence.occurrence}`,
          host: "long-lived",
          outcome: "failed",
          failure: "F1",
          error,
          conversationId: null,
          consume: false,
          dispatched: false,
          startedAt: input.now.getTime(),
          finishedAt: input.now,
        });
        // The legacy summary fields stay the CLI's read path; keep them in the
        // same locked write as the frozen view (R-5.11.1).
        const next = applyScheduleTaskV2(record, view);
        next.last_run_outcome = "failed";
        next.last_run_reason = "runtime_unavailable";
        next.last_run_error = error;
        data.tasks[index] = next;
        writeScheduleFile(data);
        return true;
      });
    } catch {
      // Lock contention: try the same occurrence again on the next tick.
      continue;
    }
    if (!applied) continue;
    missingRunnerRecorded.add(key);

    const record = recordFor(task.id);
    if (record) {
      safeAppendCronRunLogForTask(record, {
        status: "error",
        outcome: "failed",
        reason: "runtime_unavailable",
        error,
        runAtMs: input.now.getTime(),
      });
    }
    if (paused) {
      emitScheduleEvent({
        kind: "task-paused",
        at: nowIso,
        taskId: task.id,
        taskName: task.name,
        agentId: task.agentId,
        pausedReason: "auto_failures",
        error,
      });
    }
    recorded += 1;
  }
  return recorded;
}
