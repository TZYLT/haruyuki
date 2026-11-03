/**
 * Deterministic chunking for the vector-recall corpus (feature 48, package B1).
 *
 * This module is the “embedding chunk” layer of the three-level
 * (small-to-big) recall unit: the embedding text is a window of prose packed on
 * sentence boundaries, while recall and injection stay parent-scoped (one
 * transcript message or one memory paragraph). It is a **pure function of the
 * parent text**: no IO, no clock, no RNG, and no model tokenizer, so it can run
 * in the main process and its output can be replayed byte for byte.
 *
 * Contract (docs/48-1 §6.2, docs/48-2 §4.1):
 *
 * - Token estimate is conservative, not exact: CJK ≈ 1 token/char, ASCII ≈ 1/4
 *   char, punctuation ≈ 1/2. It only has to keep a window under the model limit;
 *   an exact tokenizer would drag a worker dependency into a pure module.
 * - Sentences are packed greedily to a 200-token target with a 256-token hard
 *   cap. A sentence is never cut mid-way unless the sentence alone exceeds the
 *   cap, in which case it is hard-cut at the cap and the next chunk repeats the
 *   last 32 tokens as overlap.
 * - Tables and lists are atomic up to the cap. A longer table is split by rows
 *   with its header repeated in every part; a longer list is split between
 *   items, so every item keeps its own key/marker.
 * - JSON and log lines are split by line, never by sentence.
 * - Fenced code never enters the embedding text. Each chunk still records
 *   `spans[]` (prose ranges in the original UTF-16 text), `startChar`/`endChar`
 *   (the original range, code included) and `focusChar` (the original offset of
 *   the chunk's prose midpoint) so B2's records and B4's injection window can map
 *   a hit back to the original message.
 * - A message whose prose is under `minProseChars` **because it is mostly fenced
 *   code** is marked `skipVector` (lexical recall only). A short but natural
 *   message is still chunked: the <6-char rule from 48-1 §6.2 is the recall
 *   side's job, not the chunker's.
 * - At most `maxChunksPerParent` chunks are emitted per parent; the tail is
 *   dropped and reported through `truncatedByCap` + `coverage`.
 *
 * The parent id is supplied by the caller (a message id, or `memory:<path>`),
 * because this module must not know how the corpus is keyed. Splitting the
 * implementation across `embedding-chunk-types.ts` (shapes),
 * `embedding-chunk-tokens.ts` (estimate) and `embedding-chunk-segments.ts`
 * (segmentation + span primitives) keeps every module under the 1,000-line
 * ceiling; this file is the only public surface.
 */

import {
  joinProseSpans,
  mergeSpans,
  overlapTail,
  parseParentText,
  proseOffsetToOriginalOffset,
  type RawUnit,
  spanLength,
  splitAllOversized,
  totalTokens,
  unitsToSpans,
} from "./embedding-chunk-segments";
import { estimateEmbeddingTokens } from "./embedding-chunk-tokens";
import type { EmbeddingTextSpan } from "./embedding-chunk-types";
import {
  EMBEDDING_CHUNK_DEFAULTS,
  type EmbeddingChunk,
  type EmbeddingChunkCoverage,
  type EmbeddingChunkInput,
  type EmbeddingChunkKind,
  type EmbeddingChunkOptions,
  type EmbeddingChunkPlan,
  type EmbeddingChunkSkipReason,
} from "./embedding-chunk-types";

export type {
  EmbeddingChunk,
  EmbeddingChunkCoverage,
  EmbeddingChunkInput,
  EmbeddingChunkKind,
  EmbeddingChunkOptions,
  EmbeddingChunkPlan,
  EmbeddingChunkSkipReason,
  EmbeddingTextSpan,
} from "./embedding-chunk-types";
export { EMBEDDING_CHUNK_DEFAULTS } from "./embedding-chunk-types";
export { estimateEmbeddingTokens, joinProseSpans, proseOffsetToOriginalOffset };

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

type ResolvedOptions = {
  targetTokens: number;
  maxTokens: number;
  overlapTokens: number;
  maxChunksPerParent: number;
  minProseChars: number;
};

