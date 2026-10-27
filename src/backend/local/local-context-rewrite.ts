/**
 * The writes that rewrite a conversation's in-context list — replacing history
 * with a summary, and appending topic markers.
 *
 * `LocalStore` owns the resident window, the transcript files, and the message
 * index. This module owns the *order* those are touched in, which is the part
 * that is easy to get wrong: a rewrite must publish the transcript row, the
 * in-context id list, and the resident window together, or a reader can observe
 * a summary that nothing points at. It runs against a narrow port object rather
 * than the store so the sequencing can be read (and later tested) on its own,
 * and because both sliding-window compaction and a user-picked topic trim must
 * share exactly one write path.
 */
import { appendFileSync } from "node:fs";
import type { LocalCompactionStats } from "./compaction";
import type { LocalMessage } from "./local-message";
import { cloneLocalMessage } from "./local-message-projection";
import { timestampFromIso } from "./local-transcript";
import type {
  LocalTopicCreatedBy,
  LocalTranscriptTopicEntry,
} from "./local-transcript-topic-entry";
import { readLocalTranscriptTopicEntries } from "./local-transcript-topics";
import type {
  LocalConversationContextManagement,
  StoredConversation,
} from "./local-types";
import {
  type LocalTopicMarker,
  userTurnsSinceLastTopicMarker,
} from "./topic-compaction";

export interface LocalCompactionStoreResult {
  numMessagesBefore: number;
  numMessagesAfter: number;
  summaryMessage: LocalMessage;
  /**
   * Append-only ids of the topic markers written in the same call, in order.
   *
   * Returned rather than pre-computed by the caller because the rewrite allocates
   * them: the ids are needed inside `stats` (which is serialised into the
   * `compaction` row) *and* as the `compaction` row's own predecessor chain, and
   * only the module that writes the transcript can promise both are the same
   * entries.
   */
  topicEntryIds: string[];
  /**
   * The stats the `compaction` row actually recorded.
   *
   * Returned for the same reason as the ids: this call fills in
   * `folded_topic_ids`, so a caller holding only its own input stats would report
   * a different record to the user than the transcript holds.
   */
  stats?: LocalCompactionWriteStats;
}

/**
 * The compaction audit numbers plus F-04's folded-topic list.
 *
 * The list rides inside `stats` because that is the only place the transcript's
 * compaction row serialises audit data (`details.stats`) without changing the
 * store's row writer; `trim.summarized_titles` already carries text there for
 * the same reason.
 */
export interface LocalCompactionWriteStats extends LocalCompactionStats {
  /**
   * Append-only ids of the topic markers this compaction folded in.
   *
   * This is audit data, not a metric: it rides inside `stats` because the
   * transcript row's writer (`appendConversationSessionCompactionEntry` in
   * `local-store.ts`) copies this whole object into `details.stats`, so a sibling
   * `details` field would mean editing that pinned 3356-line file. Do not drop it
   * as "stats should only be numbers" — `trim.summarized_titles` lives here for
   * the same reason.
   */
  folded_topic_ids?: string[];
}

/**
 * One topic marker to write as part of a fold.
 *
 * Same fields as {@link LocalTopicMarkerAppendInput} minus the conversation (the
 * rewrite already owns it) and plus nothing: the point of the type is that these
 * travel *with* the rewrite, so the boundary map and the fold cannot be written
 * in two orders.
 */
export interface LocalTopicMarkerDraft {
  title: string;
  summary?: string;
  createdBy: LocalTopicCreatedBy;
  anchorMessageId: string | null;
}

