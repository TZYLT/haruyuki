/**
 * `haruyuki dream run|status` — the F-06 short-lived dream host (M1).
 *
 * `run --task <id>` is the command the launcher spawns (S5, `/dream run`) and
 * the scheduler delegates to when the dream signal source produced an
 * occurrence. It is a **full** process on purpose: the run needs the backend,
 * the model and the tools, unlike `schedule tick`. What is deliberately small is
 * the host itself — the whole lifecycle is S1 `runDreamTask` (M2).
 *
 * Two entry modes:
 *
 * - automatic: the scheduler core evaluates the dream signal once for this task
 *   (`includeTask`), claims the task lease, consumes the occurrence and records
 *   the terminal outcome — so a run that was delegated from a long-lived host is
 *   accounted exactly like any other scheduled run.
 * - `--manual` (`/dream run`): the signal is bypassed (the user asked for it
 *   now), but the run still takes the same lease and records the same row.
 *
 * `status` is a read-only operator view. The TUI's `/dream status` (M4) reads
 * the same exported helpers directly; this one exists so the short-lived path
 * can be diagnosed from a shell.
 */
import { readDreamActivity } from "@/agent/dream/dream-activity";
import { readDreamPressure } from "@/agent/dream/dream-pressure";
import { createDreamTaskRunner } from "@/cli/helpers/dream-host";
import {
  DREAM_ATTEMPT_COOLDOWN_MINUTES,
  DREAM_MAX_ATTEMPTS_PER_DAY,
  ensureCronSignalSourceRegistered,
  ensureDreamSignalSourceRegistered,
  evaluateDreamEligibility,
  getScheduleTask,
  isDreamRunMarkerActive,
  isWithinDreamIdleWindow,
  listTasks,
  nextDreamWindowStart,
  readDreamSignalState,
  runScheduledTaskNow,
  runSchedulerTick,
} from "@/cron";
import { createDefaultDreamSignalDeps } from "@/cron/dream-signal-deps";
import { readDreamSettings } from "@/dream-settings";
import { settingsManager } from "@/settings-manager";
import { debugWarn } from "@/utils/debug";

/**
 * Subcommands exit before `src/index.ts` initializes the settings manager, so
 * this host must load settings itself. Without it `readDreamSettings` falls back
 * to its defaults — `enabled: false` — and every real dream run would be
 * refused as "not configured". A failure here is logged and left to the same
 * default fallback (a broken settings file must not make the CLI crash).
 */
