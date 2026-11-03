import type { EmbeddingParentLineSpan } from "./embedding-format";
import {
  type LocalTranscriptManifest,
  readJsonFileOrUndefined,
  readJsonlFileTolerant,
  transcriptManifestPath,
  transcriptMessagesPath,
} from "./local-transcript";
import { type RecallMessageText, recallMessageTexts } from "./recall-index";
import { transcriptFormat } from "./transcript-search";

/**
 * Transcript snippets for recall hits.
 *
 * The recall index stores only a tokenized projection (`nt`), never the text — the
 * requirement fixed the record shape so the sidecar stays ~8% of the transcript.
 * A snippet therefore has to come back out of `messages.jsonl`, and that is the
 * expensive half of an injection: a conversation file is 0.04–2.4 MB.
 *
 * So the split here follows the cost: `readRecallMessageTexts` pays one read and
 * one corpus-boundary pass per conversation, and `transcriptRecallSnippet` is pure,
 * so a turn with several hits in the same conversation reads it exactly once.
 */

export type RecallTranscriptSnippet = {
  /** The matched message. */
  messageId: string;
  timestamp: string;
  /** The hit plus its neighbours, roles labelled, in transcript order. */
  text: string;
  /** Every message id the snippet contains, for rendering and diagnostics. */
  messageIds: string[];
};

/**
 * Every recallable message of a conversation, in transcript order.
 *
 * Reads through the workspace rather than the index: the index is a derived cache
 * and may be stale for the current conversation (which is never refreshed lazily),
 * while a snippet must show what is on disk now. The reads are the tolerant pair:
 * a snippet is a read on the turn path, and a transcript with one interrupted line
 * must still yield every message before it rather than none of them.
 */
export function readRecallMessageTexts(
  conversationDir: string,
): RecallMessageText[] {
  const rows = readJsonlFileTolerant<unknown>(
    transcriptMessagesPath(conversationDir),
  );
  if (rows.length === 0) return [];
  const manifest = readJsonFileOrUndefined<LocalTranscriptManifest>(
    transcriptManifestPath(conversationDir),
  );
  return recallMessageTexts(rows, transcriptFormat(manifest, rows));
}

/**
 * The hit message and `neighbors` messages on each side.
 *
 * A hit whose id is not in `messages` returns `undefined` rather than a fallback:
 * that means the index and the transcript disagree, and inventing a snippet from
 * the wrong message would be worse than dropping the hit.
 */
export function transcriptRecallSnippet(input: {
  messages: readonly RecallMessageText[];
  messageId: string;
  neighbors: number;
}): RecallTranscriptSnippet | undefined {
  const index = input.messages.findIndex(
    (message) => message.id === input.messageId,
  );
  if (index === -1) return undefined;
  const neighbors = Math.max(0, Math.trunc(input.neighbors));
  const window = input.messages.slice(
    Math.max(0, index - neighbors),
    Math.min(input.messages.length, index + neighbors + 1),
  );
  return {
    messageId: input.messageId,
    timestamp: input.messages[index]?.ts ?? "",
    text: window
      .map((message) => `${message.role}: ${message.text}`)
      .join("\n\n"),
    messageIds: window.map((message) => message.id),
  };
}

// ---------------------------------------------------------------------------
// Vector-memory injection (feature 48, package B4)
// ---------------------------------------------------------------------------

/**
 * Separator between the file path and the section title (48-1 §6.2: “文件路径 ›
 * 章节标题”). U+203A rather than `>`, matching the requirement's wording and the
 * way the memory index labels are already rendered.
 */
export const MEMORY_TITLE_SEPARATOR = " › ";

