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
import type { TopicBlock } from "./topic-compaction";

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
 * - `degraded` — `null` on a clean run, `"whole-section"` when the summarizer's
 *   output could not be used and the write-back falls back to one whole-section
 *   summary (requirement §5.9.2).
 */
export interface CompactionPreview {
  conversationId: string;
  agentId: string;
  /** ISO timestamp of the summarizer call, for the receipt. */
  createdAt: string;
  topics: CompactionTopicDraft[];
  overview: CompactionOverview;
  blocks: TopicBlock[];
  numberedBlocks: number;
  suggestionIndex: number;
  usage: CompactUsage;
  degraded: "whole-section" | null;
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
