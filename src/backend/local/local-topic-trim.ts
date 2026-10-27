/**
 * Topic listing and user-picked trims (feature ③, D-104).
 *
 * The planning itself is pure and lives in `topic-compaction.ts`; this module is
 * the I/O shell around it: it reads the in-context list and the transcript
 * markers, resolves the retained-token target from the compression rate and the
 * length of that transcript, asks the existing sliding-window summarizer for the
 * summary, and writes the result through the single in-context rewrite path
 * (`local-context-rewrite.ts`) — then refreshes the frozen prefix, because a trim
 * *is* the "compaction" application point.
 *
 * It runs against a port object rather than the backend so the ordering — and the
 * "nothing to trim must not write anything" rule — can be tested without a
 * provider, exactly like the rewrite path it delegates to.
 */
import type { LocalPiModelsRuntime } from "@/backend/dev/pi-models-runtime";
import {
  LOCAL_SLIDING_WINDOW_COMPACTION_PROMPT,
  type LocalCompactionStats,
  type LocalCompleteFunction,
  type LocalTrimStats,
  normalizedSlidingWindowPercentage,
  packageLocalSummaryMessage,
  summarizeLocalMessagesSlidingWindow,
} from "./compaction";
import { estimateLocalMessagesTokens } from "./local-context-estimate";
import type {
  LocalCompactionStoreResult,
  LocalConversationRewriteInput,
} from "./local-context-rewrite";
import type { LocalMessage } from "./local-message";
import type { LocalAgentRecord } from "./local-store";
import {
  DEFAULT_TOPIC_BOUNDARY_REWIND_TURNS,
  type LocalTopicMarker,
  listTopicBlocks,
  resolveTrimPlan,
  type TopicBlock,
  type TrimNoopReason,
  type TrimPlan,
  type TrimStartSource,
} from "./topic-compaction";

/** The user's pick: a 1-based block index, or "just use the ratio". */
export type LocalTopicTrimPick =
  | { kind: "topic"; index: number }
  | { kind: "ratio_suggestion" };

export interface LocalTopicTrimSettings {
  /**
   * The compression rate: the share of the in-context transcript each trim
   * compresses away. `0.3` means "compress about 30%, keep about 70%".
   */
  slidingWindowPercentage: number;
  prompt?: string | null;
  clipChars?: number | null;
}

/**
 * Everything this module needs from the backend. Each member maps to one
 * existing backend responsibility, so no policy is duplicated here.
 */
export interface LocalTopicTrimPorts {
  resolveAgentId(conversationId: string): string;
  listMessages(conversationId: string, agentId: string): LocalMessage[];
  readMarkers(conversationId: string, agentId: string): LocalTopicMarker[];
  contextWindow(conversationId: string, agentId: string): number | undefined;
  /** The frozen agent, so the summary runs on the model the prefix pinned. */
  resolveSummarizerAgent(
    conversationId: string,
    agentId: string,
  ): LocalAgentRecord;
  compactionSettings(
    conversationId: string,
    agentId: string,
  ): LocalTopicTrimSettings;
  rewrite(input: LocalConversationRewriteInput): LocalCompactionStoreResult;
  /** Re-apply the frozen prefix after the context changed. */
  refreshFrozenPrefix(conversationId: string, agentId: string): Promise<void>;
  /**
   * The rewrite ended the unmarked stretch, so the next nudge starts a new streak
   * (D-114 + M-4). Called only after a successful write: a refusal wrote nothing
   * and must leave the one-shot flag alone.
   */
  clearTopicNudgeStreak?(conversationId: string, agentId: string): void;
  onCompactionStart?(
    conversationId: string,
    agentId: string,
    trigger: string,
  ): void | Promise<void>;
  onCompactionEnd?(
    conversationId: string,
    agentId: string,
    trigger: string,
    stats: LocalCompactionStats,
  ): void | Promise<void>;
  complete?: LocalCompleteFunction;
  storageDir: string;
  modelsRuntime?: LocalPiModelsRuntime;
}

export interface LocalTopicMarkerView {
  marker: LocalTopicMarker;
  /** False once a trim moved the anchor out of the context. */
  anchorInContext: boolean;
}