/**
 * The per-entry injection budget for a vector memory hit (48-1 §6.7: 3 entries /
 * single entry ≤400 characters). The title prefix is part of the budget, not
 * extra: the totals are what the context budget was sized for (48-1 R-33).
 *
 * Not read from `RECALL_DEFAULTS.excerptCharacters`: `backend/local/` must not
 * import `reminders/`, so the number is repeated here with its requirement
 * reference. The recall service owns the final `truncateEnd`; a vector excerpt
 * that already fits makes it a no-op (48-2 §4.3).
 */
export const MEMORY_VECTOR_EXCERPT_MAX_CHARS = 400;

/** Lines of context a vector memory excerpt returns on each side of the hit. */
export const MEMORY_VECTOR_EXCERPT_LINES = 2;

/**
 * 0-based line index of `charOffset` inside `text`.
 *
 * UTF-16 offsets are counted the same way the memory paragraph splitter counts
 * lines (``\n``-separated; the reader normalises CRLF first), so a vector chunk's
 * `focusChar` maps onto the same line the lexical retriever would report.
 */
export function lineIndexAtChar(text: string, charOffset: number): number {
  const limit = Number.isFinite(charOffset)
    ? Math.max(0, Math.min(Math.trunc(charOffset), text.length))
    : 0;
  let line = 0;
  for (let index = 0; index < limit; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

/**
 * The file lines a chunk covers, given the chunk's offsets inside its parent
 * paragraph. The span is 1-based inclusive, the shape B2 stores in
 * `parentLineSpan` (48-2 §4.2), and it is used both when writing a memory unit
 * and when verifying a hit before injection.
 */
export function lineSpanWithinParent(input: {
  parentText: string;
  /** Inclusive UTF-16 start offset into `parentText`. */
  startChar: number;
  /** Exclusive UTF-16 end offset into `parentText`. */
  endChar: number;
  /** 1-based line the parent paragraph starts at inside the file. */
  parentStartLine: number;
}): EmbeddingParentLineSpan {
  const startLine =
    input.parentStartLine + lineIndexAtChar(input.parentText, input.startChar);
  const lastChar = Math.max(input.startChar, input.endChar - 1);
  const endLine =
    input.parentStartLine + lineIndexAtChar(input.parentText, lastChar);
  return { startLine, endLine };
}

const MARKDOWN_HEADING = /^#{1,6}[ \t]+(.*?)[ \t]*#*[ \t]*$/;

/**
 * The nearest Markdown heading at or before `line` (1-based), if any.
 *
 * A heading is the only section marker the memory document format has, so the
 * nearest preceding one is the section the hit lives in. Headings *after* the
 * hit are not consulted: that would label a passage with the section that
 * follows it.
 */
export function memorySectionTitle(
  lines: readonly string[],
  line: number,
): string | undefined {
  const ceiling = Math.max(0, Math.min(Math.trunc(line), lines.length));
  for (let index = ceiling - 1; index >= 0; index -= 1) {
    const match = MARKDOWN_HEADING.exec(lines[index] ?? "");
    const title = match?.[1]?.trim();
    if (title) return title;
  }
  return undefined;
}

/**
 * `文件路径 › 章节标题`, or the bare path when the hit has no section heading.
 *
 * The path is the injection's provenance: without it the model cannot tell a
 * memory passage from a transcript one, and cannot cite it.
 */
export function memoryTitlePrefix(
  path: string,
  lines: readonly string[],
  line: number,
): string {
  const section = memorySectionTitle(lines, line);
  return section === undefined
    ? path
    : `${path}${MEMORY_TITLE_SEPARATOR}${section}`;
}

/**
 * Clips `value` to `maxCharacters` without splitting a surrogate pair.
 *
 * Cutting between a high and a low surrogate produces an unpaired code unit,
 * which JSON round-trips as U+FFFD everywhere it is rendered. The budget is a
 * character count, so losing the final code point is the correct trade.
 */
export function clipInjectionText(
  value: string,
  maxCharacters: number,
): string {
  const max = Number.isFinite(maxCharacters)
    ? Math.max(0, Math.trunc(maxCharacters))
    : 0;
  if (value.length <= max) return value;
  let end = max;
  const last = value.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return value.slice(0, end);
}

export type RecallMemoryVectorExcerpt = {
  /** The injectable text, title prefix included and already budgeted. */
  text: string;
  /** 1-based line the window is centred on, in the file. */
  hitLine: number;
  /** 1-based first line of the returned body, inclusive. */
  startLine: number;
  /** 1-based last line of the returned body, inclusive. */
  endLine: number;
  /** Prefix that was emitted; empty when the caller turned it off. */
  titlePrefix: string;
};

/**
 * The injection window for a memory chunk hit: the hit line ±`excerptLines`,
 * plus the `文件路径 › 章节标题` prefix, all inside one 400-character budget.
 *
 * The hit line comes from the chunk's `focusChar` rather than from query terms:
 * a vector hit has no lexical query to score lines with, and 48-2 §4.3 fixes the
 * mapping as “chunk `focusChar` → line offset inside the paragraph → `hitLine`”.
 * `excerptLines` keeps the lexical retriever's meaning (`MEMORY_EXCERPT_LINES`),
 * and the window is clamped against the whole document, as `memory-search`'s
 * `excerptFor` does — a paragraph boundary is a storage unit, not a display
 * boundary.
 *
 * The prefix defaults on (48-1 O-23: “默认加、可关”) and is counted in the
 * budget. When even the prefix does not fit, the prefix is clipped and no body
 * is emitted; a citation without text still beats a block with no provenance.
 */
export function memoryVectorExcerpt(input: {
  /** Workspace-relative path, as reported by `memory-search`. */
  path: string;
  /** Parent paragraph text the chunk plan was built from. */
  parentText: string;
  /** 1-based first line of `parentText` inside `lines`. */
  parentStartLine: number;
  /** Every line of the source document. */
  lines: readonly string[];
  /** UTF-16 offset of the hit inside `parentText`. */
  focusChar: number;
  excerptLines?: number;
  includeTitlePrefix?: boolean;
  maxCharacters?: number;
}): RecallMemoryVectorExcerpt {
  const excerptLines = Math.max(
    0,
    Math.trunc(input.excerptLines ?? MEMORY_VECTOR_EXCERPT_LINES),
  );
  const lineCount = Math.max(1, input.lines.length);
  const parentStartLine = Math.max(
    1,
    Math.min(Math.trunc(input.parentStartLine), lineCount),
  );
  const lineOffset = lineIndexAtChar(input.parentText, input.focusChar);
  const hitLine = Math.max(
    1,
    Math.min(parentStartLine + lineOffset, lineCount),
  );
  const startLine = Math.max(1, hitLine - excerptLines);
  const endLine = Math.min(lineCount, hitLine + excerptLines);
  const body = input.lines.slice(startLine - 1, endLine).join("\n");
  const includeTitlePrefix = input.includeTitlePrefix !== false;
  const titlePrefix = includeTitlePrefix
    ? memoryTitlePrefix(input.path, input.lines, hitLine)
    : "";
  const maxCharacters = input.maxCharacters ?? MEMORY_VECTOR_EXCERPT_MAX_CHARS;
  const text =
    titlePrefix.length === 0
      ? clipInjectionText(body, maxCharacters)
      : fitPrefixAndBody(titlePrefix, body, maxCharacters);
  return { text, hitLine, startLine, endLine, titlePrefix };
}

function fitPrefixAndBody(
  prefix: string,
  body: string,
  maxCharacters: number,
): string {
  const max = Number.isFinite(maxCharacters)
    ? Math.max(1, Math.trunc(maxCharacters))
    : MEMORY_VECTOR_EXCERPT_MAX_CHARS;
  const separator = "\n";
  const available = max - prefix.length - separator.length;
  if (available <= 0) return clipInjectionText(prefix, max);
  return `${prefix}${separator}${clipInjectionText(body, available)}`;
}
