/**
 * F-04 compaction preview: the in-memory product of one summarizer call.
 *
 * The multi-step `/compact` flow computes everything the write-back will need
 * *before* it writes anything (`prepare → pick → apply`, requirement §5.1): the
 * topic drafts, the overview, the blocking table the picker shows, and the
 * usage the calling layer records. Nothing here is persisted — a cancelled
 * preview is dropped whole (requirement §5.9.1), so there is no resume, no
 * snapshot file, and no "half-compacted" state to repair.
 *
 * This module is the frozen shape between the milestone tracks (route §2.3).
 * M0 fixes the types; the pure helpers that validate boundaries, render the
 * overview, and turn a draft into a marker live here too, but they land with
 * the data-model milestone — do not add behaviour that a later track owns.
 */
import { estimateLocalMessagesTokens } from "./local-context-estimate";
import type { LocalMessage } from "./local-message";
import { localMessageCreatedAt, type TopicBlock } from "./topic-compaction";

/**
 * One topic the summarizer proposes. `startMessageId` is a *single point*: the
 * first message of the topic, never a range (requirement §5.5.2). The host maps
 * it back to a real `message.id`; `section` is the topic's short record
 * (≤600 characters) that the write-back carries for the topics it folds in.
 */
export interface CompactionTopicDraft {
  title: string;
  startMessageId: string;
  section: string;
}

/**
 * The overview that replaces the previous one in the context.
 *
 * `restricted` is the fixed-shape part every preview must carry; `narrative` is
 * the free-form story-so-far part (requirement §5.4.1–§5.4.2). The four
 * restricted fields are the product's continuity guarantees, not a summary of
 * the work done:
 *
 * - `open` — what is unfinished and what comes next;
 * - `errors` — approaches that failed or were ruled out;
 * - `relationship` — how the relationship/emotional line has moved;
 * - `memoryIndex` — memfs paths worth knowing about, one line each.
 */
export interface CompactionOverview {
  restricted: {
    open: string;
    errors: string;
    relationship: string;
    memoryIndex: string;
  };
  narrative: string;
}

/** What one summarizer call cost. The backend only reports numbers; the
 * calling layer (TUI / listener / headless) writes the usage ledger row
 * (requirement §5.14, route C-14). */
export interface CompactUsage {
  promptTokens: number;
  cachedInputTokens: number;
  completionTokens: number;
  wallMs: number;
}

/**
 * Everything the picker and the write-back need, computed once.
 *
 * - `blocks` — the topic blocks as the picker shows them: every marker that
 *   will exist after this compaction, including the ones the summarizer
 *   proposes, plus the trailing "current topic" block.
 * - `numberedBlocks` — how many blocks existed *before* the summarizer ran.
 *   `/compact <n>` resolves `n` against that table and locks the picked
 *   identity (requirement §5.6.3), so the markers added by this run cannot
 *   move what the user meant.
 * - `suggestionIndex` — the block the compression rate would keep; this is the
 *   picker's default row and the listener/headless default selection.
 * - `degraded` — `null` on a clean run; otherwise *why* the structured product
 *   could not be used (§5.9.2, §5.9.3). Both causes end in the same product (the
 *   retired one-step whole-section summary), but they are not the same event: a
 *   model that refused the request at all (§5.9.3①) is a different thing to
 *   report than a model that answered twice with an unusable shape (§5.9.3②).
 */
/**
 * Why a run produced no topics (§5.9.2, §5.9.3).
 *
 * - `"refusal"` — the model refused the request or was unavailable, so the old
 *   one-step summary took over before the structured product could be judged
 *   (§5.9.3①). The attempt ladder never completed.
 * - `"format"` — the structured attempt was made and its answer was unusable
 *   (bad JSON, holes, missing sections, or an overflow that the truncated retry
 *   did not rescue), twice (§5.9.2, §5.9.3②).
 *
 * The two produce the same summary text — the retired one-step fallback — so the
 * distinction exists for the receipt and for `topic_report`, not for the
 * write-back.
 */
export type CompactionDegraded = "refusal" | "format";

export interface CompactionPreview {
  conversationId: string;
  agentId: string;
  /**
   * The model the summarizer call ran on (`agent.model` of the frozen agent).
   *
   * The preview is the one product all three `/compact` paths share, and the
   * usage ledger aggregates by model (`aggregateUsageByModel`), so without this
   * a `source:"compaction"` row would land in an empty-model bucket. It is also
   * what the receipt names as "compressed with".
   */
  model: string;
  /** ISO timestamp of the summarizer call, for the receipt. */
  createdAt: string;
  topics: CompactionTopicDraft[];
  overview: CompactionOverview;
  blocks: TopicBlock[];
  numberedBlocks: number;
  suggestionIndex: number;
  usage: CompactUsage;
  degraded: CompactionDegraded | null;
}