function resolveOptions(options: EmbeddingChunkOptions): ResolvedOptions {
  const targetTokens = Math.max(
    1,
    Math.floor(options.targetTokens ?? EMBEDDING_CHUNK_DEFAULTS.targetTokens),
  );
  const maxTokens = Math.max(
    targetTokens,
    Math.floor(options.maxTokens ?? EMBEDDING_CHUNK_DEFAULTS.maxTokens),
  );
  return {
    targetTokens: Math.min(targetTokens, maxTokens),
    maxTokens,
    overlapTokens: Math.max(
      0,
      Math.min(
        Math.floor(
          options.overlapTokens ?? EMBEDDING_CHUNK_DEFAULTS.overlapTokens,
        ),
        maxTokens,
      ),
    ),
    maxChunksPerParent: Math.max(
      1,
      Math.floor(
        options.maxChunksPerParent ??
          EMBEDDING_CHUNK_DEFAULTS.maxChunksPerParent,
      ),
    ),
    minProseChars: Math.max(
      0,
      Math.floor(
        options.minProseChars ?? EMBEDDING_CHUNK_DEFAULTS.minProseChars,
      ),
    ),
  };
}

// ---------------------------------------------------------------------------
// Chunk assembly
// ---------------------------------------------------------------------------

/** Original offset of the prose midpoint, which anchors the injection window. */
function focusOfSpans(
  spans: readonly EmbeddingTextSpan[],
  embeddedLength: number,
): number {
  if (spans.length === 0) return 0;
  const target = Math.floor(embeddedLength / 2);
  let cursor = 0;
  for (const span of spans) {
    const length = span.endChar - span.startChar;
    if (target <= cursor + length) {
      return span.startChar + Math.max(0, target - cursor);
    }
    cursor += length + 1; // separator "\n"
  }
  const last = spans[spans.length - 1];
  return last === undefined ? 0 : last.endChar;
}

function makeChunk(
  parentId: string,
  chunkIndex: number,
  kind: EmbeddingChunkKind,
  units: readonly RawUnit[],
  text: string,
): EmbeddingChunk {
  const spans = unitsToSpans(text, units);
  const chunkText = joinProseSpans(text, spans);
  const first = spans[0];
  const last = spans[spans.length - 1];
  return {
    parentId,
    chunkIndex,
    kind,
    text: chunkText,
    startChar: first === undefined ? 0 : first.startChar,
    endChar: last === undefined ? 0 : last.endChar,
    spans,
    focusChar: focusOfSpans(spans, chunkText.length),
    estimatedTokens: estimateEmbeddingTokens(chunkText),
  };
}

// ---------------------------------------------------------------------------
// Plan builder
// ---------------------------------------------------------------------------

/**
 * Builds the chunk plan for one parent text.
 *
 * The returned `chunks` are ordered, `chunkIndex` is dense, and every chunk's
 * `text` is reproducible from `parentId` + original text alone (deterministic,
 * no clock/RNG). When `skipVector` is true the chunks array is empty and the
 * caller should index the parent lexically only.
 */