export interface LocalConversationRewriteInput {
  conversationId: string;
  agentId: string;
  /** Raw summary text recorded on the summary message's compaction metadata. */
  summary: string;
  /** Packed summary content the model will read. */
  packedSummary: string;
  stats?: LocalCompactionWriteStats;
  /** Messages kept after the summary, in order. */
  remainingMessages?: LocalMessage[];
  /**
   * Topic markers for the topics this fold covers, written in the same call.
   *
   * Ordering is the whole reason they are here (§5.8.3, audit T-5): written
   * after the fold, a crash leaves a summary with no topic records; written by a
   * separate earlier call, a failed rewrite leaves a boundary map for a fold that
   * never happened. One call, markers first, `compaction` row second: a crash
   * between them can only leave markers whose boundaries are still in the
   * context, which is a truthful state rather than a lost one.
   */
  topicMarkers?: readonly LocalTopicMarkerDraft[];
}

export interface LocalTopicMarkerAppendInput {
  conversationId: string;
  agentId: string;
  title: string;
  summary?: string;
  createdBy: LocalTopicCreatedBy;
  /**
   * Boundary point to record instead of the newest in-context message. F-04's
   * summarizer names a topic's first message, i.e. the exact boundary between
   * two topics, so it cannot use the "newest message" default.
   */
  anchorMessageId?: string | null;
}

export interface LocalTopicMarkerAppendResult {
  marker: LocalTopicMarker;
  /** Transcript entry id, for receipts and follow-up lookups. */
  entryId: string;
  /** User turns since the previous marker, as of this write. */
  turnsSincePrevious: number;
  /** In-context messages at write time (`0` means there was no anchor). */
  contextMessageCount: number;
}

/** Transcript persistence options shared with `LocalStore`. */
export interface LocalTranscriptPersistOptions {
  transcript?: "append" | "append-compaction" | "rewrite" | "skip";
  message?: LocalMessage;
  compaction?: {
    summaryMessage: LocalMessage;
    summary: string;
    firstKeptMessageId?: string;
    previousMessages?: readonly LocalMessage[];
    stats?: LocalCompactionWriteStats;
  };
}

/**
 * Everything the rewrite path needs from the store. Each member maps to one
 * store responsibility so the sequencing below stays readable.
 */
export interface LocalContextRewritePorts {
  ensureConversation(
    conversationId: string,
    agentId: string,
  ): StoredConversation;
  conversationKey(conversationId: string, agentId: string): string;
  /** `undefined` for an in-memory store with no transcript to write. */
  conversationMessagesPath(key: string): string | undefined;
  /** Load (and validate) the resident window before it is replaced. */
  ensureResidentMessages(conversationId: string, agentId: string): void;
  inContextMessages(
    conversationId: string,
    agentId: string,
  ): readonly LocalMessage[];
  validateUnreadTranscriptHead(key: string): void;
  nextLocalMessageId(): string;
  currentLocalMessageDate(): string;
  setResidentMessages(key: string, messages: LocalMessage[]): void;
  saveConversation(key: string, conversation: StoredConversation): void;
  persistConversation(
    conversationId: string,
    agentId: string,
    options: LocalTranscriptPersistOptions,
  ): void;
  rebuildMessageIndex(): void;
  now(): string;
  ensureTranscriptHeader(
    conversation: StoredConversation,
    messagesPath: string,
  ): void;
  nextSessionEntryId(key: string): string;
  lastSessionEntryId(key: string): string | null;
  recordSessionEntryId(key: string, entryId: string): void;
}

export class LocalContextRewrites {
  constructor(private readonly ports: LocalContextRewritePorts) {}

  /**
   * The conversation's small context-management state (§2.2). A damaged or
   * unknown shape reads as "nothing recorded": the flag only ever gates a
   * reminder, so refusing to guess is enough.
   */
  readContextManagement(
    conversationId: string,
    agentId: string,
  ): LocalConversationContextManagement {
    const conversation = this.ports.ensureConversation(conversationId, agentId);
    return normalizeContextManagement(conversation.context_management);
  }

