/**
 * F-04's `prepare → pick → apply` orchestration.
 *
 * This module owns the sequencing and nothing else: it reads the in-context
 * list and the markers through a port object, asks the injected summarizer for
 * the preview, and on apply writes the folded topics' markers, the single
 * `system_alert` summary message, and the topic-index refresh — in that order.
 * The store stays behind the ports, so the ordering can be read (and tested)
 * without a provider, a store, or a clock.
 *
 * `prepareCompaction` never persists anything (requirement §5.9.1: a cancelled
 * preview is dropped whole). `applyCompaction` never calls a model: everything
 * the write-back needs was computed before the pick.
 */
import { packageLocalSummaryMessage } from "./compaction";
import {
  type CompactionDegraded,
  type CompactionOverview,
  type CompactionPreview,
  type CompactionTopicDraft,
  type CompactPick,
  type CompactUsage,
  foldedCompactionTopics,
  mergeCompactionBlocks,
  previewStaleness,
  renderCompactionSummary,
  topicBlocksFromDrafts,
  validateCompactionTopics,
} from "./compaction-preview";
import {
  estimateLocalMessagesTokens,
  estimateLocalMessageTokens,
} from "./local-context-estimate";
import type {
  LocalCompactionStoreResult,
  LocalCompactionWriteStats,
  LocalConversationRewriteInput,
  LocalTopicMarkerDraft,
} from "./local-context-rewrite";
import type { LocalMessage } from "./local-message";
import {
  retentionCapTokensFor,
  suggestionBlockIndex,
} from "./local-topic-trim";
import type { LocalAgentRecord } from "./local-types";
import {
  type LocalTopicMarker,
  listTopicBlocks,
  resolveTrimPlan,
  type TrimNoopReason,
  type TrimStartSource,
} from "./topic-compaction";

/** The one thing `prepareCompaction` needs from T1's summarizer (M1 seam). */
export interface CompactionSummarizeInput {
  /**
   * The frozen agent, resolved by the caller that can reach the execution
   * branch (`retrieveExecutionAgentRecord` + the conversation's `/model`
   * overlay). The summarizer must not resolve it itself: a mismatch would break
   * the byte-identical-prefix guarantee (§5.2.2).
   */
  agent: LocalAgentRecord;
  agentId: string;
  conversationId: string;
  storageDir: string;
  signal?: AbortSignal;
}

export interface CompactionSummarizeResult {
  topics: CompactionTopicDraft[];
  overview: CompactionOverview;
  degraded: CompactionDegraded | null;
  usage: CompactUsage;
}

export type CompactionSummarize = (
  input: CompactionSummarizeInput,
) => Promise<CompactionSummarizeResult>;

/** The compression rate, as the trim planner reads it. */
export interface CompactionSettings {
  slidingWindowPercentage: number;
}

interface CompactionPortsBase {
  listMessages(conversationId: string, agentId: string): LocalMessage[];
  readMarkers(conversationId: string, agentId: string): LocalTopicMarker[];
  compactionSettings(
    conversationId: string,
    agentId: string,
  ): CompactionSettings;
}

export interface PrepareCompactionPorts extends CompactionPortsBase {
  storageDir: string;
  /**
   * The agent the summarizer runs as: the live record overlaid with what the
   * frozen prefix pinned. `LocalBackend` supplies it from
   * `frozenAgentForConversation`, so the summarizer and the turn agree on model
   * and sampling.
   */
  frozenAgent(conversationId: string, agentId: string): LocalAgentRecord;
  summarize: CompactionSummarize;
}

export interface ApplyCompactionPorts extends CompactionPortsBase {
  rewrite(input: LocalConversationRewriteInput): LocalCompactionStoreResult;
  /** Re-apply the frozen prefix after the context changed (§5.8.4). */
  refreshFrozenPrefix(conversationId: string, agentId: string): Promise<void>;
  /** Per-agent topic index refresh; wired when the index milestone lands. */
  refreshIndex?: () => void;
  /** The rewrite ended the unmarked stretch (M-4). */
  clearTopicNudgeStreak?(conversationId: string, agentId: string): void;
}

export interface CompactionApplyResult {
  /** False when the pick resolved to a no-op; nothing was written. */
  executed: boolean;
  source: TrimStartSource;
  noopReason?: TrimNoopReason;
  /** The topic the kept region starts in (`null` = the current topic). */
  topicTitle: string | null;
  /** Append-only marker ids of the topics this cut folded in, oldest first. */
  foldedTopicIds: string[];
  foldedTitles: string[];
  numMessagesBefore: number;
  numMessagesAfter: number;
  summarizedMessageCount: number;
  summarizedTokens: number;
  retainedTokens: number;
  retentionCapTokens: number | null;
  firstKeptMessageId?: string;
  summaryMessageId?: string;
  stats: LocalCompactionWriteStats;
}

