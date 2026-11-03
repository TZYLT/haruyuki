/**
 * int8 vector quantization and float32 rescore (feature 48, package C9).
 *
 * Codes are one signed byte per axis with a per-vector scale of `max|v| / 127`
 * (`0` for a zero vector), so the compact space keeps the direction of an
 * L2-normalized encoder output. `int8 + float32 rescore` keeps the originals:
 * the query scans the codes, then the best `top-50` chunks are re-scored
 * exactly. Without the originals the hits come back with
 * `rescoreUnavailable: true` and are never presented as exact.
 *
 * The on-disk int8 generation lives in `embedding-quant-format.ts`: B2's f32
 * writer/reader reject every other quant, so the int8 encoding owns its own
 * generation while the cache dispatches on `pointer.quant` and never mixes the
 * two encodings. A quant/dimension/model/agent/space mismatch is
 * `expectation-mismatch` → `unusable` → lexical recall.
 *
 * Layer: `backend/local/`. Imports only same-directory B2/B3 modules; no
 * `cli/`, `websocket/`, `reminders/` or `agent/`.
 */

import type {
  EmbeddingChunkRecord,
  EmbeddingIndexMeta,
  EmbeddingIndexProblem,
  EmbeddingIndexQuant,
} from "./embedding-format";
import {
  EMBEDDING_SEARCH_DEFAULT_TOP_K,
  type EmbeddingSearchHit,
  type EmbeddingSearchProblem,
} from "./embedding-search";

/** Largest code magnitude; codes always fit in `[-127, 127]`. */
export const EMBEDDING_QUANT_INT8_MAX = 127;

/** Coarse candidates that get an exact float32 re-computation (48-2 §4.10). */
export const EMBEDDING_QUANT_DEFAULT_RESCORE_CANDIDATES = 50;

/** How a resident int8 generation is read: approximate only, or with rescore. */
export type EmbeddingQuantMode = "int8-only" | "int8-rescore";

/** Why quantization rejected its input. */
export type EmbeddingQuantErrorCode =
  | "invalid-dimensions"
  | "invalid-vector"
  | "invalid-record"
  | "record-vector-mismatch";

/** Thrown when the quantizer gets non-finite or misaligned input. */
export class EmbeddingQuantError extends Error {
  readonly code: EmbeddingQuantErrorCode;
  constructor(code: EmbeddingQuantErrorCode, message: string) {
    super(message);
    this.name = "EmbeddingQuantError";
    this.code = code;
  }
}

/** A batch of row-major signed codes plus one scale per row. */
export type EmbeddingQuantizedVectors = {
  dimensions: number;
  /** `count * dimensions` row-major signed bytes. */
  codes: Int8Array;
  count: number;
  /** One scale per row; `0` marks a zero vector (all codes are `0`). */
  scales: Float32Array;
};

/** One on-disk chunk record of an int8 generation. */
export type EmbeddingQuantChunkRecord = EmbeddingChunkRecord & {
  /** Scale dividing this row's codes back to the approximate vector. */
  vectorScale: number;
};

// ---------------------------------------------------------------------------
// Encode / decode
// ---------------------------------------------------------------------------

/**
 * Quantizes a batch of vectors. Each row owns its scale; a zero vector gets
 * scale `0` and all-zero codes, so it decodes back to zeros instead of `NaN`.
 * Non-finite components are rejected — a NaN that reached the index would
 * poison every later score. `dimensions` defaults to the first vector's width.
 */