export interface LocalTopicList {
  /** Blocks cut at the effective boundaries, oldest first, trailing one included. */
  blocks: TopicBlock[];
  /** Every marker in the transcript, oldest first, for `/topics --all`. */
  markers: LocalTopicMarkerView[];
  contextMessageCount: number;
  contextTokens: number;
  contextWindow?: number;
  /**
   * The most a cut may keep: `(1 - compressionRate) x contextTokens`.
   * `Infinity` when the transcript length cannot be measured, which keeps
   * everything rather than compressing blindly.
   */
  retentionCapTokens: number;
  /**
   * Block the compression rate would keep, computed by the same planner that
   * executes the trim so the picker's default and the actual cut agree. `1` (or
   * `null` for an empty context) means the rate keeps everything.
   */
  suggestedBlockIndex: number | null;
}

export interface LocalTopicTrimOutcome {
  /** False when the request resolved to a no-op; nothing was written. */
  executed: boolean;
  source: TrimStartSource;
  noopReason?: TrimNoopReason;
  /** The topic the kept region starts in (`null` = the current topic). */
  topicTitle: string | null;
  summarizedTitles: string[];
  boundaryAdjusted: boolean;
  ratioCapApplied: boolean;
  /** User turns the effective boundary was rewound from the marker anchor. */
  rewindTurns: number;
  numMessagesBefore: number;
  numMessagesAfter: number;
  summarizedMessageCount: number;
  /** Tokens in the region that was summarized away. */
  summarizedTokens: number;
  /** Retention the request asked for, before the compression-rate cut. */
  requestedRetentionTokens: number;
  retainedTokens: number;
  /** `null` when the transcript length — and therefore the target — is unknown. */
  retentionCapTokens: number | null;
  contextWindow?: number;
  /** The kept region, so a receipt can name its first message. */
  firstKeptMessageId?: string;
  /** Exactly what was persisted on the `compaction` row. */
  stats: LocalCompactionStats;
}

/**
 * The retained-token target: `(1 - compressionRate) x contextTokens`.
 *
 * The base is the length being compressed — the in-context transcript — not the
 * model's window. A trim compresses that transcript by the configured rate, and
 * the rule the cap enforces is that a cut may never *keep* more than the rate
 * allows, whether the cut point came from a topic pick or from the rate itself.
 * The window only decides when a turn is refused
 * (`backend/dev/provider-turn-executor.ts`), never how much a trim keeps.
 *
 * The rate is normalized by the same helper the sliding-window planner uses, so
 * a `0`, negative, or `NaN` percentage cannot mean different things in the two
 * places (`0` and below compress the smallest step, above `1` compresses
 * everything). A length that cannot be measured has no target: `Infinity`
 * keeps everything, so an unmeasurable transcript is never compressed blindly.
 */
export function retentionCapTokensFor(
  contextTokens: number | undefined,
  percentage: number,
): number {
  if (
    typeof contextTokens !== "number" ||
    !Number.isFinite(contextTokens) ||
    contextTokens <= 0
  ) {
    return Number.POSITIVE_INFINITY;
  }
  const keepRatio = 1 - normalizedSlidingWindowPercentage(percentage);
  return Math.floor(contextTokens * keepRatio);
}

/**
 * Whether the picker has anything to choose between.
 *
 * A list with a single block has no choice to offer and the compression rate
 * decides instead (D-119). Markers alone are not the test — a marker whose
 * effective boundary clamps onto the start of the context produces no block of
 * its own (a `/topic` in the first turns, or every anchor trimmed away), so
 * opening the picker would leave the user with one row and no way to cut.
 */
export function hasSelectableTopicBlocks(list: LocalTopicList): boolean {
  return list.blocks.length > 1;
}

export function listLocalTopics(
  ports: LocalTopicTrimPorts,
  input: {
    conversationId: string;
    agentId?: string;
    rewindTurns?: number;
  },
): LocalTopicList {
  const agentId = input.agentId ?? ports.resolveAgentId(input.conversationId);
  const messages = ports.listMessages(input.conversationId, agentId);
  const markers = ports.readMarkers(input.conversationId, agentId);
  const contextWindow = ports.contextWindow(input.conversationId, agentId);
  const blocks = listTopicBlocks(messages, markers, {
    rewindTurns: input.rewindTurns ?? DEFAULT_TOPIC_BOUNDARY_REWIND_TURNS,
  });
  const contextTokens = estimateLocalMessagesTokens(messages);
  const retentionCapTokens = retentionCapTokensFor(
    contextTokens,
    ports.compactionSettings(input.conversationId, agentId)
      .slidingWindowPercentage,
  );
  const inContext = new Set(messages.map((message) => message.id));
  return {
    blocks,
    markers: markers.map((marker) => ({
      marker,
      anchorInContext:
        marker.anchorMessageId !== null &&
        inContext.has(marker.anchorMessageId),
    })),
    contextMessageCount: messages.length,
    contextTokens,
    ...(contextWindow === undefined ? {} : { contextWindow }),
    retentionCapTokens,
    suggestedBlockIndex: suggestionBlockIndex(
      messages,
      blocks,
      retentionCapTokens,
    ),
  };
}

