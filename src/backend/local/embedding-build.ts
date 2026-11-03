/**
 * Incremental build of one vector-index unit (feature 48, package B3).
 *
 * This module is pure orchestration: it owns no filesystem access, no clock and
 * no timers, so it can run inside the builder's loop on either runtime and be
 * tested without a model. Inputs are B1's chunk plans, B2's previous snapshot
 * and an injected `embed` callback (A3 adapts the C3 worker or the C6 endpoint to
 * that signature); the caller persists the result with B2's
 * `writeEmbeddingIndex`.
 *
 * Reuse rule (48-2 §4.2): a new chunk may take an old vector when the old
 * record belongs to the same parent and has the same `textHash` and the same
 * `spans[]`. Matching is content-based, so a chunk's index may shift without
 * forcing a re-embed. The record is always rebuilt from the new plan (fresh
 * indices, line spans and hashes); only the vector is carried over.
 *
 * Cancellation (48-1 §6.8): the build checks the injected signal between
 * parents and between embed batches. Aborting is not an exception — the result
 * comes back with `aborted: true` and the part that was already embedded.
 * Within one parent a contiguous prefix is kept, so every chunk that is written
 * is complete and a resumed build reuses it instead of re-embedding it.
 *
 * Layer: `backend/local/`. Imports only same-directory B1/B2 public API; no
 * `cli/`, `websocket/`, `reminders/` or `agent/` imports and no IO.
 */

import type {
  EmbeddingChunk,
  EmbeddingChunkPlan,
  EmbeddingTextSpan,
} from "./embedding-chunk";
import {
  type EmbeddingChunkRecord,
  type EmbeddingChunkRecordInput,
  type EmbeddingIndexCoverage,
  type EmbeddingIndexSnapshot,
  type EmbeddingParentLineSpan,
  embeddingChunkRecordFromChunk,
} from "./embedding-format";

/** Default chunks handed to one `embed` call; A3 may lower it by throughput. */
export const EMBEDDING_BUILD_DEFAULT_BATCH_SIZE = 32;

/**
 * Embeds one batch of chunks in plan order. Every returned vector must be a
 * `Float32Array` of the space's width and already L2-normalized (B2's writer
 * stores it verbatim); a misbehaving callback fails the unit by throwing.
 */
export type EmbeddingEmbedCallback = (
  chunks: readonly EmbeddingChunk[],
) => Promise<readonly Float32Array[]>;

/** Build options; everything except `embed` has a documented default. */
export type EmbeddingBuildOptions = {
  /** Required: A3's adapter around the C3 worker or the C6 endpoint. */
  embed: EmbeddingEmbedCallback;
  /**
   * Loaded generation this unit currently has, or `null` when it has none.
   * Used only for vector reuse and for reporting `droppedParents`; the build
   * never reads it from disk itself.
   */
  previous?: EmbeddingIndexSnapshot | null;
  /**
   * `false` forces a full rebuild (manual `--full`, model/space switch). Default
   * `true`: unchanged chunks reuse their previous vector and are not embedded.
   */
  reuse?: boolean;
  /** Chunks per `embed` call. Default {@link EMBEDDING_BUILD_DEFAULT_BATCH_SIZE}. */
  batchSize?: number;
  /**
   * Space width. Defaults to `previous.meta.dimensions` when a usable snapshot
   * exists, otherwise it is learned from the first embedded vector. A value
   * that disagrees with the snapshot disables reuse instead of mixing spaces.
   */
  dimensions?: number;
  /**
   * Memory units only: the chunk's line span inside the parent file, forwarded
   * to B2's record mapper (48-2 §4.2). Transcript units omit it.
   */
  parentLineSpan?: (
    chunk: EmbeddingChunk,
  ) => EmbeddingParentLineSpan | undefined;
  /** Cooperative cancellation; checked between parents and between batches. */
  signal?: AbortSignal;
  /** Alternative cancellation predicate (A3's cancel sentinel). */
  isAborted?: () => boolean;
};

/**
 * Everything B2 needs to write the next generation, aligned by index:
 * `records[i]` is described by `vectors[i]`. `reusedChunks + embeddedChunks ===
 * records.length`, and `coverage` is the unit's target coverage over all plans
 * (not just the part completed before an abort).
 */
export type EmbeddingBuildResult = {
  records: EmbeddingChunkRecordInput[];
  vectors: Float32Array[];
  reusedChunks: number;
  embeddedChunks: number;
  /** Parents present in `previous` but absent from the new plans (48-1 §6.10). */
  droppedParents: string[];
  coverage: EmbeddingIndexCoverage;
  /** True when cancellation stopped the build early; `records` is a checkpoint. */
  aborted: boolean;
};

// ---------------------------------------------------------------------------
// Reuse
// ---------------------------------------------------------------------------

type ReuseLookup = {
  take(parentId: string, key: string): Float32Array | undefined;
};

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

/**
 * Identity of a reusable chunk: the embedded text's hash plus the exact prose
 * spans. The spans pin the chunk to the parent's original offsets, so two
 * chunks with equal text but different positions never alias.
 */