  /**
   * Record whether the no-marker nudge has gone out for the current streak.
   *
   * This is the only conversation-level write in this module: it touches
   * neither the context nor the transcript (`transcript: "skip"`), because the
   * flag is bookkeeping, not conversation content. Writing the same value again
   * is a no-op, so a reader can call it on every turn.
   *
   * It edits its own key rather than replacing the object: `context_management`
   * now holds feature ②'s dedup window too, and a wholesale replace would silently
   * delete a sibling key (and its window) every time the nudge settled.
   */
  setTopicNudgeSent(
    conversationId: string,
    agentId: string,
    sent: boolean,
  ): void {
    const conversation = this.ports.ensureConversation(conversationId, agentId);
    const current = normalizeContextManagement(conversation.context_management);
    if ((current.nudge_sent_for_streak === true) === sent) return;

    if (sent) {
      current.nudge_sent_for_streak = true;
    } else {
      delete current.nudge_sent_for_streak;
    }
    this.persistContextManagement(conversation, agentId, current);
  }

  /**
   * Feature ②'s dedup window: recall fingerprint -> the user turn it went out on.
   *
   * Read-only; `settleRecallDedup` on the backend is the write path.
   */
  readRecallInjectedTurns(
    conversationId: string,
    agentId: string,
  ): Record<string, number> {
    const conversation = this.ports.ensureConversation(conversationId, agentId);
    return {
      ...normalizeContextManagement(conversation.context_management)
        .recall_injected_turns,
    };
  }

  /** Replaces the dedup window; an empty window clears the key. */
  setRecallInjectedTurns(
    conversationId: string,
    agentId: string,
    turns: Record<string, number>,
  ): void {
    const conversation = this.ports.ensureConversation(conversationId, agentId);
    const current = normalizeContextManagement(conversation.context_management);
    const next = { ...current };
    if (Object.keys(turns).length === 0) {
      delete next.recall_injected_turns;
    } else {
      next.recall_injected_turns = { ...turns };
    }
    if (contextManagementKey(current) === contextManagementKey(next)) return;
    this.persistContextManagement(conversation, agentId, next);
  }

  /**
   * The one write for conversation-level bookkeeping: no transcript, no context,
   * no message index — and an empty object removes the key entirely rather than
   * leaving `{}` behind on a conversation that never used either field.
   */
  private persistContextManagement(
    conversation: StoredConversation,
    agentId: string,
    next: LocalConversationContextManagement,
  ): void {
    if (Object.keys(next).length === 0) {
      delete conversation.context_management;
    } else {
      conversation.context_management = next;
    }
    const key = this.ports.conversationKey(conversation.id, agentId);
    this.ports.saveConversation(key, conversation);
    this.ports.persistConversation(conversation.id, agentId, {
      transcript: "skip",
    });
  }

  /**
   * Every topic marker in the conversation transcript, oldest first.
   *
   * Reads the transcript file rather than the resident window on purpose: a
   * trim keeps every marker, so a marker can sit far before the window. Callers
   * are user commands and trim execution, never the per-turn request path.
   * Damaged rows are skipped.
   */
  readTopicMarkers(
    conversationId: string,
    agentId: string,
  ): LocalTopicMarker[] {
    const conversation = this.ports.ensureConversation(conversationId, agentId);
    const messagesPath = this.ports.conversationMessagesPath(
      this.ports.conversationKey(conversation.id, agentId),
    );
    if (!messagesPath) return [];
    return readLocalTranscriptTopicEntries(messagesPath).map((entry) => ({
      id: entry.id,
      title: entry.title,
      createdBy: entry.createdBy,
      anchorMessageId: entry.anchorMessageId,
      createdAt: entry.timestamp,
      ...(entry.summary === undefined ? {} : { summary: entry.summary }),
    }));
  }

