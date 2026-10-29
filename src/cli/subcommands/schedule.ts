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
 * `tick --task <id>` is the internal delegation entry (P1-2 B): the TUI host
 * spawns this process for a task it cannot run itself (another agent, `new`
 * conversation, ...). It deliberately ignores the long-lived-host arbitration —
 * the delegating host holds the scheduler lease — and runs exactly that task's
 * due occurrence once.
 *
 * The heavy modules are dynamic imports on purpose: a static import anywhere in
 * this file's graph would undo the whole point.
 */

import { isLocalAgentId } from "@/agent/agent-id";
import { hasLiveSchedulerOwner } from "@/cron/cron-lease";
import {
  createCronSignalSource,
  ensureCronSignalSourceRegistered,
} from "@/cron/cron-signal";
import { readScheduleFile, toScheduleTaskV2 } from "@/cron/cron-store";
import type { ScheduleTaskV2, TaskRunnerPort } from "@/cron/cron-types";
import { runSchedulePreflight } from "@/cron/preflight";
import { evaluateSignals } from "@/cron/signal";

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
  /** Internal: run only this task's due occurrence (TUI delegation, P1-2). */
  taskId?: string;
  /** Test seam: replaces the dynamic listener/runner import. */
  startRuntime?: () => Promise<ShortLivedRuntime | null>;
  /** Test seam: replaces the dynamic core import. */
  runTick?: (input: {
    now: Date;
    runner: TaskRunnerPort;
    includeTask?: (task: ScheduleTaskV2) => boolean;
  }) => Promise<{
    started: ScheduleTaskV2 | null;
    deferredTaskIds?: string[];
  }>;
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
  // This process is the OS-woken host: pass the host at construction time so
  // every run-log row and lease says `short-lived` (M2 F8), instead of patching
  // the returned object.
  const runner = createListenerCronRunner({
    transport: handle.transport,
    opts: handle.options,
    processQueuedTurn: handle.processQueuedTurn,
    host: "short-lived",
  });
  return {
    runner,
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
 * M1 #18: the short-lived host only arbitrates the `local` lane, so it may only
 * execute that lane. The local backend is the only one this fork ships, which is
 * why the lane is a constant; keeping the filter makes the assumption explicit
 * instead of letting a future lane's tasks run here unowned.
 */
export function taskInShortLivedLane(task: ScheduleTaskV2): boolean {
  return isLocalAgentId(task.agentId);
}

/**
 * Is one specific task due? Delegated ticks evaluate only their own task, so a
 * task-less due check elsewhere must not decide whether the child runs.
 */
function delegatedTaskDue(
  taskId: string,
  now: Date,
): { found: boolean; due: boolean } {
  const data = readScheduleFile();
  const task = data.tasks
    .map(toScheduleTaskV2)
    .find((candidate) => candidate.id === taskId);
  if (!task) return { found: false, due: false };
  if (task.status !== "active") return { found: true, due: false };
  const due = evaluateSignals({ now, tasks: [task], state: data.signal_state });
  return { found: true, due: due.length > 0 };
}

/**
 * One tick. Returns the process exit code: 0 for every "nothing to do" path and
 * for a completed run, 1 only when the runtime could not be built.
 */
export async function runScheduleTick(
  deps: ScheduleTickDeps = {},
): Promise<number> {
  const now = deps.now?.() ?? new Date();
  const taskId = deps.taskId?.trim() || null;

  if (taskId) {
    // Delegated tick: the parent host holds the scheduler lease, so the
    // long-lived-host arbitration below must not apply (P1-2 B).
    let status: { found: boolean; due: boolean };
    try {
      status = delegatedTaskDue(taskId, now);
    } catch (error) {
      console.error(
        `schedule tick: store unreadable: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 0;
    }
    if (!status.found) {
      console.error(`schedule tick: task ${taskId} not found`);
      return 0;
    }
    if (!status.due) {
      console.error(`schedule tick: task ${taskId} is not due`);
      return 0;
    }
  } else {
    const preflight = runSchedulePreflight({ now });
    if (preflight.error) {
      console.error(`schedule tick: ${preflight.error}`);
      return 0;
    }
    if (!preflight.due) return 0;
    if (hasLiveLongLivedHost()) return 0;
  }

  const startRuntime = deps.startRuntime ?? startListenerRuntime;
  const runtime = await startRuntime();
  if (!runtime) {
    console.error("schedule tick: could not start the local runtime");
    return 1;
  }

  try {
    const includeTask = taskId
      ? (task: ScheduleTaskV2) => task.id === taskId
      : taskInShortLivedLane;
    const runTick =
      deps.runTick ??
      (async (input: {
        now: Date;
        runner: TaskRunnerPort;
        includeTask?: (task: ScheduleTaskV2) => boolean;
      }) => {
        const { runSchedulerTick } = await import("@/cron/scheduler-core");
        return runSchedulerTick(input);
      });
    await runTick({ now, runner: runtime.runner, includeTask });
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
  let data: ReturnType<typeof readScheduleFile>;
  try {
    data = readScheduleFile();
  } catch (error) {
    // M1 #14: a corrupt or newer store is a diagnostic, not a crash (no stack);
    // ScheduleStoreCorruptError / ScheduleStoreVersionError both land here.
    const detail =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
    console.error(`schedule status: store unreadable (${detail})`);
    console.log("long-lived host: unknown");
    console.log("next due: —");
    return 1;
  }
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
  "  tick              one scheduler tick (internal; run by the OS timer)",
  "  tick --task <id>  internal: run one delegated task's due occurrence",
  "  status            read-only schedule diagnostics",
].join("\n");

/**
 * Parse `tick [--task <id>|--task=<id>]`. Anything else keeps the old
 * action-only behavior; the delegated form is internal (P1-2 B).
 */
function parseTickArgs(argv: string[]): { taskId?: string; error?: string } {
  let taskId: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--task") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--"))
        return { error: "--task needs an id" };
      taskId = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--task=")) {
      const value = arg.slice("--task=".length).trim();
      if (!value) return { error: "--task needs an id" };
      taskId = value;
      continue;
    }
    return { error: `Unknown tick option: ${arg}` };
  }
  return taskId ? { taskId } : {};
}

export async function runScheduleSubcommand(argv: string[]): Promise<number> {
  const [action, ...rest] = argv;
  switch (action) {
    case "tick": {
      const parsed = parseTickArgs(rest);
      if (parsed.error) {
        console.error(`schedule tick: ${parsed.error}`);
        console.error(USAGE);
        return 2;
      }
      return runScheduleTick(parsed.taskId ? { taskId: parsed.taskId } : {});
    }
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
