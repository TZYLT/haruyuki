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
import {
  getScheduleTask,
  readScheduleFile,
  toScheduleTaskV2,
} from "@/cron/cron-store";
import type { ScheduleTaskV2, TaskRunnerPort } from "@/cron/cron-types";
import { ensureDreamPreflightSignalSource } from "@/cron/dream-preflight";
import { runSchedulePreflight } from "@/cron/preflight";
import { evaluateSignals } from "@/cron/signal";
import { settingsManager } from "@/settings-manager";
import { debugWarn } from "@/utils/debug";

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
  /**
   * Test seam: startup crash recovery (F-06 fix, R-5.8.4). Defaults to a
   * dynamic import of T2's `recoverDreamRuns()` so the light path never pays
   * for the dream recovery graph.
   */
  recoverStaleRuns?: () => Promise<unknown>;
}

/**
 * F-06 fix (P1): this subcommand runs before `src/index.ts` initializes the
 * settings manager, so the dream preflight would otherwise read the defaults
 * (`dreamEnabled: false`) and never load the runtime for a configured dream.
 * `settingsManager.initialize()` is a settings-file read, not a backend load, so
 * the cron-only light path (C-24) is preserved. A failure is one line and a
 * quiet exit 0; the next OS tick retries.
 */
async function initializeSettingsForDreamProbe(): Promise<void> {
  try {
    await settingsManager.initialize();
  } catch (error) {
    // Continue: an unreadable settings file must not also stop ordinary cron
    // tasks. `readDreamSettings` treats "not initialized" as "dream disabled",
    // so the probe simply cannot see a dream this tick; the next OS tick retries.
    console.error(
      `schedule tick: settings unreadable: ${
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error)
      }`,
    );
  }
}

/**
 * F-06 fix (P1/R-5.8.4): repair dream runs that crashed earlier, once per host
 * start. Idempotent and never throws; the recovery graph is imported dynamically
 * so the "nothing due" path never pays for it.
 */
async function runStartupDreamRecovery(
  recover?: () => Promise<unknown>,
): Promise<void> {
  try {
    if (recover) {
      await recover();
      return;
    }
    const { recoverDreamRuns } = await import("@/agent/dream/dream-recovery");
    await recoverDreamRuns();
  } catch (error) {
    debugWarn(
      "dream",
      `startup dream recovery failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** A listener/runtime for one OS-woken tick, plus how to stop it. */
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
 * F-06 M1: replace the preflight's deliberately lightweight dream source with
 * the real one before this host evaluates for real.
 *
 * The preflight over-approximates pressure/silence to stay a light process
 * (C-24), so its registration is only good for "should we load the runtime".
 * Both modules are imported dynamically: when nothing is due, `schedule tick`
 * must still exit before pulling settings, the ledger or the agent graph.
 */
async function registerFullDreamSignalSource(): Promise<void> {
  const [
    { createDreamSignalSource },
    { createDefaultDreamSignalDeps },
    { registerSignalSource },
  ] = await Promise.all([
    import("@/cron/dream-signal"),
    import("@/cron/dream-signal-deps"),
    import("@/cron/signal"),
  ]);
  // Replace, not `ensure…`: the preflight registration may already exist and
  // must not survive into the real evaluation.
  registerSignalSource(createDreamSignalSource(createDefaultDreamSignalDeps()));
}

/**
 * F-06 M1: hand the dream occurrences this tick deferred to a short-lived child.
 *
 * The core never claims or consumes a deferred dream occurrence; the child
 * (`haruyuki dream run --task`) claims the task lease and consumes it, so the
 * occurrence survives a failed spawn and a second child cannot double-run it.
 * Failures are log lines — a tick must not fail because a delegation did not
 * start.
 */
function delegateDeferredDreams(
  runner: TaskRunnerPort,
  taskIds: readonly string[] | undefined,
): void {
  const runDream = runner.runDream;
  if (!runDream || !taskIds || taskIds.length === 0) return;
  for (const taskId of taskIds) {
    let task: ScheduleTaskV2 | null = null;
    try {
      task = getScheduleTask(taskId);
    } catch {
      continue;
    }
    if (!task || task.type !== "dream") continue;
    void runDream
      .call(runner, {
        task,
        runId: `delegated-dream-${Date.now().toString(36)}`,
        occurrence: `delegated:${new Date().toISOString()}`,
        signal: new AbortController().signal,
      })
      .then((result) => {
        if (result.outcome !== "failed") return;
        console.error(
          `schedule tick: could not delegate dream ${taskId}: ${result.error ?? "unknown error"}`,
        );
      })
      .catch((error: unknown) => {
        console.error(
          `schedule tick: could not delegate dream ${taskId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
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
    // F-06 fix (P1): the dream probe resolves settings, which are not loaded yet
    // in a subcommand process (`src/index.ts` initializes them after routing).
    // Without this, a configured dream looked disabled and the autostart path
    // never loaded the runtime. A failure is logged and the tick continues, so
    // an unreadable settings file cannot stop ordinary cron tasks too.
    await initializeSettingsForDreamProbe();
    // The dream source is registered by this caller, not by `preflight.ts`:
    // the signal core stays feature-agnostic (M-1). Registration is light
    // (state + settings readers only) and presence-guarded.
    ensureDreamPreflightSignalSource();
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
    // F-06 fix (P1/R-5.8.4): repair dream runs a killed process left behind
    // before this host evaluates. Awaited (not fire-and-forget) because this
    // process is about to exit after the tick.
    await runStartupDreamRecovery(deps.recoverStaleRuns);
    // The runtime is loaded: swap the preflight's lightweight dream probe for
    // the real dependencies before evaluating (F-06 M1).
    await registerFullDreamSignalSource();
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
    const result = await runTick({ now, runner: runtime.runner, includeTask });
    // F-06 M1: this process is the long-lived host's stand-in (the OS timer
    // woke it); a dream occurrence it deferred is delegated to the detached
    // `dream run --task` child before this process exits.
    delegateDeferredDreams(runtime.runner, result.deferredTaskIds);
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
