import { join } from "node:path";
import {
  buildEmbeddingChunkPlan,
  type EmbeddingChunk,
} from "@/backend/local/embedding-chunk";
import { hashEmbeddingText } from "@/backend/local/embedding-format";
import type { EmbeddingSearchHit } from "@/backend/local/embedding-search";
import { searchMemoryFiles } from "@/backend/local/memory-search";
import type { RecallMessageText } from "@/backend/local/recall-index";
import { loadRecallCorpus } from "@/backend/local/recall-index";
import {
  clipInjectionText,
  lineSpanWithinParent,
  memoryVectorExcerpt,
  readRecallMessageTexts,
  transcriptRecallSnippet,
} from "@/backend/local/recall-snippets";
import {
  rankMatches,
  type SearchStopSignal,
} from "@/backend/local/transcript-search";
import type {
  RecallCandidate,
  RecallSourceId,
  RecallSourceOutcome,
  RecallSourcePort,
  RecallSourceStatus,
} from "./recall-port";

/**
 * The two v1 recall sources, wired to the local backend.
 *
 * Each source owns its own scope rules, because the two corpora do not share them.
 * A transcript hit can be excluded by `N` (it is still in the context); a memory
 * hit cannot, since nothing in the memory workspace is "in context" as a message.
 * The index corpus already carries the agent and hidden-conversation filters, so
 * neither is repeated here.
 */

export type RecallSourceInput = {
  storageDir: string;
  /**
   * The active agent's memory workspace.
   *
   * Required, not optional: the only caller always has a path
   * (`getLocalBackendMemoryFilesystemRoot` joins one from the agent id), and a
   * source that is switched off is left out of the list entirely rather than being
   * built and told it has nowhere to look.
   */
  memoryDir: string;
  /** `N`: message ids still in the context, so not recallable. */
  excludedMessageIds: ReadonlySet<string>;
  candidateLimit: number;
  neighbors: number;
  excerptLines: number;
  /**
   * The turn's cooperative time budget. A source that is stopped part-way
   * reports `degraded` instead of `searched`/`empty`, because a truncated scan
   * and a complete one that happened to score nothing mean different things.
   */
  shouldStop?: SearchStopSignal;
};

function outcome(
  source: RecallSourceId,
  candidates: RecallCandidate[],
  reason?: string,
  status?: RecallSourceStatus,
): RecallSourceOutcome {
  return {
    candidates,
    diagnostic: {
      source,
      status: status ?? (candidates.length > 0 ? "searched" : "empty"),
      candidates: candidates.length,
      ...(reason === undefined ? {} : { reason }),
    },
  };
}

function failed(source: RecallSourceId, error: unknown): RecallSourceOutcome {
  return {
    candidates: [],
    diagnostic: {
      source,
      status: "failed",
      candidates: 0,
      reason: error instanceof Error ? error.message : String(error),
    },
  };
}

/**
 * Conversation transcripts.
 *
 * Order matters: `rankMatches` scores against the whole index corpus (document
 * frequencies may never come from a candidate subset), and only then is the result
 * cut to the candidate pool. Reading a transcript is by far the expensive step, so
 * hits are grouped by conversation and each file is read at most once per search.
 */
