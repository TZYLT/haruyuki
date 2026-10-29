/**
 * Listener-side task runner for the F-05 scheduler core (M2).
 *
 * The core (`src/cron/scheduler-core.ts`) decides *which* task is due and hands
 * one run to a `TaskRunnerPort`. This module is the long-lived host's port: it
 * resolves the target conversation, enqueues the scheduled prompt through the
 * listener's existing queue pump (C-4), executes `command` tasks through the
 * shared compaction/reflection bodies, and records the run.
 *
 * It deliberately owns no timer and no lease: T1's listener adapter installs it
 * with `setSchedulerTaskRunner(...)` and then calls the existing
 * `startScheduler(...)`. Nothing here may start a scheduler.
 *
 * Two shared policies live in `@/cron/task-run` so the TUI host cannot drift:
 * the wait/timeout/cancel envelope and the unattended-approval rule.
 */

import { getBackend } from "@/backend";
import type {
  ConversationCreateBody,
  ConversationListBody,
} from "@/backend/backend";
import { legacyRunOutcomeFor } from "@/cron/cron-file";
import type {
  RunOutcome,
  ScheduleTaskV2,
  TaskRunnerPort,
} from "@/cron/cron-types";
import {
  type CronRunLogStatus,
  safeAppendCronRunLogForTask,
} from "@/cron/run-log";
import {
  formatScheduledTaskPrompt,
  SCHEDULE_ORIGIN_TAG,
} from "@/cron/scheduled-task-prompt";
import {
  isScheduledTaskPreflightError,
  permissionModeForTier,
  resolveTaskPermissionTier,
  runScheduledTaskWithHost,
  type ScheduledCommandContext,
  type ScheduledTaskHostPort,
  ScheduledTaskPreflightError,
  TARGET_BUSY_POLL_MS,
} from "@/cron/task-run";
import type { CronPromptQueueItem, DequeuedBatch } from "@/queue/queue-runtime";
import { hiddenStandaloneProvenance } from "@/types/conversation-provenance";
import type { UsageStatistics } from "@/types/protocol";
import type { StopReasonType } from "@/types/protocol_v2";
import { appendUsageRecord, buildUsageRecord } from "@/usage/ledger";
import { debugLog, debugWarn } from "@/utils/debug";
import { ensureConversationQueueRuntime } from "@/websocket/listener/conversation-runtime";
import {
  type ConversationPermissionModeState,
  getOrCreateConversationPermissionModeStateRef,
} from "@/websocket/listener/permission-mode";
import { scheduleQueuePump } from "@/websocket/listener/queue";
import {
  getActiveRuntime,
  getConversationRuntime,
  getOrCreateConversationRuntime,
} from "@/websocket/listener/runtime";
import type { ListenerTransport } from "@/websocket/listener/transport";
import type {
  ConversationRuntime,
  IncomingMessage,
  ListenerRuntime,
  ListenerStreamObserver,
  ObservedProtocolV2Message,
  StartListenerOptions,
} from "@/websocket/listener/types";

/** Same shape the queue pump hands to `processQueuedTurn`. */
export type ListenerCronProcessQueuedTurn = (
  queuedTurn: IncomingMessage,
  dequeuedBatch: DequeuedBatch,
) => Promise<void>;

/**
 * What a pre-dispatch target lookup concluded (F-05 M2 F10). A missing,
 * deleted or hidden conversation is an F1 ("nothing this run could start"),
 * which the core records without counting toward the auto-pause streak.
 */
export type ExistingTargetState = "ok" | "missing" | "hidden";

export type ExistingTargetResolver = (input: {
  agentId: string;
  conversationId: string;
}) => Promise<ExistingTargetState>;

/**
 * Default lookup: a non-creating list, never `retrieveConversation` — on the
 * local backend that call *creates* an unknown conversation, which would turn
 * the validation itself into a write (and hide exactly the missing target this
 * check exists to find).
 */
