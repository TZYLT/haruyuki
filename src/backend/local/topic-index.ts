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
 * ## Write strategy: idempotent rebuild, last writer wins
 *
 * There is no lock (route §6.2-8, ruled: atomic write + idempotent rebuild +
 * query-time self-heal). Every write recomputes **one conversation's** entries
 * from its transcript and merges them into the agent file, so two processes
 * writing at once can only lose one of the two rebuilds — never produce a torn
 * file — and the loser is repaired by the next refresh or by a query's drift
 * check. A lock would buy a stronger guarantee at the cost of a stale-lock
 * recovery path on every marker write, to protect a cache that is rebuildable
 * from the transcript at any time.
 *
 * ## Why the query heals instead of trusting the file
 *
 * `messages.jsonl` can change without this module hearing about it: a crashed
 * process after the append, a marker written before the wiring existed, a
 * deleted conversation, a hand-edited index. A query therefore re-stats each
 * conversation the index knows about and rebuilds the ones that drifted.
 *
 * It never *discovers* conversations: a conversation that was not index has no
 * entries by construction, §5.11.6 forbids a background full scan, and the four
 * update points (§5.11.3) are what add a conversation in the first place. The
 * same boundary covers a destroyed file: a missing or unparsable index reads as
 * empty and the query writes nothing, so the repair is the next refresh of each
 * conversation. Nothing is lost by that — `messages.jsonl` holds every marker —
 * it is only deferred to a write.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { getLocalBackendStorageDir } from "@/utils/local-backend-paths";
import { isRecord } from "@/utils/type-guards";
import {
  readJsonFileOrUndefined,
  transcriptMessagesPath,
} from "./local-transcript";
import { readLocalTranscriptTopicEntries } from "./local-transcript-topics";
import { conversationDirectories, tokenize } from "./transcript-search";

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

export const TOPIC_INDEX_VERSION = 1;

/**
 * The transcript's fingerprint at the time a conversation's entries were built.
 *
 * `size` and `mtimeMs` are what `statSync` already returns, so the query-time
 * check never reads a transcript it does not intend to rebuild. `topicCount` is
 * the entry count recorded with the same build; a record whose `entries` no
 * longer agrees with it has been corrupted independently of the transcript, and
 * that is detectable without touching the source file (requirement §5.11.4's
 * third component).
 */
export interface TopicIndexSignature {
  size: number;
  mtimeMs: number;
  topicCount: number;
}

/** One conversation's slice of the agent file. */
export interface TopicIndexConversationRecord {
  conversationId: string;
  /**
   * The conversation's directory name under `conversations/`.
   *
   * Load-bearing: a refresh is handed a conversation **id**, but the transcript
   * lives at `conversations/<key>/messages.jsonl`, and the key is derived from
   * the id by a scheme this module does not own (`LocalStore.conversationKey`).
   * Recording the key the build actually read means the query can stat the
   * transcript straight from the index, without re-reading every
   * `conversation.json`.
   */
  conversationKey: string;
  hidden: boolean;
  signature: TopicIndexSignature;
  /** Oldest first, the transcript's own order. Queries sort; the file does not. */
  entries: TopicIndexEntry[];
}

/** The per-agent index file: `<storageDir>/agents/<agentId>.topics.json`. */
export interface TopicIndexFile {
  version: number;
  agentId: string;
  conversations: Record<string, TopicIndexConversationRecord>;
}

/**
 * Where the index lives — **the single place that decides it**.
 *
 * Route C-26, ruled: `<storageDir>/agents/<agentId>.topics.json`, next to the
 * other per-agent derived state. Requirement §5.11.2 spelled a different tree
 * (`topic-index/<agentId>.json`) and was withdrawn, so a future change lands here
 * and nowhere else in this module.
 */
export function topicIndexPath(storageDir: string, agentId: string): string {
  return join(storageDir, "agents", `${agentId}.topics.json`);
}

function emptyTopicIndexFile(agentId: string): TopicIndexFile {
  return {
    version: TOPIC_INDEX_VERSION,
    agentId,
    conversations: {},
  };
}

function emptyConversations(): Record<string, TopicIndexConversationRecord> {
  return {};
}

