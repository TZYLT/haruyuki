/**
 * `/compact` (feature ③, D-110 + D-119): the one interactive entry point that may
 * rewrite a conversation's context.
 *
 * Local compaction asks the user where to cut: `/compact <n>` keeps block `n`,
 * and a bare `/compact` opens the topic picker — except when nothing has been
 * marked, in which case the compression rate decides and the command runs
 * straight away (D-119). The cloud backend keeps its mode-based behaviour, so
 * the mode words still work there and are rejected here by name.
 *
 * The branch lives in its own module because the submit handler is on the size
 * ratchet and because this is a whole flow, not a line of dispatch: the picker
 * handoff, the receipt, and the bookkeeping a compaction owes the reflection
 * runtime all belong together.
 */
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { isActiveMemfsEnabled } from "@/agent/memory-runtime";
import { getBackend } from "@/backend";
import { contextPressureLevel } from "@/backend/dev/provider-turn-executor";
import { LocalBackend } from "@/backend/local/local-backend";
import type {
  LocalTopicTrimOutcome,
  LocalTopicTrimPick,
} from "@/backend/local/local-topic-trim";
import { hasSelectableTopicBlocks } from "@/backend/local/local-topic-trim";
import type { ActiveOverlay, AppCommandRunner } from "@/cli/app/types";
import type { CompactModeArgument } from "@/cli/helpers/compact-command";
import {
  COMPACT_COMMAND_USAGE,
  COMPACT_MODE_LOCAL_UNSUPPORTED,
  formatCompactPlanningFailure,
  formatContextPressureHint,
  formatNoMarkerCompactHint,
  formatSingleBlockCompactHint,
  formatTopicTrimReceipt,
  parseCompactCommandArgs,
} from "@/cli/helpers/compact-command";
import type { ContextTracker } from "@/cli/helpers/context-tracker";
import { formatErrorDetails } from "@/cli/helpers/error-formatter";
import { getReflectionSettings } from "@/cli/helpers/memory-reminder";
import { runPostCompactionTail } from "@/cli/helpers/post-compaction";
import {
  AUTO_REFLECTION_DESCRIPTION,
  launchReflectionSubagent,
} from "@/cli/helpers/reflection-launcher";
import { formatTopicNudgeHint } from "@/cli/helpers/topic-nudge";
import {
  clearTopicTrimRequest,
  setTopicTrimRequest,
} from "@/cli/helpers/topic-trim-request";
import { runPreCompactHooks } from "@/hooks";
import {
  formatRecallNoticeLine,
  takePendingRecallNotice,
} from "@/reminders/recall-runtime";
import type { SharedReminderState } from "@/reminders/state";
import { shouldAdvertiseTopicMarking } from "@/settings-tool-gates";
import { readTopicSettings } from "@/topic-settings";

export interface CompactCommandContext {
  agentDescription: string | null;
  agentId: string;
  agentName: string | null;
  agentStateRef: MutableRefObject<AgentState | null | undefined>;
  appendTaskNotificationEvents: (summaries: string[]) => boolean;
  commandRunner: AppCommandRunner;
  conversationIdRef: MutableRefObject<string>;
  /**
   * The context-pressure baseline. A trim changes the context without a provider
   * round trip, so the tracker has to be re-based here or the next send would be
   * judged on the tokens that were just removed (D-112).
   */
  contextTrackerRef: MutableRefObject<ContextTracker>;
  generateConversationDescription: (options?: {
    force?: boolean;
  }) => Promise<void>;
  setActiveOverlay: Dispatch<SetStateAction<ActiveOverlay>>;
  setCommandRunning: (value: boolean) => void;
  sharedReminderStateRef: MutableRefObject<SharedReminderState>;
}

/**
 * What the pre-send pressure check additionally needs: the window the turn's own
 * usage estimate is measured against (D-112).
 */
export interface SendPressureContext extends CompactCommandContext {
  effectiveContextWindowSize: number | undefined;
}

