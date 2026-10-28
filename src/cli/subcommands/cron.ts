/**
 * `haruyuki cron` CLI subcommand.
 *
 * Usage:
 *   haruyuki cron add --prompt <text> --every <interval> [--agent <id>] [--conversation <id>]
 *   haruyuki cron add --prompt <text> --at <time> [--once] [--agent <id>]
 *   haruyuki cron add --prompt <text> --cron <expr> [--agent <id>]
 *   haruyuki cron list [--agent <id>] [--conversation <id>]
 *   haruyuki cron get <id|name>
 *   haruyuki cron runs --id <id>
 *   haruyuki cron delete <id|name>   (alias: remove)
 *   haruyuki cron delete --all [--agent <id>]
 *
 * Every schedule is device-local: it lives in `schedules.json` under the
 * harness root (`~/.haruyuki` unless `HARUYUKI_HOME` moves it), next to the
 * read-only `crons.v1.json` backup the F-05 migration left behind. Runs fire from
 * the WS listener process on this device. Durable Cloud schedules were removed
 * with the rest of the Cloud surface.
 */

import { parseArgs } from "node:util";
import {
  addTask,
  deleteAllTasks,
  deleteTask,
  getCronRunLogPath,
  getTask,
  isValidCron,
  listTasks,
  parseAt,
  parseEvery,
  readCronRunLogEntriesPage,
} from "@/cron";
import {
  resolveCronAddConversationTarget,
  resolveCronAgentId,
  resolveCronConversationFilter,
} from "./cron-scope";
import { printAmbiguousTaskName, resolveTaskName } from "./cron-task-ref";

// ── Usage ───────────────────────────────────────────────────────────

function printUsage(): void {
  console.log(
    `
Usage:
  haruyuki cron add --prompt <text> --every <interval> [options]
  haruyuki cron add --prompt <text> --at <time> [--once] [options]
  haruyuki cron add --prompt <text> --cron <expr> [options]
  haruyuki cron list [options]
  haruyuki cron get <id|name>
  haruyuki cron runs --id <id> [--limit <n>]
  haruyuki cron delete <id|name>   (alias: remove)
  haruyuki cron delete --all [--agent <id>]

Add options:
  --prompt <text>        Prompt to send to the agent (required)
  --every <interval>     Recurring interval (e.g. 5m, 2h, 1d)
  --at <time>            Scheduled time (e.g. "in 45m", "3:00pm", or an
                         RFC 3339 timestamp with an explicit timezone)
  --once                 Fire once (with --at); default for --at
  --cron <expr>          Raw 5-field cron expression
  --agent <id>           Agent ID (defaults to HARUYUKI_AGENT_ID)
  --conversation <id>    Conversation target (omit or "new" for a fresh
                         conversation per fire; "self" for the current
                         conversation; "default" for the agent default)

List/filter options:
  --agent <id>           Filter by agent ID
  --conversation <id>    Filter by conversation ID

Delete options:
  --all                  Delete all tasks for the given agent

Output is JSON.
`.trim(),
  );
}

// ── Args ────────────────────────────────────────────────────────────

const CRON_OPTIONS = {
  help: { type: "boolean", short: "h" },
  name: { type: "string" },
  description: { type: "string" },
  prompt: { type: "string" },
  every: { type: "string" },
  at: { type: "string" },
  once: { type: "boolean" },
  cron: { type: "string" },
  agent: { type: "string" },
  conversation: { type: "string" },
  all: { type: "boolean" },
  id: { type: "string" },
  limit: { type: "string" },
  "run-id": { type: "string" },
  // Accepted only so a stale `--computer` gets an actionable error instead of
  // an "unknown option" usage dump.
  computer: { type: "string" },
} as const;

type CronArgValues = ReturnType<typeof parseCronArgs>["values"];

function parseCronArgs(argv: string[]) {
  return parseArgs({
    args: argv,
    options: CRON_OPTIONS,
    strict: true,
    allowPositionals: true,
  });
}

// ── Handlers ────────────────────────────────────────────────────────

