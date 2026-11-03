/**
 * Text segmentation for the vector-recall chunker (feature 48, package B1).
 *
 * Turns one parent text into ordered {@link Segment}s (prose sentence runs,
 * atomic table/list blocks, JSON/log line blocks) plus the fenced-code ranges
 * that must never enter the embedding text. Also owns the span helpers that map
 * the embedded prose back onto the original UTF-16 text, and the hard-cut /
 * overlap primitives the planner uses.
 *
 * Pure functions only: no IO, no clock, no tokenizer.
 */

import {
  estimateEmbeddingTokens,
  isWhitespaceCodePoint,
  tokenCostOfCodePoint,
} from "./embedding-chunk-tokens";
import type { EmbeddingTextSpan } from "./embedding-chunk-types";

// ---------------------------------------------------------------------------
// Spans and offsets
// ---------------------------------------------------------------------------

/** Joins the original slices of `spans` with `"\n"` — the embedded-text shape. */
export function joinProseSpans(
  text: string,
  spans: readonly EmbeddingTextSpan[],
): string {
  return spans
    .map((span) => text.slice(span.startChar, span.endChar))
    .join("\n");
}

/**
 * Maps an offset in the joined prose text (see {@link joinProseSpans}) back to
 * an offset in the original text. Separator characters map to the end of the
 * span before them.
 */
export function proseOffsetToOriginalOffset(
  spans: readonly EmbeddingTextSpan[],
  offset: number,
): number {
  if (spans.length === 0) return 0;
  let remaining = Math.max(0, offset);
  for (const span of spans) {
    const length = span.endChar - span.startChar;
    if (remaining <= length) return span.startChar + remaining;
    remaining -= length;
    if (remaining === 0) return span.endChar;
    remaining -= 1; // the "\n" joined between spans
  }
  const last = spans[spans.length - 1];
  return last === undefined ? 0 : last.endChar;
}

// ---------------------------------------------------------------------------
// Source lines, whitespace ranges and fenced code
// ---------------------------------------------------------------------------

type SourceLine = {
  /** Offset of the first character of the line. */
  start: number;
  /** Offset just past the line content (excluding `\r`/`\n`). */
  end: number;
  /** Line content without its line terminators. */
  content: string;
};

function splitSourceLines(text: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf("\n", start);
    const rawEnd = newline === -1 ? text.length : newline;
    const end =
      rawEnd > start && text.charCodeAt(rawEnd - 1) === 13
        ? rawEnd - 1
        : rawEnd;
    lines.push({ start, end, content: text.slice(start, end) });
    if (newline === -1) break;
    start = newline + 1;
  }
  return lines;
}

function isWhitespaceAt(text: string, index: number): boolean {
  return isWhitespaceCodePoint(text.codePointAt(index) ?? 0);
}

export function trimRange(
  text: string,
  startChar: number,
  endChar: number,
): EmbeddingTextSpan {
  let start = startChar;
  let end = endChar;
  while (start < end && isWhitespaceAt(text, start)) start += 1;
  while (end > start && isWhitespaceAt(text, end - 1)) end -= 1;
  return { startChar: start, endChar: end };
}

export function isRangeWhitespace(
  text: string,
  startChar: number,
  endChar: number,
): boolean {
  for (let index = startChar; index < endChar; index += 1) {
    if (!isWhitespaceAt(text, index)) return false;
  }
  return true;
}

type FenceMarker = {
  char: "`" | "~";
  length: number;
};

const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})/u;
const FENCE_CLOSE = /^\s{0,3}(`{3,}|~{3,})\s*$/u;

function fenceOpenMarker(content: string): FenceMarker | undefined {
  const match = FENCE_OPEN.exec(content);
  const marker = match?.[1];
  if (marker === undefined) return undefined;
  return { char: marker.startsWith("~") ? "~" : "`", length: marker.length };
}

function isFenceClose(content: string, open: FenceMarker): boolean {
  const match = FENCE_CLOSE.exec(content);
  const marker = match?.[1];
  if (marker === undefined) return false;
  const char = marker.startsWith("~") ? "~" : "`";
  return char === open.char && marker.length >= open.length;
}

