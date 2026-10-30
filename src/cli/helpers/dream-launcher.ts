/**
 * Dream launcher seam and child-process wiring (F-06 M1, route §2.3.5 S5).
 *
 * Two consumers share this module:
 *
 * - `/dream run` (M4, T4) calls {@link startDreamRun}: it resolves the settings,
 *   refuses while a run is already active, makes sure the agent has its dream
 *   task, and spawns the detached `haruyuki dream run --task <id>` host. It
 *   returns immediately, so the input loop is never blocked by a 45-minute run.
 * - The long-lived hosts (TUI delegation, listener delegation, autostart
 *   short-lived host) call {@link spawnDreamRunProcess} for an automatic
 *   occurrence: the scheduler core deferred it, the child claims the task lease
 *   and consumes the occurrence itself.
 *
 * Everything the child needs to know is on its command line; the child resolves
 * the task, re-checks the trigger (route §2.2 "二次校验") and then hands the
 * lifecycle to S1 `runDreamTask`. Parent and child therefore share no state
 * except the schedule store and the dream signal state file.
 */
import { type SpawnOptions, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { isDreamRunLive } from "@/agent/dream/dream-liveness";
import {
  addTask,
  type CronTask,
  DREAM_PLACEHOLDER_CRON,
  getScheduleTask,
  listTasks,
  serializeDreamTaskPayload,
} from "@/cron";
import {
  type ResolvedDreamSettings,
  readDreamSettings,
} from "@/dream-settings";
import { debugWarn } from "@/utils/debug";

export interface StartDreamRunInput {
  agentId: string;
  /** `--budget` override for this one run, when the user passed one. */
  budgetOverrideTokens?: number;
}

export interface StartDreamRunResult {
  started: boolean;
  runId: string | null;
  /** Why the run did not start (settings off, lock held, already running). */
  reason?: string;
}

/** Options for the child command line; all optional for an automatic run. */
export interface DreamRunCommandOptions {
  /** `/dream run`: bypasses the idle window / silence / pressure checks. */
  manual?: boolean;
  /** Once-per-run token budget override (`/dream run --budget`). */
  budgetOverrideTokens?: number;
  /** Correlation id for the launch, so a log line can name the request. */
  runId?: string;
}

/**
 * The command that re-enters this build's own short-lived dream host.
 *
 * Bundled/Node artifact: `node <haruyuki.js> dream run --task <id>`.
 * Dev under Bun: `bun src/standalone-entry.ts dream run --task <id>` — the same
 * entry the delegated schedule tick uses, which loads the app after its OAuth
 * bootstrap. The dream child genuinely needs the full runtime (backend,
 * providers, tools), unlike `schedule tick`.
 */
export function dreamRunCommand(
  taskId: string,
  options: DreamRunCommandOptions = {},
): { command: string; args: string[] } {
  const tail = ["dream", "run", "--task", taskId];
  if (options.manual) tail.push("--manual");
  if (
    options.budgetOverrideTokens !== undefined &&
    Number.isFinite(options.budgetOverrideTokens) &&
    options.budgetOverrideTokens > 0
  ) {
    tail.push("--budget", String(Math.trunc(options.budgetOverrideTokens)));
  }
  if (options.runId) tail.push("--run-id", options.runId);
  if (process.versions.bun) {
    // Resolve the dev entry next to the invoked entry, so a TUI started from a
    // directory other than the repository root still finds it.
    const invoked = process.argv[1];
    const entry = invoked
      ? resolve(dirname(invoked), "standalone-entry.ts")
      : "src/standalone-entry.ts";
    // The loader flags are passed explicitly: Bun reads `bunfig.toml` from the
    // child's cwd, and the dream child must not depend on being started from the
    // repository root (a user may run the TUI from anywhere, and a repo cwd
    // would also risk project-level harness writes).
    return {
      command: process.execPath,
      args: [
        "--loader=.md:text",
        "--loader=.mdx:text",
        "--loader=.txt:text",
        entry,
        ...tail,
      ],
    };
  }
  return {
    command: process.execPath,
    args: [process.argv[1] ?? "haruyuki.js", ...tail],
  };
}

/** Called exactly once, on spawn error or process exit. */
export type DreamChildExitHandler = () => void;

/**
 * Spawn the short-lived dream host, detached so the caller's exit cannot kill
 * a run that is mid-flight (C-15: the long-lived tick must not wait for it).
 * Returns `null` when the child could not be started at all.
 */
export function spawnDreamRunProcess(
  taskId: string,
  options: DreamRunCommandOptions = {},
  onExit?: DreamChildExitHandler,
): { pid?: number } | null {
  const { command, args } = dreamRunCommand(taskId, options);
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      env: process.env,
    } satisfies SpawnOptions);
  } catch (error) {
    debugWarn(
      "dream",
      `could not spawn the dream host for ${taskId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    onExit?.();
    return null;
  }
  let settled = false;
  const settle = (): void => {
    if (settled) return;
    settled = true;
    onExit?.();
  };
  child.once("error", (error) => {
    debugWarn(
      "dream",
      `dream host for ${taskId} could not start: ${error.message}`,
    );
    settle();
  });
  child.once("exit", settle);
  child.unref();
  return { pid: child.pid };
}

/**
 * The agent's dream task, if it has one that is still schedulable (active or
 * paused). Paused is included on purpose: `/dream run` is a manual override and
 * the launcher must not create a second task just because the automatic one is
 * paused for failures.
 */
export function findDreamTask(agentId: string): CronTask | null {
  try {
    const tasks = listTasks({ agent_id: agentId }).filter(
      (task) => task.type === "dream",
    );
    return (
      tasks.find((task) => task.status === "active") ??
      tasks.find((task) => task.status === "paused") ??
      null
    );
  } catch (error) {
    debugWarn(
      "dream",
      `could not list dream tasks for ${agentId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

/**
 * Ensure the agent has a dream task and return it.
 *
 * The dream trigger is a signal source, so it needs a persisted task to hang
 * occurrences on; the task is a carrier only (placeholder cron, `new`+hidden
 * target, `timeout_minutes: 0`). Created lazily by the first path that needs it
 * (`/dream run`, and the TUI host on behalf of the configured agent), so
 * enabling dreams in the settings page does not have to write the schedule
 * store from the settings UI.
 *
 * Throws when the store rejects the record — callers turn that into a user
 * visible reason rather than a silent no-op.
 */
export function ensureDreamTask(
  agentId: string,
  settings: ResolvedDreamSettings = readDreamSettings(agentId),
): CronTask {
  const existing = findDreamTask(agentId);
  if (existing) return existing;
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const { task } = addTask({
    agent_id: agentId,
    name: "Dream",
    description:
      "Carrier for the dream trigger (F-06). The dream signal source decides when it runs; the cron expression is a placeholder and never fires.",
    cron: DREAM_PLACEHOLDER_CRON,
    timezone,
    recurring: true,
    prompt: "",
    payload: serializeDreamTaskPayload({ version: 1 }),
    type: "dream",
    target: { kind: "new", hidden: true },
    permission: settings.permissionMode,
    // R-5.3.4 / route C-17: the F-05 default is 30 minutes, which would cut a
    // long dream run silently.
    timeout_minutes: 0,
    wait_minutes: 0,
    catch_up: false,
  });
  return task;
}

/** The task the human-facing `/dream run` would use, without creating one. */
export function describeDreamTask(agentId: string): {
  task: CronTask | null;
  taskId: string | null;
  type: string | null;
} {
  const task = findDreamTask(agentId);
  if (!task) return { task: null, taskId: null, type: null };
  return { task, taskId: task.id, type: task.type ?? "prompt" };
}

/**
 * S5: start one dream run for an agent, right now.
 *
 * The hard gate is R-5.9.4: without explicit configuration (the master switch)
 * nothing runs and the answer says why. The single-instance gate is the dream
 * run marker in the signal state file (T2's dream lock is the authoritative
 * one inside the child); a launch that races another one exits at the child's
 * task-lease claim instead of running twice.
 *
 * `spawn` is an additive test seam: the frozen S5 signature only has the input
 * object, and the single caller (`/dream run`, M4) passes one argument.
 */
export async function startDreamRun(
  input: StartDreamRunInput,
  spawn: typeof spawnDreamRunProcess = spawnDreamRunProcess,
): Promise<StartDreamRunResult> {
  const settings = readDreamSettings(input.agentId);
  if (!settings.enabled) {
    return {
      started: false,
      runId: null,
      reason:
        "dream is not enabled: finish the dream configuration first (/dream config)",
    };
  }
  let running = false;
  try {
    // Not the bare marker: a crashed run leaves the marker behind, and that
    // remnant used to make `/dream run` refuse forever. T2's `isDreamRunLive`
    // combines marker + lease + owner liveness + an age bound, so a dead run
    // reads as "not live" and the user keeps the manual escape hatch.
    running = isDreamRunLive(input.agentId);
  } catch {
    running = false;
  }
  if (running) {
    return {
      started: false,
      runId: null,
      reason: "a dream run is already in progress for this agent",
    };
  }

  let task: CronTask;
  try {
    task = ensureDreamTask(input.agentId, settings);
  } catch (error) {
    return {
      started: false,
      runId: null,
      reason: `could not prepare the dream task: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  const runId = `dream-launch-${randomBytes(4).toString("hex")}`;
  const child = spawn(task.id, {
    manual: true,
    ...(input.budgetOverrideTokens !== undefined
      ? { budgetOverrideTokens: input.budgetOverrideTokens }
      : {}),
    runId,
  });
  if (!child) {
    return {
      started: false,
      runId: null,
      reason: "could not spawn the dream run process",
    };
  }
  return { started: true, runId };
}

/**
 * The task id an already-deferred occurrence belongs to, or `null` when the
 * task vanished / is not a dream. Used by hosts that only receive ids from the
 * scheduler core and must spawn the child themselves.
 */
export function resolveDeferredDreamTaskId(taskId: string): string | null {
  try {
    const task = getScheduleTask(taskId);
    return task && task.type === "dream" ? task.id : null;
  } catch {
    return null;
  }
}