async function defaultResolveExistingTarget(input: {
  agentId: string;
  conversationId: string;
}): Promise<ExistingTargetState> {
  // The implicit conversation always exists; the conversation list hides it.
  if (input.conversationId === "default") return "ok";
  const body: ConversationListBody = {
    agent_id: input.agentId,
    summary_search: input.conversationId,
    include_hidden: true,
    limit: 100,
  };
  const rows = await getBackend().listConversations(body);
  const row = rows.find((candidate) => candidate.id === input.conversationId);
  if (!row) return "missing";
  // `hidden` is a runtime annotation the SDK's `Conversation` type does not
  // carry (`toHiddenConversationSummary` attaches it), so it is read through a
  // guard rather than a cast.
  return isRecord(row) && row.hidden === true ? "hidden" : "ok";
}

export interface ListenerCronRunnerDeps {
  /** Transport the queued turn reports through (the listener's own socket). */
  transport: ListenerTransport;
  /** The options the running listener was started with. */
  opts: StartListenerOptions;
  /** The listener's queued-turn processor, used to pump the enqueued prompt. */
  processQueuedTurn: ListenerCronProcessQueuedTurn;
  /** Defaults to `getActiveRuntime()`. Seam for tests. */
  activeRuntime?: () => ListenerRuntime | null;
  /** Defaults to `getBackend().createConversation`. Seam for tests. */
  createConversation?: (
    body: ConversationCreateBody,
  ) => Promise<{ id: string }>;
  /** Defaults to {@link defaultResolveExistingTarget}. Seam for tests. */
  resolveExistingTarget?: ExistingTargetResolver;
  /** Defaults to the real compaction/reflection bodies. Seam for tests. */
  commandContext?: ScheduledCommandContext;
  /**
   * Which host this runner is, for the run log and the task lease.
   * Defaults to `"long-lived"` (the listener itself); the short-lived
   * `schedule tick` host passes `"short-lived"`.
   */
  host?: "long-lived" | "short-lived";
  /** Clock seam (defaults to `Date.now`), used by the wait/timeout policy. */
  now?: () => number;
  /** Poll interval for the "target conversation busy" wait. Defaults to 30s. */
  pollIntervalMs?: number;
}

/** One completed turn, as the listener's own terminal event reports it. */
interface TurnTerminal {
  stopReason: StopReasonType | null;
  usage: UsageStatistics | null;
  error?: string;
  aborted: boolean;
}

const RUNNING = new Map<string, AbortController>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readUsage(value: unknown): UsageStatistics | null {
  if (!isRecord(value)) return null;
  const number = (key: string): number => {
    const raw = value[key];
    return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
  };
  return {
    prompt_tokens: number("prompt_tokens"),
    completion_tokens: number("completion_tokens"),
    total_tokens: number("total_tokens"),
    step_count: number("step_count"),
    cached_input_tokens: number("cached_input_tokens"),
    cache_write_tokens: number("cache_write_tokens"),
    reasoning_tokens: number("reasoning_tokens"),
    ...(typeof value.context_tokens === "number"
      ? { context_tokens: value.context_tokens }
      : {}),
  };
}

function scopeConversationId(
  message: ObservedProtocolV2Message,
): string | null {
  const value = message.runtime?.conversation_id;
  return typeof value === "string" && value ? value : null;
}

function normalizeConversationId(value: string | null | undefined): string {
  return value && value.length > 0 ? value : "default";
}

/** A stream observer plus the two side effects a run owns while it waits. */
interface TurnTerminalObserver {
  promise: Promise<TurnTerminal>;
  dispose: () => void;
}

/**
 * Wait for the turn **this run started** to reach a terminal state.
 *
 * `turn_finished` is the listener's own terminal projection and the only place a
 * turn's `usage` counters surface in-process (the alternative would be a new
 * hook in `turn.ts`, which M2 does not own). The observer is scoped by
 * conversation, by agent and — the F-05 M2 F5 fix — by **queue item id**: our
 * item leaving the ready queue is the proof the pump consumed *this* item into
 * the running turn. A terminal event on the same conversation while our item is
 * still queued belongs to a foreign turn (a user turn, or another run's turn)
 * and must not settle this run.
 *
 * The observer also owns cancellation (F-05 M2 F4): when the run's signal
 * aborts, the turn it started is interrupted and a still-queued item is
 * removed, so cancelling or timing out never leaves an unowned turn to run to
 * completion and bill nobody, nor an orphan item to execute later. A queue
 * clear elsewhere (`update_queue` naming our item as removed) settles the run
 * as cancelled instead of letting it wait for a turn that will never happen.
 */
