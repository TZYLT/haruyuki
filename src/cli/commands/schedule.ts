/**
 * `/schedule` — the hub for F-05's nine subcommands (R-5.12.1).
 *
 * The registry entry exists for every channel: a listener or headless run has no
 * overlay, so each subcommand still has to answer in text. The TUI claims the
 * face-bearing forms before dispatch (`app/submit-schedule-commands.ts`):
 * `list`, `show`, `add`, `run` and `logs` open a panel or a wizard there. The
 * rest — `pause`, `resume`, `delete`, `autostart` — is answered here, which is
 * also why the mutations live in this file once: the panel calls the same
 * helpers instead of growing a second copy.
 *
 * Parsing is one function (`parseScheduleInvocation`) returning a discriminated
 * value: the submit layer needs to know which subcommand was named and with
 * which target *before* it decides to claim, and a second `startsWith` chain
 * would drift from this table the first time a flag was added.
 *
 * There is no experiment gate. `tui_cron` was retired with the shadow scheduler
 * (`19ced59e`) and is a different thing from this command; `/schedule` is always
 * available.
 */

import {
  conversationRef,
  formatNextDueOrPending,
  liveScheduleSource,
  outcomeLabel,
  permissionLabel,
  refreshScheduleTasks,
  shortId,
  statusLabel,
  takeStartupScheduleSummaryLines,
} from "@/cli/helpers/schedule-store";
import {
  type AddTaskInput,
  addTask,
  deleteTask,
  getAutostartStatus,
  listScheduleTasks,
  type PermissionTier,
  parseAt,
  parseEvery,
  pauseTask,
  registerAutostart,
  resumeTask,
  type ScheduleTaskV2,
  unregisterAutostart,
} from "@/cron";

// ── Help ────────────────────────────────────────────────────────────

export const SCHEDULE_SUBCOMMANDS = [
  "list",
  "show",
  "add",
  "run",
  "pause",
  "resume",
  "delete",
  "logs",
  "autostart",
] as const;

export type ScheduleSubcommand = (typeof SCHEDULE_SUBCOMMANDS)[number];

/**
 * The help text, printed by `/schedule` with no subcommand and by an unknown
 * one. It names all nine (R-5.12.1) and the facts a user needs before choosing a
 * permission tier (R-5.8.3, Q-50).
 */
export function formatScheduleHelp(): string {
  return [
    "/schedule — scheduled tasks (local; run by a host)",
    "",
    "  /schedule list [--all]            List tasks (current agent only by default)",
    "  /schedule show <id|name>          Show one task",
    "  /schedule add [options]           Create; complete flags create in one step, otherwise the wizard asks",
    "  /schedule run <id|name>           Run once now (does not consume the next scheduled trigger)",
    "  /schedule pause <id|name>         Pause",
    "  /schedule resume <id|name>        Resume (resets the failure streak)",
    "  /schedule delete <id|name>        Delete",
    "  /schedule logs <id|name>          Run history (grouped by runId)",
    "  /schedule autostart on|off|status OS autostart (wakes a short-lived host every minute)",
    "",
    "add options:",
    "  --cron <5 fields> | --every <5m|2h|1d> | --at <time>   When (--at is one-off)",
    "  --prompt <text> | --command <command>                  Payload; commands limited to compact/reflect",
    "  --type prompt|command                                 Default: prompt",
    "  --target new|default|existing:<conversation id>       Target (required)",
    "  --visible | --hidden                                  New-conversation visibility (required with --target new)",
    "  --permission standard|acceptEdits|unrestricted        Permission (required)",
    "  --catch-up | --no-catch-up                            Run a missed slot on startup (required)",
    "  --timeout <minutes> --wait <minutes> --tz <IANA> --name <name>",
    "                                      0 is valid: timeout 0 = no limit, wait 0 = skip at once when busy",
    "",
    "Permission tiers (unattended: every approval request is denied):",
    "  read-only (standard): read files and search; no writes, shell, or subagents",
    "  read-write (acceptEdits): read and write files; shell is still denied",
    "  unrestricted: every tool. This build does not promise delete/network blocks (the sandbox is process-level)",
    "reflection command tasks keep the task's permission; read-only + reflect fails because it cannot write memory.",
  ].join("\n");
}

