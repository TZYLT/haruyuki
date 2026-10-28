import { CronExpressionParser } from "cron-parser";
import {
  type AddTaskInput,
  addTask,
  type CronTask,
  deleteTask,
  isValidCron,
  listTasks,
  parseRfc3339Timestamp,
} from "@/cron";
import { getRuntimeContext } from "@/runtime-context";

type WakeAction = "create" | "list" | "cancel";

interface WakeArgs {
  action: WakeAction;
  name?: string;
  prompt?: string;
  after_seconds?: number;
  scheduled_at?: string;
  cron?: string;
  id?: string;
  signal?: AbortSignal;
}

interface WakeScope {
  agentId: string;
  conversationId: string;
}

interface WakeRecord {
  id: string;
  runner: "local";
  name: string | null;
  prompt: string | null;
  recurring: boolean;
  scheduled_at: string | null;
  cron: string | null;
  status: string;
}

interface WakeDeps {
  now?: () => Date;
  addLocal?: typeof addTask;
  listLocal?: typeof listTasks;
  deleteLocal?: typeof deleteTask;
}

interface WakeResult {
  content: string;
  status: "success" | "error";
}

const MAX_ACTIVE_WAKES = 20;
const MIN_RECURRING_INTERVAL_MS = 60 * 60 * 1000;
const MAX_NAME_LENGTH = 80;
const MAX_PROMPT_LENGTH = 4000;

function result(
  status: WakeResult["status"],
  payload: Record<string, unknown>,
): WakeResult {
  return { content: JSON.stringify(payload, null, 2), status };
}

function requireScope(): WakeScope {
  const context = getRuntimeContext();
  const agentId = context?.agentId?.trim();
  const conversationId = context?.conversationId?.trim();
  if (!agentId || !conversationId) {
    throw new Error("Wake requires the current agent and conversation.");
  }
  return { agentId, conversationId };
}

function oneShotCron(date: Date): string {
  return `${date.getMinutes()} ${date.getHours()} ${date.getDate()} ${date.getMonth() + 1} *`;
}

function minimumCronIntervalMs(cron: string, now: Date): number {
  const expression = CronExpressionParser.parse(cron, {
    currentDate: now,
    tz: "UTC",
  });
  let previous = expression.next().toDate();
  let minimum = Number.POSITIVE_INFINITY;
  for (let index = 0; index < 32; index += 1) {
    const next = expression.next().toDate();
    minimum = Math.min(minimum, next.getTime() - previous.getTime());
    previous = next;
  }
  return minimum;
}

function parseCreateTiming(
  args: WakeArgs,
  now: Date,
): {
  cron: string;
  recurring: boolean;
  scheduledFor?: Date;
} {
  const supplied = [
    args.after_seconds !== undefined,
    args.scheduled_at !== undefined,
    args.cron !== undefined,
  ].filter(Boolean).length;
  if (supplied !== 1) {
    throw new Error(
      "Wake create requires exactly one of after_seconds, scheduled_at, or cron.",
    );
  }

  if (args.after_seconds !== undefined) {
    if (
      !Number.isInteger(args.after_seconds) ||
      args.after_seconds < 60 ||
      args.after_seconds > 31_536_000
    ) {
      throw new Error(
        "Wake after_seconds must be an integer between 60 and 31536000.",
      );
    }
    const scheduledFor = new Date(now.getTime() + args.after_seconds * 1000);
    return {
      cron: oneShotCron(scheduledFor),
      recurring: false,
      scheduledFor,
    };
  }

  if (args.scheduled_at !== undefined) {
    const value = args.scheduled_at.trim();
    const scheduledFor = parseRfc3339Timestamp(value);
    if (!scheduledFor) {
      throw new Error(
        "Wake scheduled_at must be RFC 3339 with Z or an explicit UTC offset.",
      );
    }
    if (scheduledFor.getTime() <= now.getTime()) {
      throw new Error("Wake scheduled_at must be a valid future time.");
    }
    return {
      cron: oneShotCron(scheduledFor),
      recurring: false,
      scheduledFor,
    };
  }

  const cron = args.cron?.trim() ?? "";
  if (!isValidCron(cron)) {
    throw new Error("Wake cron must be a valid five-field cron expression.");
  }
  if (minimumCronIntervalMs(cron, now) < MIN_RECURRING_INTERVAL_MS) {
    throw new Error("Wake cron cannot run more often than hourly.");
  }
  return { cron, recurring: true };
}