function reuseKey(record: {
  textHash: string;
  spans: readonly EmbeddingTextSpan[];
}): string {
  let key = record.textHash;
  for (const span of record.spans) {
    key += `|${span.startChar}:${span.endChar}`;
  }
  return key;
}

/**
 * Indexes a previous generation by `(parentId, textHash + spans)` so a new
 * chunk can claim one old vector. Returns `undefined` when the snapshot cannot
 * be trusted for reuse (unsupported quant, inconsistent counts, bad offsets):
 * the build then simply re-embeds, which is always correct.
 */
function createReuseLookup(
  snapshot: EmbeddingIndexSnapshot,
  dimensions: number,
): ReuseLookup | undefined {
  const { meta, records, vectors } = snapshot;
  if (meta.quant !== "f32") return undefined;
  if (!isPositiveInteger(dimensions)) return undefined;
  if (records.length !== meta.chunkCount) return undefined;
  if (vectors.length !== meta.chunkCount * dimensions) return undefined;

  const byParent = new Map<string, Map<string, EmbeddingChunkRecord[]>>();
  for (const record of records) {
    const offset = record.vectorOffset;
    if (!Number.isInteger(offset) || offset < 0 || offset % 4 !== 0) {
      return undefined;
    }
    if (offset / 4 + dimensions > vectors.length) return undefined;
    let byKey = byParent.get(record.parentId);
    if (byKey === undefined) {
      byKey = new Map<string, EmbeddingChunkRecord[]>();
      byParent.set(record.parentId, byKey);
    }
    const key = reuseKey(record);
    const entries = byKey.get(key);
    if (entries === undefined) {
      byKey.set(key, [record]);
    } else {
      entries.push(record);
    }
  }

  return {
    take(parentId: string, key: string): Float32Array | undefined {
      // `pop` consumes one old record per new chunk: duplicated chunks within a
      // parent must not move the same old vector twice.
      const record = byParent.get(parentId)?.get(key)?.pop();
      if (record === undefined) return undefined;
      const start = record.vectorOffset / 4;
      return vectors.slice(start, start + dimensions);
    },
  };
}

type ResolvedReuse = {
  dimensions: number | undefined;
  lookup: ReuseLookup | undefined;
};

/**
 * Resolves the space width and the reuse index. Dimensions come from the
 * caller first, then from the snapshot; a snapshot that disagrees or is
 * inconsistent disables reuse rather than being mixed into the new space.
 */