function handleAdd(values: CronArgValues): number {
  const name = values.name;
  if (!name || typeof name !== "string") {
    console.error("Error: --name is required.");
    return 1;
  }

  const description = values.description;
  if (!description || typeof description !== "string") {
    console.error("Error: --description is required.");
    return 1;
  }

  const prompt = values.prompt;
  if (!prompt || typeof prompt !== "string") {
    console.error("Error: --prompt is required.");
    return 1;
  }

  const agentId = resolveCronAgentId(values.agent);
  if (!agentId) {
    console.error("Error: --agent or HARUYUKI_AGENT_ID required.");
    return 1;
  }

  const conversationId = resolveCronAddConversationTarget(values.conversation);
  if (conversationId === null) return 1;

  if (values.computer) {
    console.error(
      "Error: --computer is no longer supported. Schedules always run on this computer.",
    );
    return 1;
  }

  // Determine schedule type
  const everyValue = values.every;
  const atValue = values.at;
  const cronValue = values.cron;

  const specCount = [everyValue, atValue, cronValue].filter(Boolean).length;
  if (specCount === 0) {
    console.error("Error: one of --every, --at, or --cron is required.");
    return 1;
  }
  if (specCount > 1) {
    console.error("Error: only one of --every, --at, or --cron allowed.");
    return 1;
  }

  let cron: string;
  let recurring: boolean;
  let scheduledFor: Date | undefined;
  let note: string | undefined;

  if (everyValue) {
    const parsed = parseEvery(everyValue);
    if (!parsed) {
      console.error(`Error: invalid interval "${everyValue}". Try: 5m, 2h, 1d`);
      return 1;
    }
    cron = parsed.cron;
    recurring = true;
    note = parsed.note;
  } else if (atValue) {
    const parsed = parseAt(atValue);
    if (!parsed) {
      console.error(
        `Error: invalid time "${atValue}". Try: "in 45m", "3:00pm", or "2026-09-24T09:00:00-07:00"`,
      );
      return 1;
    }
    cron = parsed.cron;
    recurring = false;
    scheduledFor = parsed.scheduledFor;
    note = parsed.note;
  } else if (cronValue) {
    if (!isValidCron(cronValue)) {
      console.error(
        `Error: invalid cron expression "${cronValue}". Needs 5 fields.`,
      );
      return 1;
    }
    if (values.once) {
      console.error(
        "Error: --once cannot be used with --cron. Use --at for one-shot tasks.",
      );
      return 1;
    }
    cron = cronValue;
    recurring = true;
  } else {
    console.error("Error: no schedule specified.");
    return 1;
  }

  try {
    const result = addTask({
      agent_id: agentId,
      conversation_id: conversationId,
      name,
      description,
      cron,
      recurring,
      prompt,
      scheduled_for: scheduledFor,
    });

    const output: Record<string, unknown> = {
      id: result.task.id,
      runner: "local",
      status: result.task.status,
      cron: result.task.cron,
      recurring: result.task.recurring,
      agent_id: result.task.agent_id,
      conversation_id: result.task.conversation_id,
      created_at: result.task.created_at,
    };

    if (result.task.scheduled_for) {
      output.scheduled_for = result.task.scheduled_for;
    }
    if (result.task.expires_at) {
      output.expires_at = result.task.expires_at;
    }
    if (note) {
      output.note = note;
    }
    if (result.warning) {
      output.warning = result.warning;
    }

    console.log(JSON.stringify(output, null, 2));
    console.error(
      "Created local schedule: it only fires while a Haruyuki session is running on this device.",
    );
    return 0;
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

function handleList(values: CronArgValues): number {
  const agentId = values.agent || process.env.HARUYUKI_AGENT_ID || undefined;
  const conversationId = resolveCronConversationFilter(values.conversation);
  if (conversationId === null) return 1;

  const output: Array<Record<string, unknown>> = listTasks({
    agent_id: agentId,
    conversation_id: conversationId,
  }).map((task) => ({ ...task, runner: "local" }));

  console.log(JSON.stringify(output, null, 2));
  return 0;
}

function handleGet(positionals: string[]): number {
  const taskRef = positionals[1];
  if (!taskRef) {
    console.error(
      "Error: task ID or name required. Usage: haruyuki cron get <id|name>",
    );
    return 1;
  }

  const task = getTask(taskRef);
  if (task) {
    console.log(JSON.stringify({ ...task, runner: "local" }, null, 2));
    return 0;
  }

  const resolved = resolveTaskName(taskRef);
  if (resolved && "ambiguous" in resolved) {
    printAmbiguousTaskName(taskRef, resolved.ambiguous);
    return 1;
  }
  if (resolved) {
    const named = getTask(resolved.id);
    if (named) {
      console.log(JSON.stringify({ ...named, runner: "local" }, null, 2));
      return 0;
    }
  }

  console.error(`Error: task ${taskRef} not found.`);
  return 1;
}

function handleRuns(values: CronArgValues): number {
  const id = values.id;
  if (!id || typeof id !== "string") {
    console.error(
      "Error: --id is required. Usage: haruyuki cron runs --id <id>",
    );
    return 1;
  }

  if (!getTask(id)) {
    console.error(`Error: task ${id} not found.`);
    return 1;
  }

  const limitRaw = Number.parseInt(String(values.limit ?? "50"), 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 50;
  const runId = values["run-id"];

  try {
    const logPath = getCronRunLogPath(id);
    const page = readCronRunLogEntriesPage(logPath, {
      jobId: id,
      limit,
      ...(typeof runId === "string" && runId.trim() ? { runId } : {}),
    });
    console.log(JSON.stringify(page, null, 2));
    return 0;
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

function handleDelete(values: CronArgValues, positionals: string[]): number {
  if (values.all) {
    return handleDeleteAll(values);
  }

  const taskRef = positionals[1];
  if (!taskRef) {
    console.error(
      "Error: task ID or name required. Usage: haruyuki cron delete <id|name> or --all --agent <id>",
    );
    return 1;
  }

  if (deleteTask(taskRef)) {
    console.log(JSON.stringify({ deleted: taskRef, runner: "local" }));
    return 0;
  }

  // Not an ID - try it as a task name (LET-10492): `add` requires --name, so
  // the name is the handle users actually remember.
  const resolved = resolveTaskName(taskRef);
  if (resolved && "ambiguous" in resolved) {
    printAmbiguousTaskName(taskRef, resolved.ambiguous);
    return 1;
  }
  if (resolved && deleteTask(resolved.id)) {
    console.log(
      JSON.stringify({ deleted: resolved.id, name: taskRef, runner: "local" }),
    );
    return 0;
  }

  console.error(`Error: task ${taskRef} not found.`);
  return 1;
}

function handleDeleteAll(values: CronArgValues): number {
  const agentId = resolveCronAgentId(values.agent);
  if (!agentId) {
    console.error("Error: --agent or HARUYUKI_AGENT_ID required with --all.");
    return 1;
  }

  const deleted = deleteAllTasks(agentId);

  console.log(
    JSON.stringify({
      deleted,
      local_deleted: deleted,
      agent_id: agentId,
    }),
  );
  return 0;
}

// ── Entry ───────────────────────────────────────────────────────────

export async function runCronSubcommand(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseCronArgs>;
  try {
    parsed = parseCronArgs(argv);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    printUsage();
    return 1;
  }

  const [action] = parsed.positionals;
  if (parsed.values.help || !action || action === "help") {
    printUsage();
    return 0;
  }

  switch (action) {
    case "add":
      return handleAdd(parsed.values);
    case "list":
      return handleList(parsed.values);
    case "get":
      return handleGet(parsed.positionals);
    case "runs":
      return handleRuns(parsed.values);
    case "delete":
    // "remove" reads naturally enough that agents/scripts reach for it, and
    // the old "Unknown action" + usage dump was easy to misread as success
    // in captured output (LET-10492).
    case "remove":
      return handleDelete(parsed.values, parsed.positionals);
    default:
      console.error(`Unknown action: ${action}`);
      printUsage();
      return 1;
  }
}
