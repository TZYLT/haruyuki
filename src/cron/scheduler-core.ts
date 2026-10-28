/**
 * Scheduler core (F-05, M1).
 *
 * The one place that turns "signals say these occurrences are due" into at most
 * one started run per tick: de-dup by occurrence, take the task lease, dispatch
 * to the host's `TaskRunnerPort`, record the result, release, classify failures,
 * and leave the rest for the following ticks (Q-42).
 *
 * Both hosts call this. Nothing here knows about the listener, the TUI, or any
 * concrete feature: a host supplies a runner, the core supplies the policy.
 */

import { randomBytes } from "node:crypto";
import { getTask, legacyRunOutcomeFor, updateTask } from "./cron-file";
import {
  claimTaskLease,
  heartbeatTaskLease,
  isTaskLeaseLive,
  releaseTaskLease,
  withLock,
} from "./cron-lease";
import { ensureCronSignalSourceRegistered } from "./cron-signal";
import {
  getScheduleTask,
  isCronRunReason,
  readScheduleFile,
  toScheduleTaskV2,
  updateScheduleTask,
} from "./cron-store";
import type {
  CronRunReason,
  CronTask,
  DueOccurrence,
  FailureClass,
  RunOutcome,
  ScheduleTaskV2,
  TaskRunnerPort,
} from "./cron-types";
import { TASK_LEASE_HEARTBEAT_MS } from "./cron-types";
import { cronMatchesTime, isValidCron } from "./parse-interval";
import type { CronPromptTiming } from "./prompt";
import { formatCronPrompt } from "./prompt";
import {
  getCronRunLogPath,
  readCronRunLogEntries,
  safeAppendCronRunLogForTask,
} from "./run-log";
import { appendRunSummaryEntry } from "./run-summary";
import { emitScheduleEvent } from "./schedule-events";
import { evaluateSignals, nextSignalDueAt } from "./signal";
import { TASK_COMMAND_WHITELIST } from "./task-run";

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
  /** Missed occurrences recorded (no run). */
  missed: number;
  /** Occurrences skipped because the task lease belonged to another run. */
  skipped: number;
  /** Earliest instant the next tick has work (jitter / one-shot precision). */
  nextDueAt: Date | null;
}

/** R-5.10.3: a slot older than this is a miss, not a late on-time hit. */
const MISSED_GRACE_MS = 90_000;
/** Consecutive F1/F2 runs before the task pauses itself (R-5.9.3). */
const AUTO_PAUSE_FAILURES = 3;
/** T2's runner uses this error name for pre-start (F1) failures. */
const PREFLIGHT_ERROR_NAME = "ScheduledTaskPreflightError";

// ── Failure classification ──────────────────────────────────────────

/**
 * F1 is a pre-start failure the runner reported with a typed error; everything
 * else that is not a skip or a user cancel is F2 (R-5.9.1). A skipped run (busy
 * conversation, condition unmet) is F3 and changes no counter.
 */