  /**
   * Append a topic marker to the transcript. Markers are metadata: the context,
   * the in-context id list, and the message index are untouched, so a marker
   * never disturbs the frozen request prefix.
   *
   * The anchor defaults to the newest in-context message at write time. An empty
   * context yields a `null` anchor (and `contextMessageCount: 0`), which callers
   * treat as "cannot mark here". A caller that already knows the exact boundary
   * passes `anchorMessageId` instead (F-04's summarizer).
   */
  appendTopicMarker(
    input: LocalTopicMarkerAppendInput,
  ): LocalTopicMarkerAppendResult {
    const conversation = this.ports.ensureConversation(
      input.conversationId,
      input.agentId,
    );
    const key = this.ports.conversationKey(conversation.id, input.agentId);
    const messagesPath = this.ports.conversationMessagesPath(key);
    if (!messagesPath) {
      throw new Error(
        "Topic markers need a local storage directory to append to a transcript.",
      );
    }
    const messages = this.ports.inContextMessages(
      conversation.id,
      input.agentId,
    );
    const existing = this.readTopicMarkers(conversation.id, input.agentId);
    const entry = this.buildTopicEntry({
      key,
      messages,
      existing,
      title: input.title,
      ...(input.summary === undefined ? {} : { summary: input.summary }),
      createdBy: input.createdBy,
      anchorMessageId:
        input.anchorMessageId === undefined
          ? (messages.at(-1)?.id ?? null)
          : input.anchorMessageId,
      explicitAnchor: input.anchorMessageId !== undefined,
    });
    this.appendTopicEntry(conversation, key, messagesPath, entry);
    const marker: LocalTopicMarker = {
      id: entry.id,
      title: entry.title,
      createdBy: entry.createdBy,
      anchorMessageId: entry.anchorMessageId,
      createdAt: entry.timestamp,
      ...(entry.summary === undefined ? {} : { summary: entry.summary }),
    };
    return {
      marker,
      entryId: entry.id,
      turnsSincePrevious: entry.turnsSincePrevious,
      contextMessageCount: messages.length,
    };
  }

  /**
   * Build one `topic` transcript row without writing it.
   *
   * Shared by the standalone `/topic` mark and by a fold's markers so the two
   * cannot disagree about how `turnsSincePrevious` is counted — the number a
   * frequency gate reads, and one that would otherwise be copied.
   *
   * `explicitAnchor` distinguishes "the caller named the boundary" from "the
   * anchor defaulted to the newest message": only the latter counts turns across
   * the whole context instead of up to the boundary.
   */
  private buildTopicEntry(input: {
    key: string;
    messages: readonly LocalMessage[];
    existing: readonly LocalTopicMarker[];
    title: string;
    summary?: string;
    createdBy: LocalTopicCreatedBy;
    anchorMessageId: string | null;
    explicitAnchor: boolean;
  }): LocalTranscriptTopicEntry {
    const anchorIndex =
      input.anchorMessageId === null
        ? -1
        : input.messages.findIndex(
            (message) => message.id === input.anchorMessageId,
          );
    const turnsSincePrevious =
      anchorIndex < 0 || !input.explicitAnchor
        ? userTurnsSinceLastTopicMarker(input.messages, input.existing)
        : userTurnsSinceLastTopicMarker(
            input.messages.slice(0, anchorIndex + 1),
            input.existing,
          );
    return {
      type: "topic",
      id: this.ports.nextSessionEntryId(input.key),
      parentId: this.ports.lastSessionEntryId(input.key),
      timestamp: this.ports.now(),
      title: input.title,
      ...(input.summary === undefined ? {} : { summary: input.summary }),
      createdBy: input.createdBy,
      anchorMessageId: input.anchorMessageId,
      turnsSincePrevious,
    };
  }