export function quantizeEmbeddingVectors(
  vectors: readonly ArrayLike<number>[],
  dimensions?: number,
): EmbeddingQuantizedVectors {
  const width = resolveDimensions(vectors, dimensions);
  const count = vectors.length;
  const codes = new Int8Array(count * width);
  const scales = new Float32Array(count);
  for (let row = 0; row < count; row += 1) {
    const vector = vectors[row];
    if (vector === undefined || vector.length !== width) {
      throw new EmbeddingQuantError(
        "invalid-vector",
        `vector ${row} has length ${vector?.length ?? 0}, expected ${width}`,
      );
    }
    let maxAbs = 0;
    for (let axis = 0; axis < width; axis += 1) {
      const value = vector[axis] ?? 0;
      if (!Number.isFinite(value)) {
        throw new EmbeddingQuantError(
          "invalid-vector",
          `vector ${row} axis ${axis} is not finite`,
        );
      }
      const magnitude = Math.abs(value);
      if (magnitude > maxAbs) maxAbs = magnitude;
    }
    const scale = maxAbs / EMBEDDING_QUANT_INT8_MAX;
    scales[row] = scale;
    if (scale === 0) continue;
    const offset = row * width;
    for (let axis = 0; axis < width; axis += 1) {
      const value = (vector[axis] ?? 0) / scale;
      codes[offset + axis] = Math.max(
        -EMBEDDING_QUANT_INT8_MAX,
        Math.min(EMBEDDING_QUANT_INT8_MAX, Math.round(value)),
      );
    }
  }
  return { dimensions: width, count, codes, scales };
}

/** Quantizes one vector; scale `0` for the all-zero vector. */
export function quantizeEmbeddingVector(
  vector: ArrayLike<number>,
  dimensions?: number,
): { codes: Int8Array; scale: number } {
  const batch = quantizeEmbeddingVectors([vector], dimensions);
  return { codes: batch.codes, scale: batch.scales[0] ?? 0 };
}

/** Reconstructs one row of float32 values from its codes and scale. */
export function dequantizeEmbeddingVector(
  codes: Int8Array,
  offset: number,
  scale: number,
  dimensions: number,
): Float32Array {
  const vector = new Float32Array(dimensions);
  if (!Number.isFinite(scale) || scale === 0) return vector;
  for (let axis = 0; axis < dimensions; axis += 1) {
    vector[axis] = (codes[offset + axis] ?? 0) * scale;
  }
  return vector;
}

/** Reconstructs every row of a quantized batch as one interleaved buffer. */
export function dequantizeEmbeddingVectors(
  quantized: EmbeddingQuantizedVectors,
): Float32Array {
  const { dimensions, count, codes, scales } = quantized;
  const vectors = new Float32Array(count * dimensions);
  for (let row = 0; row < count; row += 1) {
    const scale = scales[row] ?? 0;
    if (scale === 0) continue;
    const offset = row * dimensions;
    for (let axis = 0; axis < dimensions; axis += 1) {
      vectors[offset + axis] = (codes[offset + axis] ?? 0) * scale;
    }
  }
  return vectors;
}

/**
 * Inner product of one quantized row with a float32 query: the codes are summed
 * against the query and the vector's scale is applied once, so the coarse scan
 * costs one byte per axis instead of four.
 */
export function approximateEmbeddingInnerProduct(
  codes: Int8Array,
  offset: number,
  scale: number,
  query: ArrayLike<number>,
): number {
  let sum = 0;
  for (let axis = 0; axis < query.length; axis += 1) {
    sum += (codes[offset + axis] ?? 0) * (query[axis] ?? 0);
  }
  return sum * scale;
}

/** Aggregated reconstruction error of one quantized batch. */
export type EmbeddingQuantErrorStats = {
  vectors: number;
  dimensions: number;
  /** Largest single-component reconstruction error. */
  maxAbsError: number;
  /** Mean single-component reconstruction error. */
  meanAbsError: number;
  /** Root mean square single-component reconstruction error. */
  rmsError: number;
  /** Largest `|self dot - approximate self dot|` over all rows. */
  maxInnerProductError: number;
  /** Largest per-row scale; bounds a quantized component to ±scale/2. */
  maxScale: number;
};

/**
 * Compares a quantized batch against the reference vectors it was built from.
 * C5 calibration can feed measured vectors through here before switching a
 * space to int8.
 */
