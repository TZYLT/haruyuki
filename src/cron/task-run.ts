/**
 * Single-run policy for one scheduled run (F-05, M2).
 *
 * The scheduler core decides *which* task is due; a host supplies the effectful
 * half through `TaskRunnerPort` (`cron-types.ts`). This module is the policy
 * layer *inside* a run, shared by both hosts so they cannot drift:
 *
 * - command whitelist (Q-17) and verbatim argument pass-through,
 * - the target-conversation wait (R-5.7.3): poll, `wait_minutes` then F3 skip,
 * - the per-run timeout (R-5.7.4), with `0` meaning unlimited — the value is
 *   checked *before* a timer is scheduled (a `setTimeout(fn, 0)` fires on the
 *   next tick, it is not "never"),
 * - cancellation (R-5.6.5) and result normalization onto `RunOutcome`.
 *
 * Two entry points, on purpose:
 *
 * - `runScheduledTask` is the frozen M0 name. It is the **command-task execution
 *   body**: `compact` and `reflect` do not need a conversation host (their
 *   bodies are `runLocalCompaction` / `launchReflectionSubagent`), so this
 *   signature has no host parameter and is not going to grow one.
 * - `runScheduledTaskWithHost` is the host-agnostic policy entry a runner calls.
 *   The host only answers "is the target busy?" and "run this prompt"; wait,
 *   timeout, cancel and normalization stay here.
 *
 * Nothing here knows about the scheduler tick, leases or the store.
 */

import { runLocalCompaction } from "@/agent/compaction-execute";
import {
  getReflectionRun,
  type ReflectionRunState,
  subscribeReflectionRunFinished,
} from "@/agent/reflection-run";
import { getBackend } from "@/backend";
import { LocalBackend } from "@/backend/local/local-backend";
import { launchReflectionSubagent } from "@/cli/helpers/reflection-launcher";
import type { PermissionMode } from "@/permissions/mode";
import { settingsManager } from "@/settings-manager";
import { appendUsageRecord, buildUsageRecord } from "@/usage/ledger";
import { debugWarn } from "@/utils/debug";
import {
  DEFAULT_TIMEOUT_MINUTES,
  DEFAULT_WAIT_MINUTES,
  type PermissionTier,
  type RunOutcome,
  type ScheduleTaskV2,
} from "./cron-types";

/**
 * Commands a scheduled task may run. Fixed by Q-17: only commands that finish
 * without a human at the keyboard, whose arguments pass through verbatim.
 */
export const TASK_COMMAND_WHITELIST: ReadonlySet<string> = new Set([
  "compact",
  "reflect",
]);

/** Default poll interval while the target conversation is busy (R-5.7.3). */
export const TARGET_BUSY_POLL_MS = 30_000;

const PERMISSION_TIERS: readonly PermissionTier[] = [
  "standard",
  "acceptEdits",
  "unrestricted",
];

/**
 * The tier an unreadable/unknown stored value executes with (F-05 M2 F13).
 *
 * Creation defaults stay `DEFAULT_PERMISSION_TIER` (`unrestricted`): a *new*
 * task the user asked for. A record we cannot parse is different — it must not
 * fail open to the most permissive tier, so it runs as `standard` (the
 * least-privileged tier that can still do the work).
 */
export const FAIL_CLOSED_PERMISSION_TIER: PermissionTier = "standard";

const RUN_OUTCOMES: readonly RunOutcome[] = [
  "success",
  "failed",
  "skipped",
  "timeout",
  "cancelled",
];

/** `strict` is deliberately absent: it turns every tool into an approval (Q-50). */
const TIER_TO_MODE: Record<PermissionTier, PermissionMode> = {
  standard: "standard",
  acceptEdits: "acceptEdits",
  unrestricted: "unrestricted",
};

export interface ParsedScheduledCommand {
  /** Lower-cased command name without the leading slash. */
  name: string;
  /** Everything after the name, trimmed; empty when the payload had no args. */
  args: string;
}

