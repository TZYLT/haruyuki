/**
 * Brute-force vector search for the recall index (feature 48, package B2).
 *
 * Phase 1 scans every chunk of a space with a dot product. Vectors are stored
 * L2-normalized (the encoder normalizes before they reach the index), so the
 * dot product *is* cosine similarity and no per-query norm pass is needed. The
 * planned 10× corpus still fits in a linear scan; ANN is phase ③ (B6/B7/A6)
 * and only starts above 200k chunks, at which point this module stays the
 * fallback.
 *
 * Aggregation is **parent-level**: recall and injection are parent units (one
 * transcript message, one memory paragraph), so a parent's score is the best
 * score of its chunks and the hit carries that chunk's `chunkIndex`/`focusChar`
 * for B4's injection window. Returning chunk-level hits would let a single long
 * message occupy several top-k slots and crowd out other parents.
 *
 * The search path never throws: a dimension mismatch between the query and the
 * stored space is a normal condition (model switch mid-session) and returns
 * `unusable`, so the caller falls back to lexical recall.
 *
 * Layer: `backend/local/`. Imports only `embedding-format.ts` types; no `cli/`,
 * `websocket/`, `reminders/` or `agent/` imports.
 */

import type {
  EmbeddingChunkRecord,
  EmbeddingIndexSnapshot,
  EmbeddingParentLineSpan,
} from "./embedding-format";

/** Default number of parent hits a query arm requests (48-2 §4.7: 50). */
export const EMBEDDING_SEARCH_DEFAULT_TOP_K = 50;

/** Why a search could not run. Both cases mean "use lexical recall". */
export type EmbeddingSearchProblem =
  | "dimension-mismatch"
  | "empty-query"
  | "invalid-index";

/** One parent-level hit, with the chunk that produced the score. */
export type EmbeddingSearchHit = {
  parentId: string;
  chunkIndex: number;
  /** Cosine similarity (inner product of normalized vectors). */
  score: number;
  /** Original UTF-16 range of the matched chunk; B4's injection window. */
  startChar: number;
  endChar: number;
  focusChar: number;
  /** Hash of the matched chunk's embedded text; B4 verifies before injecting. */
  textHash: string;
  /** Memory units only. */
  parentLineSpan?: EmbeddingParentLineSpan;
};

export type EmbeddingSearchResult =
  | {
      ok: true;
      hits: EmbeddingSearchHit[];
      /** Chunks actually scored; lets the caller report scan cost. */
      scannedChunks: number;
    }
  | { ok: false; problem: EmbeddingSearchProblem; detail?: string };

export type EmbeddingSearchOptions = {
  /** Maximum parent hits. Defaults to {@link EMBEDDING_SEARCH_DEFAULT_TOP_K}. */
  topK?: number;
  /** Drop hits below this score. Default: no threshold (relative filtering is E1's). */
  minScore?: number;
};

type ParentBest = {
  record: EmbeddingChunkRecord;
  score: number;
};

/**
 * Scores every chunk against `query` and returns the best `topK` parents.
 *
 * Deterministic tie-breaks: a parent keeps its first-encountered chunk at equal
 * score, and parents at equal score sort by `parentId`, so two runs over the
 * same index return the same order.
 */
export function searchEmbeddingIndex(
  snapshot: EmbeddingIndexSnapshot,
  query: ArrayLike<number>,
  options: EmbeddingSearchOptions = {},
): EmbeddingSearchResult {
  const { meta, records, vectors } = snapshot;
  const dimensions = meta.dimensions;
  if (query.length === 0) {
    return {
      ok: false,
      problem: "empty-query",
      detail: "query vector is empty",
    };
  }
  if (query.length !== dimensions) {
    return {
      ok: false,
      problem: "dimension-mismatch",
      detail: `query has ${query.length} dimensions, space has ${dimensions}`,
    };
  }
  if (
    records.length !== meta.chunkCount ||
    vectors.length !== meta.chunkCount * dimensions
  ) {
    return {
      ok: false,
      problem: "invalid-index",
      detail: "record/vector counts disagree with meta",
    };
  }
  if (records.length === 0) {
    return { ok: true, hits: [], scannedChunks: 0 };
  }

  const bestByParent = new Map<string, ParentBest>();
  let scannedChunks = 0;
  for (const record of records) {
    const offset = record.vectorOffset;
    if (!Number.isInteger(offset) || offset < 0 || offset % 4 !== 0) {
      return {
        ok: false,
        problem: "invalid-index",
        detail: `record ${record.chunkIndex} has an invalid vectorOffset`,
      };
    }
    const start = offset / 4;
    let score = 0;
    for (let axis = 0; axis < dimensions; axis += 1) {
      score += (vectors[start + axis] ?? 0) * (query[axis] ?? 0);
    }
    if (!Number.isFinite(score)) {
      return {
        ok: false,
        problem: "invalid-index",
        detail: `record ${record.chunkIndex} produced a non-finite score`,
      };
    }
    scannedChunks += 1;
    const previous = bestByParent.get(record.parentId);
    if (previous === undefined || score > previous.score) {
      bestByParent.set(record.parentId, { record, score });
    }
  }

  const topK = resolveTopK(options.topK);
  const minScore = options.minScore ?? Number.NEGATIVE_INFINITY;
  const hits: EmbeddingSearchHit[] = [];
  for (const { record, score } of bestByParent.values()) {
    if (score < minScore) continue;
    hits.push(hitFromRecord(record, score));
  }
  hits.sort(
    (left, right) =>
      right.score - left.score || left.parentId.localeCompare(right.parentId),
  );
  return { ok: true, hits: hits.slice(0, topK), scannedChunks };
}

function hitFromRecord(
  record: EmbeddingChunkRecord,
  score: number,
): EmbeddingSearchHit {
  return {
    parentId: record.parentId,
    chunkIndex: record.chunkIndex,
    score,
    startChar: record.startChar,
    endChar: record.endChar,
    focusChar: record.focusChar,
    textHash: record.textHash,
    ...(record.parentLineSpan === undefined
      ? {}
      : { parentLineSpan: record.parentLineSpan }),
  };
}

function resolveTopK(topK: number | undefined): number {
  if (topK === undefined) return EMBEDDING_SEARCH_DEFAULT_TOP_K;
  if (!Number.isFinite(topK)) return EMBEDDING_SEARCH_DEFAULT_TOP_K;
  return Math.max(0, Math.floor(topK));
}