/**
 * Fenced-code ranges, including the fence lines themselves. A fence that is
 * never closed swallows the rest of the parent, which is what a truncated paste
 * should do — the tail is code, not prose.
 */
function codeRanges(
  lines: readonly SourceLine[],
  text: string,
): EmbeddingTextSpan[] {
  const ranges: EmbeddingTextSpan[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) break;
    const open = fenceOpenMarker(line.content);
    if (open === undefined) {
      index += 1;
      continue;
    }
    const startChar = line.start;
    let endChar = text.length;
    let cursor = index + 1;
    let closed = false;
    while (cursor < lines.length) {
      const candidate = lines[cursor];
      if (candidate === undefined) break;
      if (isFenceClose(candidate.content, open)) {
        endChar = candidate.end;
        closed = true;
        cursor += 1;
        break;
      }
      cursor += 1;
    }
    ranges.push({ startChar, endChar });
    index = closed ? cursor : lines.length;
  }
  return ranges;
}

function lineIsRemoved(
  line: SourceLine,
  ranges: readonly EmbeddingTextSpan[],
): boolean {
  for (const range of ranges) {
    if (line.start >= range.startChar && line.start < range.endChar)
      return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Segment classification
// ---------------------------------------------------------------------------

type UnitKind =
  | "sentence"
  | "table-row"
  | "list-item"
  | "json-line"
  | "log-line";

export type RawUnit = {
  text: string;
  startChar: number;
  endChar: number;
  tokens: number;
  kind: UnitKind;
};

export type Segment =
  | { kind: "prose"; units: RawUnit[] }
  | {
      kind: "atomic";
      atomicKind: "table" | "list";
      header: RawUnit[];
      units: RawUnit[];
    }
  | { kind: "lines"; lineKind: "json" | "log"; units: RawUnit[] };

const LIST_ITEM = /^\s{0,3}(?:[-*+]|\d{1,9}[.)])\s+\S/u;
const TABLE_SEPARATOR = /^\|?[\s:|-]*-[\s:|-]*\|?$/u;
const LOG_LINE =
  /^(?:\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?\]?|\d{2}:\d{2}:\d{2}(?:[.,]\d+)?|(?:TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\b)/u;

function isTableRowLine(content: string): boolean {
  const trimmed = content.trim();
  return trimmed.length > 1 && trimmed.startsWith("|") && trimmed.endsWith("|");
}

function isTableSeparatorLine(content: string): boolean {
  const trimmed = content.trim();
  return (
    trimmed.startsWith("|") &&
    trimmed.includes("-") &&
    TABLE_SEPARATOR.test(trimmed)
  );
}

function isListItemLine(content: string): boolean {
  return LIST_ITEM.test(content);
}

function isJsonLine(content: string): boolean {
  const trimmed = content.trim();
  return (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  );
}

function isLogLine(content: string): boolean {
  return LOG_LINE.test(content.trim());
}

function leadingIndent(content: string): number {
  return /^\s*/u.exec(content)?.[0].length ?? 0;
}

function makeUnit(
  text: string,
  startChar: number,
  endChar: number,
  kind: UnitKind,
): RawUnit | undefined {
  const range = trimRange(text, startChar, endChar);
  if (range.startChar >= range.endChar) return undefined;
  const unitText = text.slice(range.startChar, range.endChar);
  return {
    text: unitText,
    startChar: range.startChar,
    endChar: range.endChar,
    tokens: estimateEmbeddingTokens(unitText),
    kind,
  };
}

const CJK_TERMINATORS = new Set(["。", "．", "！", "？", "；", "…"]);
const ASCII_TERMINATORS = new Set([".", "!", "?", ";", "．"]);
const CLOSING_PUNCTUATION = new Set([
  "”",
  "’",
  "」",
  "』",
  "）",
  ")",
  "】",
  "〕",
  "》",
  "〉",
  "]",
  "}",
  '"',
  "'",
]);

/**
 * End offset (exclusive) of the sentence boundary starting at `index`, or
 * `undefined` when the character there does not end a sentence.
 *
 * CJK terminators end a sentence anywhere; ASCII terminators only when followed
 * by whitespace (or end of line), which keeps decimals (`3.14`), paths and
 * abbreviations such as `e.g` in one piece in practice.
 */
function sentenceBoundaryEnd(
  content: string,
  index: number,
): number | undefined {
  const char = content.charAt(index);
  if (char === "") return undefined;
  if (CJK_TERMINATORS.has(char)) {
    let cursor = index + 1;
    while (cursor < content.length) {
      const next = content.charAt(cursor);
      if (CJK_TERMINATORS.has(next) || CLOSING_PUNCTUATION.has(next)) {
        cursor += 1;
      } else {
        break;
      }
    }
    return cursor;
  }
  if (!ASCII_TERMINATORS.has(char)) return undefined;
  let cursor = index + 1;
  while (content.charAt(cursor) === ".") cursor += 1; // "..." is one boundary
  const next = content.charAt(cursor);
  if (next !== "" && !isWhitespaceAt(content, cursor)) {
    return undefined;
  }
  while (cursor < content.length) {
    const closer = content.charAt(cursor);
    if (!CLOSING_PUNCTUATION.has(closer)) break;
    cursor += 1;
  }
  return cursor;
}

function sentenceUnits(lines: readonly SourceLine[], text: string): RawUnit[] {
  const units: RawUnit[] = [];
  for (const line of lines) {
    const content = line.content;
    let sentenceStart = 0;
    let index = 0;
    while (index < content.length) {
      const boundary = sentenceBoundaryEnd(content, index);
      if (boundary === undefined) {
        index += 1;
        continue;
      }
      const unit = makeUnit(
        text,
        line.start + sentenceStart,
        line.start + boundary,
        "sentence",
      );
      if (unit !== undefined) units.push(unit);
      sentenceStart = boundary;
      index = boundary;
    }
    if (sentenceStart < content.length) {
      const unit = makeUnit(
        text,
        line.start + sentenceStart,
        line.start + content.length,
        "sentence",
      );
      if (unit !== undefined) units.push(unit);
    }
  }
  return units;
}

function linesUnit(
  text: string,
  lines: readonly SourceLine[],
  kind: UnitKind,
): RawUnit | undefined {
  const first = lines[0];
  const last = lines[lines.length - 1];
  if (first === undefined || last === undefined) return undefined;
  return makeUnit(text, first.start, last.end, kind);
}

function parseSegments(
  text: string,
  lines: readonly SourceLine[],
  removed: readonly EmbeddingTextSpan[],
): Segment[] {
  const segments: Segment[] = [];
  let proseLines: SourceLine[] = [];
  let index = 0;

  const pushProse = (): void => {
    if (proseLines.length === 0) return;
    const units = sentenceUnits(proseLines, text);
    proseLines = [];
    if (units.length === 0) return;
    const previous = segments[segments.length - 1];
    if (previous !== undefined && previous.kind === "prose") {
      // A fenced code block is not a segment: one window may span it, with the
      // code's original characters staying inside startChar/endChar (48-2 O-24).
      previous.units.push(...units);
      return;
    }
    segments.push({ kind: "prose", units });
  };

  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) break;
    if (lineIsRemoved(line, removed)) {
      index += 1;
      continue;
    }
    if (line.content.trim() === "") {
      index += 1;
      continue;
    }

    if (isTableRowLine(line.content)) {
      pushProse();
      const blockLines: SourceLine[] = [];
      while (index < lines.length) {
        const candidate = lines[index];
        if (
          candidate === undefined ||
          lineIsRemoved(candidate, removed) ||
          candidate.content.trim() === "" ||
          !isTableRowLine(candidate.content)
        ) {
          break;
        }
        blockLines.push(candidate);
        index += 1;
      }
      const firstLine = blockLines[0];
      const secondLine = blockLines[1];
      const headerLineCount =
        firstLine !== undefined &&
        secondLine !== undefined &&
        isTableSeparatorLine(secondLine.content)
          ? 2
          : firstLine === undefined
            ? 0
            : 1;
      const headerLines = blockLines.slice(0, headerLineCount);
      const dataLines = blockLines.slice(headerLineCount);
      const header = headerLines
        .map((headerLine) => linesUnit(text, [headerLine], "table-row"))
        .filter((unit): unit is RawUnit => unit !== undefined);
      const rows = dataLines
        .map((rowLine) => linesUnit(text, [rowLine], "table-row"))
        .filter((unit): unit is RawUnit => unit !== undefined);
      if (header.length > 0 || rows.length > 0) {
        const hasData = rows.length > 0;
        segments.push({
          kind: "atomic",
          atomicKind: "table",
          header: hasData ? header : [],
          units: hasData ? rows : header,
        });
      }
      continue;
    }

    if (isListItemLine(line.content)) {
      pushProse();
      const itemIndent = leadingIndent(line.content);
      const blockLines: SourceLine[] = [line];
      const itemLines: SourceLine[] = [line];
      index += 1;
      while (index < lines.length) {
        const candidate = lines[index];
        if (
          candidate === undefined ||
          lineIsRemoved(candidate, removed) ||
          candidate.content.trim() === ""
        ) {
          break;
        }
        if (
          isListItemLine(candidate.content) &&
          leadingIndent(candidate.content) <= itemIndent
        ) {
          itemLines.push(candidate);
          blockLines.push(candidate);
          index += 1;
          continue;
        }
        if (leadingIndent(candidate.content) > itemIndent) {
          blockLines.push(candidate);
          index += 1;
          continue;
        }
        break;
      }
      const items: RawUnit[] = [];
      for (let itemIndex = 0; itemIndex < itemLines.length; itemIndex += 1) {
        const itemLine = itemLines[itemIndex];
        if (itemLine === undefined) continue;
        const startLineIndex = blockLines.indexOf(itemLine);
        const nextItem = itemLines[itemIndex + 1];
        const endLineIndex =
          nextItem === undefined
            ? blockLines.length
            : blockLines.indexOf(nextItem);
        const slice = blockLines.slice(startLineIndex, endLineIndex);
        const unit = linesUnit(text, slice, "list-item");
        if (unit !== undefined) items.push(unit);
      }
      if (items.length > 0) {
        segments.push({
          kind: "atomic",
          atomicKind: "list",
          header: [],
          units: items,
        });
      }
      continue;
    }

    if (isJsonLine(line.content)) {
      pushProse();
      const units: RawUnit[] = [];
      while (index < lines.length) {
        const candidate = lines[index];
        if (
          candidate === undefined ||
          lineIsRemoved(candidate, removed) ||
          !isJsonLine(candidate.content)
        ) {
          break;
        }
        const unit = linesUnit(text, [candidate], "json-line");
        if (unit !== undefined) units.push(unit);
        index += 1;
      }
      if (units.length > 0) {
        segments.push({ kind: "lines", lineKind: "json", units });
      }
      continue;
    }

    if (isLogLine(line.content)) {
      pushProse();
      const units: RawUnit[] = [];
      while (index < lines.length) {
        const candidate = lines[index];
        if (
          candidate === undefined ||
          lineIsRemoved(candidate, removed) ||
          !isLogLine(candidate.content)
        ) {
          break;
        }
        const unit = linesUnit(text, [candidate], "log-line");
        if (unit !== undefined) units.push(unit);
        index += 1;
      }
      if (units.length > 0) {
        segments.push({ kind: "lines", lineKind: "log", units });
      }
      continue;
    }

    proseLines.push(line);
    index += 1;
  }
  pushProse();
  return segments;
}