// ── Parsing ─────────────────────────────────────────────────────────

/** What `add` collected. Every field is what the user typed, not a default. */
export interface ScheduleAddDraft {
  type?: "prompt" | "command";
  payload?: string;
  cron?: string;
  recurring: boolean;
  scheduledFor?: Date;
  timezone?: string;
  target?: AddTaskInput["target"];
  targetRef?: string;
  hidden?: boolean;
  permission?: PermissionTier;
  catchUp?: boolean;
  timeoutMinutes?: number;
  waitMinutes?: number;
  name?: string;
  description?: string;
}

/** A required flag the invocation did not carry (R-5.5.5 / US-5). */
export type MissingAddFlag =
  | "--cron|--every|--at"
  | "--prompt|--command"
  | "--target"
  | "--visible|--hidden"
  | "--permission"
  | "--catch-up|--no-catch-up";

export type ScheduleInvocation =
  | { kind: "help" }
  | { kind: "error"; message: string }
  | { kind: "list"; allAgents: boolean }
  | { kind: "show"; taskRef: string }
  | { kind: "logs"; taskRef: string }
  | { kind: "run"; taskRef: string }
  | { kind: "pause"; taskRef: string }
  | { kind: "resume"; taskRef: string }
  | { kind: "delete"; taskRef: string }
  | { kind: "autostart"; action: "on" | "off" | "status" }
  | { kind: "add"; draft: ScheduleAddDraft; missing: MissingAddFlag[] };

/**
 * Split an invocation into shell-ish tokens, honouring double quotes.
 *
 * The registry is handed pre-split argv (`executeCommand` splits on whitespace),
 * so this only matters for the submit path, which claims before that split — a
 * prompt with spaces has to survive the trip.
 */
