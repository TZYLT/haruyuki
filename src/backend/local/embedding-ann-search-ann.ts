/**
 * Chunk → record mapping and B2 parent aggregation for ANN hits (feature 48,
 * package A6).
 *
 * B7 returns chunk-level hits whose `id` is a B2 `records.jsonl` row in
 * `vectors.bin` order. This module maps each id back to `(unit, row)`, groups
 * by unit, and hands the selected chunks to B2 `searchEmbeddingIndex` through a
 * synthetic snapshot — so **parent aggregation stays B2's code**, including its
 * tie-breaks, instead of being re-implemented here.
 *
 * The per-unit split is load-bearing: transcript `message.id` is only unique
 * inside one conversation, so concatenating units before aggregation would
 * merge unrelated parents.
 */

import {
  type AnnSearchDegradedReason,
  type AnnSearchTaggedHit,
  tagHit,
  unitIdentityKey,
} from "./embedding-ann-search-shared";
import {
  type AnnShardSidecarManifest,
  orderedEntries,
  readShardSidecar,
  type SidecarCache,
  sidecarSignature,
  sidecarUnitOf,
} from "./embedding-ann-search-sidecar";
import {
  isFlatUnit,
  isQuantUnit,
  type LoadedShard,
  type LoadedUnit,
  unitSnapshotQuant,
} from "./embedding-ann-search-units";
import type {
  EmbeddingChunkRecord,
  EmbeddingIndexSnapshot,
} from "./embedding-format";
import type { EmbeddingQuantChunkRecord } from "./embedding-quant";
import { searchEmbeddingQuantIndex } from "./embedding-quant";
import { searchEmbeddingIndex } from "./embedding-search";

export type ShardAnnResult =
  | {
      ok: true;
      hits: AnnSearchTaggedHit[];
      scannedChunks: number;
      /** Chunk refs the ANN scan selected, before parent aggregation. */
      chunkHits: number;
    }
  | { ok: false; problem: AnnSearchDegradedReason; detail?: string };

/** One selected chunk id, resolved back to its unit and records row. */
export type ChunkRef = { entry: LoadedUnit; row: number };

export function refsFromAnnHits(
  ordered: readonly LoadedUnit[],
  manifest: AnnShardSidecarManifest,
  hits: readonly { id: number; score: number }[],
): ChunkRef[] | undefined {
  const offsets: number[] = [];
  let total = 0;
  for (const entry of ordered) {
    offsets.push(total);
    total += entry.snapshot.meta.chunkCount;
  }
  const refs: ChunkRef[] = [];
  const seen = new Set<number>();
  for (const hit of hits) {
    if (hit.id < 0 || hit.id >= manifest.chunkCount || seen.has(hit.id)) {
      if (hit.id < 0 || hit.id >= manifest.chunkCount) return undefined;
      continue;
    }
    seen.add(hit.id);
    let low = 0;
    let high = offsets.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if ((offsets[middle] ?? 0) <= hit.id) low = middle;
      else high = middle - 1;
    }
    const entry = ordered[low];
    if (entry === undefined) return undefined;
    const row = hit.id - (offsets[low] ?? 0);
    if (row < 0 || row >= entry.snapshot.meta.chunkCount) return undefined;
    refs.push({ entry, row });
  }
  return refs;
}

type ChunkBucket = { entry: LoadedUnit; rows: number[] };

const unitSnapshotQuantOf = unitSnapshotQuant;

/**
 * Aggregates selected chunks per unit through B2's `searchEmbeddingIndex`.
 *
 * The aggregation is deliberately delegated: a synthetic snapshot holding only
 * the ANN-selected chunks (records re-numbered to their subset offsets) is
 * enough for B2 to return one best hit per parent with its own tie-breaks. The
 * per-unit split also matters for transcripts, where `message.id` is only
 * unique inside one conversation.
 */