// ── Command payloads (M-13) ─────────────────────────────────────────

/**
 * Split `/compact 3` into `{ name: "compact", args: "3" }`.
 *
 * Arguments are **not** parsed here (Q-30): the command itself owns them. A
 * payload without a leading slash is accepted too, because the stored string is
 * whatever the user typed.
 */
export function parseScheduledCommand(
  payload: string,
): ParsedScheduledCommand | null {
  const trimmed = typeof payload === "string" ? payload.trim() : "";
  if (!trimmed) return null;
  const withoutSlash = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
  const match = /^([A-Za-z][A-Za-z0-9_-]*)([\s\S]*)$/.exec(withoutSlash);
  const name = match?.[1]?.toLowerCase();
  if (!match || !name) return null;
  return { name, args: (match[2] ?? "").trim() };
}

/** True when the payload names a whitelisted, unattended-safe command. */
export function isAllowedScheduledCommand(command: string): boolean {
  const parsed = parseScheduledCommand(command);
  return parsed !== null && TASK_COMMAND_WHITELIST.has(parsed.name);
}

// ── Permissions (M-8) ───────────────────────────────────────────────

export function isTaskPermissionTier(value: unknown): value is PermissionTier {
  return (
    typeof value === "string" &&
    (PERMISSION_TIERS as readonly string[]).includes(value)
  );
}

/** The task's tier as the existing permission mode. `strict` is unreachable. */
export function permissionModeForTier(tier: PermissionTier): PermissionMode {
  if (!isTaskPermissionTier(tier)) {
    throw new Error(
      `Unknown scheduled-task permission tier "${String(tier)}". Allowed: standard, acceptEdits, unrestricted.`,
    );
  }
  return TIER_TO_MODE[tier];
}

/**
 * Re-exported from the dependency-free policy module so the checker can import
 * the rule without pulling this file's backend/CLI dependencies into the
 * permission layer (F-05 M2 F14). See `unattended-approval.ts`.
 */
export {
  type PermissionDecisionLike,
  resolveUnattendedApproval,
  type UnattendedApprovalDecision,
} from "./unattended-approval";

// ── Result shape ────────────────────────────────────────────────────

export interface ScheduledTaskRunResult {
  outcome: RunOutcome;
  conversationId?: string;
  error?: string;
}

/** What a host's prompt execution reports back for one run. */
export interface ScheduledPromptRunResult {
  outcome?: RunOutcome;
  conversationId?: string;
  error?: string;
}

/** The only two questions a host has to answer (M1↔M2 seam inside a run). */
export interface ScheduledTaskHostPort {
  /** True while the target conversation cannot take work (R-5.7.3/Q-25). */
  isTargetBusy(task: ScheduleTaskV2): boolean;
  /** Create-or-enqueue the prompt and resolve when the turn reached a terminal state. */
  runPrompt(input: {
    task: ScheduleTaskV2;
    runId: string;
    occurrence: string;
    signal: AbortSignal;
  }): Promise<ScheduledPromptRunResult>;
}

// ── Failure classification (R-5.9.1) ────────────────────────────────

/**
 * A run that cannot start at all: no credential/model, no runtime, a missing
 * target conversation, a command outside the whitelist, a backend that cannot
 * run it (F1, R-5.9.1).
 *
 * The scheduler core classifies by `error.name`, because the frozen
 * `TaskRunnerPort` result only carries a string: throwing this error is how a
 * runner says "F1" instead of the default F2. Every other failure (model error,
 * tool error, timeout, interruption) must stay a plain result so it counts as F2
 * against the auto-pause streak.
 */
export class ScheduledTaskPreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduledTaskPreflightError";
  }
}

/** True for a runner's F1 error, including one crossing a bundle boundary. */
export function isScheduledTaskPreflightError(
  value: unknown,
): value is ScheduledTaskPreflightError {
  return (
    value instanceof ScheduledTaskPreflightError ||
    (typeof value === "object" &&
      value !== null &&
      (value as { name?: unknown }).name === "ScheduledTaskPreflightError")
  );
}