function observeTurnTerminal(input: {
  listener: ListenerRuntime;
  runtime: ConversationRuntime;
  agentId: string;
  conversationId: string;
  queueItemId: string;
  signal: AbortSignal;
}): TurnTerminalObserver {
  if (!input.listener.streamObservers) {
    input.listener.streamObservers = new Set<ListenerStreamObserver>();
  }
  const observers = input.listener.streamObservers;
  let disposed = false;
  let settle: (terminal: TurnTerminal) => void = () => {};
  const promise = new Promise<TurnTerminal>((resolve) => {
    settle = (terminal) => resolve(terminal);
  });

  const stillQueued = (): boolean => {
    const queue = input.runtime.queueRuntime;
    return (
      queue?.peekReady().some((item) => item.id === input.queueItemId) ?? false
    );
  };

  /**
   * Stop what this run started. A pre-start cancellation only has a queue item
   * to drop; once the pump consumed it, the active lease is the turn that must
   * be aborted (`.requestCancellation()` moves `active -> cancelling`, the same
   * transition an explicit user abort uses).
   */
  const interrupt = (): void => {
    const queue = input.runtime.queueRuntime;
    if (queue !== null && queue.removeItem(input.queueItemId) !== null) {
      return;
    }
    if (input.runtime.turnLifecycle.kind === "active") {
      input.runtime.turnLifecycle.requestCancellation();
    }
  };

  const finish = (terminal: TurnTerminal) => {
    if (disposed) return;
    disposed = true;
    observers.delete(observer);
    input.signal.removeEventListener("abort", onAbort);
    settle(terminal);
  };

  const onAbort = () => {
    interrupt();
    finish({
      stopReason: "cancelled",
      usage: null,
      error: "cancelled",
      aborted: true,
    });
  };

  const scopeMatches = (message: ObservedProtocolV2Message): boolean => {
    if (
      normalizeConversationId(scopeConversationId(message)) !==
      normalizeConversationId(input.conversationId)
    ) {
      return false;
    }
    const scopedAgent = message.runtime?.agent_id;
    return typeof scopedAgent !== "string" || scopedAgent === input.agentId;
  };

  /**
   * The removal id the queue's own transition reports for our item: a cron
   * prompt carries no `clientMessageId`, so `queueRemovalTransition` names it
   * `cm-<itemId>`.
   */
  const removedMarker = `cm-${input.queueItemId}`;

  /** True when an `update_queue` frame says our own item was cancelled. */
  const removedByQueueClear = (message: ObservedProtocolV2Message): boolean => {
    const removed = (message as { removed?: unknown }).removed;
    if (!Array.isArray(removed)) return false;
    return removed.some((entry) => {
      if (!isRecord(entry)) return false;
      return (
        entry.client_message_id === removedMarker &&
        entry.disposition === "cancelled"
      );
    });
  };

  const observer: ListenerStreamObserver = (message) => {
    if (!scopeMatches(message)) return;
    // F4: an authoritative queue clear removed our item, so no turn will ever
    // run for it. Settle cancelled instead of waiting for the timeout — and
    // never interrupt whatever turn follows.
    if (message.type === "update_queue") {
      if (!removedByQueueClear(message) || stillQueued()) return;
      finish({
        stopReason: "cancelled",
        usage: null,
        error: "the scheduled prompt was removed from the queue",
        aborted: true,
      });
      return;
    }
    if (message.type !== "turn_finished") return;
    // F5: a foreign turn on this conversation cannot settle this run while the
    // run's own item is still waiting in the queue.
    if (stillQueued()) return;
    const turnId =
      typeof message.turn_id === "string" && message.turn_id
        ? message.turn_id
        : null;
    const stopReason =
      typeof message.stop_reason === "string"
        ? (message.stop_reason as StopReasonType)
        : null;
    // F5: keep the matched turn id in the log so a run's settlement can be
    // traced to the exact turn, not merely to its conversation.
    debugLog(
      "Cron",
      `run on ${input.conversationId} settled by turn ${turnId ?? "unknown"}`,
    );
    finish({
      stopReason,
      usage: readUsage(message.usage),
      ...(typeof message.error === "string" ? { error: message.error } : {}),
      aborted: false,
    });
  };

  observers.add(observer);
  if (input.signal.aborted) {
    onAbort();
  } else {
    input.signal.addEventListener("abort", onAbort, { once: true });
  }

  return {
    promise,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      observers.delete(observer);
      input.signal.removeEventListener("abort", onAbort);
    },
  };
}