export function classifyRunFailure(
  outcome: RunOutcome,
  error: unknown,
): FailureClass {
  if (
    outcome === "success" ||
    outcome === "skipped" ||
    outcome === "cancelled"
  ) {
    return null;
  }
  return (error as { name?: string } | undefined)?.name === PREFLIGHT_ERROR_NAME
    ? "F1"
    : "F2";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function commandNameOf(payload: string): string {
  return payload.trim().replace(/^\//, "").split(/\s+/)[0] ?? "";
}

/** Core-owned startup checks (R-5.7.8); a failure here never dispatches. */
function preStartFailure(task: ScheduleTaskV2): string | null {
  if (task.type !== "command") return null;
  const command = commandNameOf(task.payload);
  if (!command) return "Command task has an empty payload";
  if (!TASK_COMMAND_WHITELIST.has(command)) {
    return `Command "${command}" is not allowed for unattended runs`;
  }
  return null;
}

/**
 * Run-log entries are written per *record*, not per frozen view: the log path
 * comes from the record id and the entry carries the persisted fields. A task
 * deleted mid-run simply has no line to write.
 */
function recordFor(taskId: string) {
  return getTask(taskId);
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

/** Record one missed one-shot exactly as the v1 tick did (R-5.10.4). */ export function applyMissedOneShot(
  task: ScheduleTaskV2,
  now: Date,
): boolean {
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
  const nowIso = now.toISOString();
  updateTask(task.id, (record) => {
    record.status = "missed";
    record.missed_at = nowIso;
    record.last_run_at = nowIso;
    record.last_run_outcome = "missed";
    record.last_run_reason = reason;
    record.last_run_error = error ?? null;
    record.last_missed_at = task.scheduledFor;
    record.missed_count = (record.missed_count ?? 0) + 1;
  });
  const record = recordFor(task.id);
  if (record) {
    safeAppendCronRunLogForTask(record, {
      status: "skipped",
      outcome: "missed",
      reason,
      summary: "missed",
      error: error ?? undefined,
      runAtMs: now.getTime(),
      scheduledFor: task.scheduledFor,
      missedCount: 1,
    });
  }
  emitScheduleEvent({
    kind: "task-missed",
    at: nowIso,
    taskId: task.id,
    taskName: task.name,
    agentId: task.agentId,
    occurrence: task.scheduledFor,
    missedCount: 1,
  });
  return true;
}

/**
 * Q-58 recovery: a lease whose holder is gone is an executor failure.
 *
 * The dead run's occurrence is *not* replayed (the record is written before the
 * lease is released, so the next tick sees it consumed). One F2 line per dead
 * lease: the lease is cleared in the same write, and a run id that already has a
 * terminal line is not double-counted.
 */
function recoverExpiredLeases(tasks: ScheduleTaskV2[], now: Date): number {
  let recovered = 0;
  for (const task of tasks) {
    const lease = task.lease;
    if (!lease || isTaskLeaseLive(lease, now)) continue;
    const recorded = readCronRunLogEntries(getCronRunLogPath(task.id), {
      limit: 50,
      jobId: task.id,
    }).some((entry) => entry.runId === lease.runId);
    updateTask(task.id, (record) => {
      record.lease = null;
      if (recorded) return;
      record.consecutive_failures = (record.consecutive_failures ?? 0) + 1;
      record.failed_count = (record.failed_count ?? 0) + 1;
      record.last_run_at = now.toISOString();
      record.last_run_error = "lease_expired";
    });
    if (recorded) continue;
    const record = recordFor(task.id);
    if (record) {
      safeAppendCronRunLogForTask(record, {
        status: "error",
        runOutcome: "failed",
        outcome: "failed",
        reason: "scheduler_error",
        error: "lease_expired",
        runId: lease.runId,
        host: lease.host,
        runAtMs: Date.parse(lease.startedAt) || now.getTime(),
      });
    }
    emitScheduleEvent({
      kind: "run-finished",
      at: now.toISOString(),
      taskId: task.id,
      taskName: task.name,
      agentId: task.agentId,
      runId: lease.runId,
      outcome: "failed",
      error: "lease_expired",
    });
    recovered += 1;
  }
  return recovered;
}

/** Missed recurring slots: no run, one log line, counted by slots (R-5.10.2). */ function recordMissedRecurring(
  task: ScheduleTaskV2,
  occurrence: DueOccurrence,
  now: Date,
): void {
  const cycles = Math.max(1, occurrence.missedCycles ?? 1);
  const nowIso = now.toISOString();
  updateTask(task.id, (record) => {
    record.last_run_at = nowIso;
    record.last_run_outcome = "missed";
    record.last_run_reason = "scheduler_inactive";
    record.last_run_error = null;
    record.last_missed_at = occurrence.intendedAt;
    record.missed_count = (record.missed_count ?? 0) + cycles;
    record.last_consumed_occurrence = occurrence.occurrence;
  });
  const record = recordFor(task.id);
  if (record) {
    safeAppendCronRunLogForTask(record, {
      status: "skipped",
      outcome: "missed",
      reason: "scheduler_inactive",
      summary: "missed",
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

// ── One run ─────────────────────────────────────────────────────────

interface RunRequest {
  task: ScheduleTaskV2;
  occurrence: string;
  runner: TaskRunnerPort;
  now: Date;
  /** Automatic runs consume the occurrence; manual runs never do. */
  consume: boolean;
}

interface RunResult {
  started: boolean;
  outcome?: RunOutcome;
  error?: string;
  leaseHeld?: boolean;
  leaseMissing?: boolean;
}

function newRunId(): string {
  return `run-${randomBytes(6).toString("hex")}`;
}

/** Fold the run's terminal state into the task record (atomic read-modify-write). */
function recordRunOutcome(params: {
  task: ScheduleTaskV2;
  occurrence: string;
  runId: string;
  outcome: RunOutcome;
  failure: FailureClass;
  error: string | null;
  conversationId: string | null;
  now: Date;
  host: TaskRunnerPort["host"];
  consume: boolean;
  startedAt: number;
}): { paused: boolean; task: ScheduleTaskV2 | null } {
  const nowIso = params.now.toISOString();
  let paused = false;
  const updated = withLock(() =>
    updateScheduleTask(params.task.id, (view) => {
      view.lastRunAt = nowIso;
      view.lastError = params.error;
      view.lastFiredAt = nowIso;
      view.fireCount += 1;
      if (params.consume) view.lastConsumedOccurrence = params.occurrence;
      if (params.failure) {
        view.consecutiveFailures += 1;
        view.failedCount += 1;
      } else if (params.outcome === "success") {
        // R-5.9.3: one success clears the streak. F3 leaves it untouched.
        view.consecutiveFailures = 0;
      }
      if (
        view.consecutiveFailures >= AUTO_PAUSE_FAILURES &&
        view.status === "active"
      ) {
        view.status = "paused";
        view.pausedReason = "auto_failures";
        paused = true;
      }
      if (
        params.outcome === "success" &&
        !view.recurring &&
        view.status === "active"
      ) {
        view.status = "fired";
        view.firedAt = nowIso;
      }
    }),
  );

  const logStatus =
    params.outcome === "success"
      ? "ok"
      : params.outcome === "skipped"
        ? "skipped"
        : "error";
  const record = recordFor(params.task.id);
  // One line per run: a host runner may already have logged this run id (T2's
  // listener runner does its own accounting), so the core only writes the line
  // when nobody else did.
  const alreadyLogged = readCronRunLogEntries(
    getCronRunLogPath(params.task.id),
    { limit: 50, jobId: params.task.id },
  ).some((entry) => entry.runId === params.runId);
  if (record && !alreadyLogged) {
    safeAppendCronRunLogForTask(record, {
      status: logStatus,
      // G-4: the legacy enum cannot express success/timeout/cancelled; the
      // authoritative F-05 outcome is `runOutcome` (T2's field).
      outcome: legacyRunOutcomeFor(params.outcome) ?? undefined,
      runOutcome: params.outcome,
      reason:
        params.failure === "F1" ? "runtime_unavailable" : "scheduler_error",
      error: params.error ?? undefined,
      runId: params.runId,
      host: params.host,
      durationMs: Math.max(0, params.now.getTime() - params.startedAt),
      runAtMs: params.startedAt,
      scheduledFor: params.task.scheduledFor,
      firedAt: nowIso,
      conversationId: params.conversationId ?? undefined,
    });
  }

  appendRunSummaryEntry({
    runId: params.runId,
    taskId: params.task.id,
    taskName: params.task.name,
    outcome: params.outcome,
    startedAt: new Date(params.startedAt).toISOString(),
    finishedAt: nowIso,
    ...(params.conversationId ? { conversationId: params.conversationId } : {}),
  });

  emitScheduleEvent({
    kind: "run-finished",
    at: nowIso,
    taskId: params.task.id,
    taskName: params.task.name,
    agentId: params.task.agentId,
    runId: params.runId,
    occurrence: params.occurrence,
    outcome: params.outcome,
    conversationId: params.conversationId,
    error: params.error,
    durationMs: Math.max(0, params.now.getTime() - params.startedAt),
  });

  if (paused) {
    emitScheduleEvent({
      kind: "task-paused",
      at: nowIso,
      taskId: params.task.id,
      taskName: params.task.name,
      agentId: params.task.agentId,
      pausedReason: "auto_failures",
      error: params.error,
    });
  }

  return { paused, task: updated };
}

/** Take the lease, run once, record, release. Never throws to the caller. */
async function executeRun(request: RunRequest): Promise<RunResult> {
  const { task, now, runner } = request;
  const runId = newRunId();

  const preStart = preStartFailure(task);
  if (preStart) {
    // F1 without dispatch: nothing was started, so no lease was taken.
    recordRunOutcome({
      task,
      occurrence: request.occurrence,
      runId,
      outcome: "failed",
      failure: "F1",
      error: preStart,
      conversationId: null,
      now,
      host: runner.host,
      consume: request.consume,
      startedAt: now.getTime(),
    });
    return { started: false, outcome: "failed", error: preStart };
  }

  const claim = claimTaskLease({
    taskId: task.id,
    runId,
    host: runner.host,
    now,
  });
  if (!claim.claimed) {
    return claim.reason === "held"
      ? { started: false, leaseHeld: true }
      : { started: false, leaseMissing: true };
  }

  let leaseLost = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const controller = new AbortController();
  let raw: {
    outcome: RunOutcome;
    conversationId?: string;
    error?: string;
  } | null = null;
  let thrown: unknown;
  let nothingToDo = false;

  const startedAt = Date.now();
  emitScheduleEvent({
    kind: "run-started",
    at: new Date(startedAt).toISOString(),
    taskId: task.id,
    taskName: task.name,
    agentId: task.agentId,
    runId,
    occurrence: request.occurrence,
  });

  try {
    // Re-check under the lease: another host may have consumed the occurrence
    // between evaluation and the claim (R-5.1.3 dedup is the lease's job too).
    const fresh = getScheduleTask(task.id);
    const consumed =
      fresh?.lastConsumedOccurrence != null &&
      request.occurrence <= fresh.lastConsumedOccurrence;
    const runnable =
      fresh &&
      (request.consume ? fresh.status === "active" : fresh.status !== "fired");
    if (!fresh || !runnable || (request.consume && consumed)) {
      nothingToDo = true;
      return { started: false };
    }

    heartbeat = setInterval(() => {
      if (!heartbeatTaskLease(task.id, claim.lease.token)) {
        leaseLost = true;
        try {
          controller.abort();
          runner.cancel(runId);
        } catch {
          // Best effort: the run is already lost.
        }
      }
    }, TASK_LEASE_HEARTBEAT_MS);

    try {
      raw = await runner.run({
        task: fresh,
        runId,
        occurrence: request.occurrence,
        signal: controller.signal,
      });
    } catch (error) {
      thrown = error;
      raw = { outcome: "failed", error: errorMessage(error) };
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (!nothingToDo) {
      // An expired-and-consumed occurrence is recorded as F2 and never rerun
      // (Q-58); the consume flag below is what makes the second part true.
      if (leaseLost) {
        raw = {
          outcome: "failed",
          error: "lease_expired",
        };
      }
      const outcome = raw?.outcome ?? "failed";
      const error = raw?.error ?? (leaseLost ? "lease_expired" : null);
      const failure = leaseLost
        ? "F2"
        : classifyRunFailure(
            outcome,
            thrown ?? (raw?.error ? new Error(raw.error) : undefined),
          );
      recordRunOutcome({
        task,
        occurrence: request.occurrence,
        runId,
        outcome,
        failure,
        error,
        conversationId: raw?.conversationId ?? null,
        now,
        host: runner.host,
        consume: request.consume,
        startedAt,
      });
    }
    releaseTaskLease(task.id, claim.lease.token);
  }

  return raw
    ? { started: true, outcome: raw.outcome, error: raw.error }
    : { started: false };
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
 * Evaluate every registered signal source, then start at most one run.
 *
 * Order matters: misses are recorded first (they do not occupy the run slot),
 * then the earliest remaining occurrence takes the lease.
 */
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
  const due = evaluateSignals({ now, tasks: active, state: data.signal_state })
    .filter((occurrence) => byId.has(occurrence.taskId))
    .toSorted(dueOrder);

  let missed = 0;
  const runnable: DueOccurrence[] = [];
  for (const occurrence of due) {
    const task = byId.get(occurrence.taskId);
    if (!task) continue;
    const late =
      now.getTime() - Date.parse(occurrence.intendedAt) > MISSED_GRACE_MS;
    if (!late) {
      runnable.push(occurrence);
      continue;
    }
    if (task.catchUp) {
      runnable.push(occurrence);
      continue;
    }
    if (!task.recurring) {
      if (applyMissedOneShot(task, now)) missed += 1;
    } else {
      recordMissedRecurring(task, occurrence, now);
      missed += 1;
    }
  }

  let started: ScheduleTaskV2 | null = null;
  let skipped = 0;
  const deferred = runnable.length > 0 ? runnable.length - 1 : 0;

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
    deferred: deferred + skipped,
    missed,
    skipped,
    nextDueAt,
  };
}

/**
 * No runner is registered (host wiring bug, or a tick that outlived its
 * listener). A due task is an F1 here — never silence: R-5.7.8 wants the failure
 * visible, and the occurrence is left unconsumed so the next host can still run
 * it. No lease is taken (Lead ruling).
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
  const due = evaluateSignals({
    now: input.now,
    tasks: active,
    state: data.signal_state,
  });
  const byId = new Map(active.map((task) => [task.id, task]));
  const error = "No host runner is registered";
  let recorded = 0;
  for (const occurrence of due) {
    const task = byId.get(occurrence.taskId);
    if (!task) continue;
    updateTask(task.id, (record) => {
      record.last_run_at = input.now.toISOString();
      record.last_run_outcome = "failed";
      record.last_run_reason = "runtime_unavailable";
      record.last_run_error = error;
      record.failed_count = (record.failed_count ?? 0) + 1;
    });
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
    recorded += 1;
  }
  return recorded;
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