export function tokenizeScheduleInput(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quoted = false;
  for (const char of input) {
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && /\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function parseInteger(raw: string): number | null {
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function parsePermission(raw: string): PermissionTier | null {
  if (raw === "standard" || raw === "acceptEdits" || raw === "unrestricted") {
    return raw;
  }
  // The demand's words, mapped onto the tiers they were ruled onto (Q-50).
  if (raw === "read-only" || raw === "readonly") return "standard";
  if (raw === "workspace-write") return "acceptEdits";
  if (raw === "full") return "unrestricted";
  return null;
}

function missingAddFlags(draft: ScheduleAddDraft): MissingAddFlag[] {
  const missing: MissingAddFlag[] = [];
  if (!draft.cron) missing.push("--cron|--every|--at");
  if (!draft.payload) missing.push("--prompt|--command");
  if (!draft.target) missing.push("--target");
  if (draft.target?.kind === "new" && draft.hidden === undefined) {
    missing.push("--visible|--hidden");
  }
  if (!draft.permission) missing.push("--permission");
  if (draft.catchUp === undefined) missing.push("--catch-up|--no-catch-up");
  return missing;
}

function parseAdd(args: readonly string[]): ScheduleInvocation {
  const draft: ScheduleAddDraft = { recurring: true };
  const tokens = ["add", ...args];
  let error: string | null = null;
  let index = 0;

  const nextValue = (flag: string): string => {
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith("--")) {
      error = `${flag} needs a value`;
      return "";
    }
    index += 1;
    return value;
  };

  // Text flags may be followed by a multi-word value: consume until the next
  // flag so `/schedule add --prompt summarise today's commits --cron …` works,
  // which is how the unquoted registry path arrives.
  const consumeText = (flag: string): string => {
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith("--")) {
      error = `${flag} needs a value`;
      return "";
    }
    const words = [value];
    index += 1;
    while (index + 1 < tokens.length && !tokens[index + 1]?.startsWith("--")) {
      index += 1;
      words.push(tokens[index] ?? "");
    }
    return words.join(" ");
  };

  // A cron expression is five fields, and the unquoted registry path splits
  // them: take at most five tokens (or the one quoted token when there is one).
  const consumeCron = (): string => {
    const first = tokens[index + 1];
    if (first === undefined || first.startsWith("--")) {
      error = "--cron needs an expression";
      return "";
    }
    index += 1;
    const parts = [first];
    while (
      parts.length < 5 &&
      index + 1 < tokens.length &&
      !tokens[index + 1]?.startsWith("--")
    ) {
      index += 1;
      parts.push(tokens[index] ?? "");
    }
    return parts.join(" ");
  };

  while (index < tokens.length - 1) {
    index += 1;
    const flag = tokens[index] ?? "";
    switch (flag) {
      case "--type": {
        const value = nextValue(flag);
        if (value === "prompt" || value === "command") draft.type = value;
        else error = "--type accepts only prompt or command";
        break;
      }
      case "--prompt":
        draft.payload = consumeText(flag);
        draft.type = draft.type ?? "prompt";
        break;
      case "--command":
        draft.payload = consumeText(flag);
        draft.type = "command";
        break;
      case "--cron":
        draft.cron = consumeCron();
        draft.recurring = true;
        break;
      case "--every": {
        const value = nextValue(flag);
        const parsed = parseEvery(value);
        if (!parsed)
          error = `Unrecognized interval "${value}" (try 5m, 2h, 1d)`;
        else draft.cron = parsed.cron;
        draft.recurring = true;
        break;
      }
      case "--at": {
        const value = consumeText(flag);
        const parsed = parseAt(value);
        if (!parsed) {
          error = `Unrecognized time "${value}" (try "in 45m", "3:00pm")`;
        } else {
          draft.cron = parsed.cron;
          draft.recurring = false;
          draft.scheduledFor = parsed.scheduledFor;
        }
        break;
      }
      case "--target": {
        const value = nextValue(flag);
        draft.targetRef = value;
        if (value === "new") {
          draft.target = { kind: "new", hidden: draft.hidden ?? false };
        } else if (value === "default") {
          draft.target = { kind: "existing", conversation_id: "default" };
        } else if (value.startsWith("existing:")) {
          const id = value.slice("existing:".length).trim();
          draft.target = id
            ? { kind: "existing", conversation_id: id }
            : undefined;
        } else {
          // A bare id is the common paste; anything else is the user's mistake.
          draft.target = { kind: "existing", conversation_id: value };
        }
        break;
      }
      case "--conversation": {
        const value = nextValue(flag);
        draft.target = { kind: "existing", conversation_id: value };
        break;
      }
      case "--visible":
        if (draft.target?.kind === "new") {
          draft.target = { kind: "new", hidden: false };
        }
        draft.hidden = false;
        break;
      case "--hidden":
        if (draft.target?.kind === "new") {
          draft.target = { kind: "new", hidden: true };
        }
        draft.hidden = true;
        break;
      case "--permission": {
        const value = nextValue(flag);
        const permission = parsePermission(value);
        if (!permission) {
          error =
            "Permission accepts only standard / acceptEdits / unrestricted";
        } else {
          draft.permission = permission;
        }
        break;
      }
      case "--catch-up":
        draft.catchUp = true;
        break;
      case "--no-catch-up":
        draft.catchUp = false;
        break;
      case "--timeout": {
        const value = nextValue(flag);
        const minutes = parseInteger(value);
        if (minutes === null)
          error = "--timeout needs 0 or a positive number of minutes";
        else draft.timeoutMinutes = minutes;
        break;
      }
      case "--wait": {
        const value = nextValue(flag);
        const minutes = parseInteger(value);
        if (minutes === null)
          error = "--wait needs 0 or a positive number of minutes";
        else draft.waitMinutes = minutes;
        break;
      }
      case "--tz":
      case "--timezone":
        draft.timezone = nextValue(flag);
        break;
      case "--name":
        draft.name = consumeText(flag);
        break;
      case "--description":
        draft.description = consumeText(flag);
        break;
      default:
        error = `Unknown option ${flag}`;
        break;
    }
    if (error) break;
  }

  if (error) return { kind: "error", message: error };
  return { kind: "add", draft, missing: missingAddFlags(draft) };
}

/**
 * Turn the tokens after `/schedule` into the one value the callers switch on.
 *
 * A bare `/schedule` (or `/schedule help`) prints the help rather than erroring:
 * it is the hub's documented behaviour (R-5.12.1), and `executeCommand` calls it
 * with no arguments whenever the user types the name alone.
 */
export function parseScheduleInvocation(
  args: readonly string[],
): ScheduleInvocation {
  const sub = args[0]?.toLowerCase();
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    return { kind: "help" };
  }
  const rest = args.slice(1);
  const ref = rest[0];
  switch (sub) {
    case "list":
      return { kind: "list", allAgents: rest.includes("--all") };
    case "show":
      return ref ? { kind: "show", taskRef: ref } : missingRef("show");
    case "logs":
      return ref ? { kind: "logs", taskRef: ref } : missingRef("logs");
    case "run":
      return ref ? { kind: "run", taskRef: ref } : missingRef("run");
    case "pause":
      return ref ? { kind: "pause", taskRef: ref } : missingRef("pause");
    case "resume":
      return ref ? { kind: "resume", taskRef: ref } : missingRef("resume");
    case "delete":
      return ref ? { kind: "delete", taskRef: ref } : missingRef("delete");
    case "add":
      return parseAdd(rest);
    case "autostart": {
      const action = rest[0]?.toLowerCase();
      if (action === "on" || action === "off" || action === "status") {
        return { kind: "autostart", action };
      }
      return {
        kind: "error",
        message: "Usage: /schedule autostart on|off|status",
      };
    }
    default:
      return {
        kind: "error",
        message: `Unknown subcommand ${sub}. Available: ${SCHEDULE_SUBCOMMANDS.join(" / ")}`,
      };
  }
}