export function measureEmbeddingQuantizationError(
  reference: readonly ArrayLike<number>[],
  quantized: EmbeddingQuantizedVectors,
): EmbeddingQuantErrorStats {
  const { dimensions, count, codes, scales } = quantized;
  if (reference.length !== count) {
    throw new EmbeddingQuantError(
      "record-vector-mismatch",
      `reference has ${reference.length} vectors, quantized batch has ${count}`,
    );
  }
  let maxAbsError = 0;
  let sumAbsError = 0;
  let sumSquaredError = 0;
  let maxInnerProductError = 0;
  let maxScale = 0;
  for (let row = 0; row < count; row += 1) {
    const vector = reference[row];
    if (vector === undefined || vector.length !== dimensions) {
      throw new EmbeddingQuantError(
        "invalid-vector",
        `reference vector ${row} has length ${vector?.length ?? 0}, expected ${dimensions}`,
      );
    }
    const scale = scales[row] ?? 0;
    if (scale > maxScale) maxScale = scale;
    const offset = row * dimensions;
    let exactSelfDot = 0;
    let approximateSelfDot = 0;
    for (let axis = 0; axis < dimensions; axis += 1) {
      const value = vector[axis] ?? 0;
      const reconstructed = (codes[offset + axis] ?? 0) * scale;
      const difference = Math.abs(value - reconstructed);
      if (difference > maxAbsError) maxAbsError = difference;
      sumAbsError += difference;
      sumSquaredError += difference * difference;
      exactSelfDot += value * value;
      approximateSelfDot += value * reconstructed;
    }
    const innerProductError = Math.abs(exactSelfDot - approximateSelfDot);
    if (innerProductError > maxInnerProductError) {
      maxInnerProductError = innerProductError;
    }
  }
  const components = count * dimensions;
  return {
    vectors: count,
    dimensions,
    maxAbsError,
    meanAbsError: components === 0 ? 0 : sumAbsError / components,
    rmsError: components === 0 ? 0 : Math.sqrt(sumSquaredError / components),
    maxInnerProductError,
    maxScale,
  };
}

// ---------------------------------------------------------------------------
// Search with float32 rescore
// ---------------------------------------------------------------------------

/** The fields a quantized search needs; an int8 snapshot fits. */
export type EmbeddingQuantSearchInput = {
  dimensions: number;
  records: readonly EmbeddingQuantChunkRecord[];
  codes: Int8Array;
  scales: Float32Array;
  exactVectors?: Float32Array;
};

export type EmbeddingQuantSearchOptions = {
  /** Maximum parent hits. Defaults to B2's arm depth (`50`). */
  topK?: number;
  /** Coarse rows re-scored exactly; defaults to `50` (48-2 §4.10). */
  rescoreCandidates?: number;
  /** Drop hits below this score after the final scoring pass. */
  minScore?: number;
  /** Force a mode; `int8-rescore` degrades when originals are unavailable. */
  mode?: EmbeddingQuantMode;
};

export type EmbeddingQuantSearchResult =
  | {
      ok: true;
      hits: EmbeddingSearchHit[];
      /** Chunks visited by the int8 coarse scan. */
      scannedChunks: number;
      /** Candidates re-computed from float32 originals; `0` for int8-only. */
      rescoredChunks: number;
      /** Mode actually used. */
      mode: EmbeddingQuantMode;
      /** True when the exact float32 originals were unavailable. */
      rescoreUnavailable: boolean;
    }
  | { ok: false; problem: EmbeddingSearchProblem; detail?: string };

/**
 * Int8 coarse scan followed by an optional exact float32 re-rank of the best
 * `rescoreCandidates` chunks. Parent aggregation (best chunk per parent) runs
 * after scoring, matching B2; the final order is exact when rescoring and
 * approximate when the originals are unavailable.
 */
