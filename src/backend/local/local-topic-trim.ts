/**
 * The topic blocks of a conversation, and the cut the compression rate implies
 * (feature ③, D-104).
 *
 * The planning itself is pure and lives in `topic-compaction.ts`; this module is
 * the I/O shell around it: it reads the in-context list and the transcript
 * markers, resolves the retained-token target from the compression rate and the
 * length of that transcript, and returns the blocks the list commands and the
 * `/compact` picker render.
 *
 * It runs against a port object rather than the backend so the list can be
 * tested without a provider or a store, exactly like the rewrite path it
 * delegates to.
 */
import { normalizedSlidingWindowPercentage } from "./compaction";
import { estimateLocalMessagesTokens } from "./local-context-estimate";
import type {
  LocalCompactionStoreResult,
  LocalConversationRewriteInput,
} from "./local-context-rewrite";
import type { LocalMessage } from "./local-message";
import {
  DEFAULT_TOPIC_BOUNDARY_REWIND_TURNS,
  type LocalTopicMarker,
  listTopicBlocks,
  resolveTrimPlan,
  type TopicBlock,
} from "./topic-compaction";

export interface LocalTopicTrimSettings {
  /**
   * The compression rate: the share of the in-context transcript each compaction
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
}

export interface LocalTopicMarkerView {
  marker: LocalTopicMarker;
  /**
   * The anchor's index in the in-context message list, or `null` once a
   * compaction moved the anchor out of the context.
   *
   * This is the one field that gives a marker a *context position*. The written
   * order of markers is a different order: a summarizer writes its markers when
   * a fold runs, so its rows are appended after markers whose topics sit later
   * in the context. `--context` orders by this index; the marker number (and
   * `/topic show`) stays the transcript's write order.
   */
  anchorIndex: number | null;
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
   * applies the compaction so the picker's default and the actual cut agree. `1`
   * (or `null` for an empty context) means the rate keeps everything.
   */
  suggestedBlockIndex: number | null;
}

/**
 * The retained-token target: `(1 - compressionRate) x contextTokens`.
 *
 * The base is the length being compressed — the in-context transcript — not the
 * model's window. A compaction compresses that transcript by the configured
 * rate, and the rule the cap enforces is that a cut may never *keep* more than
 * the rate allows, whether the cut point came from a topic pick or from the rate
 * itself. The window only decides when a turn is refused
 * (`backend/dev/provider-turn-executor.ts`), never how much a cut keeps.
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
  const indexById = new Map(
    messages.map((message, index) => [message.id, index] as const),
  );
  return {
    blocks,
    markers: markers.map((marker) => ({
      marker,
      anchorIndex:
        marker.anchorMessageId === null
          ? null
          : (indexById.get(marker.anchorMessageId) ?? null),
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
