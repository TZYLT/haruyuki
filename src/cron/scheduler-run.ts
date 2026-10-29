/**
 * Run execution and accounting for the scheduler core (F-05, M1).
 *
 * One run = lease, dispatch, terminal accounting, release. Every accounting
 * path (live run and dead-lease recovery) folds its terminal facts into the
 * frozen view through `applyRunOutcome`, so the failure streak, the counters,
 * the auto-pause and the visible last outcome cannot drift.
 *
 * `scheduler-core` owns the tick; this module owns one run.
 */

import { randomBytes } from "node:crypto";
import { getTask, legacyRunOutcomeFor } from "./cron-file";
import {
  claimTaskLease,
  heartbeatTaskLease,
  releaseTaskLease,
  withLock,
} from "./cron-lease";
import { getScheduleTask, updateScheduleTask } from "./cron-store";
import type {
  FailureClass,
  RunOutcome,
  ScheduleTaskV2,
  TaskRunnerPort,
} from "./cron-types";
import { TASK_LEASE_HEARTBEAT_MS } from "./cron-types";
import {
  getCronRunLogPath,
  readCronRunLogEntries,
  safeAppendCronRunLogForTask,
} from "./run-log";
import { appendRunSummaryEntry } from "./run-summary";
import { emitScheduleEvent } from "./schedule-events";
import { TASK_COMMAND_WHITELIST } from "./task-run";

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
export function recordFor(taskId: string) {
  return getTask(taskId);
}