/**
 * D-112: before a turn is sent, decide whether the context is close enough to the
 * window to say something about it.
 *
 * - `soft` (advisory) prints one line and lets the turn proceed.
 * - `hard` (the tier the local backend refuses to cross) opens the topic picker
 *   when there are blocks to choose between, and sends the turn afterwards —
 *   whether the user trims, presses Esc, or the trim refuses. A message the user
 *   typed must never be silently dropped.
 * - With no block to choose between — nothing marked yet, or every marker
 *   anchored at or before the start of the context — there is nothing to pick, so
 *   it only warns: trimming without the user choosing would be the automatic
 *   rewrite this feature exists to remove (I1). Bare `/compact` still compresses
 *   by the rate, because that is the user asking for it.
 *
 * Returns `true` when the send was deferred to the picker (the caller must not
 * send); `false` means the caller sends as usual.
 */
export async function offerTrimBeforeSend(
  ctx: SendPressureContext,
  send: () => Promise<void>,
): Promise<boolean> {
  const backend = getBackend();
  // The cloud backend owns its own context management: no picker, no hints.
  if (!(backend instanceof LocalBackend)) return false;
  reportPendingTopicNudge(ctx);
  reportPendingRecallNotice(ctx);
  const conversationId = ctx.conversationIdRef.current;
  const contextWindow = ctx.effectiveContextWindowSize;
  const contextTokens = ctx.contextTrackerRef.current.lastContextTokens;
  const level = contextPressureLevel({
    contextTokens,
    contextWindow,
    softRatio: readTopicSettings().softPressureRatio,
  });
  const tracker = ctx.contextTrackerRef.current;
  if (level === "ok") {
    tracker.lastPressureNotice = undefined;
    return false;
  }

  const list = backend.listTopics(conversationId, ctx.agentId);
  // Block 1 is a legal pick now that the compression rate caps every cut, so
  // "markers exist" is the only question: markers whose boundary clamps onto the
  // start of the context leave one block and the picker would have nothing to
  // choose between (H-2).
  const hasBlocks = hasSelectableTopicBlocks(list);
  const hint = formatContextPressureHint({
    level,
    contextTokens,
    contextWindow: contextWindow ?? 0,
    hasBlocks,
    hasMarkers: list.markers.length > 0,
  });
  if (level === "soft") {
    // One line per crossing, not one per message.
    if (tracker.lastPressureNotice === "soft") return false;
    tracker.lastPressureNotice = "soft";
    reportHint(ctx, hint);
    return false;
  }
  if (!hasBlocks) {
    if (tracker.lastPressureNotice === "hard") return false;
    tracker.lastPressureNotice = "hard";
    reportHint(ctx, hint);
    return false;
  }

  tracker.lastPressureNotice = "hard";
  setTopicTrimRequest({
    blocks: list.blocks,
    suggestionIndex: list.suggestedBlockIndex ?? 1,
    onPick: (blockIndex) => {
      ctx.setActiveOverlay(null);
      void (async () => {
        try {
          await runTrim(
            ctx,
            `/compact ${blockIndex}`,
            { kind: "topic", index: blockIndex },
            backend,
          );
        } finally {
          await send();
        }
      })();
    },
    // Esc skips the trim and sends the message as it is; if it overflows, the
    // provider reports that with its own actionable copy.
    onCancel: () => {
      void send();
    },
  });
  ctx.setActiveOverlay("compaction");
  return true;
}

/** A hint is app output, not conversation content: it shows and is never sent. */
function reportHint(ctx: CompactCommandContext, hint: string): void {
  const cmd = ctx.commandRunner.start("/compact", hint);
  cmd.finish(hint, true);
}

/**
 * The user's half of the one-shot topic nudge (D-114).
 *
 * The reminder engine decides it and parks the numbers on the shared reminder
 * state while the turn's message is being built; the TUI is the only channel
 * that can show a line to the user, so it prints the notice here and clears it.
 * Running on every send is deliberate: whoever gets there first prints exactly
 * once, and the engine is what guarantees the nudge itself is one-shot.
 */
export function reportPendingTopicNudge(ctx: CompactCommandContext): void {
  const notice = ctx.sharedReminderStateRef.current.pendingTopicNudge;
  if (!notice) return;
  ctx.sharedReminderStateRef.current.pendingTopicNudge = null;
  reportHint(ctx, formatTopicNudgeHint(notice));
}