function missingRef(sub: string): ScheduleInvocation {
  return {
    kind: "error",
    message: `/schedule ${sub} needs a task id or name`,
  };
}

// ── Task resolution and text ────────────────────────────────────────

/**
 * Find a task by id, then by short id, then by name among the given tasks.
 *
 * The TUI's rows are the agent-scoped view; a name that matches more than one
 * task is refused rather than guessed, the rule `cron-task-ref.ts` already
 * follows for the CLI. The short id is accepted because it is what every row and
 * receipt prints (`shortId`), so `/schedule show a1b2c3d4` has to work on the
 * value the panel showed.
 */
export function resolveScheduleTask(
  taskRef: string,
  tasks: readonly ScheduleTaskV2[],
): { task: ScheduleTaskV2 } | { error: string } {
  const byId = tasks.find((task) => task.id === taskRef);
  if (byId) return { task: byId };
  const byShortId = tasks.filter((task) => shortId(task.id) === taskRef);
  if (byShortId.length === 1) return { task: byShortId[0] as ScheduleTaskV2 };
  if (byShortId.length > 1) {
    return {
      error: `"${taskRef}" matches ${byShortId.length} tasks; use the full id: ${byShortId
        .map((task) => task.id)
        .join(", ")}`,
    };
  }
  const byName = tasks.filter((task) => task.name === taskRef);
  if (byName.length === 1) return { task: byName[0] as ScheduleTaskV2 };
  if (byName.length > 1) {
    return {
      error: `"${taskRef}" matches ${byName.length} tasks; use an id: ${byName
        .map((task) => shortId(task.id))
        .join(", ")}`,
    };
  }
  return { error: `Task ${taskRef} not found` };
}

/** One task's detail, as lines the command row or the panel can print. */
export function formatScheduleDetailLines(
  task: ScheduleTaskV2,
  now: Date,
  nextDueAt: Date | null,
): string[] {
  const line = (label: string, value: string): string =>
    `${label.padEnd(10)} ${value}`;
  const target =
    task.target.kind === "new"
      ? `new conversation${task.target.hidden ? " (hidden)" : ""}`
      : `conversation ${conversationRef(task.target.conversation_id)}`;
  return [
    `${task.name} (${task.id})`,
    line("Type", `${task.type} · ${task.payload}`),
    line("Target", target),
    line(
      "Schedule",
      `${task.cron} · ${task.timezone} · ${task.recurring ? "recurring" : "one-off"}`,
    ),
    line("Status", statusLabel(task)),
    line("Permission", permissionLabel(task.permission)),
    line(
      "Catch-up",
      `${task.catchUp ? "yes" : "no"} · timeout ${
        task.timeoutMinutes === 0
          ? "no limit"
          : `${task.timeoutMinutes} minutes`
      } · wait ${task.waitMinutes} minutes`,
    ),
    line(
      "Last",
      `${outcomeLabel(task.lastOutcome)}${
        task.lastRunAt ? ` · ${task.lastRunAt}` : ""
      }${task.lastError ? ` · ${task.lastError}` : ""}`,
    ),
    line(
      "Failures",
      `${task.consecutiveFailures} in a row · ${task.missedCount} missed · ${task.failedCount} failed`,
    ),
    line("Next", formatNextDueOrPending(nextDueAt, now)),
  ];
}