  /**
   * Copy a parent's topic markers into a fork.
   *
   * Messages are cloned with fresh ids, so an inherited marker's anchor has to be
   * remapped onto the child's copy of that message; a marker whose anchor fell
   * outside the forked prefix (a cutoff fork) is dropped rather than left
   * dangling. The child's rows get their own entry chain, so later marking in
   * either conversation stays independent (requirement §6, "会话 fork").
   *
   * Returns how many markers were copied, for tests and telemetry.
   */
  copyTopicMarkersForFork(input: {
    sourceConversationId: string;
    sourceAgentId: string;
    targetConversationId: string;
    targetAgentId: string;
    /** Parent message id -> the child message id holding the same message. */
    anchorIds: ReadonlyMap<string, string>;
  }): number {
    const source = this.ports.ensureConversation(
      input.sourceConversationId,
      input.sourceAgentId,
    );
    const sourcePath = this.ports.conversationMessagesPath(
      this.ports.conversationKey(source.id, input.sourceAgentId),
    );
    if (!sourcePath) return 0;
    const entries = readLocalTranscriptTopicEntries(sourcePath);
    if (entries.length === 0) return 0;

    const target = this.ports.ensureConversation(
      input.targetConversationId,
      input.targetAgentId,
    );
    const key = this.ports.conversationKey(target.id, input.targetAgentId);
    const messagesPath = this.ports.conversationMessagesPath(key);
    if (!messagesPath) return 0;

    let copied = 0;
    for (const entry of entries) {
      const anchor =
        entry.anchorMessageId === null
          ? null
          : (input.anchorIds.get(entry.anchorMessageId) ?? null);
      // The anchor's message is not part of the fork, so the marker describes
      // history the child does not have.
      if (entry.anchorMessageId !== null && anchor === null) continue;
      this.appendTopicEntry(target, key, messagesPath, {
        type: "topic",
        id: this.ports.nextSessionEntryId(key),
        parentId: this.ports.lastSessionEntryId(key),
        timestamp: entry.timestamp,
        title: entry.title,
        ...(entry.summary === undefined ? {} : { summary: entry.summary }),
        createdBy: entry.createdBy,
        anchorMessageId: anchor,
        turnsSincePrevious: entry.turnsSincePrevious,
      });
      copied += 1;
    }
    return copied;
  }

  /**
   * Replace a conversation's in-context list with `[summary, ...remaining]` and
   * append the matching `compaction` entry to the transcript.
   *
   * This is the single write path for "history became a summary": both the
   * sliding-window compaction and a user-picked topic trim go through it, so the
   * transcript, the resident window, and the message index can only be mutated
   * one way.
   */
  rewriteInContext(
    input: LocalConversationRewriteInput,
  ): LocalCompactionStoreResult {
    const conversation = this.ports.ensureConversation(
      input.conversationId,
      input.agentId,
    );
    const key = this.ports.conversationKey(conversation.id, input.agentId);
    // Ensure the resident tail first; validate its unread head pre-rewrite.
    this.ports.ensureResidentMessages(conversation.id, input.agentId);
    this.ports.validateUnreadTranscriptHead(key);
    const previousMessages = this.ports.inContextMessages(
      conversation.id,
      input.agentId,
    );
    const messagesPath = this.ports.conversationMessagesPath(key);
    const drafts = input.topicMarkers ?? [];
    if (drafts.length > 0 && !messagesPath) {
      throw new Error(
        "Topic markers need a local storage directory to append to a transcript.",
      );
    }
    // Markers first, and by this method rather than by an earlier call: the ids
    // are both `stats.folded_topic_ids` (serialised into the row below) and the
    // chain the `compaction` row hangs off. Read the existing markers *before*
    // appending anything, or the turns-since number would count this batch.
    const existingMarkers = this.readTopicMarkers(
      conversation.id,
      input.agentId,
    );
    const topicEntryIds: string[] = [];
    for (const draft of drafts) {
      if (!messagesPath) break;
      const entry = this.buildTopicEntry({
        key,
        messages: previousMessages,
        existing: existingMarkers,
        title: draft.title,
        ...(draft.summary === undefined ? {} : { summary: draft.summary }),
        createdBy: draft.createdBy,
        anchorMessageId: draft.anchorMessageId,
        explicitAnchor: true,
      });
      this.appendTopicEntry(conversation, key, messagesPath, entry);
      topicEntryIds.push(entry.id);
    }
    const stats =
      input.stats === undefined
        ? undefined
        : { ...input.stats, folded_topic_ids: topicEntryIds };
    const date = this.ports.currentLocalMessageDate();
    const summaryMessage: LocalMessage = {
      id: this.ports.nextLocalMessageId(),
      role: "user",
      metadata: {
        created_at: date,
        updated_at: date,
        agent_id: input.agentId,
        conversation_id: conversation.id,
        compaction: {
          summary: input.summary,
          ...(stats ? { stats } : {}),
        },
      },
      content: [{ type: "text", text: input.packedSummary }],
      timestamp: timestampFromIso(date),
    };
    const compactedMessages = [
      summaryMessage,
      ...(input.remainingMessages ?? []).map(cloneLocalMessage),
    ];
    conversation.in_context_message_ids = compactedMessages.map(
      (message) => message.id,
    );
    this.ports.setResidentMessages(key, compactedMessages);
    conversation.last_message_at = date;
    conversation.updated_at = date;
    this.ports.saveConversation(key, conversation);
    this.ports.persistConversation(conversation.id, input.agentId, {
      transcript: "append-compaction",
      compaction: {
        summaryMessage,
        summary: input.summary,
        firstKeptMessageId: input.remainingMessages?.[0]?.id,
        previousMessages,
        ...(stats ? { stats } : {}),
      },
    });
    this.ports.rebuildMessageIndex();
    return {
      numMessagesBefore: previousMessages.length,
      numMessagesAfter: compactedMessages.length,
      summaryMessage: cloneLocalMessage(summaryMessage),
      topicEntryIds,
      ...(stats === undefined ? {} : { stats }),
    };
  }