/** The block the ratio suggestion lands in, or `1` when nothing would move. */
export function suggestionBlockIndex(
  messages: readonly LocalMessage[],
  blocks: readonly TopicBlock[],
  retentionCapTokens: number,
): number | null {
  if (messages.length === 0) return null;
  const plan = resolveTrimPlan({
    messages,
    blocks,
    pick: { kind: "ratio_suggestion" },
    retentionCapTokens,
  });
  const containing = blocks.find(
    (block) =>
      block.startIndex <= plan.startIndex && plan.startIndex < block.endIndex,
  );
  return containing?.index ?? blocks[0]?.index ?? 1;
}

/**
 * Ask the summarizer to structure its output by topic.
 *
 * The titles are the ones being evicted, oldest first. With no titles the prompt
 * is passed through untouched, so an unmarked region summarizes exactly as it did
 * before this feature.
 *
 * The section requirement is inserted *before* the base prompt's final paragraph —
 * which is where the built-in prompt states its word limit and output rule — so
 * "every topic must have a section" is not competing with an instruction that
 * arrives after it. A single-paragraph custom prompt has no such trailing rule,
 * and gets the requirement appended.
 */
export function topicSectionPrompt(
  basePrompt: string,
  titles: readonly string[],
): string {
  if (titles.length === 0) return basePrompt;
  const list = titles.map((title) => `- ${title}`).join("\n");
  const section = [
    "Additionally, structure the summary as one section per topic listed below, in this order, using each title as the section heading. Every topic in the list is being evicted, so none of them may be dropped even if it looks minor. Keep every section heading; if the headings push against the length limit, shorten the prose inside them instead.",
    "",
    list,
  ].join("\n");
  const lastParagraph = basePrompt.lastIndexOf("\n\n");
  if (lastParagraph < 0) return `${basePrompt}\n\n${section}`;
  return `${basePrompt.slice(0, lastParagraph)}\n\n${section}\n\n${basePrompt.slice(lastParagraph + 2)}`;
}

function emptyStats(contextWindow: number | undefined): LocalCompactionStats {
  return contextWindow === undefined ? {} : { context_window: contextWindow };
}

function noopOutcome(
  input: {
    numMessagesBefore: number;
    retentionCapTokens: number;
    contextWindow?: number;
  },
  plan: TrimPlan,
): LocalTopicTrimOutcome {
  return {
    executed: false,
    source: plan.source,
    ...(plan.noopReason === undefined ? {} : { noopReason: plan.noopReason }),
    topicTitle: plan.topicTitle,
    summarizedTitles: [],
    boundaryAdjusted: plan.boundaryAdjusted,
    ratioCapApplied: plan.ratioCapApplied,
    rewindTurns: 0,
    numMessagesBefore: input.numMessagesBefore,
    numMessagesAfter: input.numMessagesBefore,
    summarizedMessageCount: 0,
    summarizedTokens: 0,
    requestedRetentionTokens: 0,
    retainedTokens: estimateLocalMessagesTokens(plan.keep),
    retentionCapTokens: Number.isFinite(input.retentionCapTokens)
      ? input.retentionCapTokens
      : null,
    ...(input.contextWindow === undefined
      ? {}
      : { contextWindow: input.contextWindow }),
    stats: emptyStats(input.contextWindow),
  };
}

/**
 * Execute a user-picked trim: summarize everything before the picked boundary
 * and rewrite the in-context list as `[summary, ...kept]`.
 *
 * Every refusal path returns `executed: false` with a structured reason and
 * writes nothing — a trim that cannot honor the request must not half-apply.
 */
