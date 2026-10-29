/**
 * The TUI's side of the long-lived host (F-05, M3; the lease policy is Lead's).
 *
 * The TUI keeps no scheduler of its own — that was the point of deleting the
 * shadow scheduler (`19ced59e`). What it keeps is a **host leg**: while the TUI
 * is alive it ticks the shared core every 60 s, with the TUI's own task runner.
 *
 * Lease policy (ruled by Lead): the TUI claims the scheduler lease with scope
 * `"all"`. If another live process holds it — the WS listener, or another TUI —
 * this host does not tick, logs one line, and retries on the next tick (a
 * listener that exits releases the lease, and the TUI should take over without a
 * restart). The lease is released on dispose. **Task-level** leases are the
 * core's business (`runSchedulerTick` / `runScheduledTaskNow` claim and release
 * them per run), so nothing here touches them.
 *
 * Two shapes are deliberate:
 *
 * - **No per-tick React state.** The host is a module-level object with a ref of
 *   pending strings; a schedule event appends to that ref and one flush runs
 *   afterwards. `AppCoordinator` gains a hook call, not a state block.
 * - **Notifications ride the existing path.** `appendTaskNotificationEvents`
 *   is the coordinator's own callback into
 *   `appendTaskNotificationEventsToBuffer` — the same function every background
 *   task already uses; no second notification format is invented here.
 */

import { type SpawnOptions, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { useEffect, useRef } from "react";
import {
  createTuiCronRunner,
  type TuiScheduleActiveTarget,
} from "@/cli/helpers/schedule-prompt";
import {
  formatScheduleNotification,
  listAllScheduleTasks,
  refreshScheduleTasks,
} from "@/cli/helpers/schedule-store";
import {
  claimSchedulerLease,
  type RunOutcome,
  refreshSchedulerLease,
  releaseSchedulerLease,
  runScheduledTaskNow,
  runSchedulerTick,
  type TaskRunnerPort,
} from "@/cron";
import {
  type ScheduleEvent,
  subscribeScheduleEvents,
} from "@/cron/schedule-events";
import { debugWarn } from "@/utils/debug";

/** How often the TUI checks the store (R-5.3.1's 60 s tick). */
export const TUI_SCHEDULE_TICK_MS = 60_000;

/** The first tick waits for startup I/O instead of competing with it. */
export const TUI_SCHEDULE_FIRST_TICK_MS = 10_000;

/**
 * Spawns the short-lived child that runs one due task, or `null`/throws when it
 * cannot be started.
 *
 * `onExit` is called exactly once (spawn `error` or process `exit`) so the
 * caller's in-flight map stops blocking a later retry.
 */
export type SpawnDelegatedTick = (
  taskId: string,
  onExit: () => void,
) => { pid?: number } | null;

/**
 * The command that re-enters this build's own short-lived host for one task.
 *
 * Bundled/Node artifact: `node <haruyuki.js> schedule tick --task <id>`.
 * Dev under Bun: `bun src/standalone-entry.ts schedule tick --task <id>` — the
 * lightweight entry, because `src/index.ts` would load the whole app (OAuth,
 * providers, pi-ai) just to run one task.
 */
export function delegatedTickCommand(taskId: string): {
  command: string;
  args: string[];
} {
  const tail = ["schedule", "tick", "--task", taskId];
  if (process.versions.bun) {
    // Resolve the dev entry next to the invoked entry, so a TUI started from a
    // directory other than the repository root still finds it.
    const invoked = process.argv[1];
    const entry = invoked
      ? resolve(dirname(invoked), "standalone-entry.ts")
      : "src/standalone-entry.ts";
    return { command: process.execPath, args: [entry, ...tail] };
  }
  return {
    command: process.execPath,
    args: [process.argv[1] ?? "haruyuki.js", ...tail],
  };
}

/** Spawn one delegated tick, detached, so the TUI exit cannot kill it. */
function spawnDelegatedScheduleTick(
  taskId: string,
  onExit: () => void,
): { pid?: number } | null {
  const { command, args } = delegatedTickCommand(taskId);
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    env: process.env,
  } satisfies SpawnOptions);
  let settled = false;
  const settle = (): void => {
    if (settled) return;
    settled = true;
    onExit();
  };
  child.once("error", (error) => {
    debugWarn(
      "schedule",
      `delegated schedule tick for ${taskId} could not start: ${error.message}`,
    );
    settle();
  });
  child.once("exit", settle);
  child.unref();
  return { pid: child.pid };
}