// ── Command execution (C-1 / C-2) ───────────────────────────────────

/**
 * Terminal state of a scheduled reflection subprocess (F-05 M2 F7).
 *
 * `unknown` is the registered degradation: the launcher reported a launch but
 * the run is not in this process's reflection registry (an injected launcher in
 * a test, or a launch whose registry entry was already pruned). A run that did
 * spawn is always registered before `launchReflectionSubagent` resolves, so a
 * real launch never takes this branch.
 */
export type ScheduledReflectionTerminal =
  | "succeeded"
  | "failed"
  | "timeout"
  | "cancelled"
  | "unknown";

/** Wait for one reflection run to reach its terminal state (test seam). */
export type ScheduledReflectionWaiter = (input: {
  runId: string;
  signal: AbortSignal;
}) => Promise<ScheduledReflectionTerminal>;

const TERMINAL_REFLECTION_STATUSES: ReadonlySet<ReflectionRunState["status"]> =
  new Set(["succeeded", "failed", "timeout", "cancelled"]);

/**
 * Wait for the reflection run's real terminal state instead of reporting the
 * spawn as a success (F-05 M2 F7).
 *
 * The launcher returns as soon as the child was spawned; the run registry is
 * the only place that knows when the child actually finished (§5.8.8). A run
 * that is already terminal (a fast child that finished before this call) is
 * read from the registry, otherwise a finish subscription resolves it. The
 * run's own deadline still governs — this wait has no timer of its own, and the
 * scheduled run's `timeout_minutes` envelope resolves the abort.
 */
async function defaultWaitForReflectionTerminal(input: {
  runId: string;
  signal: AbortSignal;
}): Promise<ScheduledReflectionTerminal> {
  const current = getReflectionRun(input.runId);
  if (!current) return "unknown";
  const terminal = reflectionTerminalOf(current.status);
  if (terminal) return terminal;
  if (input.signal.aborted) return "cancelled";

  return new Promise<ScheduledReflectionTerminal>((resolve) => {
    let settled = false;
    const settle = (terminal: ScheduledReflectionTerminal): void => {
      if (settled) return;
      settled = true;
      unsubscribe();
      input.signal.removeEventListener("abort", onAbort);
      resolve(terminal);
    };
    const onAbort = (): void => settle("cancelled");
    const unsubscribe = subscribeReflectionRunFinished((event) => {
      if (event.runId !== input.runId) return;
      const status = reflectionTerminalOf(event.status);
      if (status) settle(status);
    });
    input.signal.addEventListener("abort", onAbort, { once: true });
  });
}

function reflectionTerminalOf(
  status: ReflectionRunState["status"],
): ScheduledReflectionTerminal | null {
  return TERMINAL_REFLECTION_STATUSES.has(status)
    ? (status as ScheduledReflectionTerminal)
    : null;
}

/**
 * Seams for the two command bodies. Defaults are the real implementations; the
 * overrides exist so the policy tests never touch a backend or a child process.
 */
export interface ScheduledCommandContext {
  /** `compact` needs the local backend; `null` means this backend cannot do it. */
  resolveLocalBackend?(): CompactBackendLike | null;
  launchReflection?: typeof launchReflectionSubagent;
  /** Defaults to {@link defaultWaitForReflectionTerminal}. */
  waitForReflectionTerminal?: ScheduledReflectionWaiter;
  isMemfsEnabled?(agentId: string): boolean;
  /** Ledger writer; defaults to `appendUsageRecord`. */
  appendUsage?(
    record: Parameters<typeof appendUsageRecord>[0],
  ): Promise<boolean>;
}

/** The three backend calls a compaction needs (kept structural for tests). */
type CompactBackendLike = Pick<
  LocalBackend,
  "listTopics" | "prepareCompaction" | "applyCompaction"