export function aggregateChunks(
  refs: readonly ChunkRef[],
  query: Float32Array,
): { hits: AnnSearchTaggedHit[]; problem?: string } {
  const hits: AnnSearchTaggedHit[] = [];
  for (const bucket of chunkBuckets(refs)) {
    const { entry } = bucket;
    if (!isFlatUnit(entry)) {
      return { hits, problem: `unit ${entry.key} is not a float32 snapshot` };
    }
    const dimensions = entry.snapshot.meta.dimensions;
    const rows = bucket.rows;
    const vectors = new Float32Array(rows.length * dimensions);
    const records: EmbeddingChunkRecord[] = [];
    for (const [position, row] of rows.entries()) {
      const record = entry.snapshot.records[row];
      if (record === undefined) {
        return { hits, problem: `missing record row ${row} in ${entry.key}` };
      }
      vectors.set(
        entry.snapshot.vectors.subarray(
          row * dimensions,
          (row + 1) * dimensions,
        ),
        position * dimensions,
      );
      records.push({ ...record, vectorOffset: position * dimensions * 4 });
    }
    const parents = new Set(records.map((record) => record.parentId)).size;
    const synthetic: EmbeddingIndexSnapshot = {
      unitDir: entry.snapshot.unitDir,
      generation: entry.snapshot.generation,
      pointer: entry.snapshot.pointer,
      meta: {
        ...entry.snapshot.meta,
        chunkCount: records.length,
        parentCount: parents,
      },
      records,
      vectors,
    };
    const aggregated = searchEmbeddingIndex(synthetic, query, {
      topK: records.length,
    });
    if (!aggregated.ok) {
      return {
        hits,
        problem: `${entry.key}: ${aggregated.problem}${aggregated.detail === undefined ? "" : ` (${aggregated.detail})`}`,
      };
    }
    for (const hit of aggregated.hits) hits.push(tagHit(entry.unit, hit));
  }
  return { hits };
}

/**
 * The int8 twin of {@link aggregateChunks}: the synthetic snapshot carries
 * codes and per-row scales instead of float32 rows, and B2's
 * `searchEmbeddingQuantIndex` runs the same parent aggregation (best chunk per
 * parent, its tie-breaks, its ordering). Scores are the code-scan inner
 * products, which is what the int8 index itself ranks by — so ANN and flat
 * agree on every chunk they both visit.
 */
export function aggregateChunksInt8(
  refs: readonly ChunkRef[],
  query: Float32Array,
): { hits: AnnSearchTaggedHit[]; problem?: string } {
  const hits: AnnSearchTaggedHit[] = [];
  for (const bucket of chunkBuckets(refs)) {
    const { entry } = bucket;
    if (!isQuantUnit(entry)) {
      return { hits, problem: `unit ${entry.key} is not an int8 snapshot` };
    }
    const dimensions = entry.snapshot.meta.dimensions;
    const rows = bucket.rows;
    const codes = new Int8Array(rows.length * dimensions);
    const scales = new Float32Array(rows.length);
    const records: EmbeddingQuantChunkRecord[] = [];
    for (const [position, row] of rows.entries()) {
      const record = entry.snapshot.records[row];
      if (record === undefined) {
        return { hits, problem: `missing record row ${row} in ${entry.key}` };
      }
      const source = row * dimensions;
      for (let axis = 0; axis < dimensions; axis += 1) {
        codes[position * dimensions + axis] =
          entry.snapshot.codes[source + axis] ?? 0;
      }
      scales[position] = entry.snapshot.scales[row] ?? 0;
      records.push({ ...record, vectorOffset: position * dimensions });
    }
    const aggregated = searchEmbeddingQuantIndex(
      { dimensions, records, codes, scales },
      query,
      { topK: records.length, mode: "int8-only" },
    );
    if (!aggregated.ok) {
      return {
        hits,
        problem: `${entry.key}: ${aggregated.problem}${aggregated.detail === undefined ? "" : ` (${aggregated.detail})`}`,
      };
    }
    for (const hit of aggregated.hits) hits.push(tagHit(entry.unit, hit));
  }
  return { hits };
}