export function searchEmbeddingQuantIndex(
  input: EmbeddingQuantSearchInput,
  query: ArrayLike<number>,
  options: EmbeddingQuantSearchOptions = {},
): EmbeddingQuantSearchResult {
  const { dimensions, records, codes, scales, exactVectors } = input;
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    return {
      ok: false,
      problem: "invalid-index",
      detail: "invalid dimensions",
    };
  }
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
  const count = records.length;
  if (
    codes.length !== count * dimensions ||
    scales.length !== count ||
    (exactVectors !== undefined && exactVectors.length !== count * dimensions)
  ) {
    return {
      ok: false,
      problem: "invalid-index",
      detail: "code/scale/exact counts disagree with the records",
    };
  }
  const requestedMode: EmbeddingQuantMode =
    options.mode ?? (exactVectors === undefined ? "int8-only" : "int8-rescore");
  const mode: EmbeddingQuantMode =
    requestedMode === "int8-rescore" && exactVectors === undefined
      ? "int8-only"
      : requestedMode;
  const rescoreUnavailable = exactVectors === undefined;
  const topK = resolveCount(options.topK, EMBEDDING_SEARCH_DEFAULT_TOP_K);
  const rescoreCandidates = resolveCount(
    options.rescoreCandidates,
    EMBEDDING_QUANT_DEFAULT_RESCORE_CANDIDATES,
  );
  const minScore = options.minScore ?? Number.NEGATIVE_INFINITY;

  const coarse: { row: number; score: number }[] = [];
  for (let row = 0; row < count; row += 1) {
    const scale = scales[row] ?? 0;
    if (!Number.isFinite(scale) || scale < 0) {
      return {
        ok: false,
        problem: "invalid-index",
        detail: `record ${row} has an invalid scale`,
      };
    }
    const score = approximateEmbeddingInnerProduct(
      codes,
      row * dimensions,
      scale,
      query,
    );
    if (!Number.isFinite(score)) {
      return {
        ok: false,
        problem: "invalid-index",
        detail: `record ${row} produced a non-finite score`,
      };
    }
    coarse.push({ row, score });
  }
  if (count === 0) {
    return {
      ok: true,
      hits: [],
      scannedChunks: 0,
      rescoredChunks: 0,
      mode,
      rescoreUnavailable,
    };
  }

  let scored = coarse;
  let rescoredChunks = 0;
  if (mode === "int8-rescore" && exactVectors !== undefined) {
    coarse.sort(
      (left, right) => right.score - left.score || left.row - right.row,
    );
    scored = coarse
      .slice(0, Math.max(1, rescoreCandidates))
      .map((candidate) => ({
        row: candidate.row,
        score: dotProduct(exactVectors, candidate.row * dimensions, query),
      }));
    rescoredChunks = scored.length;
  }

  const bestByParent = new Map<
    string,
    { record: EmbeddingQuantChunkRecord; score: number }
  >();
  for (const { row, score } of scored) {
    const record = records[row];
    if (record === undefined) {
      return {
        ok: false,
        problem: "invalid-index",
        detail: `record ${row} is missing`,
      };
    }
    const previous = bestByParent.get(record.parentId);
    if (previous === undefined || score > previous.score) {
      bestByParent.set(record.parentId, { record, score });
    }
  }
  const hits: EmbeddingSearchHit[] = [];
  for (const { record, score } of bestByParent.values()) {
    if (!Number.isFinite(score) || score < minScore) continue;
    hits.push({
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
    });
  }
  hits.sort(
    (left, right) =>
      right.score - left.score || left.parentId.localeCompare(right.parentId),
  );
  return {
    ok: true,
    hits: hits.slice(0, topK),
    scannedChunks: count,
    rescoredChunks,
    mode,
    rescoreUnavailable,
  };
}

function dotProduct(
  vectors: Float32Array,
  offset: number,
  query: ArrayLike<number>,
): number {
  let sum = 0;
  for (let axis = 0; axis < query.length; axis += 1) {
    sum += (vectors[offset + axis] ?? 0) * (query[axis] ?? 0);
  }
  return sum;
}

