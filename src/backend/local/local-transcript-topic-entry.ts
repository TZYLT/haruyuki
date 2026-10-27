/**
 * The topic-marker record of a local transcript: its base entry shape, the
 * `createdBy` union, and the guard that admits one row.
 *
 * Split out of `local-transcript.ts` because that module sat 19 lines under the
 * 1,000-line ceiling and F-04's `createdBy: "summarizer"` would have pushed it
 * over (route C-25). The union lives here so the five projections that carry it
 * (`LocalTranscriptTopicEntry`, `LocalTopicMarker`, `TopicBlock`, the rewrite
 * input, and `LocalBackend.markTopic`) share one definition instead of five
 * literals that can drift apart (route C-24).
 */
import { isRecord } from "@/utils/type-guards";

/**
 * Who wrote a marker.
 *
 * `summarizer` is F-04's in-process compaction summarizer. Its markers are
 * ordinary `type:"topic"` rows (requirement §5.5.1) with the same block-cutting
 * weight as the other two, but they never feed the marker nudge or the
 * write-frequency gate — the model must not be able to satisfy its own reminder
 * (requirement §5.5.5).
 */
export type LocalTopicCreatedBy = "agent" | "user" | "summarizer";

/** Fields every transcript session entry carries. */
export interface LocalTranscriptEntryBase {
  id: string;
  parentId: string | null;
  timestamp: string;
}

/**
 * A topic marker: something declares that a topic ended at a single point.
 * Markers are metadata, never context — they record where a topic boundary is,
 * not what the model sees. The effective boundary is derived at read time
 * (rewound a few user turns; see `topic-compaction.ts`), so a marker keeps its
 * original anchor and stays valid if that policy changes.
 *
 * The one exception is a `summarizer` marker: it is anchored at the *first
 * message of the next topic*, which is the exact boundary the summarizer named
 * (`startMessageId`), so its boundary is used verbatim instead of being rewound.
 * Rewinding it would move a boundary the summarizer had already resolved.
 */
export interface LocalTranscriptTopicEntry extends LocalTranscriptEntryBase {
  type: "topic";
  /** Short, searchable noun phrase (≤ 60 chars at the tool boundary). */
  title: string;
  /**
   * Optional prose summary of the topic (≤ 600 chars at the tool boundary).
   * F-04 carries the summarizer's per-topic section here.
   */
  summary?: string;
  createdBy: LocalTopicCreatedBy;
  /** Last in-context message id when the marker was written. */
  anchorMessageId: string | null;
  /** User turns since the previous marker, for sparsity reporting. */
  turnsSincePrevious: number;
}

/**
 * Admit a parsed transcript row as a topic marker. Unknown `createdBy` values are
 * rejected, which is the documented forward-compatibility behaviour: a newer
 * build's marker is skipped by an older one rather than corrupting the context
 * (requirement §7, "旧版本读新数据").
 */
export function isLocalTranscriptTopicEntry(
  value: unknown,
): value is LocalTranscriptTopicEntry {
  return (
    isRecord(value) &&
    value.type === "topic" &&
    typeof value.id === "string" &&
    (value.parentId === null || typeof value.parentId === "string") &&
    typeof value.timestamp === "string" &&
    typeof value.title === "string" &&
    (value.summary === undefined || typeof value.summary === "string") &&
    (value.createdBy === "agent" ||
      value.createdBy === "user" ||
      value.createdBy === "summarizer") &&
    (value.anchorMessageId === null ||
      typeof value.anchorMessageId === "string") &&
    typeof value.turnsSincePrevious === "number"
  );
}