/**
 * Where the written-back context starts.
 *
 * A pick is identified by a *message id*, never by a row number: numbers are
 * display-only and are recomputed from the live marker set (requirement §5.6.2,
 * §5.6.4), while the id of the message that stays is stable across the
 * summarizer's own additions. The picker resolves the chosen row to its block's
 * `boundaryMessageId`; `/compact <n>` resolves `n` against the pre-summarizer
 * numbering table and locks the same id (requirement §5.6.3).
 *
 * `ratio_suggestion` is the default selection for the paths without a picker
 * (listener, headless) and for "nothing to choose from": the compression rate
 * decides the cut (requirement §5.12.2).
 */
export type CompactPick =
  | { kind: "message"; messageId: string }
  | { kind: "ratio_suggestion" };

/** Length ceilings the summarizer prompt and §5.9.2 validation share. */
export const COMPACTION_TOPIC_TITLE_MAX_CHARS = 60;
export const COMPACTION_SECTION_MAX_CHARS = 600;

export type CompactionTopicIssueCode =
  | "empty"
  | "missing_title"
  | "title_too_long"
  | "unknown_start_message"
  | "starts_after_first_message"
  | "not_after_previous"
  | "missing_section"
  | "section_too_long";

/** One way the summarizer's topic list failed §5.9.2's structural checks. */
export interface CompactionTopicIssue {
  code: CompactionTopicIssueCode;
  /** `-1` for a list-level problem (an empty list). */
  topicIndex: number;
  detail: string;
}

/**
 * The boundary/structure half of §5.9.2's validation: topics must start at the
 * first input message, name real messages, and advance strictly, with a title
 * and a section inside the length ceilings.
 *
 * An empty issue list means the drafts describe a continuous cover of the input
 * with no holes and no overlaps. The caller (M1's summarizer or the prepare
 * orchestration) turns a non-empty list into a retry and then the
 * `whole-section` degradation.
 */
export function validateCompactionTopics(
  messages: readonly LocalMessage[],
  topics: readonly CompactionTopicDraft[],
): CompactionTopicIssue[] {
  if (messages.length === 0) return [];
  if (topics.length === 0) {
    return [
      {
        code: "empty",
        topicIndex: -1,
        detail: "the summarizer returned no topics",
      },
    ];
  }

  const indexById = new Map(
    messages.map((message, index) => [message.id, index] as const),
  );
  const issues: CompactionTopicIssue[] = [];
  const firstTopic = topics[0];
  if (firstTopic && firstTopic.startMessageId !== messages[0]?.id) {
    issues.push({
      code: "starts_after_first_message",
      topicIndex: 0,
      detail: `the first topic starts at ${firstTopic.startMessageId}, not at the first input message`,
    });
  }

  let previousIndex = -1;
  topics.forEach((topic, topicIndex) => {
    const title = topic.title.trim();
    if (title.length === 0) {
      issues.push({
        code: "missing_title",
        topicIndex,
        detail: "the topic has no title",
      });
    } else if (title.length > COMPACTION_TOPIC_TITLE_MAX_CHARS) {
      issues.push({
        code: "title_too_long",
        topicIndex,
        detail: `the title is ${title.length} characters (limit ${COMPACTION_TOPIC_TITLE_MAX_CHARS})`,
      });
    }
    const section = topic.section.trim();
    if (section.length === 0) {
      issues.push({
        code: "missing_section",
        topicIndex,
        detail: "the topic has no section",
      });
    } else if (section.length > COMPACTION_SECTION_MAX_CHARS) {
      issues.push({
        code: "section_too_long",
        topicIndex,
        detail: `the section is ${section.length} characters (limit ${COMPACTION_SECTION_MAX_CHARS})`,
      });
    }

    const startIndex = indexById.get(topic.startMessageId);
    if (startIndex === undefined) {
      issues.push({
        code: "unknown_start_message",
        topicIndex,
        detail: `startMessageId ${topic.startMessageId} is not an input message`,
      });
      return;
    }
    if (startIndex <= previousIndex) {
      issues.push({
        code: "not_after_previous",
        topicIndex,
        detail: `the topic starts at input position ${startIndex}, not after the previous topic`,
      });
      return;
    }
    previousIndex = startIndex;
  });

  return issues;
}

