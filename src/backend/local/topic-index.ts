/**
 * F-04 topic index: a per-agent derived view over the `type:"topic"` rows in
 * each conversation transcript (requirement §5.11).
 *
 * The transcript is the only source of truth. This module owns the derived
 * file, its incremental writes, and the `(mtime, size, topic-row count)` check
 * that rebuilds a conversation's entries when the file disagrees with the
 * transcript (requirement §5.11.4). Deleting the file must lose nothing: every
 * entry can be recomputed from `messages.jsonl`, and the index is not part of
 * an export package and is never read by passive recall (requirement §2.3 #9,
 * §5.11.2, §5.15).
 *
 * M0 freezes the shape and the two entry points (route §2.3); the index
 * milestone owns the bodies — incremental append, the four update points,
 * query-time self-healing, and the write strategy for two processes writing the
 * same agent file. Until then both functions throw, so an early call site is
 * loud instead of silently empty.
 */

/**
 * One indexed topic marker.
 *
 * `topicId` is the marker record's append-only id (the identity), while
 * `anchorMessageId` is where it was written — derived boundaries are recomputed
 * on read and never stored (requirement §5.6.1–§5.6.2). `section` is the
 * topic's short record, present once a compaction has written one.
 */
export interface TopicIndexEntry {
  conversationId: string;
  agentId: string;
  topicId: string;
  title: string;
  /** ISO timestamp of the marker record. */
  createdAt: string;
  anchorMessageId: string | null;
  createdBy: "agent" | "user" | "summarizer";
  section?: string;
  /** The marker belongs to a hidden conversation; queries exclude these by default. */
  hidden: boolean;
  /** The marker's anchor is no longer in the conversation's context. */
  evicted: boolean;
}

/**
 * Bring one conversation's entries up to date with its transcript.
 *
 * Called from the four marker-producing points (user/agent marker, summarizer
 * write-back, fork copy, conversation delete) — not from a background scan:
 * a conversation that was never marked has no entries by construction
 * (requirement §5.11.3, §5.11.6).
 */
export function refreshTopicIndexForConversation(
  agentId: string,
  conversationId: string,
): void {
  void agentId;
  void conversationId;
  throw new Error(
    "topic index: refreshTopicIndexForConversation() lands with the topic-index milestone (M3)",
  );
}

/**
 * Read the index for one agent.
 *
 * Results are newest-first and never filtered by "is this topic still in the
 * context": the model must be able to confirm a marker it just wrote
 * (requirement §5.11.5). `hidden` conversations are excluded unless the caller
 * passes `conversationId`; that is the §5.11.7 default, not a per-call policy.
 */
export function queryTopicIndex(input: {
  agentId: string;
  keyword?: string;
  days?: number;
  conversationId?: string;
  limit?: number;
}): TopicIndexEntry[] {
  void input;
  throw new Error(
    "topic index: queryTopicIndex() lands with the topic-index milestone (M3)",
  );
}