function transcriptSource(input: RecallSourceInput): RecallSourcePort {
  return {
    id: "transcript",
    arm: "lexical",
    async search(request) {
      try {
        const corpus = loadRecallCorpus(input.storageDir, {
          agentId: request.scope.agentId,
          currentConversationId: request.scope.currentConversationId,
          shouldStop: input.shouldStop,
        });
        const searchable = corpus.records.filter(
          (record) =>
            !(
              record.conversationId === request.scope.currentConversationId &&
              input.excludedMessageIds.has(record.messageId)
            ),
        );
        const ranked = rankMatches(
          searchable,
          {
            terms: [...request.terms.terms],
            phrases: [...request.terms.phrases],
          },
          { shouldStop: input.shouldStop },
        )
          .sort(
            (left, right) =>
              right.score - left.score ||
              left.conversationKey.localeCompare(right.conversationKey) ||
              left.messageId.localeCompare(right.messageId),
          )
          .slice(0, Math.max(0, input.candidateLimit));

        const textsByConversation = new Map<string, RecallMessageText[]>();
        const candidates: RecallCandidate[] = [];
        for (const record of ranked) {
          if (input.shouldStop?.()) break;
          let texts = textsByConversation.get(record.conversationKey);
          if (!texts) {
            texts = readRecallMessageTexts(
              join(input.storageDir, "conversations", record.conversationKey),
            );
            textsByConversation.set(record.conversationKey, texts);
          }
          const snippet = transcriptRecallSnippet({
            messages: texts,
            messageId: record.messageId,
            neighbors: input.neighbors,
          });
          // No snippet means the index and the transcript disagree about this
          // message. Dropping the hit is the safe answer; a wrong snippet is not.
          if (!snippet) continue;
          candidates.push({
            source: "transcript",
            fingerprint: `transcript:${record.conversationKey}:${record.messageId}`,
            file: record.conversationKey,
            conversationKey: record.conversationKey,
            messageId: record.messageId,
            timestamp: snippet.timestamp,
            text: snippet.text,
            score: record.score,
          });
        }

        const unavailable = corpus.unavailable.length;
        const reasons: string[] = [];
        if (unavailable > 0) {
          reasons.push(`${unavailable} conversation(s) had no usable index`);
        }
        const degraded = input.shouldStop?.() === true;
        if (degraded) reasons.push("the recall deadline expired");
        // "No index anywhere in scope" is the source being unable to run, not an
        // empty corpus: nothing was searched. It is the state a fresh install is
        // in, and the only signal `/recall build` is the fix for, so it must not
        // be flattened into "nothing matched".
        const indexless =
          !degraded &&
          candidates.length === 0 &&
          corpus.records.length === 0 &&
          unavailable > 0;
        return outcome(
          "transcript",
          candidates,
          reasons.length > 0 ? reasons.join("; ") : undefined,
          degraded ? "degraded" : indexless ? "unavailable" : undefined,
        );
      } catch (error) {
        return failed("transcript", error);
      }
    },
  };
}

/** The MemFS workspace. Scanned on demand; there is no memory index by design. */
function memorySource(input: RecallSourceInput): RecallSourcePort {
  return {
    id: "memory",
    arm: "lexical",
    async search(request) {
      try {
        const result = searchMemoryFiles(
          input.memoryDir,
          {
            terms: [...request.terms.terms],
            phrases: [...request.terms.phrases],
          },
          {
            excerptLines: input.excerptLines,
            limit: input.candidateLimit,
            shouldStop: input.shouldStop,
          },
        );
        const candidates: RecallCandidate[] = result.entries.map((entry) => ({
          source: "memory" as const,
          // Several paragraphs of one file can match, but the window suppresses the
          // document: re-sending another paragraph of a file the model has already
          // seen most of is what the window exists to prevent.
          fingerprint: `memory:${entry.path}`,
          file: entry.path,
          startLine: entry.startLine,
          endLine: entry.endLine,
          text: entry.text,
          score: entry.score,
        }));
        const degraded = input.shouldStop?.() === true;
        const reasons: string[] = [];
        if (result.stats.skippedFiles > 0) {
          reasons.push(
            `${result.stats.skippedFiles} file(s) were not readable text`,
          );
        }
        if (degraded) reasons.push("the recall deadline expired");
        return outcome(
          "memory",
          candidates,
          reasons.length > 0 ? reasons.join("; ") : undefined,
          degraded ? "degraded" : undefined,
        );
      } catch (error) {
        return failed("memory", error);
      }
    },
  };
}

export function buildRecallSources(
  input: RecallSourceInput,
): RecallSourcePort[] {
  return [transcriptSource(input), memorySource(input)];
}

// ---------------------------------------------------------------------------
// Vector-hit injection mapping (feature 48, package B4)
// ---------------------------------------------------------------------------

/**
 * Characters of the matched parent a vector transcript hit injects (48-1 R-33).
 * The window is centred on the chunk's `focusChar`, so it is the same 300
 * characters no matter which chunk of a long message matched.
 */
export const VECTOR_INJECTION_FOCUS_CHARS = 300;

/**
 * Characters a vector transcript hit may spend on one neighbour: the previous
 * user message, or — when there is none — the next assistant message
 * (48-1 §6.7). The injected text is focus + neighbour, and only the *text* is
 * capped by these two numbers; the role labels are paid out of the hard cap.
 */
export const VECTOR_INJECTION_NEIGHBOR_CHARS = 100;

/** Hard cap for one injected vector entry, transcript or memory (48-1 R-33). */
export const VECTOR_INJECTION_MAX_CHARS = 400;

const VECTOR_ROLE_LABELS = { user: "用户", assistant: "助手" } as const;

/**
 * A vector-arm candidate.
 *
 * `arm` is what lets the service keep the two arms distinct without learning
 * which ports exist; `focusChar`/`chunkIndex` are kept for diagnostics and for
 * E2's display, and are not read by the orchestrator. The rest is exactly
 * {@link RecallCandidate}: `source` stays `transcript|memory`, so the fingerprint
 * is the lexical one and dedup/RRF keys do not change (48-2 §4.3).
 */