/**
 * Render the overview the write-back carries: the four fixed restricted
 * sections first, then the free-form story-so-far (requirement §5.4.1–§5.4.2).
 *
 * Empty parts are omitted entirely, headings included: the `whole-section`
 * degradation carries its prose in `narrative` and leaves `restricted` blank,
 * and an empty "## 未决与后续" would look like a section that lost its content.
 */
export function renderCompactionOverview(overview: CompactionOverview): string {
  const restricted: [string, string][] = [
    ["未决与后续", overview.restricted.open],
    ["错误与修正", overview.restricted.errors],
    ["关系与情绪线", overview.restricted.relationship],
    ["记忆文件索引", overview.restricted.memoryIndex],
  ];
  const parts = restricted
    .filter(([, body]) => body.trim().length > 0)
    .map(([heading, body]) => `## ${heading}\n${body.trim()}`);
  const narrative = overview.narrative.trim();
  if (narrative.length > 0) parts.push(`## 故事梗概\n${narrative}`);
  return parts.join("\n\n");
}

/**
 * The text of the one `system_alert` user message a compaction writes back:
 * the new overview, then only the topics this cut folded in (requirement
 * §5.8.1–§5.8.2). Historical sections are never carried — they were already
 * absorbed by an earlier overview.
 */
export function renderCompactionSummary(input: {
  overview: CompactionOverview;
  folded: readonly { title: string; section: string }[];
}): string {
  const parts = [renderCompactionOverview(input.overview)];
  if (input.folded.length > 0) {
    const sections = input.folded.map(
      (topic) => `### ${topic.title.trim()}\n${topic.section.trim()}`,
    );
    parts.push(["## 折叠话题", ...sections].join("\n\n"));
  }
  return parts.join("\n\n");
}

/**
 * Whether the context moved under a preview between `prepare` and `apply`.
 *
 * A preview is computed once and applied later, and nothing serialises the two
 * (the listener holds no lease, and a turn may run while the summarizer works).
 * Every block boundary and every topic start is an anchor into the message list
 * the preview described; an ordinary turn only *appends*, so a missing anchor
 * means the list was rewritten in between — most likely by another compaction.
 *
 * Applying such a preview would write its (older) overview over the newer one
 * and, because the folded topics' ids are gone, silently drop the sections the
 * first fold recorded. Refusing is the only safe answer: the caller reports a
 * no-op and the user retries against the current context.
 */
export function previewStaleness(
  preview: CompactionPreview,
  messages: readonly LocalMessage[],
): "stale_preview" | null {
  const live = new Set(messages.map((message) => message.id));
  const anchored: string[] = [
    ...preview.blocks.map((block) => block.boundaryMessageId),
    ...preview.topics.map((topic) => topic.startMessageId),
  ];
  if (anchored.length === 0) return null;
  return anchored.some((id) => !live.has(id)) ? "stale_preview" : null;
}

/**
 * Merge several cut-point tables into the single table the picker shows.
 *
 * Requirement §5.5.1 makes a summarizer's topic a first-class marker, *equal in
 * weight* to a user's or the agent's own: neither table may erase the other. So
 * the picker's table is the union of every boundary point either table knows,
 * in message order, renumbered from 1 — a boundary is a point, and two points
 * do not conflict.
 *
 * Overlap is resolved by the table, never by refusing the summarizer's answer
 * (requirement §5.5.3 asks the model to respect existing boundaries; it does not
 * ask the host to reject it when the model does not). Where both tables end a
 * block at the same point, the *earlier* table names it: callers pass the
 * pre-existing marker table first, so a boundary someone actually named keeps
 * its title and the summarizer's own title for the same point is not invented
 * over it. A block that only one table ends takes that table's title, which is
 * what splits a summarizer topic that spans a marker into two blocks: the part
 * before the marker is titled by the marker, the part after it by the topic.
 *
 * `compaction`, `messageCount`, `tokens`, `startsAt` and `sparse` are recomputed
 * from the messages themselves: a block created by the merge need not exist in
 * either input table verbatim.
 */