/** True when the run log already has a terminal line for this run id. */
export function hasTerminalRunLine(taskId: string, runId: string): boolean {
  return readCronRunLogEntries(getCronRunLogPath(taskId), {
    limit: 50,
    jobId: taskId,
  }).some((entry) => entry.runId === runId);
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

/** Terminal facts every accounting path feeds the same view mutator. */
interface RunOutcomeParams {
  occurrence: string;
  runId: string;
  host: TaskRunnerPort["host"];
  outcome: RunOutcome;
  failure: FailureClass;
  error: string | null;
  conversationId: string | null;
  /** Automatic runs consume the occurrence; manual runs never do. */
  consume: boolean;
  /** True only when the runner was actually invoked (M1 #10). */
  dispatched: boolean;
  startedAt: number;
  finishedAt: Date;
}

function latestOccurrence(
  current: string | null,
  candidate: string,
): string | null {
  if (!candidate) return current;
  if (current === null || candidate > current) return candidate;
  return current;
}

/**
 * Fold one run's terminal state into the frozen view.
 *
 * Single source of truth for failure accounting (R-5.9.3, M1 #9): live runs and
 * dead-lease recovery both go through here, so the streak, the counters, the
 * auto-pause and the visible last outcome cannot drift between the two paths.
 * Mutates the view only — the caller owns the lock and the write.
 *
 * Returns true when this run paused the task (the caller emits the event).
 */
export function applyRunOutcome(
  view: ScheduleTaskV2,
  params: RunOutcomeParams,
): boolean {
  const finishedIso = params.finishedAt.toISOString();
  view.lastRunAt = finishedIso;
  view.lastOutcome = params.outcome;
  view.lastReason =
    params.failure === "F1"
      ? "runtime_unavailable"
      : params.failure === "F2"
        ? "scheduler_error"
        : null;
  view.lastError = params.error;
  if (params.dispatched) {
    // M1 #10: a pre-start failure (F1) never fired, so it must not bump these.
    view.lastFiredAt = finishedIso;
    view.fireCount += 1;
  }
  if (params.consume) {
    view.lastConsumedOccurrence = latestOccurrence(
      view.lastConsumedOccurrence,
      params.occurrence,
    );
  }
  if (params.failure) {
    view.consecutiveFailures += 1;
    view.failedCount += 1;
  } else if (params.outcome === "success") {
    // R-5.9.3: one success clears the streak. F3 leaves it untouched.
    view.consecutiveFailures = 0;
  }
  let paused = false;
  if (
    view.consecutiveFailures >= AUTO_PAUSE_FAILURES &&
    view.status === "active"
  ) {
    view.status = "paused";
    view.pausedReason = "auto_failures";
    paused = true;
  }
  if (params.consume && view.status === "active" && !view.recurring) {
    if (params.outcome === "success") {
      view.status = "fired";
      view.firedAt = finishedIso;
    } else {
      // M1 #5: a consumed, non-successful one-shot has no retry left. Leaving
      // it `active` would be a zombie; it becomes a terminal miss whose last
      // outcome and error stay visible.
      view.status = "missed";
      view.missedAt = finishedIso;
    }
  }
  return paused;
}

/** Fold the run's terminal state into the task record (atomic read-modify-write). */
function recordRunOutcome(
  params: Omit<RunOutcomeParams, "finishedAt"> & {
    task: ScheduleTaskV2;
    finishedAt?: Date;
  },
): { paused: boolean; task: ScheduleTaskV2 | null } {
  const finishedAt = params.finishedAt ?? new Date();
  const finishedIso = finishedAt.toISOString();
  let paused = false;
  let alreadyConsumed = false;
  const updated = withLock(() => {
    // M1 #4: recheck under the lock — two hosts must not both account for the
    // same occurrence.
    const fresh = getScheduleTask(params.task.id);
    if (!fresh) return null;
    if (
      params.consume &&
      fresh.lastConsumedOccurrence !== null &&
      fresh.lastConsumedOccurrence !== undefined &&
      params.occurrence <= fresh.lastConsumedOccurrence
    ) {
      alreadyConsumed = true;
      return fresh;
    }
    return updateScheduleTask(params.task.id, (view) => {
      paused = applyRunOutcome(view, { ...params, finishedAt });
    });
  });
  if (alreadyConsumed) return { paused: false, task: updated };

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
  if (record && !hasTerminalRunLine(params.task.id, params.runId)) {
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
      durationMs: Math.max(0, finishedAt.getTime() - params.startedAt),
      runAtMs: params.startedAt,
      scheduledFor: params.task.scheduledFor,
      firedAt: finishedIso,
      conversationId: params.conversationId ?? undefined,
    });
  }

  appendRunSummaryEntry({
    runId: params.runId,
    taskId: params.task.id,
    taskName: params.task.name,
    outcome: params.outcome,
    startedAt: new Date(params.startedAt).toISOString(),
    finishedAt: finishedIso,
    ...(params.conversationId ? { conversationId: params.conversationId } : {}),
  });

  emitScheduleEvent({
    kind: "run-finished",
    at: finishedIso,
    taskId: params.task.id,
    taskName: params.task.name,
    agentId: params.task.agentId,
    runId: params.runId,
    occurrence: params.occurrence,
    outcome: params.outcome,
    conversationId: params.conversationId,
    error: params.error,
    durationMs: Math.max(0, finishedAt.getTime() - params.startedAt),
  });

  if (paused) {
    emitScheduleEvent({
      kind: "task-paused",
      at: finishedIso,
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
export async function executeRun(request: RunRequest): Promise<RunResult> {
  const { task, now, runner } = request;
  const runId = newRunId();

  const preStart = preStartFailure(task);
  if (preStart) {
    // F1 without dispatch: nothing was started, so no lease was taken. The
    // occurrence is still consumed (a permanently invalid task must not be
    // retried forever) but `fire_count` stays untouched (M1 #10).
    recordRunOutcome({
      task,
      occurrence: request.occurrence,
      runId,
      outcome: "failed",
      failure: "F1",
      error: preStart,
      conversationId: null,
      host: runner.host,
      consume: request.consume,
      dispatched: false,
      startedAt: Date.now(),
    });
    return { started: false, outcome: "failed", error: preStart };
  }

  const claim = claimTaskLease({
    taskId: task.id,
    runId,
    host: runner.host,
    now,
    // Manual runs carry no scheduled occurrence (they must not consume one).
    occurrence: request.consume ? request.occurrence : null,
  });
  if (!claim.claimed) {
    if (claim.reason === "held") return { started: false, leaseHeld: true };
    // `consumed`: the occurrence was already taken under the claim lock, so
    // there is nothing to do and no failure to record.
    if (claim.reason === "consumed") return { started: false };
    return { started: false, leaseMissing: true };
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
  let startedAt = 0;
  let dispatched = false;

  const markLeaseLost = (): void => {
    if (leaseLost) return;
    leaseLost = true;
    try {
      controller.abort();
    } catch {
      // Best effort: the run is already lost.
    }
    try {
      runner.cancel(runId);
    } catch {
      // Best effort: the run is already lost.
    }
  };

  try {
    // Re-check under the lease: another host may have consumed the occurrence
    // between evaluation and the claim (R-5.1.3 dedup is the lease's job too).
    const fresh = getScheduleTask(task.id);
    const consumed =
      fresh?.lastConsumedOccurrence != null &&
      request.consume &&
      request.occurrence <= fresh.lastConsumedOccurrence;
    const runnable =
      fresh &&
      (request.consume ? fresh.status === "active" : fresh.status !== "fired");
    // P0-1 pre-dispatch re-check: the lease we just took must still be ours.
    const leaseOurs = fresh?.lease?.token === claim.lease.token;
    if (!fresh || !runnable || consumed || !leaseOurs) {
      return { started: false };
    }

    // M1 #11: `run-started` is emitted only once the run is certain to happen.
    startedAt = Date.now();
    dispatched = true;
    emitScheduleEvent({
      kind: "run-started",
      at: new Date(startedAt).toISOString(),
      taskId: task.id,
      taskName: task.name,
      agentId: task.agentId,
      runId,
      occurrence: request.occurrence,
    });

    heartbeat = setInterval(() => {
      // P0-5: a throw inside a timer body terminates the host, so a heartbeat
      // failure (lock timeout included) is folded into lease loss here and
      // never escapes.
      try {
        if (heartbeatTaskLease(task.id, claim.lease.token)) return;
        markLeaseLost();
      } catch {
        markLeaseLost();
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
    if (dispatched) {
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
      // M1 #5: an F3-skipped one-shot keeps its occurrence so the next wake can
      // retry it until the grace window closes; every other automatic run
      // consumes it. Missing the retry would leave a permanently active task.
      const consume =
        request.consume && !(outcome === "skipped" && !task.recurring);
      recordRunOutcome({
        task,
        occurrence: request.occurrence,
        runId,
        outcome,
        failure,
        error,
        conversationId: raw?.conversationId ?? null,
        host: runner.host,
        consume,
        dispatched,
        startedAt,
      });
    }
    try {
      releaseTaskLease(task.id, claim.lease.token);
    } catch {
      // Best effort: expiry recovery clears a lease we could not release.
    }
  }

  return raw
    ? { started: true, outcome: raw.outcome, error: raw.error }
    : { started: false };
}