export async function trimLocalConversationToTopic(
  ports: LocalTopicTrimPorts,
  input: {
    conversationId: string;
    agentId?: string;
    pick: LocalTopicTrimPick;
    rewindTurns?: number;
    trigger?: string;
  },
): Promise<LocalTopicTrimOutcome> {
  const conversationId = input.conversationId;
  const agentId = input.agentId ?? ports.resolveAgentId(conversationId);
  const trigger = input.trigger ?? "manual";
  const messages = ports.listMessages(conversationId, agentId);
  const contextWindow = ports.contextWindow(conversationId, agentId);
  const settings = ports.compactionSettings(conversationId, agentId);
  const transcriptTokens = estimateLocalMessagesTokens(messages);
  const retentionCapTokens = retentionCapTokensFor(
    transcriptTokens,
    settings.slidingWindowPercentage,
  );
  const rewindTurns = input.rewindTurns ?? DEFAULT_TOPIC_BOUNDARY_REWIND_TURNS;
  const markers = ports.readMarkers(conversationId, agentId);
  const blocks = listTopicBlocks(messages, markers, { rewindTurns });
  const plan = resolveTrimPlan({
    messages,
    blocks,
    pick: input.pick,
    retentionCapTokens,
  });
  const windowFields = contextWindow === undefined ? {} : { contextWindow };
  if (plan.noop) {
    return noopOutcome(
      {
        numMessagesBefore: messages.length,
        retentionCapTokens,
        ...windowFields,
      },
      plan,
    );
  }

  const pick = input.pick;
  const pickedBlock =
    pick.kind === "topic"
      ? blocks.find((block) => block.index === pick.index)
      : undefined;
  const summarize = [...plan.summarize];
  const keep = [...plan.keep];
  const summarizedTokens = estimateLocalMessagesTokens(summarize);
  const requestedRetentionTokens = estimateLocalMessagesTokens(
    messages.slice(plan.requestedStartIndex),
  );
  const retainedTokens = estimateLocalMessagesTokens(keep);
  const trim: LocalTrimStats = {
    source: plan.source,
    topic_title: plan.topicTitle,
    summarized_titles: [...plan.summarizedTitles],
    rewind_turns: pickedBlock ? pickedBlock.rewindTurns : 0,
    requested_retention_tokens: requestedRetentionTokens,
    retention_tokens: retainedTokens,
    retention_cap_tokens: Number.isFinite(retentionCapTokens)
      ? retentionCapTokens
      : null,
  };
  await ports.onCompactionStart?.(conversationId, agentId, trigger);
  const summary = await summarizeLocalMessagesSlidingWindow({
    conversationId,
    agent: ports.resolveSummarizerAgent(conversationId, agentId),
    messages: summarize,
    complete: ports.complete,
    prompt: topicSectionPrompt(
      settings.prompt ?? LOCAL_SLIDING_WINDOW_COMPACTION_PROMPT,
      plan.summarizedTitles,
    ),
    clipChars: settings.clipChars,
    localProviderAuthStorageDir: ports.storageDir,
    modelsRuntime: ports.modelsRuntime,
  });

  const stats: LocalCompactionStats = {
    trigger,
    context_tokens_before: transcriptTokens,
    context_tokens_after: Math.ceil(summary.length / 4) + retainedTokens,
    messages_count_before: messages.length,
    messages_count_after: 1 + keep.length,
    trim,
    ...(contextWindow === undefined ? {} : { context_window: contextWindow }),
  };
  const written = ports.rewrite({
    conversationId,
    agentId,
    summary,
    packedSummary: packageLocalSummaryMessage(summary, stats, "sliding_window"),
    stats,
    remainingMessages: keep,
  });
  // The context changed, so the unmarked stretch this conversation was in is over
  // even when the kept region is still longer than `topic_nudge_turns` (M-4).
  ports.clearTopicNudgeStreak?.(conversationId, agentId);
  await ports.refreshFrozenPrefix(conversationId, agentId);
  await ports.onCompactionEnd?.(conversationId, agentId, trigger, stats);

  return {
    executed: true,
    source: plan.source,
    topicTitle: plan.topicTitle,
    summarizedTitles: [...plan.summarizedTitles],
    boundaryAdjusted: plan.boundaryAdjusted,
    ratioCapApplied: plan.ratioCapApplied,
    rewindTurns: trim.rewind_turns,
    numMessagesBefore: written.numMessagesBefore,
    numMessagesAfter: written.numMessagesAfter,
    summarizedMessageCount: summarize.length,
    summarizedTokens,
    requestedRetentionTokens,
    retainedTokens,
    retentionCapTokens: trim.retention_cap_tokens,
    ...windowFields,
    ...(keep[0] === undefined ? {} : { firstKeptMessageId: keep[0].id }),
    stats,
  };
}
