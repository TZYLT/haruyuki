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
import {
  formatCompactionDegradedNote,
  formatCompactNoopReason,
  formatCompactPlanningFailure,
} from "@/agent/compaction-execute";
import { isActiveMemfsEnabled } from "@/agent/memory-runtime";
import { type Backend, getBackend } from "@/backend";
import { contextPressureLevel } from "@/backend/dev/provider-turn-executor";
import type {
  CompactionPreview,
  CompactPick,
} from "@/backend/local/compaction-preview";
import { renderCompactionOverview } from "@/backend/local/compaction-preview";
import type { CompactionApplyResult } from "@/backend/local/compaction-run";
import { compactUsageOf } from "@/backend/local/compaction-usage-error";
import { LocalBackend } from "@/backend/local/local-backend";
import { hasSelectableTopicBlocks } from "@/backend/local/local-topic-trim";
import type { ActiveOverlay, AppCommandRunner } from "@/cli/app/types";
import type { CompactModeArgument } from "@/cli/helpers/compact-command";
import {
  COMPACT_COMMAND_USAGE,
  COMPACT_MODE_LOCAL_UNSUPPORTED,
  formatContextPressureHint,
  formatNoMarkerCompactHint,
  formatSingleBlockCompactHint,
  parseCompactCommandArgs,
} from "@/cli/helpers/compact-command";
import type { ContextTracker } from "@/cli/helpers/context-tracker";
import { formatErrorDetails } from "@/cli/helpers/error-formatter";
import { getReflectionSettings } from "@/cli/helpers/memory-reminder";
import {
  consumePendingCompactionTrigger,
  runPostCompactionTail,
} from "@/cli/helpers/post-compaction";
import { launchReflectionSubagent } from "@/cli/helpers/reflection-launcher";
import { formatTopicNudgeHint } from "@/cli/helpers/topic-nudge";
import {
  clearTopicTrimRequest,
  setCompactionPreparingRequest,
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
import { recordCompactionUsage } from "@/usage/compaction-usage";

export interface CompactCommandContext {
  agentDescription: string | null;
  agentId: string;
  agentName: string | null;
  agentStateRef: MutableRefObject<AgentState | null | undefined>;
  appendTaskNotificationEvents: (summaries: string[]) => boolean;
  commandRunner: AppCommandRunner;
  /**
   * F-04's prepare/apply seam. Unset in the app (the runtime is resolved from
   * the local backend); a test injects a fixture here instead of a provider.
   */
  compaction?: CompactionRuntime;
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
 * D-112 + F-04: before a turn is sent, decide whether the context is close enough
 * to the window to compact it first.
 *
 * - `ok` says nothing.
 * - `soft` (advisory) prints one line and lets the turn proceed.
 * - `hard` (the tier the local backend refuses to cross) runs the same
 *   `prepare → apply` the command does, with the **rate's own pick**: the user
 *   already said "send this message", so there is no picker to answer here — the
 *   preview feeds the receipt and the write-back takes `ratio_suggestion`. The
 *   message is sent afterwards either way; a message the user typed is never
 *   dropped, whether the compaction ran, was cancelled, or failed.
 *
 * The pre-send path is a *compaction*, not a hint, because a hint cannot keep a
 * turn that is already over the window from being refused. It therefore also
 * carries the cancel face (`preparing`, Esc) and the ledger row — a call that
 * burned 40k prompt tokens before the user pressed Esc is exactly what a usage
 * view exists to explain.
 *
 * Returns `void`: the caller sends. It used to return "the send was deferred to
 * the picker", which no longer exists on this path.
 */
export async function offerTrimBeforeSend(
  ctx: SendPressureContext,
): Promise<void> {
  const backend = getBackend();
  // The cloud backend owns its own context management: no picker, no hints.
  if (!(backend instanceof LocalBackend)) return;
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
    return;
  }

  const list = backend.listTopics(conversationId, ctx.agentId);
  // Block 1 is a legal pick now that the compression rate caps every cut, so
  // "markers exist" is the only question: markers whose boundary clamps onto the
  // start of the context leave one block (H-2).
  const hasBlocks = hasSelectableTopicBlocks(list);
  if (level === "soft") {
    // One line per crossing, not one per message.
    if (tracker.lastPressureNotice === "soft") return;
    tracker.lastPressureNotice = "soft";
    reportHint(
      ctx,
      formatContextPressureHint({
        level,
        contextTokens,
        contextWindow: contextWindow ?? 0,
        hasBlocks,
        hasMarkers: list.markers.length > 0,
      }),
    );
    return;
  }

  tracker.lastPressureNotice = "hard";
  const runtime = ctx.compaction ?? localCompactionRuntime(backend);
  if (!runtime) {
    reportHint(
      ctx,
      "This context is past the point where a turn this large can be sent, and this backend cannot prepare a compaction. Run /compact to try again.",
    );
    return;
  }

  const cmd = ctx.commandRunner.start(
    "/compact",
    "Preparing the compaction...",
  );
  const outcome = await runPreparation(ctx, runtime, conversationId);
  if (outcome.kind === "cancelled") {
    closePreparingFace(ctx);
    cmd.finish(
      "Compaction cancelled: nothing was written, and the message is being sent with the context as it is.",
      true,
    );
    return;
  }
  if (outcome.kind === "failed") {
    closePreparingFace(ctx);
    cmd.fail(
      `This compaction could not run (${outcome.message}). The message is being sent with the context unchanged — run /compact to retry, or /topic to mark a cheaper cut point.`,
    );
    return;
  }

  // No picker on this path: the user asked to send, so the rate decides.
  closePreparingFace(ctx);
  const topicMarkingEnabled = shouldAdvertiseTopicMarking(
    ctx.agentId,
    conversationId,
  );
  const extraNote =
    list.markers.length === 0
      ? formatNoMarkerCompactHint(topicMarkingEnabled)
      : formatSingleBlockCompactHint({
          topicMarkingEnabled,
          liveMarkerAnchor: list.markers.some(
            (view) => view.anchorIndex !== null,
          ),
        });
  await applyPreparedCompaction(
    ctx,
    runtime,
    outcome.preview,
    { kind: "ratio_suggestion" },
    cmd,
    { extraNote },
  );
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
  // F-03: this compaction is the trigger. Consume the pending flag first so the
  // turn-end check does not launch a second reflection for it.
  consumePendingCompactionTrigger({
    reminderState: ctx.sharedReminderStateRef.current,
    contextTracker: ctx.contextTrackerRef.current,
  });
  runPostCompactionTail({
    reminderState: ctx.sharedReminderStateRef.current,
    reflect: () => {
      const reflectionSettings = getReflectionSettings(ctx.agentId);
      if (
        !reflectionSettings.onCompaction ||
        !isActiveMemfsEnabled(ctx.agentId)
      ) {
        return;
      }
      void launchReflectionSubagent({
        agentId: ctx.agentId,
        conversationId,
        memfsEnabled: isActiveMemfsEnabled(ctx.agentId),
        triggerSource: "compaction",
        reflectionSettings: {
          timeoutMinutes: reflectionSettings.timeoutMinutes,
        },
      });
    },
    regenerateDescription: () => {
      void ctx.generateConversationDescription({ force: true });
    },
  });
}

/**
 * The one sentence a cancelled `/compact` says, in every path that can cancel.
 */
const COMPACT_CANCELLED_TEXT = "Cancelled: the context is unchanged.";

/**
 * How far a `/compact` has got (route §2.4): `preparing` → `ready` →
 * `applying`, with `cancelled` and `failed` as the two zero-write exits.
 *
 * The stage is not stored in a variable anyone reads back: it *is* the command
 * row's own output, which is what the user watches while the summarizer runs.
 * A parallel state field could disagree with the row the user is looking at, and
 * that disagreement is the one this flow cannot afford.
 */
export type CompactionStage =
  | "preparing"
  | "ready"
  | "applying"
  | "cancelled"
  | "failed";

/**
 * F-04's `prepare → apply` seam, as the command layer uses it.
 *
 * The real implementation is `LocalBackend`'s two delegates (`localCompactionRuntime`).
 * A test injects a fixture through `ctx.compaction` instead of a provider, which
 * is why the flow takes this as an argument rather than reaching for the backend
 * itself: the state machine under test is this file's, and the summarizer's is
 * M1's.
 */
export interface CompactionRuntime {
  prepare(input: {
    conversationId: string;
    agentId: string;
    signal?: AbortSignal;
  }): Promise<CompactionPreview>;
  apply(input: {
    preview: CompactionPreview;
    pick: CompactPick;
  }): Promise<CompactionApplyResult>;
}

/** The backend's own delegates, or `null` when this backend has no runtime. */
export function localCompactionRuntime(
  backend: Backend,
): CompactionRuntime | null {
  if (!(backend instanceof LocalBackend)) return null;
  return {
    prepare: (input) => backend.prepareCompaction(input),
    apply: (input) => backend.applyCompaction(input),
  };
}

/**
 * The preparation a `/compact` currently has in flight.
 *
 * §5.2.6 sets no wall-clock timeout — the only way out of a stuck summarizer is
 * the user — so the signal has to outlive the call's own stack. One slot, because
 * one `/compact` runs at a time (the command is not re-entrant: the row it owns
 * is the one the picker closes).
 */
let inFlightPreparation: AbortController | null = null;

/**
 * Abort the preparation in flight, if any, and drop its preview whole (§5.9.1).
 *
 * Exported for the key path that owns Escape while a preparation is running;
 * `submitCompactPreparation` handles the abort itself — this only has to stop
 * the call, and the flow notices.
 */
export function cancelCompactionPreparation(): void {
  inFlightPreparation?.abort();
  inFlightPreparation = null;
}

/**
 * One ledger row per attempt (§5.14). Numbers and ids only, and the helper never
 * throws, so a ledger that cannot be written cannot change what the compaction
 * did — it is deliberately not wrapped in `try`/`catch` (swallowing here would
 * hide the one failure mode the caller is supposed to ignore anyway).
 *
 * A run that threw produced no preview, but the spend is still real: the numbers
 * rode up on the error (`compactUsageOf`, §5.14). A call that never reached a
 * provider has neither, and only then is the row 0 — its model stays empty rather
 * than guessing, because a guessed model would be aggregated as if the summarizer
 * had really run on it.
 */
async function recordCompactionRun(
  ctx: CompactCommandContext,
  preview: CompactionPreview | null,
  outcome: "completed" | "cancelled" | "failed",
  error?: unknown,
): Promise<void> {
  const usage =
    preview?.usage ?? (error === undefined ? undefined : compactUsageOf(error));
  await recordCompactionUsage({
    agentId: ctx.agentId,
    conversationId: ctx.conversationIdRef.current,
    model: preview?.model ?? "",
    promptTokens: usage?.promptTokens ?? 0,
    cachedInputTokens: usage?.cachedInputTokens ?? 0,
    completionTokens: usage?.completionTokens ?? 0,
    wallMs: usage?.wallMs ?? 0,
    outcome,
  });
}

/** Which cut the receipt should name, in the words the old receipt used. */
function cutPointLabel(
  result: CompactionApplyResult,
  options: { confirmedSuggestion?: boolean },
): string {
  if (options.confirmedSuggestion === true) {
    return result.source === "ratio_cap"
      ? "compression rate (the suggested block kept more, so the rate cut earlier)"
      : "compression rate (the block it points at, confirmed as it was)";
  }
  switch (result.source) {
    case "topic_pick":
      return "the topic block you picked";
    case "ratio_cap":
      return "compression rate (the picked block kept more than the rate allows)";
    default:
      return "compression rate (no marker defines a boundary here, so it decided)";
  }
}

/**
 * The receipt (§5.14): what the summarizer wrote, what the context weighs now,
 * whether the rate moved the cut, and what the call cost.
 *
 * It is a pure function of the preview and the apply result so the copy is
 * testable without a backend, and so the three `/compact` paths can share it.
 * A degraded run says so here: "no topics" is a result the user has to be told
 * about, not something to discover from a missing list.
 */
export function formatCompactionReceipt(
  preview: CompactionPreview,
  result: CompactionApplyResult,
  options: { confirmedSuggestion?: boolean } = {},
): string {
  if (!result.executed) {
    return [
      "Nothing was written: there is no cut point to take here.",
      `  reason:     ${formatCompactNoopReason(result.noopReason)}`,
      `  context:    ${result.numMessagesBefore} messages · ~${result.retainedTokens} tokens`,
    ].join("\n");
  }

  const overview = renderCompactionOverview(preview.overview);
  const folded = result.foldedTitles.length;
  const cap =
    result.retentionCapTokens === null
      ? ""
      : ` · cap ~${result.retentionCapTokens}`;
  const lines = [
    "Compaction complete.",
    `  summary:    ${overview.length} characters · ${folded} topic${folded === 1 ? "" : "s"} folded${folded > 0 ? ` (${result.foldedTitles.join(", ")})` : ""}`,
    `  tokens:     ~${result.summarizedTokens} → ~${result.retainedTokens} (${result.numMessagesBefore} → ${result.numMessagesAfter} messages${cap})`,
    `  cut point:  ${cutPointLabel(result, options)}`,
    `  model:      ${preview.model} · ${(preview.usage.wallMs / 1000).toFixed(1)}s`,
    `  usage:      ${preview.usage.promptTokens} prompt (${preview.usage.cachedInputTokens} cached) · ${preview.usage.completionTokens} completion`,
  ];
  const degradedNote = formatCompactionDegradedNote(preview.degraded);
  if (degradedNote !== null) {
    lines.push(`  note:       ${degradedNote}`);
  }
  lines.push(
    "  note:       the next turn re-reads the prefix, so it evicts the provider cache",
  );
  return lines.join("\n");
}

/**
 * Re-base the pressure baseline on what the write-back actually kept (M-5): the
 * context shrank without a provider round trip, so the next send must be judged
 * on the tokens that are left, not on the ones just removed.
 */
function syncContextTrackerFromApply(
  ctx: CompactCommandContext,
  result: CompactionApplyResult,
): void {
  const after = result.stats.context_tokens_after;
  if (typeof after !== "number") return;
  const tracker = ctx.contextTrackerRef.current;
  tracker.lastContextTokens = after;
  tracker.lastPressureNotice = undefined;
}

/**
 * Apply a prepared preview and report it: the `applying` stage of §2.4.
 *
 * The ledger row is written for all three outcomes, and it is written *before*
 * the command row finishes so the receipt and the ledger cannot disagree about
 * whether the run happened.
 */
async function applyPreparedCompaction(
  ctx: CompactCommandContext,
  runtime: CompactionRuntime,
  preview: CompactionPreview,
  pick: CompactPick,
  cmd: {
    finish: (output: string, success?: boolean) => void;
    fail: (output: string) => void;
    update: (update: { output: string }) => void;
  },
  options: { confirmedSuggestion?: boolean; extraNote?: string } = {},
): Promise<{ submitted: boolean }> {
  const conversationId = ctx.conversationIdRef.current;
  cmd.update({ output: "Applying the compaction..." });
  ctx.setCommandRunning(true);
  try {
    const result = await runtime.apply({ preview, pick });
    await recordCompactionRun(ctx, preview, "completed");
    const receipt = formatCompactionReceipt(preview, result, options);
    cmd.finish(
      options.extraNote ? `${receipt}\n\n${options.extraNote}` : receipt,
      true,
    );
    if (result.executed) {
      syncContextTrackerFromApply(ctx, result);
      await afterCompaction(ctx, conversationId);
    }
  } catch (error) {
    await recordCompactionRun(ctx, preview, "failed");
    cmd.fail(`Failed: ${formatCompactPlanningFailure(error)}`);
  } finally {
    ctx.setCommandRunning(false);
  }
  return { submitted: true };
}

/**
 * The `preparing` stage, shared by `/compact` and the pre-send pressure check.
 *
 * It owns four things that must happen exactly the same way on both paths: the
 * cancel face (`preparing`, Esc — §5.2.6 sets no wall-clock timeout, so the user
 * is the only exit), the per-request `AbortSignal`, the ledger row for the two
 * zero-write exits, and clearing the in-flight slot.
 *
 * On success it leaves the cancel face **up**: the caller either replaces the
 * slot with the picker (which re-renders the same overlay in place) or closes it
 * with `closePreparingFace`. That is why the face is not closed here — closing
 * and reopening would remount the overlay, and the mount is what keeps the frame
 * stable.
 */
type PreparationOutcome =
  | { kind: "preview"; preview: CompactionPreview }
  | { kind: "cancelled" }
  | { kind: "failed"; message: string };

async function runPreparation(
  ctx: CompactCommandContext,
  runtime: CompactionRuntime,
  conversationId: string,
): Promise<PreparationOutcome> {
  const controller = new AbortController();
  inFlightPreparation = controller;
  setCompactionPreparingRequest({
    startedAt: Date.now(),
    onCancel: () => cancelCompactionPreparation(),
  });
  ctx.setActiveOverlay("compaction");
  ctx.setCommandRunning(true);
  try {
    const preview = await runtime.prepare({
      conversationId,
      agentId: ctx.agentId,
      signal: controller.signal,
    });
    // Esc landed after the answer did: still zero writes (§5.9.1).
    if (controller.signal.aborted) {
      await recordCompactionRun(ctx, preview, "cancelled");
      return { kind: "cancelled" };
    }
    return { kind: "preview", preview };
  } catch (error) {
    if (controller.signal.aborted) {
      await recordCompactionRun(ctx, null, "cancelled", error);
      return { kind: "cancelled" };
    }
    await recordCompactionRun(ctx, null, "failed", error);
    return { kind: "failed", message: formatCompactPlanningFailure(error) };
  } finally {
    if (inFlightPreparation === controller) inFlightPreparation = null;
    ctx.setCommandRunning(false);
  }
}

/** Take the cancel face down and empty the slot. Idempotent. */
function closePreparingFace(ctx: CompactCommandContext): void {
  clearTopicTrimRequest();
  ctx.setActiveOverlay(null);
}

/**
 * The multi-step local `/compact` (requirement §5.1): prepare once, let the user
 * pick from what the summarizer found, then write back.
 *
 * `preparing` holds no locks: input stays enabled and messages queue, because a
 * compaction is not a turn (§5.1.4). Esc during this stage aborts the call and
 * the preview is dropped whole — nothing was written, so there is nothing to
 * undo (§5.9.1). The tokens already spent are still recorded.
 */
export async function submitCompactPreparation(
  ctx: CompactCommandContext,
  runtime: CompactionRuntime,
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

  // `/compact <n>` locks its identity *now*, against the numbering table the
  // user was looking at (§5.6.3): the markers this run is about to add cannot
  // move what `n` meant.
  let lockedMessageId: string | undefined;
  if (request.kind === "block") {
    const block = list.blocks[request.index - 1];
    if (!block) {
      const count = `${list.blocks.length} block${list.blocks.length === 1 ? "" : "s"}`;
      return fail(
        ctx,
        input,
        `There is no topic block ${request.index}: this context has ${count}. Run /topic list to list them, or /compact with no number to compress by the rate.`,
      );
    }
    lockedMessageId = block.boundaryMessageId;
  }

  const preCompact = await runPreCompactHooks(
    undefined,
    undefined,
    ctx.agentId,
    conversationId,
  );
  if (preCompact.blocked) {
    return fail(
      ctx,
      input,
      `Compact blocked: ${preCompact.feedback.join("\n") || "Blocked by hook"}`,
    );
  }

  // The command row opens before the call does, so a cancelled invocation still
  // leaves a trace (L-1): the transcript showed nothing at all without it.
  const cmd = ctx.commandRunner.start(input, "Preparing compaction...");
  const outcome = await runPreparation(ctx, runtime, conversationId);
  if (outcome.kind === "cancelled") {
    closePreparingFace(ctx);
    cmd.finish(COMPACT_CANCELLED_TEXT, true);
    return { submitted: true };
  }
  if (outcome.kind === "failed") {
    closePreparingFace(ctx);
    cmd.fail(`Failed: ${outcome.message}`);
    return { submitted: true };
  }
  const preview = outcome.preview;

  // `ready`. The pick is an identity, never a row number (§5.6.4): the picker
  // hands back a block index, and this resolves it to the block's boundary
  // message before anything is written.
  const pick: CompactPick | null = lockedMessageId
    ? { kind: "message", messageId: lockedMessageId }
    : preview.blocks.length > 1
      ? null
      : { kind: "ratio_suggestion" };

  if (pick === null) {
    const suggestion = preview.suggestionIndex;
    // Replaces the cancel face in place: the overlay is already mounted.
    setTopicTrimRequest({
      blocks: preview.blocks,
      suggestionIndex: suggestion,
      onPick: (blockIndex) => {
        clearTopicTrimRequest();
        ctx.setActiveOverlay(null);
        const block = preview.blocks[blockIndex - 1];
        if (!block) {
          cmd.fail(
            `There is no topic block ${blockIndex} in this preview. Nothing was written.`,
          );
          return;
        }
        void applyPreparedCompaction(
          ctx,
          runtime,
          preview,
          { kind: "message", messageId: block.boundaryMessageId },
          cmd,
          { confirmedSuggestion: blockIndex === suggestion },
        );
      },
      onCancel: () => {
        clearTopicTrimRequest();
        // Zero writes, but the summarizer ran: the row still records it.
        void recordCompactionRun(ctx, preview, "cancelled");
        cmd.finish(COMPACT_CANCELLED_TEXT, true);
      },
    });
    cmd.update({ output: "Choose the topic block to keep..." });
    // The face is already up (the cancel one); the slot swap re-rendered it.
    return { submitted: true };
  }

  // D-119 + H-2: fewer than two blocks means there is nothing to choose between —
  // either nothing is marked yet, or every marker's boundary clamps onto the start
  // of the context. The ratio decides, and the note says which of the two it was.
  closePreparingFace(ctx);
  const topicMarkingEnabled = shouldAdvertiseTopicMarking(
    ctx.agentId,
    conversationId,
  );
  const extraNote =
    request.kind === "auto"
      ? list.markers.length === 0
        ? formatNoMarkerCompactHint(topicMarkingEnabled)
        : formatSingleBlockCompactHint({
            topicMarkingEnabled,
            liveMarkerAnchor: list.markers.some(
              (view) => view.anchorIndex !== null,
            ),
          })
      : undefined;
  return applyPreparedCompaction(ctx, runtime, preview, pick, cmd, {
    ...(extraNote === undefined ? {} : { extraNote }),
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
  // The runtime is injected by a test and resolved from the backend in the app.
  const runtime = ctx.compaction ?? localCompactionRuntime(backend);
  if (!runtime) {
    return fail(
      ctx,
      input,
      "This backend cannot prepare a compaction. Run /compact help.",
    );
  }
  return submitCompactPreparation(ctx, runtime, input, request, backend);
}