/** Shared grouping: de-duplicated rows per unit, ascending row order. */
function chunkBuckets(refs: readonly ChunkRef[]): ChunkBucket[] {
  const byUnit = new Map<string, ChunkBucket>();
  for (const ref of refs) {
    const key = unitIdentityKey({
      kind: ref.entry.unit.kind,
      key: ref.entry.key,
    });
    const bucket = byUnit.get(key);
    if (bucket === undefined) {
      byUnit.set(key, { entry: ref.entry, rows: [ref.row] });
    } else {
      bucket.rows.push(ref.row);
    }
  }
  const buckets: ChunkBucket[] = [];
  for (const bucket of byUnit.values()) {
    const rows = [...new Set(bucket.rows)].sort((left, right) => left - right);
    if (rows.length > 0) buckets.push({ entry: bucket.entry, rows });
  }
  return buckets;
}

export function searchShardAnn(
  loaded: LoadedShard,
  query: Float32Array,
  chunkDepth: number,
  dir: string,
  cache: SidecarCache,
): ShardAnnResult {
  if (loaded.dimensions === undefined) {
    return {
      ok: false,
      problem: "sidecar-dimension-mismatch",
      detail: "shard has mixed dimensions",
    };
  }
  const read = readShardSidecar(loaded, dir, cache);
  if (!read.ok) return read;
  const { manifest, index } = read;
  if (loaded.dimensions !== manifest.dimensions) {
    return {
      ok: false,
      problem: "sidecar-dimension-mismatch",
      detail: `sidecar is ${manifest.dimensions}-d, live space is ${loaded.dimensions}-d`,
    };
  }
  const liveUnits = loaded.entries.map((entry) =>
    sidecarUnitOf(entry.unit, entry.snapshot),
  );
  if (sidecarSignature(liveUnits) !== manifest.signature) {
    return {
      ok: false,
      problem: "sidecar-stale",
      detail: "sidecar was built for different unit generations",
    };
  }
  if (query.length !== manifest.dimensions) {
    return {
      ok: false,
      problem: "search-failed",
      detail: `query has ${query.length} dimensions, sidecar has ${manifest.dimensions}`,
    };
  }
  const ordered = orderedEntries(loaded, manifest);
  if (ordered === undefined) {
    return {
      ok: false,
      problem: "sidecar-stale",
      detail: "sidecar units do not match the live units",
    };
  }
  const searched = index.search(query, chunkDepth);
  if (!searched.ok) {
    return {
      ok: false,
      problem: "search-failed",
      detail: `${searched.problem}${searched.detail === undefined ? "" : ` (${searched.detail})`}`,
    };
  }
  const refs = refsFromAnnHits(ordered, manifest, searched.hits);
  if (refs === undefined) {
    return {
      ok: false,
      problem: "sidecar-corrupt",
      detail: "ANN hit id is outside the sidecar's chunk rows",
    };
  }
  const quant =
    ordered[0] === undefined ? "f32" : unitSnapshotQuantOf(ordered[0]);
  if (ordered.some((entry) => unitSnapshotQuantOf(entry) !== quant)) {
    return {
      ok: false,
      problem: "sidecar-stale",
      detail: "shard mixes float32 and int8 units",
    };
  }
  const aggregated =
    quant === "int8"
      ? aggregateChunksInt8(refs, query)
      : aggregateChunks(refs, query);
  if (aggregated.problem !== undefined) {
    return {
      ok: false,
      problem: "search-failed",
      detail: aggregated.problem,
    };
  }
  return {
    ok: true,
    hits: aggregated.hits,
    scannedChunks: searched.scannedVectors,
    chunkHits: refs.length,
  };
}