export type RecallVectorCandidate = RecallCandidate & {
  arm: "vector";
  /** Original UTF-16 offset of the matched chunk's prose midpoint. */
  focusChar: number;
  /** Parent-local chunk index that produced the hit. */
  chunkIndex: number;
};

/**
 * What the caller hands back for a hit: the parent unit's *current* text.
 *
 * A parent is one transcript message or one memory paragraph, and `text` is the
 * exact text B1 chunked, so replaying the chunker reproduces the stored
 * `textHash`. Memory parents additionally carry the whole document: the title
 * prefix needs the heading above the paragraph, and the reported line numbers
 * have to be file-absolute the way `memory-search` reports them.
 */
export type RecallVectorParent = {
  text: string;
  /** Memory parents only: every line of the source document. */
  lines?: readonly string[];
  /** Memory parents only: 1-based first line of `text` inside `lines`. */
  startLine?: number;
};

/** Reads one parent's current text; `undefined` means it no longer exists. */
export type RecallVectorParentReader = (
  parentId: string,
) => RecallVectorParent | undefined;

/**
 * Re-derives the matched chunk from the parent's current text and checks it
 * against the stored record.
 *
 * The hash is the load-bearing check (48-2 §4.3: “注入前用 `textHash` 校验原文
 * 漂移；失败**丢候选不猜**”). It covers the embedded text, which is what the
 * vector scored; the offsets are checked too because a drift that only moves
 * characters *between* prose runs (an edited fenced code block) leaves the hash
 * intact while making `focusChar` point somewhere else. A candidate whose window
 * cannot be placed exactly is dropped.
 */
export function verifyVectorHitText(
  parentText: string,
  hit: EmbeddingSearchHit,
): boolean {
  return matchVectorChunk(parentText, hit) !== undefined;
}

function matchVectorChunk(
  parentText: string,
  hit: EmbeddingSearchHit,
): EmbeddingChunk | undefined {
  if (parentText.length === 0) return undefined;
  const plan = buildEmbeddingChunkPlan({
    parentId: hit.parentId,
    text: parentText,
  });
  const chunk = plan.chunks.find(
    (entry) => entry.chunkIndex === hit.chunkIndex,
  );
  if (chunk === undefined) return undefined;
  if (
    chunk.startChar !== hit.startChar ||
    chunk.endChar !== hit.endChar ||
    chunk.focusChar !== hit.focusChar
  ) {
    return undefined;
  }
  if (hashEmbeddingText(chunk.text) !== hit.textHash) return undefined;
  return chunk;
}

/**
 * The `focusChars`-wide window of original text centred on `focusChar`.
 *
 * Original text, not the embedded text: fenced code inside the window is
 * injected as-is (48-1 §6.2 item 5: “注入原文保持不变”). The window is shifted
 * rather than shortened at either end, so it always has the full width unless
 * the parent is shorter than that.
 */
export function vectorFocusWindow(
  text: string,
  focusChar: number,
  focusChars: number = VECTOR_INJECTION_FOCUS_CHARS,
): string {
  const max = Number.isFinite(focusChars)
    ? Math.max(1, Math.trunc(focusChars))
    : VECTOR_INJECTION_FOCUS_CHARS;
  if (text.length <= max) return text;
  const focus = Number.isFinite(focusChar)
    ? Math.max(0, Math.min(Math.trunc(focusChar), text.length))
    : 0;
  let start = Math.max(0, focus - Math.floor(max / 2));
  if (start + max > text.length) start = text.length - max;
  let end = start + max;
  // Never start on a low surrogate or end on a high one: the window is cut out
  // of the message verbatim and must stay valid UTF-16.
  const first = text.charCodeAt(start);
  if (start > 0 && first >= 0xdc00 && first <= 0xdfff) start += 1;
  const last = text.charCodeAt(end - 1);
  if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(start, end);
}

type TranscriptNeighbor = {
  role: keyof typeof VECTOR_ROLE_LABELS;
  text: string;
};

/**
 * The neighbour a vector transcript hit injects.
 *
 * Previous user first, then next assistant (48-1 §6.7): the user turn is the
 * question the passage is an answer to, so it is worth more than the following
 * answer when a long message has neighbours on both sides.
 */
function vectorNeighbor(
  messages: readonly RecallMessageText[],
  hitIndex: number,
): TranscriptNeighbor | undefined {
  for (let cursor = hitIndex - 1; cursor >= 0; cursor -= 1) {
    const message = messages[cursor];
    if (message?.role === "user") {
      return { role: "user", text: message.text };
    }
  }
  for (let cursor = hitIndex + 1; cursor < messages.length; cursor += 1) {
    const message = messages[cursor];
    if (message?.role === "assistant") {
      return { role: "assistant", text: message.text };
    }
  }
  return undefined;
}