/**
 * The user's half of a recall degradation, timeout, or breaker trip (feature ②).
 *
 * Same contract as the topic nudge above, and deliberately the same mechanism:
 * the provider parks one notice on the shared reminder state while the turn's
 * message is being built, and whoever can print a line claims it. Claiming
 * clears it, so a turn that is retried does not print twice.
 */
export function reportPendingRecallNotice(ctx: CompactCommandContext): void {
  const notice = takePendingRecallNotice(ctx.sharedReminderStateRef.current);
  if (!notice) return;
  reportHint(ctx, formatRecallNoticeLine(notice));
}

/**
 * Does this message belong to `/compact`? The command is intercepted before the
 * registry so the TUI can own the selector; every other channel still reaches
 * the registry entry. `/compact config` (mode settings) must not match.
 */
export function isCompactCommand(message: string): boolean {
  return /^\/compact(\s|$)/.test(message.trim());
}

function fail(
  ctx: CompactCommandContext,
  input: string,
  message: string,
): { submitted: boolean } {
  const cmd = ctx.commandRunner.start(input, message);
  cmd.fail(message);
  return { submitted: true };
}

/**
 * The cloud path (and the local one before this feature): summarize by the
 * configured strategy. Local compaction keeps sliding-window as its only mode,
 * so a mode argument is refused there by name rather than silently ignored.
 */
async function compactByMode(
  ctx: CompactCommandContext,
  input: string,
  mode: CompactModeArgument | undefined,
): Promise<{ submitted: boolean }> {
  const modeDisplay = mode ? ` (mode: ${mode})` : "";
  const cmd = ctx.commandRunner.start(
    input,
    `Compacting conversation history${modeDisplay}...`,
  );
  ctx.setCommandRunning(true);
  try {
    const preCompact = await runPreCompactHooks(
      undefined, // context_length - not available here
      undefined, // max_context_length - not available here
      ctx.agentId,
      ctx.conversationIdRef.current,
    );
    if (preCompact.blocked) {
      const feedback = preCompact.feedback.join("\n") || "Blocked by hook";
      cmd.fail(`Compact blocked: ${feedback}`);
      return { submitted: true };
    }

    const compactParams = mode
      ? {
          compaction_settings: {
            mode,
          },
        }
      : undefined;
    const conversationId = ctx.conversationIdRef.current;
    const body =
      conversationId === "default"
        ? { agent_id: ctx.agentId, ...(compactParams ?? {}) }
        : compactParams;
    const result = await getBackend().compactConversationMessages(
      conversationId,
      body,
    );
    await afterCompaction(ctx, conversationId);
    cmd.finish(
      [
        `Compaction completed${modeDisplay}. Message buffer length reduced from ${result.num_messages_before} to ${result.num_messages_after}.`,
        "",
        `Summary: ${result.summary}`,
      ].join("\n"),
      true,
    );
  } catch (error) {
    const apiError = error as {
      status?: number;
      error?: { detail?: string };
    };
    const detail = apiError?.error?.detail;
    if (
      apiError?.status === 400 &&
      detail?.includes("Summarization failed to reduce the number of messages")
    ) {
      cmd.finish(
        "Compaction run, but the number of messages is the same",
        true,
      );
      return { submitted: true };
    }
    cmd.fail(`Failed: ${formatErrorDetails(error, ctx.agentId)}`);
  } finally {
    ctx.setCommandRunning(false);
  }
  return { submitted: true };
}

/**
 * Everything a succeeded compaction owes the rest of the runtime: the reminder
 * that the context changed, the reflection trigger, and a fresh conversation
 * description. All best-effort —a failure here must not undo the trim.
 *
 * The ordering and the failure policy live in `runPostCompactionTail` because the
 * listener runs the same tail (L-18).
 */