function localWakeRecord(task: CronTask): WakeRecord {
  return {
    id: task.id,
    runner: "local",
    name: task.name,
    prompt: task.prompt,
    recurring: task.recurring,
    scheduled_at: task.scheduled_for,
    cron: task.recurring ? task.cron : null,
    status: task.status,
  };
}

function listCurrentWakes(scope: WakeScope, deps: WakeDeps): WakeRecord[] {
  return (deps.listLocal ?? listTasks)({
    agent_id: scope.agentId,
    conversation_id: scope.conversationId,
  })
    .filter((task) => task.status === "active" || task.status === "paused")
    .map(localWakeRecord);
}

function requireCreateText(args: WakeArgs): { name: string; prompt: string } {
  const name = args.name?.trim() ?? "";
  const prompt = args.prompt?.trim() ?? "";
  if (!name) throw new Error("Wake create requires name.");
  if (!prompt) throw new Error("Wake create requires prompt.");
  if (name.length > MAX_NAME_LENGTH) {
    throw new Error(`Wake name must be at most ${MAX_NAME_LENGTH} characters.`);
  }
  if (prompt.length > MAX_PROMPT_LENGTH) {
    throw new Error(
      `Wake prompt must be at most ${MAX_PROMPT_LENGTH} characters.`,
    );
  }
  return { name, prompt };
}

function createWake(
  args: WakeArgs,
  scope: WakeScope,
  deps: WakeDeps,
): WakeResult {
  const { name, prompt } = requireCreateText(args);
  const now = (deps.now ?? (() => new Date()))();
  const timing = parseCreateTiming(args, now);
  args.signal?.throwIfAborted();

  const activeWakeCount = listCurrentWakes(scope, deps).filter(
    (wake) => wake.status === "active",
  ).length;
  if (activeWakeCount >= MAX_ACTIVE_WAKES) {
    throw new Error(
      `This conversation already has ${activeWakeCount} active wakes (max ${MAX_ACTIVE_WAKES}). Cancel one before creating another.`,
    );
  }

  const input: AddTaskInput = {
    agent_id: scope.agentId,
    conversation_id: scope.conversationId,
    name,
    description: `Self-scheduled wake: ${name}`,
    cron: timing.cron,
    timezone: "UTC",
    recurring: timing.recurring,
    prompt,
    scheduled_for: timing.scheduledFor,
    // F-05 G-3: write the defaults explicitly instead of relying on the store's
    // normalizer. Values are Q-45/Q-53's, identical to the old behaviour:
    // full access (what `wake` tasks always had), no catch-up, 30-minute run
    // ceiling, 10-minute wait for a busy conversation.
    type: "prompt",
    target:
      scope.conversationId === "new"
        ? { kind: "new", hidden: false }
        : { kind: "existing", conversation_id: scope.conversationId },
    permission: "unrestricted",
    catch_up: false,
    timeout_minutes: 30,
    wait_minutes: 10,
  };
  const created = (deps.addLocal ?? addTask)(input);
  const warnings = [created.warning].filter((warning): warning is string =>
    Boolean(warning),
  );
  return result("success", {
    action: "created",
    id: created.task.id,
    name,
    runner: "local",
    conversation_id: scope.conversationId,
    recurring: timing.recurring,
    scheduled_at: created.task.scheduled_for,
    warnings,
  });
}

function cancelWake(
  args: WakeArgs,
  scope: WakeScope,
  deps: WakeDeps,
): WakeResult {
  const id = args.id?.trim();
  if (!id) throw new Error("Wake cancel requires id.");
  const wake = listCurrentWakes(scope, deps).find(
    (candidate) => candidate.id === id,
  );
  if (!wake) {
    throw new Error(`Wake ${id} was not found in the current conversation.`);
  }

  args.signal?.throwIfAborted();
  if (!(deps.deleteLocal ?? deleteTask)(id)) {
    throw new Error(`Wake ${id} was already removed.`);
  }
  return result("success", {
    action: "cancelled",
    id,
    runner: "local",
  });
}

export async function wake(
  args: WakeArgs,
  deps: WakeDeps = {},
): Promise<WakeResult> {
  try {
    args.signal?.throwIfAborted();
    const scope = requireScope();
    switch (args.action) {
      case "create":
        return createWake(args, scope, deps);
      case "list":
        return result("success", {
          action: "listed",
          conversation_id: scope.conversationId,
          wakes: listCurrentWakes(scope, deps),
        });
      case "cancel":
        return cancelWake(args, scope, deps);
      default:
        throw new Error("Wake action must be create, list, or cancel.");
    }
  } catch (error) {
    return result("error", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
