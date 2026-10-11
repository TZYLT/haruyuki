import {
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { isRecord } from "@/utils/type-guards";
import type { LocalMessage } from "./local-message";
import {
  type LocalTranscriptManifest,
  readJsonFileOrUndefined,
  readJsonlFileTolerant,
  transcriptManifestPath,
  transcriptMessagesPath,
} from "./local-transcript";
import type {
  RankableSearchRecord,
  SearchStopSignal,
} from "./transcript-search";
import {
  conversationDirectories,
  conversationSearchRecord,
  type LocalTranscriptMessageFormat,
  textFromContent,
  tokenize,
  transcriptFormat,
  transcriptMessageRows,
} from "./transcript-search";

/**
 * The per-conversation conversation-recall index.
 *
 * This is a derived cache over `messages.jsonl`, never a source of truth: it can
 * be deleted at any time and rebuilt by `/recall build`. It holds only the text
 * the passive-recall feature is allowed to inject — the user and assistant text
 * parts of a message, tokenized at ingest time so a query never pays for reading
 * and tokenizing the raw transcript.
 *
 * Two rules make the cache cheap and correct, and both live here so there is one
 * corpus definition:
 *
 * - The corpus boundary: no thinking, tool calls, tool results, images, no
 *   compaction summary, and no `<system-reminder>` block (an injected reminder
 *   is not something the user said, so it must not come back as a recall hit).
 * - The identity rule: `message.id` is unique only *within* a conversation, and
 *   the same id can be appended again when an assistant message is finalized.
 *   Ingestion therefore upserts on `(conversation directory, message.id)`, which
 *   mirrors the last-wins read side.
 */

export const RECALL_INDEX_VERSION = 1;
export const RECALL_INDEX_FILENAME = "recall-index.json";

export type RecallIndexRole = "user" | "assistant";

export type RecallIndexRecord = {
  /** `message.id`; unique within the conversation, not across conversations. */
  id: string;
  role: RecallIndexRole;
  /** Entry timestamp, falling back to the message metadata creation time. */
  ts: string;
  /** Pre-tokenized text as a space-joined string; `split(" ")` recovers tokens. */
  nt: string;
};

/**
 * A drift *sniffer*, not a source of truth. The lazy check may only stat the
 * transcript, so the signature is the two values `statSync` already returns;
 * computing a line count would mean reading the file and paying exactly the cost
 * this index exists to avoid.
 */
export type RecallSourceSignature = {
  size: number;
  mtimeMs: number;
};

export type RecallIndexSidecar = {
  version: number;
  /** The conversation directory name — the stable key shared with the read side. */
  conversationKey: string;
  conversationId: string;
  agentId: string;
  signature: RecallSourceSignature;
  /** Ingest-time line count, for `/recall status` and repair diagnostics. */
  lineCount: number;
  records: RecallIndexRecord[];
};

export type RecallIndexIdentity = {
  conversationKey: string;
  conversationId: string;
  agentId: string;
};

export type RecallIndexStatus =
  | "ready"
  | "rebuilt"
  | "exempt"
  | "stale"
  | "unavailable";

export type RecallIndexResolution = {
  status: RecallIndexStatus;
  sidecar?: RecallIndexSidecar;
  reason?: string;
};

export type RecallCorpusRecord = RankableSearchRecord & {
  messageId: string;
  conversationKey: string;
  conversationId: string;
  role: RecallIndexRole;
  timestamp: string;
  score: number;
};

export type RecallCorpusProblem = {
  conversationKey: string;
  status: RecallIndexStatus;
  reason?: string;
};

export type RecallCorpusMaintenance = {
  ready: number;
  rebuilt: number;
  exempt: number;
  stale: number;
  unavailable: number;
};

export type RecallCorpus = {
  records: RecallCorpusRecord[];
  conversations: number;
  maintenance: RecallCorpusMaintenance;
  unavailable: RecallCorpusProblem[];
};

export type LoadRecallCorpusOptions = {
  agentId?: string;
  currentConversationId?: string;
  includeHidden?: boolean;
  /** `false` never writes an index; the caller only wants to read or report. */
  maintain?: boolean;
  /**
   * Cooperative time budget (feature ②). Loading walks every conversation
   * directory — a `conversation.json` read, a signature stat, and a sidecar read
   * each — so it is checked once per conversation; a truncated load returns the
   * records it has already collected.
   */
  shouldStop?: SearchStopSignal;
};

const REMINDER_BLOCK = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

/**
 * Removes injected reminder blocks. Only a paired block is removed: text that
 * merely quotes an opening tag (a transcript dump, for example) is left alone.
 */
export function stripReminderBlocks(text: string): string {
  return text.replace(REMINDER_BLOCK, "");
}

export function recallIndexPath(conversationDir: string): string {
  return join(conversationDir, RECALL_INDEX_FILENAME);
}

export function readSourceSignature(
  conversationDir: string,
): RecallSourceSignature | undefined {
  try {
    const stats = statSync(transcriptMessagesPath(conversationDir));
    return { size: stats.size, mtimeMs: stats.mtimeMs };
  } catch {
    return undefined;
  }
}

/** The user/assistant text of one message, with reminder blocks removed. */
function recallRecordText(message: LocalMessage): string {
  return stripReminderBlocks(textFromContent(message.content)).trim();
}

/**
 * One transcript message as the recall corpus sees it — text, not tokens.
 *
 * This is the corpus boundary in its single definition: the index stores a
 * tokenized projection of these rows, and a hit's snippet is a window over the
 * same rows. Two implementations of "what counts as recallable text" would drift,
 * and the drift would show up as an index that disagrees with its own snippets.
 */
export type RecallMessageText = {
  id: string;
  role: RecallIndexRole;
  /** Entry timestamp, falling back to the message metadata creation time. */
  ts: string;
  text: string;
};

/**
 * Every recallable message of a transcript, last-wins per `message.id`.
 *
 * A compaction summary is a stored user message whose text is generated, not
 * said. Compaction keeps every old row, so those messages stay recallable and the
 * summary adds nothing.
 */
export function recallMessageTexts(
  rows: readonly unknown[],
  format: LocalTranscriptMessageFormat | undefined,
): RecallMessageText[] {
  const byId = new Map<string, RecallMessageText>();
  if (!format) return [];
  for (const row of transcriptMessageRows(rows, format)) {
    if (row.entryType === "compaction") continue;
    const role = row.message.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = recallRecordText(row.message);
    if (!text) continue;
    const record: RecallMessageText = {
      id: row.message.id,
      role,
      ts: row.timestamp ?? row.message.metadata?.created_at ?? "",
      text,
    };
    // Delete before set so an upserted record keeps its latest position, the way
    // the transcript read side does.
    if (byId.has(record.id)) byId.delete(record.id);
    byId.set(record.id, record);
  }
  return [...byId.values()];
}

/**
 * Reads one conversation's transcript and produces its sidecar. Pure read: it
 * never writes, and an unreadable or unversioned transcript yields no records
 * rather than throwing.
 *
 * "Unreadable" is why the reads here are the tolerant pair: this runs over every
 * conversation in the store, so a `messages.jsonl` with one interrupted line, or
 * a `conversation.json` half-written by a killed process, must cost that
 * conversation's data and nothing else. A manifest that cannot be parsed reads as
 * absent, which `transcriptFormat` already handles by sniffing the rows.
 */
export function ingestConversation(input: {
  conversationDir: string;
  identity: RecallIndexIdentity;
}): RecallIndexSidecar {
  const rows = readJsonlFileTolerant<unknown>(
    transcriptMessagesPath(input.conversationDir),
  );
  const manifest = readJsonFileOrUndefined<LocalTranscriptManifest>(
    transcriptManifestPath(input.conversationDir),
  );
  const format = transcriptFormat(manifest, rows);
  const records: RecallIndexRecord[] = recallMessageTexts(rows, format).map(
    (entry) => ({
      id: entry.id,
      role: entry.role,
      ts: entry.ts,
      nt: tokenize(entry.text).join(" "),
    }),
  );

  return {
    version: RECALL_INDEX_VERSION,
    conversationKey: input.identity.conversationKey,
    conversationId: input.identity.conversationId,
    agentId: input.identity.agentId,
    signature: readSourceSignature(input.conversationDir) ?? {
      size: 0,
      mtimeMs: 0,
    },
    lineCount: rows.length,
    records,
  };
}

/** Writes the sidecar through a temporary file so a reader never sees a partial one. */
export function writeRecallIndex(
  conversationDir: string,
  sidecar: RecallIndexSidecar,
): void {
  const target = recallIndexPath(conversationDir);
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(sidecar)}\n`, "utf8");
  try {
    renameSync(temporary, target);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary file is already gone; the original error is reported.
    }
    throw error;
  }
}

function parseSidecar(value: unknown): RecallIndexSidecar | undefined {
  if (!isRecord(value)) return undefined;
  if (value.version !== RECALL_INDEX_VERSION) return undefined;
  if (typeof value.conversationKey !== "string") return undefined;
  if (typeof value.conversationId !== "string") return undefined;
  if (typeof value.agentId !== "string") return undefined;
  const signature = value.signature;
  if (!isRecord(signature)) return undefined;
  if (typeof signature.size !== "number") return undefined;
  if (typeof signature.mtimeMs !== "number") return undefined;
  if (!Array.isArray(value.records)) return undefined;

  const records: RecallIndexRecord[] = [];
  for (const entry of value.records) {
    if (!isRecord(entry)) return undefined;
    if (typeof entry.id !== "string" || typeof entry.nt !== "string") {
      return undefined;
    }
    if (entry.role !== "user" && entry.role !== "assistant") return undefined;
    records.push({
      id: entry.id,
      role: entry.role,
      ts: typeof entry.ts === "string" ? entry.ts : "",
      nt: entry.nt,
    });
  }

  return {
    version: RECALL_INDEX_VERSION,
    conversationKey: value.conversationKey,
    conversationId: value.conversationId,
    agentId: value.agentId,
    signature: { size: signature.size, mtimeMs: signature.mtimeMs },
    lineCount: typeof value.lineCount === "number" ? value.lineCount : 0,
    records,
  };
}

export function readRecallIndex(
  conversationDir: string,
): { sidecar: RecallIndexSidecar } | { error: string } {
  let text: string;
  try {
    text = readFileSync(recallIndexPath(conversationDir), "utf8");
  } catch {
    return { error: "recall index is missing" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: "recall index is not valid JSON" };
  }
  const sidecar = parseSidecar(parsed);
  if (!sidecar) return { error: "recall index does not match its schema" };
  return { sidecar };
}

function sameSignature(
  a: RecallSourceSignature,
  b: RecallSourceSignature,
): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/** Ingests and writes unconditionally; used by `/recall build` and lazy rebuilds. */
export function rebuildConversationIndex(input: {
  conversationDir: string;
  identity: RecallIndexIdentity;
}): { sidecar: RecallIndexSidecar } | { error: string } {
  try {
    const sidecar = ingestConversation(input);
    writeRecallIndex(input.conversationDir, sidecar);
    return { sidecar };
  } catch (error) {
    return {
      error:
        error instanceof Error ? error.message : "recall index rebuild failed",
    };
  }
}

/**
 * Returns a usable sidecar for one conversation.
 *
 * A missing or unreadable index is *not* repaired here. The first-use contract
 * is "do not inject this turn, tell the user to run the build command", so
 * absence is reported as `unavailable` and left to the explicit build entry. A
 * signature mismatch is different: that is drift in an index that already
 * exists, and it is re-ingested on the spot.
 *
 * A signature mismatch is never reconciled against the content: the signature is
 * only a sniffer, so a moved transcript is simply re-ingested. The one exception
 * is the conversation the turn is running in. Its newest messages are excluded
 * from recall anyway (they are still in context), so refreshing it once per turn
 * would buy nothing and cost a rebuild every turn.
 */
export function ensureConversationIndex(input: {
  conversationDir: string;
  identity: RecallIndexIdentity;
  currentConversationId?: string;
  maintain?: boolean;
}): RecallIndexResolution {
  const maintain = input.maintain !== false;
  const source = readSourceSignature(input.conversationDir);
  if (!source) {
    return { status: "unavailable", reason: "transcript is missing" };
  }

  const existing = readRecallIndex(input.conversationDir);
  if ("error" in existing) {
    return { status: "unavailable", reason: existing.error };
  }

  if (sameSignature(existing.sidecar.signature, source)) {
    return { status: "ready", sidecar: existing.sidecar };
  }

  const isCurrent =
    input.currentConversationId !== undefined &&
    input.currentConversationId === input.identity.conversationId;
  if (isCurrent) {
    return {
      status: "exempt",
      sidecar: existing.sidecar,
      reason: "current conversation is never refreshed lazily",
    };
  }

  if (!maintain) {
    return {
      status: "stale",
      sidecar: existing.sidecar,
      reason: "maintenance is disabled",
    };
  }

  const rebuilt = rebuildConversationIndex(input);
  if ("error" in rebuilt) {
    return { status: "unavailable", reason: rebuilt.error };
  }
  return { status: "rebuilt", sidecar: rebuilt.sidecar };
}

function emptyMaintenance(): RecallCorpusMaintenance {
  return {
    ready: 0,
    rebuilt: 0,
    exempt: 0,
    stale: 0,
    unavailable: 0,
  };
}

/**
 * Loads the complete index corpus for every conversation in scope, so the caller
 * can score against full-corpus document frequencies. A record is never
 * pre-filtered by the query here; candidates are the scorer's business.
 */
export function loadRecallCorpus(
  storageDir: string,
  options: LoadRecallCorpusOptions = {},
): RecallCorpus {
  const records: RecallCorpusRecord[] = [];
  const maintenance = emptyMaintenance();
  const unavailable: RecallCorpusProblem[] = [];
  let conversations = 0;

  for (const conversationDir of conversationDirectories(storageDir)) {
    // A conversation is the unit of work here: three file touches and, on drift,
    // a full re-ingest. A budget can only be honoured between them.
    if (options.shouldStop?.()) break;
    const conversation = conversationSearchRecord(
      readJsonFileOrUndefined(join(conversationDir, "conversation.json")),
    );
    if (!conversation) continue;
    if (conversation.hidden && options.includeHidden !== true) continue;
    if (options.agentId && conversation.agent_id !== options.agentId) continue;
    // No transcript means nothing to recall; that is not an index problem.
    if (!readSourceSignature(conversationDir)) continue;
    conversations++;

    const conversationKey = basename(conversationDir);
    const resolution = ensureConversationIndex({
      conversationDir,
      identity: {
        conversationKey,
        conversationId: conversation.id,
        agentId: conversation.agent_id,
      },
      currentConversationId: options.currentConversationId,
      maintain: options.maintain,
    });
    maintenance[resolution.status] += 1;

    if (!resolution.sidecar) {
      unavailable.push({
        conversationKey,
        status: resolution.status,
        reason: resolution.reason,
      });
      continue;
    }

    for (const record of resolution.sidecar.records) {
      records.push({
        messageId: record.id,
        conversationKey,
        conversationId: conversation.id,
        role: record.role,
        timestamp: record.ts,
        normalizedText: record.nt,
        tokens: record.nt ? record.nt.split(" ") : [],
        score: 0,
        isSearchEcho: false,
      });
    }
  }

  return { records, conversations, maintenance, unavailable };
}