>;

export interface RunScheduledTaskInput {
  task: ScheduleTaskV2;
  runId: string;
  signal: AbortSignal;
}

function defaultLocalBackend(): CompactBackendLike | null {
  const backend = getBackend();
  return backend instanceof LocalBackend ? backend : null;
}

function defaultAppendUsage(
  record: Parameters<typeof appendUsageRecord>[0],
): Promise<boolean> {
  return appendUsageRecord(record);
}

/**
 * The frozen M0 entry: run one `command` task.
 *
 * A `prompt` task cannot be executed here — it needs a conversation host to
 * create or enqueue into (see `runScheduledTaskWithHost`) — so it returns a
 * failure rather than pretending.
 */
export async function runScheduledTask(
  input: RunScheduledTaskInput,
  context: ScheduledCommandContext = {},
): Promise<ScheduledTaskRunResult> {
  const { task, signal } = input;
  if (signal.aborted) {
    return { outcome: "cancelled", error: "cancelled" };
  }
  if (task.type !== "command") {
    return {
      outcome: "failed",
      error:
        "Prompt tasks must be run by a host runner; runScheduledTask only executes command tasks.",
    };
  }

  const command = parseScheduledCommand(task.payload);
  if (!command) {
    throw new ScheduledTaskPreflightError("empty scheduled command");
  }
  if (!TASK_COMMAND_WHITELIST.has(command.name)) {
    throw new ScheduledTaskPreflightError(
      `Command "/${command.name}" is not allowed in a scheduled task. Allowed: ${[...TASK_COMMAND_WHITELIST].join(", ")}.`,
    );
  }

  const conversationId =
    task.target.kind === "existing" ? task.target.conversation_id : undefined;
  if (!conversationId) {
    throw new ScheduledTaskPreflightError(
      "A command task needs an existing target conversation.",
    );
  }

  if (command.name === "compact") {
    return runCompactCommand(input, command, conversationId, context);
  }
  return runReflectCommand(input, command, conversationId, context);
}