export interface TuiScheduleHostOptions {
  /** The coordinator's `appendTaskNotificationEvents` (display path). */
  appendTaskNotificationEvents: (summaries: string[]) => boolean;
  /**
   * Whether a user turn owns the conversation right now (R-5.7.3). The runner
   * waits for idle instead of pushing a scheduled prompt into a turn that is
   * already running; T2's runner defaults to "not busy" because the TUI's queue
   * is serial anyway, and this is the honest answer where one exists.
   */
  isConversationBusy?: () => boolean;
  /**
   * The session this host can run a turn in. Only tasks targeting this session
   * are run in-process; every other due task is delegated to a short-lived child
   * (P1-2, user ruling B).
   */
  getActiveTarget?: () => TuiScheduleActiveTarget | null;
  /** Clock seam; tests only. */
  now?: () => Date;
  /** Runner seam; the app leaves it unset and gets T2's TUI runner. */
  runner?: TaskRunnerPort;
  /** Spawn seam for the delegated short-lived host; tests only. */
  spawnDelegatedTick?: SpawnDelegatedTick;
  tickIntervalMs?: number;
  firstTickMs?: number;
}

export interface TuiScheduleHost {
  /** True once the scheduler lease is held (and not lost). */
  hasLease(): boolean;
  /** One core tick, the same call the interval makes. */
  tick(): Promise<void>;
  /** `/schedule run <id>`: the core's manual entry, through this host's runner. */
  runTaskNow(
    taskId: string,
  ): Promise<{ outcome: RunOutcome; error?: string } | null>;
  /** Stop ticking, unsubscribe and release the lease. Idempotent. */
  dispose(): void;
}

let currentHost: TuiScheduleHost | null = null;

/** The live host, for the submit layer's `/schedule run`. */
export function currentTuiScheduleHost(): TuiScheduleHost | null {
  return currentHost;
}

/**
 * Create the TUI runner once, tolerating the M2 stub.
 *
 * While `createTuiCronRunner` is still a stub it throws; a TUI that crashed on
 * startup because the scheduler is not finished would be worse than a TUI that
 * schedules nothing, so the failure is one logged line and the host stays idle
 * until a restart (the runner is built once, not per tick).
 */
