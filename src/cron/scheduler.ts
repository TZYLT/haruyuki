/**
 * Long-lived schedule host (F-05, M1): lease, 60s tick, real jitter delay,
 * hourly GC and scope filter. Every decision is delegated to `scheduler-core`.
 * Export names are the M0 freeze (C-28).
 */

import { isLocalAgentId } from "@/agent/agent-id";
import type { StartListenerOptions } from "@/websocket/listener/types";
import { garbageCollect, getTask } from "./cron-file";
import {
  claimSchedulerLease,
  refreshSchedulerLease,
  releaseSchedulerLease,
} from "./cron-lease";
import { getScheduleTask, readCronFile } from "./cron-store";
import type {
  CronSchedulerScope,
  CronTask,
  ScheduleTaskV2,
  TaskRunnerPort,
} from "./cron-types";
import { ensureDreamSignalSourceRegistered } from "./dream-signal";
import { createDefaultDreamSignalDeps } from "./dream-signal-deps";
import {
  recordMissingScheduleRunner,
  runScheduledTaskNow,
  runSchedulerTick,
} from "./scheduler-core";

export {
  type CronPromptTiming,
  formatCronPrompt,
  formatTimezoneQualifiedIso,
  getIntendedCronOccurrence,
} from "./prompt";

const TICK_INTERVAL_MS = 60_000;
const GC_INTERVAL_MS = 60 * 60_000;
const TOMBSTONE_HEARTBEAT_MS = 1_000;
const LEASE_RETRY_MS = 30_000;
const MAX_LEASE_RETRIES = 3;

export const CRON_SCHEDULER_SCOPE_ENV = "HARUYUKI_CRON_SCHEDULER_SCOPE";

type HostOptions = StartListenerOptions;

interface SchedulerState {
  token: string;
  scope: CronSchedulerScope;
  tickInterval: NodeJS.Timeout;
  gcInterval: NodeJS.Timeout;
  tombstoneInterval: NodeJS.Timeout | null;
  opts: HostOptions;
  tombstoneToken: string | undefined;
  pendingTimer: NodeJS.Timeout | null;
  /** P1-7/R-5.7.5: a tick never overlaps another; a wake during one is queued. */
  tickInFlight: boolean;
  tickQueued: boolean;
}

let schedulerState: SchedulerState | null = null;
let taskRunner: TaskRunnerPort | null = null;
/** M1 #13: the lease-retry timer must be cancellable by `stopScheduler`. */
let leaseRetryTimer: NodeJS.Timeout | null = null;
/** F-06 M1: the debounced wake requested by `requestSchedulerTick`. */
let pendingTickTimer: NodeJS.Timeout | null = null;
/** How long a requested tick waits, so several turn ends coalesce into one. */
const REQUESTED_TICK_DELAY_MS = 250;
/** Bumped on stop so a stale retry callback can never resurrect the host. */
let schedulerEpoch = 0;

/** The host registers its runner before starting; `stopScheduler` clears it. */
export function setSchedulerTaskRunner(runner: TaskRunnerPort | null): void {
  taskRunner = runner;
}

export function resolveCronSchedulerScope(
  value = process.env[CRON_SCHEDULER_SCOPE_ENV],
): CronSchedulerScope {
  return value === "cloud" || value === "local" ? value : "all";
}

export function taskMatchesCronSchedulerScope(
  task: CronTask,
  scope: CronSchedulerScope,
): boolean {
  if (scope === "all") return true;
  return scope === "local"
    ? isLocalAgentId(task.agent_id)
    : !isLocalAgentId(task.agent_id);
}
function taskInScope(task: ScheduleTaskV2, scope: CronSchedulerScope): boolean {
  const record = { agent_id: task.agentId } as CronTask;
  return taskMatchesCronSchedulerScope(record, scope);
}

// The v1 tick's pure/policy helpers now live in `scheduler-core`; these names
// stay on this frozen surface for their existing consumers.
export {
  handleInvalidRecurringTask,
  handleMissedOneShot,
  handleTaskPreflight,
  minuteKey,
  shouldFireTask,
  wrapCronPrompt,
} from "./scheduler-core";

function logScheduler(opts: HostOptions, message: string): void {
  opts.onLog?.(`[Cron] ${message}`);
}

function leaseError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
function clearPendingTimer(state: SchedulerState): void {
  if (!state.pendingTimer) return;
  clearTimeout(state.pendingTimer);
  state.pendingTimer = null;
}

/** True while we hold the lease. Lock timeouts throw and are logged by callers. */
function holdSchedulerLease(state: SchedulerState): boolean {
  if (refreshSchedulerLease(state.token, state.scope, state.tombstoneToken)) {
    return true;
  }
  if (state.scope === "all") {
    logScheduler(state.opts, "Scheduler lease lost. Stopping.");
    stopScheduler();
    return false;
  }
  try {
    state.token = claimSchedulerLease(state.scope);
    state.tombstoneToken = readCronFile().scheduler_owner?.token;
    logScheduler(state.opts, "Reclaimed scoped scheduler lease.");
    return true;
  } catch (err) {
    logScheduler(
      state.opts,
      `Scheduler lease lost; retrying: ${leaseError(err)}`,
    );
    clearPendingTimer(state);
    return false;
  }
}