/** Terminal stop reasons that mean the turn actually finished its work. */
const SUCCESS_STOP_REASONS = new Set<StopReasonType>([
  "end_turn",
  "no_tool_call",
]);

function outcomeOfTerminal(terminal: TurnTerminal): RunOutcome {
  if (terminal.aborted || terminal.stopReason === "cancelled") {
    return "cancelled";
  }
  if (terminal.stopReason && SUCCESS_STOP_REASONS.has(terminal.stopReason)) {
    return "success";
  }
  return "failed";
}

function runLogStatusOf(outcome: RunOutcome): CronRunLogStatus {
  switch (outcome) {
    case "success":
      return "ok";
    case "skipped":
      return "skipped";
    default:
      return "error";
  }
}

function taskRef(task: ScheduleTaskV2, conversationId: string | null) {
  return {
    id: task.id,
    agent_id: task.agentId,
    conversation_id:
      conversationId ??
      (task.target.kind === "existing" ? task.target.conversation_id : "new"),
  };
}

/**
 * The permission state is per conversation and shared with the user's own
 * turns, so both fields are written for the run and restored afterwards.
 *
 * Restoration is compare-and-restore (F-05 M2 F9): only a field the run still
 * owns is put back. If the user changed the mode while the run was in flight,
 * their newer choice wins instead of being silently overwritten by the state
 * that preceded the run.
 */
function applyRunPermissionState(
  state: ConversationPermissionModeState,
  tier: ReturnType<typeof resolveTaskPermissionTier>,
): () => void {
  const previousMode = state.mode;
  const previousUnattended = state.unattended;
  const runMode = permissionModeForTier(tier);
  state.mode = runMode;
  state.unattended = true;
  return () => {
    if (state.mode === runMode) state.mode = previousMode;
    if (state.unattended === true) state.unattended = previousUnattended;
  };
}