/** The tail of `value`, used for the previous-user neighbour closest to the hit. */
function clipInjectionTail(value: string, maxCharacters: number): string {
  const max = Math.max(0, Math.trunc(maxCharacters));
  if (value.length <= max) return value;
  let start = value.length - max;
  const first = value.charCodeAt(start);
  if (first >= 0xdc00 && first <= 0xdfff) start += 1;
  return value.slice(start);
}

/**
 * Focus + neighbour, labels included, capped at {@link VECTOR_INJECTION_MAX_CHARS}.
 *
 * The focus block is the hit message's role label plus the 300-character window.
 * Whatever room is left after it pays for the separator, the neighbour's label
 * and the neighbour text — but never more than
 * {@link VECTOR_INJECTION_NEIGHBOR_CHARS}, which is the requirement's own cap on
 * the neighbour (48-1 §6.7, R-33). Without that second cap a short hit message
 * would spend almost the whole 400 on context and nearly none on the passage the
 * vector arm actually matched. A previous user message contributes its *tail*
 * (the part nearest the hit), a next assistant message its head. If the leftover
 * budget cannot hold at least one character, the neighbour is dropped rather
 * than emitted as a dangling label.
 */
function transcriptVectorText(input: {
  parentText: string;
  focusChar: number;
  role: keyof typeof VECTOR_ROLE_LABELS;
  neighbor: TranscriptNeighbor | undefined;
}): string {
  const focusBlock = `${VECTOR_ROLE_LABELS[input.role]}：${vectorFocusWindow(
    input.parentText,
    input.focusChar,
  )}`;
  const focusText = clipInjectionText(focusBlock, VECTOR_INJECTION_MAX_CHARS);
  const neighbor = input.neighbor;
  if (neighbor === undefined) return focusText;
  const separator = "\n\n";
  const neighborLabel = VECTOR_ROLE_LABELS[neighbor.role];
  const room =
    VECTOR_INJECTION_MAX_CHARS -
    focusText.length -
    separator.length -
    neighborLabel.length -
    "：".length;
  const remaining = Math.min(room, VECTOR_INJECTION_NEIGHBOR_CHARS);
  if (remaining < 1) return focusText;
  const neighborText =
    neighbor.role === "user"
      ? clipInjectionTail(neighbor.text, remaining)
      : clipInjectionText(neighbor.text, remaining);
  return `${focusText}${separator}${neighborLabel}：${neighborText}`;
}

/**
 * Maps one B2 transcript hit to an injectable candidate, or drops it.
 *
 * Drops, never guesses: a hit whose parent is gone, whose text drifted, or whose
 * message the transcript no longer has cannot be rendered faithfully, and a
 * wrong injection is worse than a missed recall (48-2 §4.3).
 */
export function buildTranscriptVectorCandidate(input: {
  hit: EmbeddingSearchHit;
  /** The hit conversation's directory key, as the lexical arm reports it. */
  conversationKey: string;
  messages: readonly RecallMessageText[];
  readParent: RecallVectorParentReader;
}): RecallVectorCandidate | undefined {
  const messageIndex = input.messages.findIndex(
    (message) => message.id === input.hit.parentId,
  );
  if (messageIndex === -1) return undefined;
  const parent = input.readParent(input.hit.parentId);
  if (parent === undefined || parent.text.length === 0) return undefined;
  if (!verifyVectorHitText(parent.text, input.hit)) return undefined;
  const message = input.messages[messageIndex];
  if (message === undefined) return undefined;
  return {
    source: "transcript",
    fingerprint: `transcript:${input.conversationKey}:${input.hit.parentId}`,
    file: input.conversationKey,
    conversationKey: input.conversationKey,
    messageId: input.hit.parentId,
    timestamp: message.ts,
    text: transcriptVectorText({
      parentText: parent.text,
      focusChar: input.hit.focusChar,
      role: message.role,
      neighbor: vectorNeighbor(input.messages, messageIndex),
    }),
    score: input.hit.score,
    arm: "vector",
    focusChar: input.hit.focusChar,
    chunkIndex: input.hit.chunkIndex,
  };
}