export type ParsedParentText = {
  segments: Segment[];
  /** Fenced-code ranges, fence lines included; empty when there is no code. */
  codeSpans: EmbeddingTextSpan[];
};

/** Splits one parent text into segments and the fenced-code ranges to drop. */
export function parseParentText(text: string): ParsedParentText {
  const lines = splitSourceLines(text);
  const codeSpans = codeRanges(lines, text);
  return { segments: parseSegments(text, lines, codeSpans), codeSpans };
}

// ---------------------------------------------------------------------------
// Hard cuts and overlap
// ---------------------------------------------------------------------------

/**
 * Splits a unit whose estimate exceeds `limit` into pieces of at most `limit`
 * tokens. Used for one sentence/row/item that alone is longer than the cap.
 */
export function hardSplitUnit(
  text: string,
  unit: RawUnit,
  limit: number,
): RawUnit[] {
  if (unit.tokens <= limit) return [unit];
  const pieces: RawUnit[] = [];
  let pieceStart = unit.startChar;
  let cursor = unit.startChar;
  let spent = 0;
  while (cursor < unit.endChar) {
    const codePoint = text.codePointAt(cursor) ?? 0;
    const width = codePoint > 0xffff ? 2 : 1;
    const cost = tokenCostOfCodePoint(codePoint);
    if (cursor > pieceStart && spent + cost > limit) {
      const piece = makeUnit(text, pieceStart, cursor, unit.kind);
      if (piece !== undefined) pieces.push(piece);
      pieceStart = cursor;
      spent = 0;
    }
    spent += cost;
    cursor += width;
  }
  const tail = makeUnit(text, pieceStart, unit.endChar, unit.kind);
  if (tail !== undefined) pieces.push(tail);
  return pieces;
}