function parseSignature(value: unknown): TopicIndexSignature | undefined {
  if (!isRecord(value)) return undefined;
  const { size, mtimeMs, topicCount } = value;
  if (typeof size !== "number" || !Number.isFinite(size)) return undefined;
  if (typeof mtimeMs !== "number" || !Number.isFinite(mtimeMs))
    return undefined;
  if (typeof topicCount !== "number" || !Number.isFinite(topicCount)) {
    return undefined;
  }
  return { size, mtimeMs, topicCount };
}

function parseEntry(value: unknown): TopicIndexEntry | undefined {
  if (!isRecord(value)) return undefined;
  const { conversationId, agentId, topicId, title, createdAt, createdBy } =
    value;
  if (typeof conversationId !== "string") return undefined;
  if (typeof agentId !== "string") return undefined;
  if (typeof topicId !== "string") return undefined;
  if (typeof title !== "string") return undefined;
  if (typeof createdAt !== "string") return undefined;
  if (
    createdBy !== "agent" &&
    createdBy !== "user" &&
    createdBy !== "summarizer"
  ) {
    return undefined;
  }
  if (value.section !== undefined && typeof value.section !== "string") {
    return undefined;
  }
  if (typeof value.hidden !== "boolean") return undefined;
  if (typeof value.evicted !== "boolean") return undefined;
  const anchor = value.anchorMessageId;
  if (anchor !== null && typeof anchor !== "string") return undefined;
  return {
    conversationId,
    agentId,
    topicId,
    title,
    createdAt,
    anchorMessageId: anchor,
    createdBy,
    ...(typeof value.section === "string" ? { section: value.section } : {}),
    hidden: value.hidden,
    evicted: value.evicted,
  };
}

function parseConversationRecord(
  conversationId: string,
  value: unknown,
): TopicIndexConversationRecord | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.conversationKey !== "string") return undefined;
  if (typeof value.hidden !== "boolean") return undefined;
  const signature = parseSignature(value.signature);
  if (!signature) return undefined;
  if (!Array.isArray(value.entries)) return undefined;

  const entries: TopicIndexEntry[] = [];
  for (const raw of value.entries) {
    const entry = parseEntry(raw);
    // A dropped entry leaves `entries.length !== signature.topicCount`, which the
    // query reads as "this record is damaged" and rebuilds. Tolerating the bad
    // entry keeps the rest of the agent's conversations readable in the meantime.
    if (entry) entries.push(entry);
  }

  return {
    conversationId:
      typeof value.conversationId === "string"
        ? value.conversationId
        : conversationId,
    conversationKey: value.conversationKey,
    hidden: value.hidden,
    signature,
    entries,
  };
}

function parseTopicIndexFile(value: unknown): TopicIndexFile | undefined {
  if (!isRecord(value)) return undefined;
  if (value.version !== TOPIC_INDEX_VERSION) return undefined;
  if (typeof value.agentId !== "string") return undefined;
  if (!isRecord(value.conversations)) return undefined;

  const conversations = emptyConversations();
  for (const [conversationId, raw] of Object.entries(value.conversations)) {
    const record = parseConversationRecord(conversationId, raw);
    // Same tolerance as a damaged entry, one level up: one unreadable
    // conversation must not cost the agent the others.
    if (record) conversations[conversationId] = record;
  }
  return {
    version: TOPIC_INDEX_VERSION,
    agentId: value.agentId,
    conversations,
  };
}

/** Reads the agent file. Missing, unreadable, or version-drifted reads as absent. */
function readTopicIndexFile(path: string): TopicIndexFile | undefined {
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  return parseTopicIndexFile(parsed);
}

/**
 * Writes the agent file through a temporary file, so a reader never sees a
 * partial one and a crash mid-write leaves the previous index intact.
 */