function emptyOverview(): CompactionOverview {
  return {
    restricted: { open: "", errors: "", relationship: "", memoryIndex: "" },
    narrative: "",
  };
}

function emptyUsage(): CompactUsage {
  return {
    promptTokens: 0,
    cachedInputTokens: 0,
    completionTokens: 0,
    wallMs: 0,
  };
}

/** Tokens of the one message a fold writes back, measured the way the next turn
 * will measure it: the packed text, not the bare summary. */
function estimatePackedSummaryTokens(packedSummary: string): number {
  return estimateLocalMessageTokens({
    id: "packed-summary",
    role: "user",
    content: [{ type: "text", text: packedSummary }],
    timestamp: 0,
  });
}

/**
 * Pack the summary and report the context weight the write-back will have.
 *
 * §5.14's "tokens after" is the pressure baseline for the next send, so it has to
 * describe the message that is actually persisted and re-estimated — the packed
 * `system_alert` text — rather than the bare summary that is only an input to it.
 * The packed body *contains* these stats, so the measurement is taken in
 * fixed-point passes: a pass can change a digit and therefore the length, and the
 * loop stops as soon as it stops moving.
 */
function packWithMeasuredTokens(input: {
  summary: string;
  retainedTokens: number;
  stats: LocalCompactionWriteStats;
}): { stats: LocalCompactionWriteStats; packedSummary: string } {
  let contextTokensAfter = input.retainedTokens;
  let packedSummary = "";
  for (let pass = 0; pass < 4; pass += 1) {
    const stats = { ...input.stats, context_tokens_after: contextTokensAfter };
    packedSummary = packageLocalSummaryMessage(input.summary, stats);
    const measured =
      input.retainedTokens + estimatePackedSummaryTokens(packedSummary);
    if (measured === contextTokensAfter) break;
    contextTokensAfter = measured;
  }
  const stats = { ...input.stats, context_tokens_after: contextTokensAfter };
  return {
    stats,
    packedSummary: packageLocalSummaryMessage(input.summary, stats),
  };
}

/**
 * Run the summarizer and shape its answer into the frozen preview.
 *
 * A degraded or structurally invalid answer is *not* thrown away silently: the
 * preview says `degraded: "whole-section"`, carries no topics, and leaves the
 * marker-derived blocks in place, so the picker still shows something the user
 * can cut on and the write-back still runs (requirement §5.9.2, §5.12.2).
 */