/** `/compact [n]` through the shared F-04 body (C-1), one ledger row. */
async function runCompactCommand(
  input: RunScheduledTaskInput,
  command: ParsedScheduledCommand,
  conversationId: string,
  context: ScheduledCommandContext,
): Promise<ScheduledTaskRunResult> {
  const { task, signal } = input;
  const backend = (context.resolveLocalBackend ?? defaultLocalBackend)();
  if (!backend) {
    throw new ScheduledTaskPreflightError(
      "The compact command requires the local backend.",
    );
  }

  const blockIndex = parseBlockIndex(command.args);
  if (blockIndex === "invalid") {
    // `/compact <bad>` is a payload defect, i.e. nothing this run could start.
    throw new ScheduledTaskPreflightError(
      `Invalid /compact argument "${command.args}". Expected a block number.`,
    );
  }

  const startedAt = Date.now();
  try {
    const outcome = await runLocalCompaction({
      backend,
      conversationId,
      agentId: task.agentId,
      ...(blockIndex === undefined ? {} : { blockIndex }),
      signal,
    });
    const finishedAt = Date.now();
    await writeCommandUsage(input, conversationId, {
      outcome: outcome.kind === "cancelled" ? "cancelled" : "completed",
      agentId: outcome.agentId ?? task.agentId,
      model: outcome.model,
      promptTokens: outcome.usage?.promptTokens ?? 0,
      cachedInputTokens: outcome.usage?.cachedInputTokens ?? 0,
      completionTokens: outcome.usage?.completionTokens ?? 0,
      wallMs: outcome.usage?.wallMs ?? finishedAt - startedAt,
      context,
    });
    return {
      outcome: outcome.kind === "cancelled" ? "cancelled" : "success",
      conversationId,
      ...(outcome.kind === "cancelled"
        ? { error: "compaction cancelled" }
        : {}),
    };
  } catch (error) {
    // One outcome for both the ledger row and the run result. A cancelled
    // compaction that throws must not write `failed` and report `cancelled`
    // (F-05 M2 F11).
    const outcome = signal.aborted ? "cancelled" : "failed";
    await writeCommandUsage(input, conversationId, {
      outcome,
      agentId: task.agentId,
      model: "",
      promptTokens: 0,
      cachedInputTokens: 0,
      completionTokens: 0,
      wallMs: Date.now() - startedAt,
      context,
    });
    return {
      outcome,
      conversationId,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function parseBlockIndex(args: string): number | undefined | "invalid" {
  if (!args) return undefined;
  const match = /^(\d+)$/.exec(args);
  if (!match) return "invalid";
  const index = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(index) && index > 0 ? index : "invalid";
}

/**
 * One cron ledger row for a command run.
 *
 * Only the commands that do not write their own row go through here: `compact`
 * (its executor reports numbers and writes nothing, C-1) does; `reflect` does
 * not, because the reflection child puts its own spend in the ledger under its
 * own run id.
 */
async function writeCommandUsage(
  input: RunScheduledTaskInput,
  conversationId: string,
  facts: {
    outcome: "completed" | "failed" | "cancelled" | "timeout";
    agentId: string;
    model: string;
    promptTokens: number;
    cachedInputTokens: number;
    completionTokens: number;
    wallMs: number;
    context: ScheduledCommandContext;
  },
): Promise<void> {
  const writer = facts.context.appendUsage ?? defaultAppendUsage;
  try {
    await writer(
      buildUsageRecord({
        agentId: facts.agentId,
        model: facts.model || "unknown",
        prompt: facts.promptTokens,
        cachedInput: facts.cachedInputTokens,
        cacheWrite: 0,
        completion: facts.completionTokens,
        reasoning: 0,
        steps: 1,
        wallMs: Math.max(0, Math.round(facts.wallMs)),
        apiMs: 0,
        source: "cron",
        outcome: facts.outcome,
        runId: input.runId,
        sessionId: conversationId,
      }),
    );
  } catch {
    // A ledger row must never change what the run reports (F-03 §5.16.2).
  }
}

/**
 * `/reflect` through the shared F-03 launcher (C-2/C-3), with the task's mode.
 *
 * Registered degradation (F-05 M2 F7): the reflection launcher exposes no
 * cancel handle for the child it spawned, so a scheduled-run timeout stops
 * *waiting* but cannot stop the child; the child's own
 * `reflectionSettings.timeoutMinutes` deadline still applies and its spend is
 * recorded by the reflection run itself. The run outcome is the child's real
 * terminal state, never the spawn.
 */
async function runReflectCommand(
  input: RunScheduledTaskInput,
  _command: ParsedScheduledCommand,
  conversationId: string,
  context: ScheduledCommandContext,
): Promise<ScheduledTaskRunResult> {
  const { task, signal } = input;
  const memfsEnabled = (
    context.isMemfsEnabled ??
    ((agentId: string) => settingsManager.isMemfsEnabled(agentId))
  )(task.agentId);
  const launch = context.launchReflection ?? launchReflectionSubagent;

  try {
    const result = await launch({
      agentId: task.agentId,
      conversationId,
      memfsEnabled,
      // C-3: the only difference from the end-of-turn path is the trigger.
      triggerSource: "scheduled",
      // C-17: the subprocess inherits the task's tier instead of unrestricted.
      // An unreadable stored tier fails closed to `standard` (C-17/F13).
      permissionMode: permissionModeForTier(resolveTaskPermissionTier(task)),
    });
    if (!result.launched) {
      return {
        outcome: signal.aborted ? "cancelled" : "failed",
        conversationId,
        error: `reflection was not launched: ${result.reason}`,
      };
    }

    // F-05 M2 F7: the launcher resolves at spawn time, so its answer is not the
    // run's outcome. Wait for the child's real terminal state (bounded by this
    // run's `timeout_minutes` envelope, which aborts `signal`).
    const wait =
      context.waitForReflectionTerminal ?? defaultWaitForReflectionTerminal;
    const terminal = await wait({ runId: result.runId, signal });
    switch (terminal) {
      case "succeeded":
        return { outcome: "success", conversationId };
      case "timeout":
        return {
          outcome: "timeout",
          conversationId,
          error: "reflection timed out",
        };
      case "cancelled":
        return {
          outcome: "cancelled",
          conversationId,
          error: "reflection cancelled",
        };
      case "unknown":
        // Registered degradation: no registry entry, so the terminal state is
        // unknowable. Report the launch rather than inventing a failure.
        debugWarn(
          "Cron",
          `reflection run ${result.runId} is not in this process's registry; recording the launch as its outcome`,
        );
        return { outcome: "success", conversationId };
      default:
        return {
          outcome: "failed",
          conversationId,
          error: "reflection run failed",
        };
    }
  } catch (error) {
    return {
      outcome: signal.aborted ? "cancelled" : "failed",
      conversationId,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ── Wait / timeout / cancel policy ──────────────────────────────────

export interface ScheduledTaskPolicyInput {
  task: ScheduleTaskV2;
  runId: string;
  occurrence: string;
  signal: AbortSignal;
  host: ScheduledTaskHostPort;
  /** Defaults to the real compaction/reflection bodies. */
  commandContext?: ScheduledCommandContext;
  /** Clock seam (defaults to `Date.now`). */
  now?: () => number;
  /** Busy-wait poll interval (defaults to 30s). */
  pollIntervalMs?: number;
  /** Sleep seam (defaults to a real timer); tests inject it. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Minutes → milliseconds. `0` (or anything unusable) means "no limit". */
function minutesToMs(minutes: number | undefined, fallback: number): number {
  const value =
    typeof minutes === "number" && Number.isFinite(minutes) && minutes >= 0
      ? minutes
      : fallback;
  return value * 60_000;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted || ms <= 0) {
      resolve();
      return;
    }
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", settle);
      resolve();
    };
    const timer = setTimeout(settle, ms);
    signal.addEventListener("abort", settle, { once: true });
  });
}

function isRunOutcome(value: unknown): value is RunOutcome {
  return (
    typeof value === "string" &&
    (RUN_OUTCOMES as readonly string[]).includes(value)
  );
}

/**
 * The effectful body of one run, whichever task kind it is.
 *
 * Command tasks go through the same envelope as prompt tasks (F-05 M2 F3):
 * `compact`/`reflect` used to return before the timeout timer was created, so
 * `timeout_minutes` and cancellation never reached them. This function is the
 * only thing the envelope wraps, which is what keeps the two kinds on the same
 * policy.
 */
function executeScheduledBody(input: {
  task: ScheduleTaskV2;
  runId: string;
  occurrence: string;
  signal: AbortSignal;
  host: ScheduledTaskHostPort;
  commandContext: ScheduledCommandContext;
}): Promise<ScheduledPromptRunResult> {
  if (input.task.type === "command") {
    return runScheduledTask(
      { task: input.task, runId: input.runId, signal: input.signal },
      input.commandContext,
    ).then((result) => ({
      outcome: result.outcome,
      ...(result.conversationId !== undefined
        ? { conversationId: result.conversationId }
        : {}),
      ...(result.error !== undefined ? { error: result.error } : {}),
    }));
  }
  return input.host.runPrompt({
    task: input.task,
    runId: input.runId,
    occurrence: input.occurrence,
    signal: input.signal,
  });
}

/**
 * Run one task under the wait/timeout/cancel policy and normalize the answer.
 *
 * `task.timeoutMinutes === 0` is "unlimited": the timer is never created. This
 * is checked before `setTimeout`, because `setTimeout(fn, 0)` fires on the next
 * tick instead of never (AGENTS.md gotcha).
 *
 * The timeout applies to **both** task kinds (F-05 M2 F3/F4): a command body
 * runs inside the same `AbortSignal` as a prompt turn, so the listener host can
 * interrupt the turn it belongs to and the TUI host can drop its queued item.
 */
export async function runScheduledTaskWithHost(
  input: ScheduledTaskPolicyInput,
): Promise<ScheduledTaskRunResult> {
  const { task, runId, occurrence, signal, host } = input;
  const now = input.now ?? Date.now;
  const pollMs = Math.max(1, input.pollIntervalMs ?? TARGET_BUSY_POLL_MS);
  const sleep = input.sleep ?? abortableSleep;
  const commandContext = input.commandContext ?? {};

  if (signal.aborted) {
    return { outcome: "cancelled", error: "cancelled" };
  }

  // ── Wait for the target conversation (R-5.7.3) ────────────────────
  // Command tasks (`compact`/`reflect`) take a conversation id but do not send
  // a turn, so they have nothing to wait for; they still run under the timeout
  // below.
  if (task.type !== "command") {
    const waitMs = minutesToMs(task.waitMinutes, DEFAULT_WAIT_MINUTES);
    const waitDeadline = now() + waitMs;
    for (;;) {
      if (signal.aborted) {
        return { outcome: "cancelled", error: "cancelled" };
      }
      if (!host.isTargetBusy(task)) break;
      const remaining = waitDeadline - now();
      if (waitMs <= 0 || remaining <= 0) {
        return {
          outcome: "skipped",
          error: "target conversation busy",
        };
      }
      await sleep(Math.min(pollMs, remaining), signal);
    }
  }

  // ── Execute under the timeout (R-5.7.4) ───────────────────────────
  const timeoutMs = minutesToMs(task.timeoutMinutes, DEFAULT_TIMEOUT_MINUTES);
  const runController = new AbortController();
  const onOuterAbort = () => runController.abort();
  if (signal.aborted) {
    runController.abort();
  } else {
    signal.addEventListener("abort", onOuterAbort, { once: true });
  }

  let timedOut = false;
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          runController.abort();
        }, timeoutMs)
      : null;

  try {
    const executed = await Promise.race([
      executeScheduledBody({
        task,
        runId,
        occurrence,
        signal: runController.signal,
        host,
        commandContext,
      }),
      new Promise<null>((resolve) => {
        if (runController.signal.aborted) {
          resolve(null);
          return;
        }
        runController.signal.addEventListener("abort", () => resolve(null), {
          once: true,
        });
      }),
    ]);

    if (executed === null || runController.signal.aborted) {
      // A host that finished successfully in the same tick as the deadline keeps
      // its success; everything else that raced the abort is a timeout/cancel.
      if (executed?.outcome === "success") {
        return {
          outcome: "success",
          ...(executed.conversationId !== undefined
            ? { conversationId: executed.conversationId }
            : {}),
        };
      }
      return timedOut
        ? { outcome: "timeout", error: "run timed out" }
        : { outcome: "cancelled", error: "cancelled" };
    }
    const outcome = isRunOutcome(executed.outcome)
      ? executed.outcome
      : "success";
    return {
      outcome,
      ...(executed.conversationId !== undefined
        ? { conversationId: executed.conversationId }
        : {}),
      ...(executed.error !== undefined ? { error: executed.error } : {}),
    };
  } finally {
    if (timer !== null) clearTimeout(timer);
    signal.removeEventListener("abort", onOuterAbort);
  }
}

/**
 * The tier a task executes with. An unreadable record fails **closed** to
 * `standard` instead of the most permissive tier (F-05 M2 F13).
 */
export function resolveTaskPermissionTier(
  task: ScheduleTaskV2,
): PermissionTier {
  return isTaskPermissionTier(task.permission)
    ? task.permission
    : FAIL_CLOSED_PERMISSION_TIER;
}