export function buildEmbeddingChunkPlan(
  input: EmbeddingChunkInput,
  options: EmbeddingChunkOptions = {},
): EmbeddingChunkPlan {
  const resolved = resolveOptions(options);
  const text = input.text;
  const { segments, codeSpans } = parseParentText(text);

  const allUnits: RawUnit[] = [];
  for (const segment of segments) {
    allUnits.push(...segment.units);
    if (segment.kind === "atomic") allUnits.push(...segment.header);
  }
  const proseChars = spanLength(
    mergeSpans(
      allUnits.map((unit) => ({
        startChar: unit.startChar,
        endChar: unit.endChar,
      })),
    ),
  );
  const recallableChars = text.length;
  const codeChars = spanLength(mergeSpans(codeSpans));

  const skipPlan = (reason: EmbeddingChunkSkipReason): EmbeddingChunkPlan => ({
    parentId: input.parentId,
    chunks: [],
    skipVector: true,
    skipReason: reason,
    coverage: { embeddedChars: 0, recallableChars, ratio: 0 },
    truncatedByCap: false,
  });

  if (allUnits.length === 0) {
    if (text.trim() === "") return skipPlan("empty");
    return skipPlan(codeChars > 0 ? "code-only" : "empty");
  }
  // 48-1 §6.2 / 48-2 §4.1: the <40-char floor is the *code-heavy* message rule
  // ("纯代码消息只走词法"). A short natural message is still embedded; the
  // separate <6-char skip lives on the recall side, not in this pure module.
  if (codeChars > 0 && proseChars < resolved.minProseChars) {
    return skipPlan("prose-too-short");
  }

  const chunks: EmbeddingChunk[] = [];
  const embeddedSpans: EmbeddingTextSpan[] = [];
  let truncatedByCap = false;
  let halted = false;

  const emit = (
    units: readonly RawUnit[],
    kind: EmbeddingChunkKind,
  ): boolean => {
    if (units.length === 0) return true;
    if (chunks.length >= resolved.maxChunksPerParent) {
      truncatedByCap = true;
      halted = true;
      return false;
    }
    const chunk = makeChunk(input.parentId, chunks.length, kind, units, text);
    chunks.push(chunk);
    embeddedSpans.push(...chunk.spans);
    return true;
  };

  const packSequential = (
    units: readonly RawUnit[],
    kind: EmbeddingChunkKind,
    softLimit: number,
  ): boolean => {
    let part: RawUnit[] = [];
    let partTokens = 0;
    for (const unit of units) {
      if (part.length > 0 && partTokens + unit.tokens > softLimit) {
        if (!emit(part, kind)) return false;
        part = [];
        partTokens = 0;
      }
      part.push(unit);
      partTokens += unit.tokens;
    }
    if (part.length > 0 && !emit(part, kind)) return false;
    return true;
  };

  let active: RawUnit[] = [];
  let activeTokens = 0;
  let pendingOverlap: RawUnit[] = [];

  const flushProse = (): void => {
    if (active.length === 0) return;
    const realUnits = active;
    const overlapCount = pendingOverlap.length;
    active = [];
    activeTokens = 0;
    let units: RawUnit[] = [...pendingOverlap, ...realUnits];
    pendingOverlap = [];
    let dropFront = 0;
    let chunk = makeChunk(input.parentId, chunks.length, "prose", units, text);
    while (
      chunk.estimatedTokens > resolved.maxTokens &&
      dropFront < overlapCount
    ) {
      dropFront += 1;
      units = units.slice(dropFront);
      chunk = makeChunk(input.parentId, chunks.length, "prose", units, text);
    }
    if (!emit(units, "prose")) return;
    pendingOverlap = overlapTail(text, realUnits, resolved.overlapTokens);
  };

  const addProseUnit = (unit: RawUnit): void => {
    if (halted) return;
    const nextTokens = activeTokens + unit.tokens;
    const fitsTarget =
      active.length === 0 || nextTokens <= resolved.targetTokens;
    if (!fitsTarget || nextTokens > resolved.maxTokens) {
      flushProse();
      if (halted) return;
    }
    active.push(unit);
    activeTokens += unit.tokens;
  };

  for (const segment of segments) {
    if (halted) break;
    if (segment.kind === "prose") {
      for (const unit of splitAllOversized(
        text,
        segment.units,
        resolved.maxTokens,
      )) {
        addProseUnit(unit);
        if (halted) break;
      }
      continue;
    }

    flushProse();
    pendingOverlap = [];
    if (halted) break;

    if (segment.kind === "lines") {
      const units = splitAllOversized(text, segment.units, resolved.maxTokens);
      if (!packSequential(units, segment.lineKind, resolved.targetTokens)) {
        break;
      }
      continue;
    }

    if (segment.atomicKind === "table") {
      const headerTokens = totalTokens(segment.header);
      const repeatsHeader =
        segment.header.length > 0 && headerTokens < resolved.maxTokens;
      const header = repeatsHeader
        ? splitAllOversized(text, segment.header, resolved.maxTokens)
        : [];
      const headerTotal = totalTokens(header);
      const budget = Math.max(1, resolved.maxTokens - headerTotal);
      const rows = splitAllOversized(text, segment.units, budget);
      if (rows.length === 0) {
        if (!emit(header, "table")) break;
        continue;
      }
      // Atomic up to the cap: the whole table is one chunk when it fits.
      if (headerTotal + totalTokens(rows) <= resolved.maxTokens) {
        if (!emit([...header, ...rows], "table")) break;
        continue;
      }
      const parts: RawUnit[][] = [];
      let part: RawUnit[] = [];
      let partTokens = 0;
      for (const row of rows) {
        if (part.length > 0 && partTokens + row.tokens > budget) {
          parts.push(part);
          part = [];
          partTokens = 0;
        }
        part.push(row);
        partTokens += row.tokens;
      }
      if (part.length > 0) parts.push(part);
      for (const partUnits of parts) {
        if (!emit([...header, ...partUnits], "table")) break;
      }
      continue;
    }

    // A list stays atomic up to the cap; a longer one is split between items so
    // every item keeps its own key/marker (nothing is cut mid-item).
    const items = splitAllOversized(text, segment.units, resolved.maxTokens);
    if (totalTokens(items) <= resolved.maxTokens) {
      if (!emit(items, "list")) break;
      continue;
    }
    if (!packSequential(items, "list", resolved.maxTokens)) break;
  }

  if (!halted) flushProse();

  const embeddedChars = spanLength(mergeSpans(embeddedSpans));
  const coverage: EmbeddingChunkCoverage = {
    embeddedChars,
    recallableChars,
    ratio: recallableChars === 0 ? 0 : embeddedChars / recallableChars,
  };
  return {
    parentId: input.parentId,
    chunks,
    skipVector: false,
    skipReason: undefined,
    coverage,
    truncatedByCap,
  };
}