/**
 * Maps one B2 memory hit to an injectable candidate, or drops it.
 *
 * Memory injection keeps the lexical “best line ± `excerptLines`” window
 * (48-1 §6.2): the hit line comes from the chunk's `focusChar` (48-2 §4.3) and
 * the window is the file's lines, so it matches what the lexical arm reports for
 * the same passage. The title prefix is added on top of that window and counted
 * inside the 400-character budget.
 *
 * The stored `parentLineSpan`, when present, is checked against the current
 * document layout as well: it is what proves the paragraph has not moved, and a
 * shifted hit must not be injected at the old line numbers.
 */
export function buildMemoryVectorCandidate(input: {
  hit: EmbeddingSearchHit;
  /** Workspace-relative memory path; the unit's `fileKey` is derived from it. */
  file: string;
  readParent: RecallVectorParentReader;
  excerptLines?: number;
  includeTitlePrefix?: boolean;
  maxCharacters?: number;
}): RecallVectorCandidate | undefined {
  const parent = input.readParent(input.hit.parentId);
  if (
    parent === undefined ||
    parent.lines === undefined ||
    parent.startLine === undefined
  ) {
    return undefined;
  }
  const chunk = matchVectorChunk(parent.text, input.hit);
  if (chunk === undefined) return undefined;
  const storedSpan = input.hit.parentLineSpan;
  if (storedSpan !== undefined) {
    const expectedSpan = lineSpanWithinParent({
      parentText: parent.text,
      startChar: chunk.startChar,
      endChar: chunk.endChar,
      parentStartLine: parent.startLine,
    });
    if (
      expectedSpan.startLine !== storedSpan.startLine ||
      expectedSpan.endLine !== storedSpan.endLine
    ) {
      return undefined;
    }
  }
  const excerpt = memoryVectorExcerpt({
    path: input.file,
    parentText: parent.text,
    parentStartLine: parent.startLine,
    lines: parent.lines,
    focusChar: input.hit.focusChar,
    ...(input.excerptLines === undefined
      ? {}
      : { excerptLines: input.excerptLines }),
    ...(input.includeTitlePrefix === undefined
      ? {}
      : { includeTitlePrefix: input.includeTitlePrefix }),
    maxCharacters: input.maxCharacters ?? VECTOR_INJECTION_MAX_CHARS,
  });
  return {
    source: "memory",
    fingerprint: `memory:${input.file}`,
    file: input.file,
    startLine: excerpt.startLine,
    endLine: excerpt.endLine,
    text: excerpt.text,
    score: input.hit.score,
    arm: "vector",
    focusChar: input.hit.focusChar,
    chunkIndex: input.hit.chunkIndex,
  };
}

/** Batch form of {@link buildTranscriptVectorCandidate}; order is preserved. */
export function buildTranscriptVectorCandidates(input: {
  hits: readonly EmbeddingSearchHit[];
  conversationKey: string;
  messages: readonly RecallMessageText[];
  readParent: RecallVectorParentReader;
}): RecallVectorCandidate[] {
  const candidates: RecallVectorCandidate[] = [];
  for (const hit of input.hits) {
    const candidate = buildTranscriptVectorCandidate({
      hit,
      conversationKey: input.conversationKey,
      messages: input.messages,
      readParent: input.readParent,
    });
    if (candidate !== undefined) candidates.push(candidate);
  }
  return candidates;
}

/** Batch form of {@link buildMemoryVectorCandidate}; order is preserved. */
export function buildMemoryVectorCandidates(input: {
  hits: readonly EmbeddingSearchHit[];
  file: string;
  readParent: RecallVectorParentReader;
  excerptLines?: number;
  includeTitlePrefix?: boolean;
  maxCharacters?: number;
}): RecallVectorCandidate[] {
  const candidates: RecallVectorCandidate[] = [];
  for (const hit of input.hits) {
    const candidate = buildMemoryVectorCandidate({
      hit,
      file: input.file,
      readParent: input.readParent,
      ...(input.excerptLines === undefined
        ? {}
        : { excerptLines: input.excerptLines }),
      ...(input.includeTitlePrefix === undefined
        ? {}
        : { includeTitlePrefix: input.includeTitlePrefix }),
      ...(input.maxCharacters === undefined
        ? {}
        : { maxCharacters: input.maxCharacters }),
    });
    if (candidate !== undefined) candidates.push(candidate);
  }
  return candidates;
}

/**
 * Reader for transcript parents built from an already-read message list.
 *
 * E2 reads a conversation once per search; this keeps the callback free of
 * repeated file reads and gives the mapper the same texts the chunker saw.
 */
export function createTranscriptVectorParentReader(
  messages: readonly RecallMessageText[],
): RecallVectorParentReader {
  const byId = new Map<string, RecallVectorParent>(
    messages.map((message) => [message.id, { text: message.text }]),
  );
  return (parentId) => byId.get(parentId);
}