export function splitAllOversized(
  text: string,
  units: readonly RawUnit[],
  limit: number,
): RawUnit[] {
  const pieces: RawUnit[] = [];
  for (const unit of units) pieces.push(...hardSplitUnit(text, unit, limit));
  return pieces;
}

/** Contiguous tail of `unit` worth at most `budget` tokens, for chunk overlap. */
function tailOfUnit(
  text: string,
  unit: RawUnit,
  budget: number,
): RawUnit | undefined {
  if (budget <= 0) return undefined;
  let cursor = unit.endChar;
  let spent = 0;
  while (cursor > unit.startChar) {
    const previous = text.charCodeAt(cursor - 1);
    const isLowSurrogate = previous >= 0xdc00 && previous <= 0xdfff;
    const width = isLowSurrogate && cursor - 2 >= unit.startChar ? 2 : 1;
    const codePoint = text.codePointAt(cursor - width) ?? 0;
    const cost = tokenCostOfCodePoint(codePoint);
    if (spent + cost > budget) break;
    spent += cost;
    cursor -= width;
  }
  if (cursor >= unit.endChar) return undefined;
  return makeUnit(text, cursor, unit.endChar, unit.kind);
}

/** Last units of `units` worth at most `budget` tokens (contiguous tail). */
export function overlapTail(
  text: string,
  units: readonly RawUnit[],
  budget: number,
): RawUnit[] {
  if (budget <= 0) return [];
  const picked: RawUnit[] = [];
  let spent = 0;
  for (let index = units.length - 1; index >= 0; index -= 1) {
    const unit = units[index];
    if (unit === undefined) break;
    if (spent + unit.tokens <= budget) {
      picked.unshift(unit);
      spent += unit.tokens;
      continue;
    }
    if (picked.length === 0) {
      const tail = tailOfUnit(text, unit, budget);
      if (tail !== undefined) picked.unshift(tail);
    }
    break;
  }
  return picked;
}