async function afterCompaction(
  ctx: CompactCommandContext,
  conversationId: string,
): Promise<void> {
  runPostCompactionTail({
    reminderState: ctx.sharedReminderStateRef.current,
    reflect: () => {
      if (
        getReflectionSettings(ctx.agentId).trigger !== "compaction-event" ||
        !isActiveMemfsEnabled(ctx.agentId)
      ) {
        return;
      }
      const feedbackContext = {
        parentAgentName: ctx.agentName,
        parentAgentDescription: ctx.agentDescription,
        surface: "letta_code_tui",
      };
      void launchReflectionSubagent({
        agentId: ctx.agentId,
        conversationId,
        memfsEnabled: isActiveMemfsEnabled(ctx.agentId),
        triggerSource: "compaction-event",
        description: AUTO_REFLECTION_DESCRIPTION,
        completionConversationId: () => ctx.conversationIdRef.current,
        onCompletionMessage: (completionMessage) => {
          ctx.appendTaskNotificationEvents([completionMessage]);
        },
        feedbackContext,
      });
    },
    regenerateDescription: () => {
      void ctx.generateConversationDescription({ force: true });
    },
  });
}

/**
 * D-112: a trim changes the context without a provider round trip, so the
 * pressure baseline is re-based on what was actually kept. Otherwise the very
 * next send is judged on the tokens that were just removed and can open the
 * picker again, or print a hard hint, for a context that no longer needs one.
 */
function syncContextTrackerAfterTrim(
  ctx: CompactCommandContext,
  outcome: LocalTopicTrimOutcome,
): void {
  const after = outcome.stats.context_tokens_after;
  if (typeof after !== "number") return;
  const tracker = ctx.contextTrackerRef.current;
  tracker.lastContextTokens = after;
  // A fresh baseline deserves a fresh notice: if the kept region is still over
  // the threshold, that is a new crossing the user has not been told about.
  tracker.lastPressureNotice = undefined;
}

/**
 * Run a trim and report it. A refusal is a result, not a failure: the plan said
 * there is nothing to cut, so the command succeeds with the reason.
 */
async function runTrim(
  ctx: CompactCommandContext,
  input: string,
  pick: LocalTopicTrimPick,
  backend: LocalBackend,
  options: { extraNote?: string; confirmedSuggestion?: boolean } = {},
): Promise<{ submitted: boolean }> {
  const conversationId = ctx.conversationIdRef.current;
  const cmd = ctx.commandRunner.start(input, "Trimming context...");
  ctx.setCommandRunning(true);
  try {
    const preCompact = await runPreCompactHooks(
      undefined,
      undefined,
      ctx.agentId,
      conversationId,
    );
    if (preCompact.blocked) {
      const feedback = preCompact.feedback.join("\n") || "Blocked by hook";
      cmd.fail(`Compact blocked: ${feedback}`);
      return { submitted: true };
    }

    const outcome = await backend.trimConversationToTopic({
      conversationId,
      agentId: ctx.agentId,
      pick,
    });
    const receipt = formatTopicTrimReceipt(outcome, {
      confirmedSuggestion: options.confirmedSuggestion === true,
    });
    if (!outcome.executed) {
      cmd.finish(receipt, true);
      return { submitted: true };
    }
    syncContextTrackerAfterTrim(ctx, outcome);
    cmd.finish(
      options.extraNote ? `${receipt}\n\n${options.extraNote}` : receipt,
      true,
    );
    await afterCompaction(ctx, conversationId);
  } catch (error) {
    cmd.fail(`Failed: ${formatCompactPlanningFailure(error)}`);
  } finally {
    ctx.setCommandRunning(false);
  }
  return { submitted: true };
}

/**
 * Local `/compact`: pick a cut point from the topic blocks, or let the ratio
 * decide when nothing is marked.
 */