// ── Tick ────────────────────────────────────────────────────────────

/**
 * Hand the dream occurrences this tick deferred to a short-lived child.
 *
 * The core deliberately never claims a dream task lease or consumes its
 * occurrence (`canRun === false` path): the short-lived `dream run --task`
 * child claims the lease and consumes the occurrence itself, so there is
 * exactly one owner at a time and a failed spawn leaves the occurrence for the
 * next tick. The runner's own in-flight guard stops two children for one task
 * while the first is alive; the child's lease claim is the authoritative
 * de-dupe. Failures are one log line each — a tick must not fail because a
 * delegation could not start.
 */
function delegateDeferredDreams(
  runner: TaskRunnerPort,
  taskIds: readonly string[],
  opts: HostOptions,
): void {
  const runDream = runner.runDream;
  if (!runDream || taskIds.length === 0) return;
  for (const taskId of taskIds) {
    let task: ScheduleTaskV2 | null = null;
    try {
      task = getScheduleTask(taskId);
    } catch {
      continue;
    }
    if (!task || task.type !== "dream") continue;
    const runId = `delegated-dream-${Date.now().toString(36)}`;
    void runDream
      .call(runner, {
        task,
        runId,
        occurrence: `delegated:${new Date().toISOString()}`,
        signal: new AbortController().signal,
      })
      .then((result) => {
        if (result.outcome !== "failed") return;
        logScheduler(
          opts,
          `could not delegate dream task ${taskId}: ${result.error ?? "unknown error"}`,
        );
      })
      .catch((error) => {
        logScheduler(
          opts,
          `could not delegate dream task ${taskId}: ${leaseError(error)}`,
        );
      });
  }
}

async function runTickWork(state: SchedulerState): Promise<void> {
  try {
    if (!holdSchedulerLease(state)) return;
  } catch (err) {
    logScheduler(state.opts, `Lease check error: ${leaseError(err)}`);
    return;
  }

  // F-06 M1: register the dream signal source before any evaluation, so a
  // dream task this host owns is never judged only by the cron source (C-37).
  // Presence-guarded: a test or an earlier registration keeps its deps.
  ensureDreamSignalSourceRegistered(createDefaultDreamSignalDeps());

  const runner = taskRunner;
  const now = new Date();
  const includeTask = (task: ScheduleTaskV2) => taskInScope(task, state.scope);
  if (!runner) {
    recordMissingScheduleRunner({ now, includeTask });
    return;
  }

  const result = await runSchedulerTick({ now, runner, includeTask });
  // F-06 (Q-47/C-16): the core leaves a due dream occurrence untouched (no
  // claim, no consume, no failure) and reports the task. The long-lived host
  // delegates it to a short-lived `dream run --task` child through the runner's
  // `runDream` seam; spawning returns immediately, so a 45-minute run can never
  // stall this tick (C-15). The listener has no host leg of its own — this is
  // the delegation TUI already had (C-16).
  delegateDeferredDreams(runner, result.deferredTaskIds, state.opts);
  // Real jitter delay: the occurrence's intended instant is a little in the
  // future, so wake for it instead of waiting out the next 60s tick.
  if (schedulerState !== state || !result.nextDueAt) return;
  const delay = result.nextDueAt.getTime() - Date.now();
  if (delay <= 0 || delay >= TICK_INTERVAL_MS) return;
  clearPendingTimer(state);
  state.pendingTimer = setTimeout(() => {
    state.pendingTimer = null;
    runTickSafely(state);
  }, delay);
}

async function runTick(state: SchedulerState): Promise<void> {
  if (schedulerState !== state) return;
  // P1-7/R-5.7.5: a long run must not be overlapped by the next interval or the
  // jitter wake. Queue one follow-up instead, and run it when this tick ends.
  if (state.tickInFlight) {
    state.tickQueued = true;
    return;
  }
  state.tickInFlight = true;
  try {
    await runTickWork(state);
  } finally {
    state.tickInFlight = false;
    if (state.tickQueued) {
      state.tickQueued = false;
      if (schedulerState === state) runTickSafely(state);
    }
  }
}

function runTickSafely(state: SchedulerState): void {
  void runTick(state).catch((err) =>
    logScheduler(state.opts, `Tick error: ${leaseError(err)}`),
  );
}

/**
 * F-06 M1 (R-5.2.4): ask the running long-lived host to evaluate soon.
 *
 * Called at the end of a turn (TUI conversation loop, listener turn
 * completion) so a dream that just became eligible does not wait out the
 * remaining 60 s tick. It is a **request**, not a run: it debounces, is
 * non-blocking, never creates a scheduler, and the evaluation itself still goes
 * through the normal tick (lease check, core policy). A no-op when no
 * long-lived host owns this process.
 */