export function createListenerCronRunner(
  deps: ListenerCronRunnerDeps,
): TaskRunnerPort {
  const resolveRuntime = deps.activeRuntime ?? getActiveRuntime;
  const createConversation =
    deps.createConversation ??
    ((body: ConversationCreateBody) => getBackend().createConversation(body));
  const resolveExistingTarget =
    deps.resolveExistingTarget ?? defaultResolveExistingTarget;
  const now = deps.now ?? Date.now;
  const pollIntervalMs = deps.pollIntervalMs ?? TARGET_BUSY_POLL_MS;
  const runnerHost = deps.host ?? "long-lived";
  const transport = deps.transport;
  const opts = deps.opts;
  const processQueuedTurn = deps.processQueuedTurn;

  const runPrompt = async (input: {
    task: ScheduleTaskV2;
    runId: string;
    occurrence: string;
    signal: AbortSignal;
  }): Promise<{
    outcome?: RunOutcome;
    conversationId?: string;
    error?: string;
  }> => {
    const { task, runId, occurrence, signal } = input;
    const listener = resolveRuntime();
    if (!listener) {
      throw new ScheduledTaskPreflightError("no active listener runtime");
    }

    let conversationId: string;
    if (task.target.kind === "existing") {
      conversationId = task.target.conversation_id;
      // F-05 M2 F10: resolve the target *before* dispatch. Without this an
      // unknown/deleted/hidden conversation surfaces as a failed turn (F2) and
      // counts toward the auto-pause streak, when it is really "nothing this
      // run could start" (F1).
      let targetState: ExistingTargetState;
      try {
        targetState = await resolveExistingTarget({
          agentId: task.agentId,
          conversationId,
        });
      } catch (error) {
        throw new ScheduledTaskPreflightError(
          error instanceof Error
            ? `failed to resolve the target conversation: ${error.message}`
            : "failed to resolve the target conversation",
        );
      }
      if (targetState !== "ok") {
        throw new ScheduledTaskPreflightError(
          targetState === "hidden"
            ? `target conversation ${conversationId} is hidden and cannot receive a scheduled run`
            : `target conversation ${conversationId} does not exist (missing or deleted)`,
        );
      }
    } else {
      // The SDK's create body has no `tags` / provenance fields; the old
      // scheduler cast the same way (`scheduler.ts`).
      const body = {
        agent_id: task.agentId,
        summary: task.name,
        tags: [SCHEDULE_ORIGIN_TAG],
        ...(task.target.hidden ? hiddenStandaloneProvenance("background") : {}),
      } as ConversationCreateBody;
      try {
        const created = await createConversation(body);
        conversationId = created.id;
      } catch (error) {
        // A target that cannot be created is a pre-start failure (F1).
        throw new ScheduledTaskPreflightError(
          error instanceof Error
            ? `failed to create the target conversation: ${error.message}`
            : "failed to create the target conversation",
        );
      }
    }

    const conversationRuntime = ensureConversationQueueRuntime(
      listener,
      getOrCreateConversationRuntime(listener, task.agentId, conversationId),
    );
    const scopedConversationId = conversationRuntime.conversationId;

    // Build the turn's prompt with the same wrapper the listener used before
    // (R-5.10.1's "scheduled T, actual T'" pair travels in it).
    const intendedOccurrence = parseOccurrence(occurrence, now());
    const text = formatScheduledTaskPrompt({
      name: task.name,
      description: task.description,
      timezone: task.timezone,
      scheduledFor: intendedOccurrence,
      currentTime: new Date(now()),
      recurrence: task.recurring
        ? { type: "recurring", cron: task.cron, fireNumber: 1 }
        : { type: "one-off" },
      prompt: task.payload,
    });

    // F-05 M2 F4: a run cancelled between creating/validating the target and
    // reaching the queue must not enqueue work nobody is waiting for.
    if (signal.aborted) {
      return {
        outcome: "cancelled",
        conversationId: scopedConversationId,
        error: "cancelled",
      };
    }

    const permissionState = getOrCreateConversationPermissionModeStateRef(
      listener,
      task.agentId,
      scopedConversationId,
    );
    const restorePermissionState = applyRunPermissionState(
      permissionState,
      resolveTaskPermissionTier(task),
    );
    let observed: TurnTerminalObserver | null = null;

    try {
      // `Omit<QueueItem, ...>` is a union, so a `cron_prompt` literal cannot be
      // assigned without narrowing; the old scheduler cast the same way.
      const queued = conversationRuntime.queueRuntime.enqueue({
        kind: "cron_prompt",
        source: "cron",
        text,
        cronTaskId: task.id,
        agentId: task.agentId,
        conversationId: scopedConversationId,
        runId,
      } as Omit<CronPromptQueueItem, "id" | "enqueuedAt">);
      if (!queued) {
        return {
          outcome: "failed",
          conversationId: scopedConversationId,
          error: "the conversation queue is full",
        };
      }

      observed = observeTurnTerminal({
        listener,
        runtime: conversationRuntime,
        agentId: task.agentId,
        conversationId: scopedConversationId,
        queueItemId: queued.id,
        signal,
      });
      scheduleQueuePump(
        conversationRuntime,
        transport,
        opts,
        processQueuedTurn,
      );

      const terminal = await observed.promise;
      const outcome = outcomeOfTerminal(terminal);
      await recordPromptUsage({
        task,
        runId,
        conversationId: scopedConversationId,
        terminal,
        outcome,
      });
      return {
        outcome,
        conversationId: scopedConversationId,
        ...(terminal.error !== undefined && outcome !== "success"
          ? { error: terminal.error }
          : {}),
      };
    } finally {
      observed?.dispose();
      restorePermissionState();
    }
  };

  const host: ScheduledTaskHostPort = {
    isTargetBusy: (task) => {
      if (task.target.kind === "new") return false;
      const listener = resolveRuntime();
      if (!listener) return false;
      const runtime = getConversationRuntime(
        listener,
        task.agentId,
        task.target.conversation_id,
      );
      if (!runtime) return false;
      if (runtime.turnLifecycle.kind !== "idle") return true;
      if (runtime.pendingTurns > 0) return true;
      // `queueRuntime` is null until the pump is first ensured.
      if (runtime.queueRuntime && runtime.queueRuntime.length > 0) return true;
      return runtime.pendingApprovalResolvers.size > 0;
    },
    runPrompt,
  };

  return {
    host: runnerHost,
    async run({ task, runId, occurrence, signal }) {
      const controller = new AbortController();
      const onOuterAbort = () => controller.abort();
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onOuterAbort, { once: true });
      RUNNING.set(runId, controller);

      const startedAt = now();
      try {
        const result = await runScheduledTaskWithHost({
          task,
          runId,
          occurrence,
          signal: controller.signal,
          host,
          ...(deps.commandContext
            ? { commandContext: deps.commandContext }
            : {}),
          now,
          pollIntervalMs,
        });
        appendRunLog(task, {
          result,
          runId,
          host: runnerHost,
          durationMs: Math.max(0, now() - startedAt),
        });
        return result;
      } catch (error) {
        // A pre-start failure must reach the core as a thrown typed error, so it
        // is recorded as F1 instead of being flattened into a string (R-5.9.1).
        if (isScheduledTaskPreflightError(error)) {
          throw error;
        }
        const result = {
          outcome: "failed" as const,
          error: error instanceof Error ? error.message : String(error),
        };
        appendRunLog(task, {
          result,
          runId,
          host: runnerHost,
          durationMs: Math.max(0, now() - startedAt),
        });
        return result;
      } finally {
        RUNNING.delete(runId);
        signal.removeEventListener("abort", onOuterAbort);
      }
    },
    cancel(runId) {
      RUNNING.get(runId)?.abort();
    },
  };
}