/** `missing` as the sentence the wizard and the registry both show. */
export function formatMissingAddFlags(
  missing: readonly MissingAddFlag[],
): string {
  return `Missing required flags: ${missing.join(", ")}`;
}

/**
 * Whether a detail line is where an auto-paused task's warning belongs.
 *
 * The panel used to colour `index === 4`, which silently stopped pointing at the
 * status line the moment the list gained or lost a field. The lines are keyed by
 * what they say instead: the status line and the failure-streak line are the two
 * the warning is about, and both exist in every detail rendering.
 */
export function isAutoPauseDetailLine(
  task: ScheduleTaskV2,
  line: string,
): boolean {
  if (task.pausedReason !== "auto_failures") return false;
  return line.startsWith("Status") || line.startsWith("Failures");
}

// ── Creation (one place for the one-step form and the wizard) ───────

export interface CreateScheduleInput {
  agentId: string;
  draft: ScheduleAddDraft;
}

/**
 * What a created task is reduced to for the receipt and the wizard.
 *
 * Deliberately not the persisted record: the receipt needs five facts, and a
 * face (or a test) that only has to say "created this, with this permission"
 * should not have to fabricate a full `CronTask`.
 */
export interface CreatedScheduleSummary {
  taskId: string;
  name: string;
  cron: string;
  timezone: string;
  permission: PermissionTier;
  warning?: string;
}

export type CreateScheduleResult =
  | ({ kind: "created" } & CreatedScheduleSummary)
  | { kind: "error"; message: string };

/**
 * Create the task from a complete draft (R-5.12.1: 一步参数化完成).
 *
 * The draft has already passed `missingAddFlags`; this only refuses what the
 * store would refuse anyway and turns the store's throw into one message. The
 * F-05 fields are passed through and defaulted by the store's normalizer, so a
 * caller that cannot carry them still creates a valid v1-shaped task.
 */