export async function prepareCompaction(
  ports: PrepareCompactionPorts,
  input: {
    conversationId: string;
    agentId: string;
    signal?: AbortSignal;
  },
): Promise<CompactionPreview> {
  const { conversationId, agentId } = input;
  // Resolved once: the summarizer runs as exactly this agent, so the preview's
  // `model` is the one the call actually used (usage ledger + receipt).
  const agent = ports.frozenAgent(conversationId, agentId);
  const messages = ports.listMessages(conversationId, agentId);
  const markers = ports.readMarkers(conversationId, agentId);
  const existingBlocks = listTopicBlocks(messages, markers);
  const retentionCapTokens = retentionCapTokensFor(
    estimateLocalMessagesTokens(messages),
    ports.compactionSettings(conversationId, agentId).slidingWindowPercentage,
  );
  const degradedPreview: CompactionPreview = {
    conversationId,
    agentId,
    model: agent.model,
    createdAt: new Date().toISOString(),
    topics: [],
    overview: emptyOverview(),
    blocks: existingBlocks,
    numberedBlocks: existingBlocks.length,
    suggestionIndex:
      suggestionBlockIndex(messages, existingBlocks, retentionCapTokens) ?? 1,
    usage: emptyUsage(),
    // Nothing in the context, nothing to degrade: no call was made and the
    // apply path refuses with `empty_context` before writing anything.
    degraded: null,
  };
  // Nothing to summarize: do not spend a provider call on an empty context.
  if (messages.length === 0) return degradedPreview;

  const result = await ports.summarize({
    agent,
    agentId,
    conversationId,
    storageDir: ports.storageDir,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const usable =
    result.degraded === null &&
    validateCompactionTopics(messages, result.topics).length === 0;
  // §5.5.1: a summarizer topic weighs the same as a marker someone wrote, so the
  // picker's table is the union of both. Losing a user's own boundary because the
  // summarizer drew its own lines is exactly the defect this merge removes.
  const blocks = usable
    ? mergeCompactionBlocks(messages, [
        existingBlocks,
        topicBlocksFromDrafts(messages, result.topics),
      ])
    : existingBlocks;
  return {
    conversationId,
    agentId,
    model: agent.model,
    createdAt: new Date().toISOString(),
    topics: usable ? [...result.topics] : [],
    overview: result.overview,
    blocks,
    numberedBlocks: existingBlocks.length,
    suggestionIndex:
      suggestionBlockIndex(messages, blocks, retentionCapTokens) ?? 1,
    usage: result.usage,
    degraded: usable ? null : (result.degraded ?? "format"),
  };
}

function noopApplyResult(input: {
  messages: readonly LocalMessage[];
  source: TrimStartSource;
  noopReason?: TrimNoopReason;
  topicTitle?: string | null;
  retentionCapTokens: number;
}): CompactionApplyResult {
  return {
    executed: false,
    source: input.source,
    ...(input.noopReason === undefined ? {} : { noopReason: input.noopReason }),
    topicTitle: input.topicTitle ?? null,
    foldedTopicIds: [],
    foldedTitles: [],
    numMessagesBefore: input.messages.length,
    numMessagesAfter: input.messages.length,
    summarizedMessageCount: 0,
    summarizedTokens: 0,
    retainedTokens: estimateLocalMessagesTokens(input.messages),
    retentionCapTokens: Number.isFinite(input.retentionCapTokens)
      ? input.retentionCapTokens
      : null,
    stats: {},
  };
}

/**
 * Write one preview back: fold the picked region into the new overview, record
 * the folded topics as `summarizer` markers, and refresh the frozen prefix.
 *
 * Markers are written *before* the rewrite because they are inert metadata: if
 * the rewrite then fails, the transcript keeps a valid boundary map instead of a
 * fold with no topic records. The rewrite itself is the single atomic write path
 * (`local-context-rewrite.ts`), so a failure cannot half-apply the context.
 */
export async function applyCompaction(
  ports: ApplyCompactionPorts,
  input: { preview: CompactionPreview; pick: CompactPick },
): Promise<CompactionApplyResult> {
  const preview = input.preview;
  const pick = input.pick;
  const conversationId = preview.conversationId;
  const agentId = preview.agentId;
  const messages = ports.listMessages(conversationId, agentId);
  const retentionCapTokens = retentionCapTokensFor(
    estimateLocalMessagesTokens(messages),
    ports.compactionSettings(conversationId, agentId).slidingWindowPercentage,
  );
  // Checked before the pick: a preview whose context was rewritten underneath it
  // would otherwise report "unknown_block" for a pick that *was* valid, and then
  // (on the rate path) write its older overview over the newer one.
  const staleness = previewStaleness(preview, messages);
  if (staleness !== null) {
    return noopApplyResult({
      messages,
      source: pick.kind === "message" ? "topic_pick" : "ratio_suggestion",
      noopReason: staleness,
      retentionCapTokens,
    });
  }
  // A pick whose message is gone cannot be honored: the pick's identity is the
  // id, so refuse rather than let the rate silently choose a different cut.
  if (
    pick.kind === "message" &&
    !messages.some((message) => message.id === pick.messageId)
  ) {
    return noopApplyResult({
      messages,
      source: "topic_pick",
      noopReason: "unknown_block",
      retentionCapTokens,
    });
  }
  // `resolveTrimPlan` is the one cut planner: a message-id pick and the rate's
  // own suggestion both go through it, so the retention cap and the no-op rules
  // cannot differ between `/compact <n>` and the paths without a picker.
  const plan = resolveTrimPlan({
    messages,
    blocks: [],
    pick,
    retentionCapTokens,
  });
  if (plan.noop) {
    return noopApplyResult({
      messages,
      source: plan.source,
      ...(plan.noopReason === undefined ? {} : { noopReason: plan.noopReason }),
      topicTitle: plan.topicTitle,
      retentionCapTokens,
    });
  }

  const keep = messages.slice(plan.startIndex);
  const folded = foldedCompactionTopics(
    messages,
    preview.topics,
    plan.startIndex,
  );
  const foldedTitles = folded.map((topic) => topic.title);
  const pickedBlock = preview.blocks.find((block) =>
    pick.kind === "message"
      ? block.boundaryMessageId === pick.messageId
      : block.index === preview.suggestionIndex,
  );
  const topicTitle = pickedBlock?.title ?? null;

  const foldedTitlesByStart = new Set(
    folded.map((topic) => topic.startMessageId),
  );
  const existingAnchors = new Set(
    ports
      .readMarkers(conversationId, agentId)
      .map((marker) => marker.anchorMessageId)
      .filter((anchor): anchor is string => anchor !== null),
  );
  // The markers are handed to the rewrite rather than written here: the rewrite
  // is the single write path for a fold, so the topic rows and the `compaction`
  // row that supersedes them can only land in one order (§5.8.3). Writing them
  // first also means the audit ids exist before `stats` is serialised — which is
  // why `folded_topic_ids` is filled in by the rewrite, not by this loop.
  const topicMarkers: LocalTopicMarkerDraft[] = [];
  preview.topics.forEach((topic, position) => {
    if (!foldedTitlesByStart.has(topic.startMessageId)) return;
    // A summarizer marker records the exact boundary between two topics, which
    // is the next topic's first message (or the picked cut for the last topic).
    const anchorMessageId =
      preview.topics[position + 1]?.startMessageId ?? keep[0]?.id ?? null;
    // §5.5.4: never double-mark one anchor.
    if (anchorMessageId === null || existingAnchors.has(anchorMessageId)) {
      return;
    }
    existingAnchors.add(anchorMessageId);
    topicMarkers.push({
      title: topic.title,
      ...(topic.section.trim().length > 0 ? { summary: topic.section } : {}),
      createdBy: "summarizer",
      anchorMessageId,
    });
  });

  const summary = renderCompactionSummary({
    overview: preview.overview,
    folded,
  });
  const retainedTokens = estimateLocalMessagesTokens(keep);
  const measured = packWithMeasuredTokens({
    summary,
    retainedTokens,
    stats: {
      context_tokens_before: estimateLocalMessagesTokens(messages),
      messages_count_before: messages.length,
      messages_count_after: 1 + keep.length,
      trim: {
        source: plan.source,
        topic_title: topicTitle,
        summarized_titles: foldedTitles,
        // Summarizer boundaries are exact; nothing was rewound for this cut.
        rewind_turns: 0,
        requested_retention_tokens: estimateLocalMessagesTokens(
          messages.slice(plan.requestedStartIndex),
        ),
        retention_tokens: retainedTokens,
        retention_cap_tokens: Number.isFinite(retentionCapTokens)
          ? retentionCapTokens
          : null,
      },
    },
  });
  const written = ports.rewrite({
    conversationId,
    agentId,
    summary,
    packedSummary: measured.packedSummary,
    stats: measured.stats,
    remainingMessages: keep,
    topicMarkers,
  });
  // The rewrite fills in `folded_topic_ids` (it is the only writer that knows
  // them), so its copy is what the receipt reports.
  const stats = written.stats ?? measured.stats;
  // The rewrite is the one atomic step, and it is already done: everything below
  // is bookkeeping that must not turn a completed fold into a reported failure.
  // Failing here used to reach the user as `Failed: …` while the context *had*
  // been rewritten, which also skipped the post-compaction tail (reflection,
  // tracker rebase, nudge reset) and recorded the run as failed in the ledger.
  try {
    ports.clearTopicNudgeStreak?.(conversationId, agentId);
  } catch {
    // A stale nudge flag costs one extra reminder, never correctness.
  }
  try {
    await ports.refreshFrozenPrefix(conversationId, agentId);
  } catch {
    // Recorded as debt: the next turn re-compiles on its own path when the
    // snapshot is missing, but a *stale* snapshot would not self-heal here.
  }
  try {
    ports.refreshIndex?.();
  } catch {
    // The index is a derived cache; its own self-heal rebuilds it on next read.
  }

  return {
    executed: true,
    source: plan.source,
    topicTitle,
    foldedTopicIds: written.topicEntryIds,
    foldedTitles,
    numMessagesBefore: written.numMessagesBefore,
    numMessagesAfter: written.numMessagesAfter,
    summarizedMessageCount: messages.length - keep.length,
    summarizedTokens: estimateLocalMessagesTokens(messages) - retainedTokens,
    retainedTokens,
    retentionCapTokens: Number.isFinite(retentionCapTokens)
      ? retentionCapTokens
      : null,
    ...(keep[0] === undefined ? {} : { firstKeptMessageId: keep[0].id }),
    summaryMessageId: written.summaryMessage.id,
    stats,
  };
}
