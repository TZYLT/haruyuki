/**
 * `haruyuki schedule tick|status` — the F-05 short-lived host (M1).
 *
 * `tick` is what the OS timer wakes every 60s (R-5.2.1). Its order is the contract
 * (R-5.3.2, C-24): read the store and evaluate signals first; when nothing is due,
 * or a long-lived host already owns the lease, exit 0 **without loading** the
 * backend, providers, tools or the listener. Only then does it build a runtime
 * (`startLocalChannelListener` with `startCronScheduler: false`, C-5), run exactly
 * one core tick, and release.
 *
 * The heavy modules are dynamic imports on purpose: a static import anywhere in
 * this file's graph would undo the whole point.
 */

import { hasLiveSchedulerOwner } from "@/cron/cron-lease";
import {
  createCronSignalSource,
  ensureCronSignalSourceRegistered,
} from "@/cron/cron-signal";
import { readScheduleFile, toScheduleTaskV2 } from "@/cron/cron-store";
import type { ScheduleTaskV2, TaskRunnerPort } from "@/cron/cron-types";
import { runSchedulePreflight } from "@/cron/preflight";

/** The backend lane a short-lived host competes for (this fork is local-only). */
const BACKEND_LANE = "local";
const CONNECTION_ID = "schedule-tick";
const DEVICE_ID = "schedule-tick";
const CONNECTION_NAME = "schedule tick";

export interface ShortLivedRuntime {
  runner: TaskRunnerPort;
  stop: () => void;
}

export interface ScheduleTickDeps {
  now?: () => Date;
  /** Test seam: replaces the dynamic listener/runner import. */
  startRuntime?: () => Promise<ShortLivedRuntime | null>;
  /** Test seam: replaces the dynamic core import. */
  runTick?: (input: {
    now: Date;
    runner: TaskRunnerPort;
  }) => Promise<{ started: ScheduleTaskV2 | null }>;
}

async function startListenerRuntime(): Promise<ShortLivedRuntime | null> {
  const [
    { startLocalChannelListenerWithHandle, stopListenerClient },
    { createListenerCronRunner },
  ] = await Promise.all([
    import("@/websocket/listener/lifecycle"),
    import("@/websocket/listener/cron-host"),
  ]);
  const handle = await startLocalChannelListenerWithHandle({
    connectionId: CONNECTION_ID,
    deviceId: DEVICE_ID,
    connectionName: CONNECTION_NAME,
    onConnected: () => {},
    onError: () => {},
    startCronScheduler: false,
  });
  if (!handle) return null;
  const runner = createListenerCronRunner({
    transport: handle.transport,
    opts: handle.options,
    processQueuedTurn: handle.processQueuedTurn,
  });
  // This process is the OS-woken host: leases and records must say so.
  return {
    runner: { ...runner, host: "short-lived" },
    stop: () => stopListenerClient(),
  };
}

/** True when a long-lived host (listener or TUI) is live for this lane. */
export function hasLiveLongLivedHost(): boolean {
  try {
    return hasLiveSchedulerOwner(readScheduleFile(), BACKEND_LANE);
  } catch {
    // An unreadable/newer store cannot be scheduled by this build.
    return true;
  }
}

/**
 * One tick. Returns the process exit code: 0 for every "nothing to do" path and
 * for a completed run, 1 only when the runtime could not be built.
 */
export async function runScheduleTick(
  deps: ScheduleTickDeps = {},
): Promise<number> {
  const now = deps.now?.() ?? new Date();
  const preflight = runSchedulePreflight({ now });
  if (preflight.error) {
    console.error(`schedule tick: ${preflight.error}`);
    return 0;
  }
  if (!preflight.due) return 0;
  if (hasLiveLongLivedHost()) return 0;

  const startRuntime = deps.startRuntime ?? startListenerRuntime;
  const runtime = await startRuntime();
  if (!runtime) {
    console.error("schedule tick: could not start the local runtime");
    return 1;
  }

  try {
    const runTick =
      deps.runTick ??
      (async (input: { now: Date; runner: TaskRunnerPort }) => {
        const { runSchedulerTick } = await import("@/cron/scheduler-core");
        return runSchedulerTick(input);
      });
    await runTick({ now, runner: runtime.runner });
    return 0;
  } catch (error) {
    console.error(
      `schedule tick: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 0;
  } finally {
    runtime.stop();
  }
}

/** `haruyuki schedule status` — read-only diagnostics for operators. */
export function runScheduleStatus(): number {
  ensureCronSignalSourceRegistered();
  const data = readScheduleFile();
  const tasks = data.tasks.map(toScheduleTaskV2);
  const counts = { active: 0, paused: 0, terminal: 0 };
  for (const task of tasks) {
    if (task.status === "active") counts.active += 1;
    else if (task.status === "paused") counts.paused += 1;
    else counts.terminal += 1;
  }
  const nextDueAt = createCronSignalSource().nextDueAt({
    now: new Date(),
    tasks: tasks.filter((task) => task.status === "active"),
  });
  console.log(
    `tasks: ${counts.active} active, ${counts.paused} paused, ${counts.terminal} finished`,
  );
  console.log(`long-lived host: ${hasLiveLongLivedHost() ? "live" : "none"}`);
  console.log(`next due: ${nextDueAt ? nextDueAt.toISOString() : "—"}`);
  console.log(`store: version ${data.version}, ${tasks.length} tasks`);
  return 0;
}

const USAGE = [
  "Usage: haruyuki schedule <tick|status>",
  "",
  "  tick     one scheduler tick (internal; run by the OS timer)",
  "  status   read-only schedule diagnostics",
].join("\n");

export async function runScheduleSubcommand(argv: string[]): Promise<number> {
  const [action] = argv;
  switch (action) {
    case "tick":
      return runScheduleTick();
    case "status":
      return runScheduleStatus();
    case "--help":
    case "-h":
    case "help":
      console.log(USAGE);
      return 0;
    default:
      if (action) {
        console.error(`Unknown schedule subcommand: ${action}`);
        console.error(USAGE);
        return 2;
      }
      console.log(USAGE);
      return 0;
  }
}