function writeTopicIndexFile(path: string, file: TopicIndexFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(file)}\n`, "utf8");
  try {
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary file is already gone; the original error is reported.
    }
    throw error;
  }
}

/** The conversation fields this module needs, read from `conversation.json`. */
interface TopicSourceConversation {
  conversationId: string;
  conversationKey: string;
  conversationDir: string;
  agentId?: string;
  hidden: boolean;
  /**
   * The resident message window, or `undefined` when the record predates the
   * field. `undefined` means "unknown", not "empty": a marker must not read as
   * evicted merely because an old record never wrote the list.
   */
  inContextMessageIds?: readonly string[];
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function readTopicSourceConversation(
  conversationDir: string,
): TopicSourceConversation | undefined {
  const raw = readJsonFileOrUndefined<unknown>(
    join(conversationDir, "conversation.json"),
  );
  if (!isRecord(raw)) return undefined;
  const id = raw.id;
  if (typeof id !== "string" || id.length === 0) return undefined;
  return {
    conversationId: id,
    conversationKey: basename(conversationDir),
    conversationDir,
    ...(typeof raw.agent_id === "string" ? { agentId: raw.agent_id } : {}),
    hidden: raw.hidden === true,
    ...(isStringArray(raw.in_context_message_ids)
      ? { inContextMessageIds: raw.in_context_message_ids }
      : {}),
  };
}

/**
 * Finds one conversation by id; a store-wide walk, so only refresh pays for it.
 *
 * The agent is part of the lookup rather than a filter applied afterwards: every
 * agent has a conversation whose id is `default`, so the id alone is ambiguous
 * and a first-match walk can land on another agent's directory. A record with no
 * `agent_id` is accepted (there is nothing to disagree with), and a match that
 * exists only for another agent is still returned, so the caller classifies it as
 * not-owned instead of silently indexing the wrong transcript.
 */
function findTopicSourceConversation(
  storageDir: string,
  conversationId: string,
  agentId: string,
): TopicSourceConversation | undefined {
  let foreignMatch: TopicSourceConversation | undefined;
  for (const conversationDir of conversationDirectories(storageDir)) {
    const conversation = readTopicSourceConversation(conversationDir);
    if (conversation?.conversationId !== conversationId) continue;
    if (
      conversation.agentId === undefined ||
      conversation.agentId === agentId
    ) {
      return conversation;
    }
    foreignMatch ??= conversation;
  }
  return foreignMatch;
}

function transcriptStat(
  conversationDir: string,
): { size: number; mtimeMs: number } | undefined {
  try {
    const stats = statSync(transcriptMessagesPath(conversationDir));
    return { size: stats.size, mtimeMs: stats.mtimeMs };
  } catch {
    return undefined;
  }
}

function isEvicted(
  anchorMessageId: string | null,
  inContextMessageIds: readonly string[] | undefined,
): boolean {
  if (anchorMessageId === null) return false;
  if (inContextMessageIds === undefined) return false;
  return !inContextMessageIds.includes(anchorMessageId);
}

function toTopicIndexEntry(input: {
  conversation: TopicSourceConversation;
  marker: {
    id: string;
    title: string;
    timestamp: string;
    summary?: string;
    createdBy: "agent" | "user" | "summarizer";
    anchorMessageId: string | null;
  };
  agentId: string;
}): TopicIndexEntry {
  const { conversation, marker } = input;
  const section =
    typeof marker.summary === "string" ? marker.summary.trim() : "";
  return {
    conversationId: conversation.conversationId,
    agentId: input.agentId,
    topicId: marker.id,
    title: marker.title,
    createdAt: marker.timestamp,
    anchorMessageId: marker.anchorMessageId,
    createdBy: marker.createdBy,
    ...(section.length > 0 ? { section } : {}),
    hidden: conversation.hidden,
    evicted: isEvicted(
      marker.anchorMessageId,
      conversation.inContextMessageIds,
    ),
  };
}

/**
 * Rebuilds one conversation's record from its transcript.
 *
 * Returns `undefined` when there is nothing to index: the transcript is gone
 * (the conversation was deleted) or it holds no markers (a conversation that was
 * never marked has no entries, requirement §5.11.6). Both cases mean "remove the
 * record", which is why they share one answer.
 */
function buildConversationRecord(input: {
  conversation: TopicSourceConversation;
  agentId: string;
}): TopicIndexConversationRecord | undefined {
  const stat = transcriptStat(input.conversation.conversationDir);
  if (!stat) return undefined;
  const markers = readLocalTranscriptTopicEntries(
    transcriptMessagesPath(input.conversation.conversationDir),
  );
  if (markers.length === 0) return undefined;
  return {
    conversationId: input.conversation.conversationId,
    conversationKey: input.conversation.conversationKey,
    hidden: input.conversation.hidden,
    signature: { ...stat, topicCount: markers.length },
    entries: markers.map((marker) =>
      toTopicIndexEntry({
        conversation: input.conversation,
        marker,
        agentId: input.agentId,
      }),
    ),
  };
}

/**
 * Bring one conversation's entries up to date with its transcript.
 *
 * Called from the four marker-producing points (user/agent marker, summarizer
 * write-back, fork copy, conversation delete) — not from a background scan:
 * a conversation that was never marked has no entries by construction
 * (requirement §5.11.3, §5.11.6).
 *
 * Finding the transcript costs one walk over `conversations/` because the
 * conversation-key scheme belongs to `LocalStore` and is not part of this
 * module's input. That is a fair price at a marker write (interactive, rare) and
 * would not be at a per-turn one — which is why no turn path calls this.
 */
export function refreshTopicIndexForConversation(
  agentId: string,
  conversationId: string,
  /**
   * The backend instance's storage root, not the ambient default.
   *
   * Route §2.3 froze `(agentId, conversationId)` only, which cannot reach the
   * `LocalBackend` instance state; falling back to `getLocalBackendStorageDir()`
   * would then write the index of a test or alternate-root backend into the
   * real `~/.haruyuki/lc-local-backend`. Call sites inside the backend pass
   * `this.storageDir`; the default exists for the tool path only.
   */
  storageDir: string = getLocalBackendStorageDir(),
): void {
  const path = topicIndexPath(storageDir, agentId);
  const file = readTopicIndexFile(path) ?? emptyTopicIndexFile(agentId);
  const conversation = findTopicSourceConversation(
    storageDir,
    conversationId,
    agentId,
  );
  // A conversation owned by another agent must never land in this agent's file;
  // `undefined` also covers "the conversation is gone", which removes the record.
  const owned =
    conversation !== undefined &&
    (conversation.agentId === undefined || conversation.agentId === agentId)
      ? conversation
      : undefined;
  const record = owned
    ? buildConversationRecord({ conversation: owned, agentId })
    : undefined;

  if (record) {
    file.conversations[conversationId] = record;
  } else if (Object.hasOwn(file.conversations, conversationId)) {
    delete file.conversations[conversationId];
  } else {
    // Nothing to add and nothing to remove: do not create a file just to say so.
    return;
  }
  writeTopicIndexFile(path, file);
}

/**
 * Brings a loaded file back in agreement with the store, without discovering
 * conversations it has never indexed.
 *
 * Three drifts are repaired: a conversation that vanished (its directory is
 * gone, so a delete needs no refresh call to be reflected), a transcript whose
 * `(size, mtime)` no longer matches the signature, and a record whose entries no
 * longer agree with its own `topicCount`. A hidden-flag change touches neither
 * the transcript nor the entry count, so it is patched in place instead of
 * paying for a rebuild.
 */
function healTopicIndexFile(input: {
  file: TopicIndexFile;
  agentId: string;
  storageDir: string;
}): boolean {
  let changed = false;
  const conversationsDir = join(input.storageDir, "conversations");
  const directoryKeys = new Set<string>();
  for (const conversationDir of conversationDirectories(input.storageDir)) {
    directoryKeys.add(basename(conversationDir));
  }

  for (const [conversationId, record] of Object.entries(
    input.file.conversations,
  )) {
    if (!directoryKeys.has(record.conversationKey)) {
      delete input.file.conversations[conversationId];
      changed = true;
      continue;
    }
    const conversationDir = join(conversationsDir, record.conversationKey);
    const conversation = readTopicSourceConversation(conversationDir);
    if (!conversation) {
      // A damaged `conversation.json` is not a deletion: leave the record alone
      // rather than throwing away entries a readable transcript still backs.
      continue;
    }
    if (
      conversation.agentId !== undefined &&
      conversation.agentId !== input.agentId
    ) {
      delete input.file.conversations[conversationId];
      changed = true;
      continue;
    }

    const stat = transcriptStat(conversationDir);
    const drifted =
      !stat ||
      stat.size !== record.signature.size ||
      stat.mtimeMs !== record.signature.mtimeMs ||
      record.entries.length !== record.signature.topicCount;
    if (drifted) {
      const rebuilt = buildConversationRecord({
        conversation,
        agentId: input.agentId,
      });
      if (rebuilt) {
        input.file.conversations[conversationId] = rebuilt;
      } else {
        delete input.file.conversations[conversationId];
      }
      changed = true;
      continue;
    }

    if (record.hidden !== conversation.hidden) {
      record.hidden = conversation.hidden;
      for (const entry of record.entries) entry.hidden = conversation.hidden;
      changed = true;
    }
  }
  return changed;
}

/** Newest first, with a stable tie-break so two runs cannot disagree. */
function sortNewestFirst(a: TopicIndexEntry, b: TopicIndexEntry): number {
  const left = Date.parse(a.createdAt);
  const right = Date.parse(b.createdAt);
  const leftMillis = Number.isFinite(left) ? left : 0;
  const rightMillis = Number.isFinite(right) ? right : 0;
  if (leftMillis !== rightMillis) return rightMillis - leftMillis;
  if (a.conversationId !== b.conversationId) {
    return a.conversationId.localeCompare(b.conversationId);
  }
  return b.topicId.localeCompare(a.topicId);
}

/**
 * The searchable text of one entry: the title and the section, tokenized with
 * the corpus's own tokenizer so a CJK keyword behaves the same here as it does
 * in transcript search (a run is a substring, not a token).
 */
function keywordHaystack(entry: TopicIndexEntry): string {
  return tokenize(`${entry.title} ${entry.section ?? ""}`).join(" ");
}

function matchesKeyword(
  entry: TopicIndexEntry,
  terms: readonly string[],
): boolean {
  if (terms.length === 0) return true;
  const haystack = keywordHaystack(entry);
  return terms.every((term) => haystack.includes(term));
}

function daysCutoff(days: number | undefined): number | undefined {
  if (days === undefined) return undefined;
  if (!Number.isFinite(days) || days <= 0) return undefined;
  return Date.now() - days * 24 * 60 * 60 * 1000;
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
  /** Same reason as `refreshTopicIndexForConversation`; the tool omits it. */
  storageDir?: string;
}): TopicIndexEntry[] {
  const storageDir = input.storageDir ?? getLocalBackendStorageDir();
  const path = topicIndexPath(storageDir, input.agentId);
  const stored = readTopicIndexFile(path);
  // No index yet (never written, destroyed, or unreadable) means nothing is
  // indexed — the query must not go looking. A missing conversation is only
  // discovered by the refresh of that conversation (§5.11.3), which is what keeps
  // this function off the store-wide walk §5.11.6 forbids.
  if (!stored) return [];
  const file = stored;
  if (healTopicIndexFile({ file, agentId: input.agentId, storageDir })) {
    writeTopicIndexFile(path, file);
  }

  const terms = input.keyword ? tokenize(input.keyword) : [];
  const cutoff = daysCutoff(input.days);
  const scopedConversationId = input.conversationId;

  let entries = Object.values(file.conversations).flatMap(
    (record) => record.entries,
  );
  if (scopedConversationId !== undefined) {
    entries = entries.filter(
      (entry) => entry.conversationId === scopedConversationId,
    );
  } else {
    entries = entries.filter((entry) => !entry.hidden);
  }
  if (cutoff !== undefined) {
    entries = entries.filter((entry) => {
      const createdAt = Date.parse(entry.createdAt);
      return Number.isFinite(createdAt) && createdAt >= cutoff;
    });
  }
  entries = entries.filter((entry) => matchesKeyword(entry, terms));
  entries.sort(sortNewestFirst);

  const limit = input.limit;
  if (limit !== undefined && Number.isFinite(limit) && limit > 0) {
    return entries.slice(0, Math.floor(limit));
  }
  return entries;
}