  /**
   * Append a `topic` row. Unlike message and compaction rows it carries no
   * `message`, so it only joins the entry-id and parent-chain bookkeeping —
   * never the message-id maps or the persisted message snapshots. That is what
   * keeps markers out of every content reader.
   */
  private appendTopicEntry(
    conversation: StoredConversation,
    key: string,
    messagesPath: string,
    entry: LocalTranscriptTopicEntry,
  ): void {
    this.ports.ensureTranscriptHeader(conversation, messagesPath);
    this.ports.validateUnreadTranscriptHead(key);
    appendFileSync(messagesPath, `${JSON.stringify(entry)}\n`);
    this.ports.recordSessionEntryId(key, entry.id);
  }
}

/**
 * Keep the fields this build understands and preserve the ones it does not: a
 * newer build may have written a sibling key, and this one must not delete state it
 * cannot read (L-14). `nudge_sent_for_streak` and the recall dedup window both
 * have an explicit branch here — a field with no branch is carried through
 * unvalidated, so every field this build *writes* needs one.
 *
 * A damaged value reads as "nothing recorded" rather than throwing. Both fields
 * only gate a reminder or a repeat injection, so guessing wrong costs at most one
 * duplicated line, while propagating a shape error would break the turn.
 */
function normalizeContextManagement(
  value: LocalConversationContextManagement | undefined,
): LocalConversationContextManagement {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const normalized = { ...value };
  if (normalized.nudge_sent_for_streak === true) {
    normalized.nudge_sent_for_streak = true;
  } else {
    delete normalized.nudge_sent_for_streak;
  }

  const window: Record<string, number> = {};
  const turns = normalized.recall_injected_turns;
  if (turns && typeof turns === "object" && !Array.isArray(turns)) {
    for (const [fingerprint, turn] of Object.entries(turns)) {
      if (fingerprint.length === 0) continue;
      if (typeof turn !== "number" || !Number.isFinite(turn)) continue;
      window[fingerprint] = turn;
    }
  }
  if (Object.keys(window).length > 0) {
    normalized.recall_injected_turns = window;
  } else {
    delete normalized.recall_injected_turns;
  }
  return normalized;
}

/**
 * Canonical form of the fields this build owns, for the write no-op check. Keys
 * this build does not know are deliberately excluded: both sides of a comparison
 * descend from the same normalized value, so a sibling key is identical by
 * construction and would only add noise.
 */
function contextManagementKey(
  value: LocalConversationContextManagement,
): string {
  return JSON.stringify([
    value.nudge_sent_for_streak === true,
    Object.entries(value.recall_injected_turns ?? {}).sort(),
  ]);
}