async function ensureSettingsReady(): Promise<void> {
  try {
    await settingsManager.initialize();
  } catch (error) {
    debugWarn(
      "dream",
      `settings could not be initialized: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** One diagnostic line for a store that cannot be read, mirroring `schedule`. */
function storeErrorLine(error: unknown): string {
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  return `store unreadable (${name}: ${message})`;
}

const USAGE = [
  "Usage: haruyuki dream <run|status>",
  "",
  "  run --task <id> [--manual] [--budget <n>]   run one dream task",
  "      (internal: the scheduler delegates automatic runs to this form)",
  "  status                                      read-only dream diagnostics",
].join("\n");

interface ParsedRunArgs {
  taskId?: string;
  manual: boolean;
  budgetOverrideTokens?: number;
  runId?: string;
  error?: string;
}

function parsePositiveInteger(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseRunArgs(argv: string[]): ParsedRunArgs {
  const parsed: ParsedRunArgs = { manual: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    const next = (): string | undefined => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) return undefined;
      index += 1;
      return value;
    };
    if (arg === "--task" || arg.startsWith("--task=")) {
      const value = arg.startsWith("--task=") ? arg.slice(7).trim() : next();
      if (!value) return { ...parsed, error: "--task needs an id" };
      parsed.taskId = value;
      continue;
    }
    if (arg === "--budget" || arg.startsWith("--budget=")) {
      const value = arg.startsWith("--budget=") ? arg.slice(9).trim() : next();
      const budget =
        value === undefined ? undefined : parsePositiveInteger(value);
      if (budget === undefined) {
        return { ...parsed, error: "--budget needs a positive integer" };
      }
      parsed.budgetOverrideTokens = budget;
      continue;
    }
    if (arg === "--run-id" || arg.startsWith("--run-id=")) {
      const value = arg.startsWith("--run-id=") ? arg.slice(9).trim() : next();
      if (!value) return { ...parsed, error: "--run-id needs a value" };
      parsed.runId = value;
      continue;
    }
    if (arg === "--manual" || arg === "--force") {
      parsed.manual = true;
      continue;
    }
    return { ...parsed, error: `Unknown dream run option: ${arg}` };
  }
  return parsed;
}

/** Register every source the child must evaluate before ticking. */
function registerSignalSources(): void {
  ensureCronSignalSourceRegistered();
  ensureDreamSignalSourceRegistered(createDefaultDreamSignalDeps());
}

async function runDreamOnce(argv: string[]): Promise<number> {
  const args = parseRunArgs(argv);
  if (args.error) {
    console.error(`dream run: ${args.error}`);
    console.error(USAGE);
    return 2;
  }
  if (!args.taskId) {
    console.error("dream run: --task <id> is required");
    console.error(USAGE);
    return 2;
  }
  await ensureSettingsReady();
  let task: ReturnType<typeof getScheduleTask>;
  try {
    task = getScheduleTask(args.taskId);
  } catch (error) {
    // A corrupt or newer-version schedule store is a diagnostic, not a crash:
    // the delegated child has no visible stderr (stdio is ignored), so a clean
    // one-line message plus a non-zero exit is the only signal it can leave.
    console.error(`dream run: ${storeErrorLine(error)}`);
    return 1;
  }
  if (!task) {
    console.error(`dream run: task ${args.taskId} not found`);
    return 1;
  }
  if (task.type !== "dream") {
    console.error(`dream run: task ${args.taskId} is not a dream task`);
    return 1;
  }
  const settings = readDreamSettings(task.agentId);
  // R-5.9.4: explicit configuration is the hard gate for every trigger,
  // including the manual one. Failing before the scheduler tick keeps the task's
  // failure streak clean.
  if (!settings.enabled) {
    console.error(
      "dream run: dream is not enabled — finish the dream configuration first (/dream config)",
    );
    return 1;
  }

  registerSignalSources();
  const runner = createDreamTaskRunner({
    manual: args.manual,
    ...(args.budgetOverrideTokens !== undefined
      ? { budgetOverrideTokens: args.budgetOverrideTokens }
      : {}),
  });
  const launchNote = args.runId ? ` (launch ${args.runId})` : "";

  if (args.manual) {
    const result = await runScheduledTaskNow({
      taskId: task.id,
      runner,
      now: new Date(),
    });
    if (!result.started) {
      console.error(`dream run: ${result.error ?? "the run did not start"}`);
      return 1;
    }
    console.log(
      `dream run: ${result.outcome ?? "started"}${launchNote}${result.error ? ` — ${result.error}` : ""}`,
    );
    return result.outcome === "failed" || result.outcome === "timeout" ? 1 : 0;
  }

  const result = await runSchedulerTick({
    now: new Date(),
    runner,
    includeTask: (candidate) => candidate.id === task.id,
  });
  if (!result.started) {
    // Not an error: the trigger conditions may have gone away between the
    // delegation and this process starting (the user came back, pressure eased).
    console.error(
      `dream run: task ${task.id} was not due when the host started${launchNote}`,
    );
    return 0;
  }
  console.log(
    `dream run: ${result.started.lastOutcome ?? "started"}${launchNote}`,
  );
  return result.started.lastOutcome === "failed" ||
    result.started.lastOutcome === "timeout"
    ? 1
    : 0;
}

/** `haruyuki dream status` — read-only diagnostics for operators. */
export function runDreamStatus(): number {
  let tasks: ReturnType<typeof listTasks>;
  try {
    tasks = listTasks().filter((task) => task.type === "dream");
  } catch (error) {
    console.error(`dream status: ${storeErrorLine(error)}`);
    return 1;
  }
  if (tasks.length === 0) {
    console.log("dream: no dream tasks (configure dreams to create one)");
    return 0;
  }
  const now = new Date();
  for (const record of tasks) {
    const agentId = record.agent_id;
    const settings = readDreamSettings(agentId);
    const state = readDreamSignalState(agentId);
    const pressure = readDreamPressure(agentId);
    const windowText = settings.idleWindows
      .map((window) => `${window.start}–${window.end}`)
      .join(", ");
    const inWindow = isWithinDreamIdleWindow(settings.idleWindows, now);
    const nextWindow = nextDreamWindowStart(settings.idleWindows, now);
    const nextEligibleAt = state.nextEligibleAt
      ? new Date(state.nextEligibleAt).toISOString()
      : "—";
    console.log(`dream task ${record.id} · agent ${agentId}`);
    console.log(
      `  enabled: ${settings.enabled ? "yes" : "no"} · auto-trigger: ${settings.autoTrigger ? "on" : "off"} · permission: ${settings.permissionMode}`,
    );
    console.log(
      `  window: ${windowText || "—"} · currently ${inWindow ? "inside" : "outside"} · next window ${nextWindow ? new Date(nextWindow).toISOString() : "—"}`,
    );
    console.log(
      `  silence: ${settings.silenceMinutes}m · pressure: ${Math.round(pressure)} / ${settings.pressureThreshold}`,
    );
    console.log(
      `  today: ${state.dayCount}/${DREAM_MAX_ATTEMPTS_PER_DAY} attempts · cooldown ${DREAM_ATTEMPT_COOLDOWN_MINUTES}m · next eligible ${nextEligibleAt}`,
    );
    console.log(
      `  last attempt: ${state.lastAttemptAt ? new Date(state.lastAttemptAt).toISOString() : "—"} · last outcome: ${state.lastOutcome ?? "—"} · running: ${state.running ? state.running.runId : "no"}`,
    );
    if (record.type === "dream") {
      let task: ReturnType<typeof getScheduleTask>;
      try {
        task = getScheduleTask(record.id);
      } catch (error) {
        console.error(
          `  would trigger now: unknown (${storeErrorLine(error)})`,
        );
        continue;
      }
      if (task) {
        // Same sources as the real gate: S2 activity (not a hardcoded null) and
        // the age-bounded run marker, so the operator view cannot claim
        // "eligible" while the trigger is actually blocked.
        const eligibility = evaluateDreamEligibility({
          task,
          settings,
          state,
          now,
          pressure,
          lastActiveAt: readDreamActivity(agentId),
          isRunning: isDreamRunMarkerActive(state.running, settings, now),
        });
        console.log(`  would trigger now: ${eligibility.reason}`);
      }
    }
  }
  return 0;
}

export async function runDreamSubcommand(argv: string[]): Promise<number> {
  const [action, ...rest] = argv;
  switch (action) {
    case "run":
      return runDreamOnce(rest);
    case "status":
      await ensureSettingsReady();
      return runDreamStatus();
    case "--help":
    case "-h":
    case "help":
      console.log(USAGE);
      return 0;
    default:
      if (action) {
        console.error(`Unknown dream subcommand: ${action}`);
        console.error(USAGE);
        return 2;
      }
      console.log(USAGE);
      return 0;
  }
}