function resolveCount(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

// ---------------------------------------------------------------------------
// Space switching and volume
// ---------------------------------------------------------------------------

/** The caller-declared space a generation must match. */
export type EmbeddingQuantSpaceExpectation = {
  formatVersion?: number;
  chunkerVersion?: number;
  modelId?: string;
  dimensions?: number;
  quant?: EmbeddingIndexQuant;
  agentId?: string;
  spaceId?: string;
};

/**
 * `undefined` when the generation belongs to the expected space. A mismatch
 * (including the quant itself) must make the whole unit unusable: scoring a
 * query against another space's geometry would silently mix models.
 */
export function checkEmbeddingQuantSpace(
  meta: EmbeddingIndexMeta,
  expectation: EmbeddingQuantSpaceExpectation,
): EmbeddingIndexProblem | undefined {
  const matches =
    (expectation.formatVersion === undefined ||
      meta.formatVersion === expectation.formatVersion) &&
    (expectation.chunkerVersion === undefined ||
      meta.chunkerVersion === expectation.chunkerVersion) &&
    (expectation.modelId === undefined ||
      meta.modelId === expectation.modelId) &&
    (expectation.dimensions === undefined ||
      meta.dimensions === expectation.dimensions) &&
    (expectation.quant === undefined || meta.quant === expectation.quant) &&
    (expectation.agentId === undefined ||
      meta.agentId === expectation.agentId) &&
    (expectation.spaceId === undefined || meta.spaceId === expectation.spaceId);
  return matches ? undefined : "expectation-mismatch";
}

export type EmbeddingQuantVolumeInput = {
  chunkCount: number;
  dimensions: number;
  /** `f32` keeps B2's layout; `int8` stores one code byte per axis. */
  quant: EmbeddingIndexQuant;
  /** int8 only: also keep the float32 originals for exact rescore. */
  rescore?: boolean;
};

export type EmbeddingQuantVolume = {
  chunkCount: number;
  dimensions: number;
  quant: EmbeddingIndexQuant;
  rescore: boolean;
  /** Bytes of the stored primary vectors (`f32`: 4/axis, `int8`: 1/axis). */
  vectorBytes: number;
  /** Per-vector scale bytes; `0` for `f32`. */
  scaleBytes: number;
  /** Extra float32-originals bytes kept for int8 rescore; `0` otherwise. */
  rescoreBytes: number;
  totalBytes: number;
  bytesPerChunk: number;
  /** `naiveFloat32Bytes / totalBytes`; `1` for plain `f32`. */
  compressionRatio: number;
};

/**
 * Reports the on-disk cost of one encoding. int8 alone is ~4× smaller than
 * float32; keeping the originals for rescore is a second copy, so the honest
 * ratio is about `1.25` and the caller has to choose (48-2 §4.10).
 */
export function estimateEmbeddingQuantVolume(
  input: EmbeddingQuantVolumeInput,
): EmbeddingQuantVolume {
  const { chunkCount, dimensions } = input;
  if (!Number.isInteger(chunkCount) || chunkCount < 0) {
    throw new EmbeddingQuantError(
      "invalid-record",
      `chunkCount must be a non-negative integer, got ${chunkCount}`,
    );
  }
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new EmbeddingQuantError(
      "invalid-dimensions",
      `dimensions must be a positive integer, got ${dimensions}`,
    );
  }
  const naiveFloat32Bytes = chunkCount * dimensions * 4;
  const quant: EmbeddingIndexQuant = input.quant === "int8" ? "int8" : "f32";
  const rescore = quant === "int8" && input.rescore !== false;
  const vectorBytes =
    quant === "int8" ? chunkCount * dimensions : naiveFloat32Bytes;
  const scaleBytes = quant === "int8" ? chunkCount * 4 : 0;
  const rescoreBytes = rescore ? chunkCount * dimensions * 4 : 0;
  const totalBytes = vectorBytes + scaleBytes + rescoreBytes;
  return {
    chunkCount,
    dimensions,
    quant,
    rescore,
    vectorBytes,
    scaleBytes,
    rescoreBytes,
    totalBytes,
    bytesPerChunk: chunkCount === 0 ? 0 : totalBytes / chunkCount,
    compressionRatio: totalBytes === 0 ? 0 : naiveFloat32Bytes / totalBytes,
  };
}

function resolveDimensions(
  vectors: readonly ArrayLike<number>[],
  dimensions: number | undefined,
): number {
  const width = dimensions ?? vectors[0]?.length;
  if (width === undefined || !Number.isInteger(width) || width <= 0) {
    throw new EmbeddingQuantError(
      "invalid-dimensions",
      `dimensions must be a positive integer, got ${String(width)}`,
    );
  }
  return width;
}