export function createScheduleTask(
  input: CreateScheduleInput,
): CreateScheduleResult {
  const { draft, agentId } = input;
  if (!draft.payload || !draft.cron || !draft.permission) {
    return {
      kind: "error",
      message: formatMissingAddFlags(missingAddFlags(draft)),
    };
  }
  const type = draft.type ?? "prompt";
  const name =
    draft.name?.trim() ||
    `${type === "command" ? "Command" : "Prompt"}: ${draft.payload.slice(0, 32)}`;
  const description = draft.description?.trim() || draft.payload.slice(0, 80);
  const target: AddTaskInput["target"] =
    draft.target ?? ({ kind: "new", hidden: draft.hidden ?? false } as const);
  try {
    const created = addTask({
      agent_id: agentId,
      name,
      description,
      cron: draft.cron,
      recurring: draft.recurring,
      prompt: draft.payload,
      type,
      payload: draft.payload,
      target,
      permission: draft.permission,
      catch_up: draft.catchUp ?? false,
      timeout_minutes: draft.timeoutMinutes,
      wait_minutes: draft.waitMinutes,
      timezone: draft.timezone,
      scheduled_for: draft.scheduledFor,
    });
    refreshScheduleTasks();
    return {
      kind: "created",
      taskId: created.task.id,
      name: created.task.name,
      cron: created.task.cron,
      timezone: created.task.timezone,
      permission: created.task.permission ?? draft.permission,
      warning: created.warning,
    };
  } catch (error) {
    return {
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * The receipt for a created task: what was made, and the facts that decide
 * whether it will actually run.
 */
export function formatScheduleCreatedLines(
  result: CreateScheduleResult,
  options?: {
    autostart?: "registered" | "declined" | "failed";
    detail?: string;
  },
): string[] {
  if (result.kind === "error")
    return [`Failed to create task: ${result.message}`];
  const lines = [
    `Created scheduled task ${result.name} (${shortId(result.taskId)})`,
    `  ${result.cron} · ${result.timezone} · permission ${permissionLabel(result.permission)}`,
    result.warning ? `  ${result.warning}` : "",
  ].filter(Boolean);
  if (options?.autostart === "failed") {
    lines.push(
      `  Task created, but autostart is not registered: ${options.detail ?? "registration failed"}. It runs only while Haruyuki is running.`,
    );
  } else if (options?.autostart === "declined") {
    lines.push(
      "  Autostart not registered (you chose No): the task runs only while Haruyuki is running.",
    );
  } else if (options?.autostart === "registered") {
    lines.push(
      "  Autostart registered: a short-lived host checks every minute.",
    );
  }
  return lines;
}

// ── Mutations ───────────────────────────────────────────────────────

function mutationReceipt(
  action: "pause" | "resume" | "delete",
  result: { success: boolean; name: string; error?: string },
): string {
  const verbs = {
    pause: "Paused",
    resume: "Resumed",
    delete: "Deleted",
  } as const;
  if (!result.success) {
    return `${result.name}: ${result.error ?? "operation failed"}`;
  }
  return `${verbs[action]} ${result.name}`;
}

/** The agent's tasks, or every task when `all` is asked for. */
export function scheduleTasksFor(
  agentId: string | undefined,
  all: boolean,
): ScheduleTaskV2[] {
  const tasks = listScheduleTasks();
  if (all || !agentId) return tasks;
  return tasks.filter((task) => task.agentId === agentId);
}

export interface ScheduleCommandScope {
  agentId?: string;
  now?: Date;
}

/**
 * The registry handler: every subcommand that does not need an overlay.
 *
 * `list`/`show`/`logs` answer in text here because a listener has no panel; the
 * TUI claims them earlier and never reaches this. `run` is the one subcommand
 * this cannot do — execution must go through the host that owns the runner, so
 * the text says where it works.
 */
export async function handleScheduleCommand(
  args: string[],
  scope?: ScheduleCommandScope,
): Promise<string> {
  const invocation = parseScheduleInvocation(args);
  const now = scope?.now ?? new Date();
  switch (invocation.kind) {
    case "help":
      return formatScheduleHelp();
    case "error":
      return `${invocation.message}\n\nRun /schedule for usage.`;
    case "list": {
      const tasks = scheduleTasksFor(scope?.agentId, invocation.allAgents);
      if (tasks.length === 0) {
        return invocation.allAgents
          ? "No scheduled tasks yet. Create one with /schedule add."
          : "This agent has no scheduled tasks yet. Create one with /schedule add (or use --all to see every task).";
      }
      const source = liveScheduleSource();
      return tasks
        .map((task) => {
          const next = formatNextDueOrPending(source.nextDueAt(task, now), now);
          return `${shortId(task.id)}  ${task.name} · ${task.type} · ${task.status} · ${outcomeLabel(task.lastOutcome)} · next ${next}`;
        })
        .join("\n");
    }
    case "show":
    case "logs": {
      // Agent-scope rule (M3 #19): `list`/`show`/`logs` answer for the current
      // agent only — the panel is the agent's own view (R-5.12.4), and a
      // listener's `/schedule show` must not expose another agent's task. A
      // mutation, by contrast, may name any task the machine owns: the user
      // typed an id or name, and the store resolves it to exactly one row.
      const resolved = resolveScheduleTask(
        invocation.taskRef,
        scheduleTasksFor(scope?.agentId, false),
      );
      if ("error" in resolved) return resolved.error;
      if (invocation.kind === "show") {
        return formatScheduleDetailLines(
          resolved.task,
          now,
          liveScheduleSource().nextDueAt(resolved.task, now),
        ).join("\n");
      }
      // The run log is rendered by the panel; in text the pointer is the honest
      // answer (`/schedule logs` has the grouping and the paging there).
      return `/schedule logs ${shortId(resolved.task.id)}: open the run history in the TUI panel.`;
    }
    case "run":
      return "/schedule run must run in the TUI: it uses the TUI host's own runner.";
    case "pause":
    case "resume":
    case "delete": {
      // Cross-agent on purpose (M3 #19): the mutation resolves the reference
      // against every task the machine owns, because the user named it. An
      // ambiguous name is refused by `resolveScheduleTask` rather than guessed.
      const resolved = resolveScheduleTask(
        invocation.taskRef,
        scheduleTasksFor(scope?.agentId, true),
      );
      if ("error" in resolved) return resolved.error;
      const task = resolved.task;
      if (invocation.kind === "delete") {
        const ok = deleteTask(task.id);
        refreshScheduleTasks();
        return mutationReceipt("delete", {
          success: ok,
          name: task.name,
          error: ok ? undefined : "the task no longer exists",
        });
      }
      const result =
        invocation.kind === "pause" ? pauseTask(task.id) : resumeTask(task.id);
      refreshScheduleTasks();
      return mutationReceipt(invocation.kind, {
        success: result.success,
        name: task.name,
        error: result.error,
      });
    }
    case "autostart":
      return await formatAutostartReceipt(invocation.action);
    case "add": {
      if (invocation.missing.length > 0) {
        return [
          formatMissingAddFlags(invocation.missing),
          "",
          "Run `/schedule add` in the TUI to open the wizard and fill each one in.",
        ].join("\n");
      }
      if (!scope?.agentId) return "No current agent; cannot create a task.";
      const created = createScheduleTask({
        agentId: scope.agentId,
        draft: invocation.draft,
      });
      return formatScheduleCreatedLines(created).join("\n");
    }
  }
}

/**
 * The pure receipt for one `autostart` answer, split out so "could not confirm"
 * is testable without touching the OS.
 *
 * `unregisterAutostart` may *return* `registered: false` with an `error` when it
 * could not read or write the crontab — that is not the same fact as "the entry
 * is gone", and M3 #7 exists because the old receipt called it "autostart off".
 */
export function formatAutostartResult(
  action: "on" | "off" | "status",
  status: {
    registered: boolean;
    method: string | null;
    launcherPath?: string;
    error?: string;
  },
): string {
  if (action === "on") {
    return status.registered
      ? `Autostart registered (${status.method ?? "unknown method"}${
          status.launcherPath ? `, ${status.launcherPath}` : ""
        }).`
      : `Autostart registration failed: ${status.error ?? "unknown reason"}`;
  }
  if (action === "off") {
    if (status.registered) {
      return `Autostart is still present: ${status.error ?? "uninstall did not take effect"}`;
    }
    if (status.error) {
      return `Could not confirm autostart is off: ${status.error}. The entry may still exist; check manually.`;
    }
    return "Autostart off. Tasks run only while Haruyuki is running.";
  }
  if (status.registered) {
    return `Autostart: registered (${status.method ?? "unknown method"}).`;
  }
  return `Autostart: not registered${status.error ? ` (${status.error})` : ""}.`;
}

/**
 * `autostart on|off|status`, with the M4 failure paths treated as answers.
 *
 * `registerAutostart`/`unregisterAutostart` throw on a policy denial and may
 * also *return* `registered: false` with an `error`; the command has to be able
 * to say either, because the wizard offers a retry on both.
 */
export async function formatAutostartReceipt(
  action: "on" | "off" | "status",
): Promise<string> {
  try {
    if (action === "on") {
      return formatAutostartResult(action, await registerAutostart());
    }
    if (action === "off") {
      return formatAutostartResult(action, await unregisterAutostart());
    }
    return formatAutostartResult(action, await getAutostartStatus());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const verb =
      action === "on"
        ? "registration"
        : action === "off"
          ? "unregistration"
          : "status read";
    return `Autostart ${verb} failed: ${message}`;
  }
}

/**
 * The startup summary the two launch effects print (R-5.11.2).
 *
 * Re-exported through this module so the coordinator's wiring imports one
 * place, and so "read once, mark once" lives beside the command that can replay
 * the same records (`/schedule logs`).
 */
export function startupScheduleSummaryLines(now = new Date()): string[] {
  return takeStartupScheduleSummaryLines(now);
}