function resolveReuse(
  previous: EmbeddingIndexSnapshot | undefined,
  requestedDimensions: number | undefined,
  reuse: boolean,
): ResolvedReuse {
  if (previous === undefined || !reuse) {
    return { dimensions: requestedDimensions, lookup: undefined };
  }
  const dimensions = requestedDimensions ?? previous.meta.dimensions;
  const lookup = createReuseLookup(previous, dimensions);
  if (lookup === undefined) {
    return { dimensions: requestedDimensions, lookup: undefined };
  }
  return { dimensions, lookup };
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

function abortRequested(options: EmbeddingBuildOptions): boolean {
  if (options.signal?.aborted === true) return true;
  return options.isAborted?.() === true;
}

// ---------------------------------------------------------------------------
// Embed validation
// ---------------------------------------------------------------------------

/**
 * Validates one `embed` reply and returns the space width. The callback is an
 * injected boundary, so a wrong count or width fails loudly instead of writing
 * misaligned records and vectors.
 */
function assertEmbedOutput(
  output: readonly Float32Array[],
  expectedCount: number,
  dimensions: number | undefined,
): number {
  if (!Array.isArray(output) || output.length !== expectedCount) {
    throw new Error(
      `embed() returned ${Array.isArray(output) ? output.length : "no"} vectors for ${expectedCount} chunks.`,
    );
  }
  const first = output[0];
  if (first === undefined) {
    throw new Error("embed() returned no vectors for a non-empty batch.");
  }
  if (!(first instanceof Float32Array)) {
    throw new Error("embed() must return Float32Array vectors.");
  }
  const width = dimensions ?? first.length;
  if (!isPositiveInteger(width)) {
    throw new Error(`embed() returned a vector with width ${width}.`);
  }
  for (const vector of output) {
    if (!(vector instanceof Float32Array)) {
      throw new Error("embed() must return Float32Array vectors.");
    }
    if (vector.length !== width) {
      throw new Error(
        `embed() returned mixed widths: expected ${width}, got ${vector.length}.`,
      );
    }
  }
  return width;
}

// ---------------------------------------------------------------------------
// Deleted parents
// ---------------------------------------------------------------------------

/** Parents the new plans no longer contain; B5 cascades the cleanup later. */
function collectDroppedParents(
  previous: EmbeddingIndexSnapshot | undefined,
  currentParentIds: ReadonlySet<string>,
): string[] {
  if (previous === undefined) return [];
  const dropped: string[] = [];
  const seen = new Set<string>();
  for (const record of previous.records) {
    if (currentParentIds.has(record.parentId)) continue;
    if (seen.has(record.parentId)) continue;
    seen.add(record.parentId);
    dropped.push(record.parentId);
  }
  return dropped;
}

function sumCoverage(
  plans: readonly EmbeddingChunkPlan[],
): EmbeddingIndexCoverage {
  let embeddedChars = 0;
  let recallableChars = 0;
  for (const plan of plans) {
    embeddedChars += plan.coverage.embeddedChars;
    recallableChars += plan.coverage.recallableChars;
  }
  return {
    embeddedChars,
    recallableChars,
    ratio: recallableChars === 0 ? 0 : embeddedChars / recallableChars,
  };
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

type PendingChunk = {
  chunk: EmbeddingChunk;
  /** Slot into the parent's `vectors` array; filled by reuse or by `embed`. */
  slot: number;
};

/**
 * Builds the record/vector set for one unit from its new chunk plans.
 *
 * Plans are processed in the given order and each parent's chunks keep their
 * `chunkIndex` order, so `records` is deterministic for equal inputs. Parents
 * marked `skipVector` contribute coverage but no records. On abort the result
 * contains every fully processed parent plus the embedded prefix of the parent
 * being processed, and `aborted` is `true`.
 */
export async function buildEmbeddingIndex(
  plans: readonly EmbeddingChunkPlan[],
  options: EmbeddingBuildOptions,
): Promise<EmbeddingBuildResult> {
  const requestedDimensions = options.dimensions;
  if (
    requestedDimensions !== undefined &&
    !isPositiveInteger(requestedDimensions)
  ) {
    throw new Error(
      `Embedding build dimensions must be a positive integer, got ${requestedDimensions}.`,
    );
  }
  const batchSize = options.batchSize ?? EMBEDDING_BUILD_DEFAULT_BATCH_SIZE;
  if (!isPositiveInteger(batchSize)) {
    throw new Error(
      `Embedding build batchSize must be a positive integer, got ${batchSize}.`,
    );
  }

  const parentIds = new Set<string>();
  for (const plan of plans) parentIds.add(plan.parentId);
  const previous = options.previous ?? undefined;
  const droppedParents = collectDroppedParents(previous, parentIds);
  const coverage = sumCoverage(plans);
  const { dimensions: initialDimensions, lookup } = resolveReuse(
    previous,
    requestedDimensions,
    options.reuse !== false,
  );

  let dimensions = initialDimensions;
  const records: EmbeddingChunkRecordInput[] = [];
  const vectors: Float32Array[] = [];
  let reusedChunks = 0;
  let embeddedChunks = 0;
  let aborted = false;

  for (const plan of plans) {
    if (abortRequested(options)) {
      aborted = true;
      break;
    }
    if (plan.skipVector || plan.chunks.length === 0) continue;

    const localRecords: EmbeddingChunkRecordInput[] = [];
    const localVectors: Array<Float32Array | undefined> = [];
    const localReused: boolean[] = [];
    const pending: PendingChunk[] = [];

    for (const chunk of plan.chunks) {
      const lineSpan = options.parentLineSpan?.(chunk);
      const record = embeddingChunkRecordFromChunk(chunk, lineSpan);
      const slot = localRecords.length;
      localRecords.push(record);
      const reused = lookup?.take(plan.parentId, reuseKey(record));
      if (reused === undefined) {
        localVectors.push(undefined);
        localReused.push(false);
        pending.push({ chunk, slot });
      } else {
        localVectors.push(reused);
        localReused.push(true);
      }
    }

    let parentAborted = false;
    for (let start = 0; start < pending.length; start += batchSize) {
      if (abortRequested(options)) {
        parentAborted = true;
        aborted = true;
        break;
      }
      const batch = pending.slice(start, start + batchSize);
      const chunks = batch.map((entry) => entry.chunk);
      const output = await options.embed(chunks);
      const width = assertEmbedOutput(output, chunks.length, dimensions);
      if (dimensions === undefined) dimensions = width;
      for (const [position, entry] of batch.entries()) {
        const vector = output[position];
        if (vector !== undefined) localVectors[entry.slot] = vector;
      }
    }

    // Keep the contiguous prefix of this parent that has a vector: aborting
    // mid-parent must not leave a hole in the middle of a parent's chunks.
    let retained = localVectors.length;
    for (let index = 0; index < localVectors.length; index += 1) {
      if (localVectors[index] === undefined) {
        retained = index;
        break;
      }
    }
    for (let index = 0; index < retained; index += 1) {
      const record = localRecords[index];
      const vector = localVectors[index];
      if (record === undefined || vector === undefined) continue;
      records.push(record);
      vectors.push(vector);
      if (localReused[index] === true) {
        reusedChunks += 1;
      } else {
        embeddedChunks += 1;
      }
    }

    if (parentAborted) break;
  }

  return {
    records,
    vectors,
    reusedChunks,
    embeddedChunks,
    droppedParents,
    coverage,
    aborted,
  };
}