export function requestSchedulerTick(): void {
  const state = schedulerState;
  if (!state || pendingTickTimer !== null) return;
  pendingTickTimer = setTimeout(() => {
    pendingTickTimer = null;
    if (schedulerState === state) runTickSafely(state);
  }, REQUESTED_TICK_DELAY_MS);
  pendingTickTimer.unref?.();
}

// ── Public API ──────────────────────────────────────────────────────

export function startScheduler(
  socket: unknown,
  opts: HostOptions,
  processQueuedTurn?: (...args: never[]) => Promise<void>,
  retryCount = 0,
): void {
  if (schedulerState) return;
  const epoch = ++schedulerEpoch;

  let token: string;
  const scope = resolveCronSchedulerScope();
  try {
    token = claimSchedulerLease(scope);
  } catch (err) {
    if (retryCount >= MAX_LEASE_RETRIES) {
      logScheduler(
        opts,
        `Failed to claim scheduler lease after ${MAX_LEASE_RETRIES + 1} attempts. Cron tasks will not fire.`,
      );
      logScheduler(
        opts,
        "Another process may hold the lease. Restart Haruyuki to retry.",
      );
      return;
    }
    logScheduler(
      opts,
      `Could not claim scheduler lease (attempt ${retryCount + 1}/${MAX_LEASE_RETRIES + 1}): ${leaseError(err)}`,
    );
    logScheduler(
      opts,
      "Cron tasks will not fire until the scheduler starts. Retrying...",
    );
    if (leaseRetryTimer) clearTimeout(leaseRetryTimer);
    leaseRetryTimer = setTimeout(() => {
      leaseRetryTimer = null;
      // M1 #13: a retry armed before `stopScheduler` must not resurrect the host.
      if (schedulerState || epoch !== schedulerEpoch) return;
      startScheduler(socket, opts, processQueuedTurn, retryCount + 1);
    }, LEASE_RETRY_MS);
    return;
  }

  const state: SchedulerState = {
    token,
    scope,
    tickInterval: null as unknown as NodeJS.Timeout,
    gcInterval: null as unknown as NodeJS.Timeout,
    tombstoneInterval: null,
    opts,
    tombstoneToken: readCronFile().scheduler_owner?.token,
    pendingTimer: null,
    tickInFlight: false,
    tickQueued: false,
  };
  schedulerState = state;

  // Verify the lease before arming anything: a lease lost in the initial check
  // must not leave intervals running without ownership.
  try {
    if (!holdSchedulerLease(state)) return;
  } catch (err) {
    logScheduler(opts, `Lease check error: ${leaseError(err)}`);
    return;
  }

  runTickSafely(state);
  if (schedulerState !== state) return;

  state.tickInterval = setInterval(
    () => runTickSafely(state),
    TICK_INTERVAL_MS,
  );
  state.gcInterval = setInterval(() => {
    try {
      garbageCollect();
    } catch (err) {
      logScheduler(opts, `GC error: ${leaseError(err)}`);
    }
  }, GC_INTERVAL_MS);

  if (scope !== "all") {
    state.tombstoneInterval = setInterval(() => {
      try {
        holdSchedulerLease(state);
      } catch (err) {
        logScheduler(opts, `Tombstone heartbeat error: ${leaseError(err)}`);
      }
    }, TOMBSTONE_HEARTBEAT_MS);
  }
}

export function stopScheduler(): void {
  taskRunner = null;
  // M1 #13: cancel the lease-retry timer and invalidate any callback already
  // queued, so a stopped host cannot revive itself up to 30s later.
  schedulerEpoch += 1;
  if (leaseRetryTimer) {
    clearTimeout(leaseRetryTimer);
    leaseRetryTimer = null;
  }
  if (pendingTickTimer) {
    // A wake requested for a host that is stopping must not fire after it did.
    clearTimeout(pendingTickTimer);
    pendingTickTimer = null;
  }
  if (!schedulerState) return;
  clearInterval(schedulerState.tickInterval);
  clearInterval(schedulerState.gcInterval);
  clearInterval(schedulerState.tombstoneInterval ?? undefined);
  clearPendingTimer(schedulerState);
  try {
    releaseSchedulerLease(schedulerState.token, schedulerState.scope);
  } catch {
    // Best effort
  }
  schedulerState = null;
}

export function isSchedulerRunning(): boolean {
  return schedulerState !== null;
}

/**
 * "Send now" (WS `run_cron_task`). Goes through the injected host runner, so a
 * manual run takes the same task lease and writes the same records.
 */
export async function runCronTaskNow(taskId: string): Promise<{
  success: boolean;
  found: boolean;
  task?: CronTask;
  error?: string;
}> {
  const task = getTask(taskId);
  if (!task)
    return { success: false, found: false, error: "Schedule not found" };
  const runner = taskRunner;
  if (!runner) {
    return {
      success: false,
      found: true,
      task,
      error: "Cron scheduler is not running",
    };
  }
  const result = await runScheduledTaskNow({ taskId, runner });
  return {
    success: result.started,
    found: true,
    task: getTask(taskId) ?? task,
    ...(result.error ? { error: result.error } : {}),
  };
}