// ---------------------------------------------------------------------------
// Span aggregation used by the planner
// ---------------------------------------------------------------------------

export function unitsToSpans(
  text: string,
  units: readonly RawUnit[],
): EmbeddingTextSpan[] {
  const spans: EmbeddingTextSpan[] = [];
  for (const unit of units) {
    const last = spans[spans.length - 1];
    if (
      last !== undefined &&
      unit.startChar >= last.endChar &&
      isRangeWhitespace(text, last.endChar, unit.startChar)
    ) {
      last.endChar = unit.endChar;
      continue;
    }
    spans.push({ startChar: unit.startChar, endChar: unit.endChar });
  }
  return spans;
}

export function mergeSpans(
  spans: readonly EmbeddingTextSpan[],
): EmbeddingTextSpan[] {
  const sorted = [...spans].sort(
    (left, right) => left.startChar - right.startChar,
  );
  const merged: EmbeddingTextSpan[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span.startChar <= last.endChar) {
      last.endChar = Math.max(last.endChar, span.endChar);
      continue;
    }
    merged.push({ startChar: span.startChar, endChar: span.endChar });
  }
  return merged;
}

export function spanLength(spans: readonly EmbeddingTextSpan[]): number {
  let total = 0;
  for (const span of spans) total += span.endChar - span.startChar;
  return total;
}

export function totalTokens(units: readonly RawUnit[]): number {
  let total = 0;
  for (const unit of units) total += unit.tokens;
  return total;
}