function appendRunLog(
  task: ScheduleTaskV2,
  input: {
    result: { outcome: RunOutcome; conversationId?: string; error?: string };
    runId: string;
    host: "long-lived" | "short-lived";
    durationMs: number;
  },
): void {
  const legacyOutcome = legacyRunOutcomeFor(input.result.outcome);
  safeAppendCronRunLogForTask(
    taskRef(task, input.result.conversationId ?? null),
    {
      status: runLogStatusOf(input.result.outcome),
      runOutcome: input.result.outcome,
      ...(legacyOutcome ? { outcome: legacyOutcome } : {}),
      ...(input.result.error ? { error: input.result.error } : {}),
      runId: input.runId,
      host: input.host,
      durationMs: Math.round(input.durationMs),
      runAtMs: Date.now(),
      conversationId: input.result.conversationId ?? undefined,
      scheduledFor: task.scheduledFor,
    },
  );
}

/**
 * One ledger row for a prompt run.
 *
 * Degradation (accepted by the Lead): a listener turn only carries `usage` when
 * the runtime was started with execution settings (`turn.ts`), so this row is
 * often numbers-less. It still carries the wall time and `steps: 0`, so usage
 * aggregation by `runId` can tell "ran, no numbers" from "did not run".
 */
async function recordPromptUsage(input: {
  task: ScheduleTaskV2;
  runId: string;
  conversationId: string;
  terminal: TurnTerminal;
  outcome: RunOutcome;
}): Promise<void> {
  const usage = input.terminal.usage;
  const record = buildUsageRecord({
    agentId: input.task.agentId,
    model: "unknown",
    prompt: usage?.prompt_tokens ?? 0,
    cachedInput: usage?.cached_input_tokens ?? 0,
    cacheWrite: usage?.cache_write_tokens ?? 0,
    completion: usage?.completion_tokens ?? 0,
    reasoning: usage?.reasoning_tokens ?? 0,
    steps: usage?.step_count ?? 0,
    wallMs: 0,
    apiMs: 0,
    source: "cron",
    outcome: usageOutcomeOf(input.outcome),
    runId: input.runId,
    sessionId: input.conversationId,
  });
  try {
    const written = await appendUsageRecord(record);
    if (!written) {
      debugWarn("Cron", `dropped usage row for scheduled run ${input.runId}`);
    }
  } catch (error) {
    debugWarn(
      "Cron",
      `failed to record usage for scheduled run ${input.runId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function usageOutcomeOf(
  outcome: RunOutcome,
): "completed" | "timeout" | "failed" | "cancelled" {
  switch (outcome) {
    case "success":
      return "completed";
    case "timeout":
      return "timeout";
    case "cancelled":
      return "cancelled";
    default:
      return "failed";
  }
}

/** The occurrence string is whatever the signal source minted; accept both. */
function parseOccurrence(occurrence: string, fallbackMs: number): Date {
  const parsed = new Date(occurrence);
  if (Number.isFinite(parsed.getTime())) return parsed;
  const fallback = new Date(fallbackMs);
  fallback.setSeconds(0, 0);
  return fallback;
}