export function mergeCompactionBlocks(
  messages: readonly LocalMessage[],
  tables: readonly (readonly TopicBlock[])[],
): TopicBlock[] {
  const ends = new Set<number>();
  for (const table of tables) {
    for (const block of table) {
      if (block.endIndex > 0) ends.add(block.endIndex);
    }
  }
  const breaks = [...ends].sort((left, right) => left - right);
  const blocks: TopicBlock[] = [];
  let start = 0;

  for (const end of breaks) {
    if (end <= start) continue;
    const slice = messages.slice(start, end);
    const first = slice[0];
    if (!first) break;
    const endings = tables
      .map((table) => table.find((block) => block.endIndex === end))
      .filter((block): block is TopicBlock => block !== undefined);
    // The first table that names this boundary owns it; an unnamed trailing
    // block (the current topic) yields to a table that does name it.
    const primary = endings.find((block) => block.title !== null) ?? endings[0];
    const absorbedTitles: string[] = [];
    for (const ending of endings) {
      for (const title of ending.absorbedTitles) {
        if (!absorbedTitles.includes(title)) absorbedTitles.push(title);
      }
    }
    blocks.push({
      index: blocks.length + 1,
      title: primary?.title ?? null,
      markerId: primary?.markerId ?? null,
      createdBy: primary?.createdBy ?? null,
      ...(primary?.summary === undefined ? {} : { summary: primary.summary }),
      ...(first.metadata?.compaction === undefined ? {} : { compaction: true }),
      anchorMessageId: primary?.anchorMessageId ?? null,
      absorbedTitles,
      boundaryMessageId: first.id,
      startIndex: start,
      endIndex: end,
      rewindTurns: primary?.rewindTurns ?? 0,
      startMarkerAnchorMessageId: primary?.startMarkerAnchorMessageId ?? null,
      messageCount: slice.length,
      tokens: estimateLocalMessagesTokens(slice),
      startsAt: localMessageCreatedAt(first),
      sparse: slice.length <= 1,
    });
    start = end;
  }

  if (start < messages.length) {
    // Nothing in any table ends at the end of the context: the trailing current
    // topic still needs a row, or the picker would hide the newest messages.
    const slice = messages.slice(start);
    const first = slice[0];
    if (first) {
      blocks.push({
        index: blocks.length + 1,
        title: null,
        markerId: null,
        createdBy: null,
        ...(first.metadata?.compaction === undefined
          ? {}
          : { compaction: true }),
        anchorMessageId: null,
        absorbedTitles: [],
        boundaryMessageId: first.id,
        startIndex: start,
        endIndex: messages.length,
        rewindTurns: 0,
        startMarkerAnchorMessageId: null,
        messageCount: slice.length,
        tokens: estimateLocalMessagesTokens(slice),
        startsAt: localMessageCreatedAt(first),
        sparse: slice.length <= 1,
      });
    }
  }

  return blocks;
}

/**
 * The drafts whose start falls inside the summarized region — "刚裁话题".
 * A draft that begins before the cut counts even when the cut lands inside it:
 * its section describes content that just left the context.
 */
export function foldedCompactionTopics(
  messages: readonly LocalMessage[],
  topics: readonly CompactionTopicDraft[],
  startIndex: number,
): CompactionTopicDraft[] {
  return topics.filter((topic) => {
    const index = messages.findIndex(
      (message) => message.id === topic.startMessageId,
    );
    return index >= 0 && index < startIndex;
  });
}

/**
 * Project the summarizer's topics onto the picker's block shape.
 *
 * Unlike a marker-derived block, these boundaries are exact: the summarizer
 * names the first message of each topic, so no rewind applies (`rewindTurns: 0`).
 * The anchoring marker is not written yet, so `markerId` is `null` and
 * `anchorMessageId` names the next topic's first message — the exact point where
 * the write-back will anchor it.
 */
export function topicBlocksFromDrafts(
  messages: readonly LocalMessage[],
  drafts: readonly CompactionTopicDraft[],
): TopicBlock[] {
  const starts = drafts.map((draft) =>
    messages.findIndex((message) => message.id === draft.startMessageId),
  );
  const blocks: TopicBlock[] = [];
  drafts.forEach((draft, position) => {
    const startIndex = starts[position];
    if (startIndex === undefined || startIndex < 0) return;
    const nextStart = starts[position + 1];
    const endIndex =
      nextStart !== undefined && nextStart > startIndex
        ? nextStart
        : messages.length;
    const slice = messages.slice(startIndex, endIndex);
    const first = slice[0];
    if (!first) return;
    blocks.push({
      index: blocks.length + 1,
      title: draft.title,
      markerId: null,
      createdBy: "summarizer",
      summary: draft.section,
      anchorMessageId: drafts[position + 1]?.startMessageId ?? null,
      absorbedTitles: [],
      boundaryMessageId: first.id,
      startIndex,
      endIndex,
      rewindTurns: 0,
      startMarkerAnchorMessageId: null,
      messageCount: slice.length,
      tokens: estimateLocalMessagesTokens(slice),
      startsAt: localMessageCreatedAt(first),
      sparse: slice.length <= 1,
    });
  });
  return blocks;
}