function createRunner(options: TuiScheduleHostOptions): TaskRunnerPort | null {
  if (options.runner) return options.runner;
  try {
    return createTuiCronRunner({
      ...(options.isConversationBusy
        ? { isConversationBusy: options.isConversationBusy }
        : {}),
      ...(options.getActiveTarget
        ? { getActiveTarget: options.getActiveTarget }
        : {}),
    });
  } catch (error) {
    debugWarn(
      "schedule",
      `TUI schedule host idle: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

export function startTuiScheduleHost(
  options: TuiScheduleHostOptions,
): TuiScheduleHost {
  const now = options.now ?? (() => new Date());
  const runner = createRunner(options);
  let leaseToken: string | null = null;
  let leaseLossLogged = false;
  let disposed = false;
  let ticking = false;

  const pendingNotifications: string[] = [];
  let flushScheduled = false;

  const flushNotifications = (): void => {
    flushScheduled = false;
    if (pendingNotifications.length === 0) return;
    const batch = pendingNotifications.splice(0, pendingNotifications.length);
    try {
      options.appendTaskNotificationEvents(batch);
    } catch (error) {
      debugWarn(
        "schedule",
        `could not append schedule notifications: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };

  /**
   * Queue one line per finished run and flush once.
   *
   * `appendTaskNotificationEvents` writes the transcript buffer and calls
   * `refreshDerived` (a React state update), so an event must not call it
   * directly: several events can land in one tick (a run plus a task pausing),
   * and one flush keeps that to one render.
   */
  const onScheduleEvent = (event: ScheduleEvent): void => {
    const line = formatScheduleNotification(event, now());
    if (line) pendingNotifications.push(line);
    if (!flushScheduled) {
      flushScheduled = true;
      setTimeout(flushNotifications, 0).unref?.();
    }
    // The rail's own store already listens; this keeps a host whose first tick
    // recorded a miss from waiting up to 30 s for the next low-frequency read.
    if (event.kind !== "run-started") refreshScheduleTasks(now());
  };

  const unsubscribe = subscribeScheduleEvents(onScheduleEvent);

  const tryClaim = (): boolean => {
    if (leaseToken) return true;
    try {
      leaseToken = claimSchedulerLease("all");
      leaseLossLogged = false;
      return true;
    } catch (error) {
      if (!leaseLossLogged) {
        leaseLossLogged = true;
        debugWarn(
          "schedule",
          `TUI schedule host will not tick: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      return false;
    }
  };

  // Task ids whose delegated short-lived child is still alive. One child per
  // task: a tick that sees the same occurrence still unconsumed (the child is
  // slow, or failed before consuming) must not start a second runner for it.
  const delegatedInFlight = new Set<string>();

  /**
   * Hand one due task the in-process runner cannot run to a short-lived child.
   *
   * The child creates/uses its own target conversation and records its own run
   * (the TUI never writes its result); the TUI stops delegating once the
   * occurrence is consumed and the next tick no longer lists the task. Spawn
   * failures are one log line — a tick must not fail because a child could not
   * start.
   *
   * Two bounded retries are intended, not dedupe failures (M1 #5 semantics):
   * a one-shot F3-skipped occurrence is deliberately not consumed inside its
   * 90 s grace, so it may be delegated once more before it turns `missed`; and
   * a child that exits 1 because its runtime would not start leaves the
   * occurrence unconsumed, so the next tick retries it. The in-flight set only
   * prevents a *second child for the same task while the first is alive*.
   */
  const delegateTask = (taskId: string): void => {
    if (delegatedInFlight.has(taskId)) return;
    delegatedInFlight.add(taskId);
    const spawnTick = options.spawnDelegatedTick ?? spawnDelegatedScheduleTick;
    try {
      const child = spawnTick(taskId, () => delegatedInFlight.delete(taskId));
      if (child === null) delegatedInFlight.delete(taskId);
    } catch (error) {
      delegatedInFlight.delete(taskId);
      debugWarn(
        "schedule",
        `could not delegate schedule ${taskId} to a short-lived host: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };

  const tick = async (): Promise<void> => {
    if (disposed || ticking || !runner) return;
    if (!tryClaim()) return;
    if (leaseToken && !refreshSchedulerLease(leaseToken, "all")) {
      // Somebody else is the all-host now; stop claiming until we can again.
      leaseToken = null;
      if (!leaseLossLogged) {
        leaseLossLogged = true;
        debugWarn("schedule", "TUI schedule host lost the scheduler lease");
      }
      return;
    }
    ticking = true;
    try {
      const result = await runSchedulerTick({ now: now(), runner });
      if (result.started || result.missed > 0) refreshScheduleTasks(now());
      // The core leaves due tasks this host's runner said `canRun === false`
      // alone (neither claimed nor consumed) and reports their ids (P1-2): the
      // TUI's own session is the only thing it can run, so everything else is
      // handed to a short-lived child.
      for (const taskId of result.deferredTaskIds ?? []) {
        delegateTask(taskId);
      }
    } catch (error) {
      debugWarn(
        "schedule",
        `scheduler tick failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      ticking = false;
    }
  };

  // Claim at startup, not on the first tick: the short-lived host's
  // arbitration (R-5.6.3) asks "is a long-lived host alive?" the moment it
  // wakes, and a TUI that only claims ten seconds in would leave that window
  // open. Failure is one log line, not an error — the WS listener may be the
  // one running schedules.
  tryClaim();

  const firstTick = setTimeout(() => {
    void tick();
  }, options.firstTickMs ?? TUI_SCHEDULE_FIRST_TICK_MS);
  firstTick.unref?.();
  const interval = setInterval(
    () => void tick(),
    options.tickIntervalMs ?? TUI_SCHEDULE_TICK_MS,
  );
  interval.unref?.();

  const host: TuiScheduleHost = {
    hasLease: () => leaseToken !== null,
    tick,
    async runTaskNow(taskId) {
      if (!runner) return null;
      // A manual run does not tick, so it also does not need the scheduler
      // lease: the core takes the task-level lease for this one run.
      const result = await runScheduledTaskNow({ taskId, runner, now: now() });
      if (!result.started) {
        throw new Error(result.error ?? "任务没有跑起来");
      }
      return {
        outcome: result.outcome ?? "failed",
        error: result.error,
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(firstTick);
      clearInterval(interval);
      unsubscribe();
      if (leaseToken) {
        try {
          releaseSchedulerLease(leaseToken, "all");
        } catch (error) {
          debugWarn(
            "schedule",
            `could not release the scheduler lease: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        leaseToken = null;
      }
      if (currentHost === host) currentHost = null;
    },
  };
  currentHost = host;
  return host;
}

/**
 * `/schedule run <id|name>` from the submit layer.
 *
 * Resolves a name to an id through the same store the panel reads, then runs it
 * through the live host. `unavailable` is a real answer, not an error: with no
 * host leg there is no executor, and a task must never be run by a second,
 * ad-hoc path (the listener's `runCronTaskNow` is not this one).
 */
export type TuiRunNowResult =
  | { kind: "ran"; outcome: RunOutcome; error?: string }
  /** Accepted; the turn is still running and will report through its notification. */
  | { kind: "started"; taskName: string }
  | { kind: "unavailable"; message: string };

/**
 * How long `/schedule run` waits before it answers "started" instead of the
 * result.
 *
 * A prompt task's run lasts as long as the turn it starts (T2's runner resolves
 * when the TUI consumes the queued turn), so a command row that awaited it would
 * sit "running" for minutes. The row answers "已开始运行" after this, and the run
 * reports itself through the notification and the run log — the same two places
 * a tick-started run reports.
 */
const RUN_NOW_ACK_MS = 800;

export async function runScheduledTaskViaTuiHost(
  taskRef: string,
): Promise<TuiRunNowResult> {
  const host = currentTuiScheduleHost();
  if (!host) {
    return {
      kind: "unavailable",
      message: "TUI 调度宿主没有运行：计划任务只在 Haruyuki 运行时执行。",
    };
  }
  const tasks = listAllScheduleTasks();
  const byId = tasks.find((task) => task.id === taskRef);
  const byName = tasks.filter((task) => task.name === taskRef);
  const task = byId ?? (byName.length === 1 ? byName[0] : undefined);
  if (!task) {
    return {
      kind: "unavailable",
      message:
        byName.length > 1
          ? `「${taskRef}」匹配到 ${byName.length} 个任务，请用 id。`
          : `找不到任务 ${taskRef}`,
    };
  }
  const run = host.runTaskNow(task.id);
  const raced = await Promise.race([
    run,
    new Promise<"pending">((resolve) => {
      const timer = setTimeout(() => resolve("pending"), RUN_NOW_ACK_MS);
      timer.unref?.();
    }),
  ]);
  if (raced === "pending") {
    // The run continues; its failure is already logged and notified by the
    // core, so nothing here may drop an unhandled rejection.
    void run.catch(() => {});
    return { kind: "started", taskName: task.name };
  }
  if (!raced) {
    return {
      kind: "unavailable",
      message: "TUI 调度宿主不可用：任务执行器还没就绪。",
    };
  }
  return { kind: "ran", outcome: raced.outcome, error: raced.error };
}

/**
 * One line in the coordinator: start the host for this session, stop it on
 * unmount. The host owns everything else — the interval, the lease, the event
 * subscription — so the pinned file gains no state.
 *
 * The effect deliberately runs **once** (P1-3): the callbacks are read through a
 * ref, so a new `isConversationBusy` closure on every `isExecutingTool` flip no
 * longer disposes and recreates the host — which used to clear the tick timer
 * and release/re-take the "all" scheduler lease on every tool call.
 */
export function useTuiScheduleHost(input: {
  appendTaskNotificationEvents: (summaries: string[]) => boolean;
  isConversationBusy?: () => boolean;
  getActiveTarget?: () => TuiScheduleActiveTarget | null;
}): void {
  const inputRef = useRef(input);
  inputRef.current = input;
  useEffect(() => {
    // The ref is the live view of the caller's callbacks: the host's interval
    // and runner outlive any single render, and must never hold a stale one.
    const host = startTuiScheduleHost({
      appendTaskNotificationEvents: (summaries) =>
        inputRef.current.appendTaskNotificationEvents(summaries),
      isConversationBusy: () =>
        inputRef.current.isConversationBusy?.() ?? false,
      getActiveTarget: () => inputRef.current.getActiveTarget?.() ?? null,
    });
    return () => host.dispose();
  }, []);
}