async function compactLocal(
  ctx: CompactCommandContext,
  input: string,
  request: { kind: "auto" } | { kind: "block"; index: number },
  backend: LocalBackend,
): Promise<{ submitted: boolean }> {
  const conversationId = ctx.conversationIdRef.current;
  const list = backend.listTopics(conversationId, ctx.agentId);
  if (list.contextMessageCount === 0) {
    return fail(
      ctx,
      input,
      "There is nothing in this conversation's context to trim.",
    );
  }

  if (request.kind === "block") {
    if (request.index > list.blocks.length) {
      const count = `${list.blocks.length} block${list.blocks.length === 1 ? "" : "s"}`;
      return fail(
        ctx,
        input,
        `There is no topic block ${request.index}: this context has ${count}. Run /topic list to list them, or /compact with no number to compress by the rate.`,
      );
    }
    return runTrim(
      ctx,
      input,
      { kind: "topic", index: request.index },
      backend,
    );
  }

  const topicMarkingEnabled = shouldAdvertiseTopicMarking(
    ctx.agentId,
    conversationId,
  );
  if (hasSelectableTopicBlocks(list)) {
    // Hand the picker its rows and keep the trim in this environment: only the
    // submit handler knows how to finish the compaction bookkeeping. Confirming
    // the row the cursor starts on is the "empty enter" case: the cut is still
    // topic-aligned, but the ratio chose it, and the receipt says so (V9).
    //
    // The command line opens before the rows do, so cancelling leaves a trace
    // (L-1): without it the transcript showed nothing at all for the invocation.
    const suggestion = list.suggestedBlockIndex ?? 1;
    const cmd = ctx.commandRunner.start(
      input,
      "Choose the topic block to keep...",
    );
    setTopicTrimRequest({
      blocks: list.blocks,
      suggestionIndex: suggestion,
      onPick: (blockIndex) => {
        ctx.setActiveOverlay(null);
        cmd.finish(
          blockIndex === suggestion
            ? `Keeping block ${blockIndex} (the ratio's suggestion).`
            : `Keeping block ${blockIndex}.`,
          true,
        );
        void runTrim(
          ctx,
          `/compact ${blockIndex}`,
          { kind: "topic", index: blockIndex },
          backend,
          { confirmedSuggestion: blockIndex === suggestion },
        );
      },
      onCancel: () => {
        cmd.finish("Cancelled: the context is unchanged.", true);
      },
    });
    ctx.setActiveOverlay("compaction");
    return { submitted: true };
  }

  // D-119 + H-2: fewer than two blocks means there is nothing to choose between —
  // either nothing is marked yet, or every marker's boundary clamps onto the start
  // of the context (`/topic` in the first turns, or every anchor trimmed away).
  // The ratio decides, and the note says which of the two it was.
  clearTopicTrimRequest();
  const extraNote =
    list.markers.length === 0
      ? formatNoMarkerCompactHint(topicMarkingEnabled)
      : formatSingleBlockCompactHint({
          topicMarkingEnabled,
          liveMarkerAnchor: list.markers.some((view) => view.anchorInContext),
        });
  return runTrim(ctx, input, { kind: "ratio_suggestion" }, backend, {
    extraNote,
  });
}

export async function handleCompactCommand(
  msg: string,
  ctx: CompactCommandContext,
): Promise<{ submitted: boolean }> {
  const input = msg.trim();
  const request = parseCompactCommandArgs(input.split(/\s+/).slice(1));
  const backend = getBackend();

  if (request.kind === "help") {
    const cmd = ctx.commandRunner.start(input, "Showing compact help...");
    cmd.finish(COMPACT_COMMAND_USAGE, true);
    return { submitted: true };
  }
  if (request.kind === "invalid") {
    const cmd = ctx.commandRunner.start(input, "Invalid /compact arguments.");
    cmd.fail(`${request.message}\n\n${COMPACT_COMMAND_USAGE}`);
    return { submitted: true };
  }

  if (!(backend instanceof LocalBackend)) {
    // Cloud behaviour is unchanged: no topic blocks, no picker, mode words kept.
    if (request.kind === "block") {
      return fail(
        ctx,
        input,
        "Picking a context cut point by number requires the local backend. Run /compact help.",
      );
    }
    return compactByMode(
      ctx,
      input,
      request.kind === "mode" ? request.mode : undefined,
    );
  }

  if (request.kind === "mode") {
    return fail(ctx, input, COMPACT_MODE_LOCAL_UNSUPPORTED);
  }
  clearTopicTrimRequest();
  return compactLocal(ctx, input, request, backend);
}
