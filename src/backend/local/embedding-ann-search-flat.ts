/**
 * Exact B2 fallback scan for the ANN query path (feature 48, package A6).
 *
 * When a shard is below the trigger, or its sidecar is missing/stale/corrupt,
 * the query keeps B2's brute-force scan and its parent aggregation. The caller
 * marks the result `degraded:ann-unavailable`; this module only reports what
 * was scanned and which units could not be scored.
 *
 * The scan dispatches on the unit's encoding: a float32 unit uses B2's
 * `vectors.bin` scan, an int8 unit uses the code scan (48-4 D-23 keeps the
 * int8 space native, never dequantizing the corpus).
 */

import { type AnnSearchTaggedHit, tagHit } from "./embedding-ann-search-shared";
import {
  isFlatUnit,
  isQuantUnit,
  type LoadedShard,
} from "./embedding-ann-search-units";
import { searchEmbeddingQuantIndex } from "./embedding-quant";
import { searchEmbeddingIndex } from "./embedding-search";

export type ShardFlatResult = {
  hits: AnnSearchTaggedHit[];
  scannedChunks: number;
  /** Chunks that cleared the score floor, before parent aggregation. */
  chunkHits: number;
  /** Units whose B2 scan actually ran (dimension drift skips one). */
  scoredUnits: number;
  problems: string[];
};

/** Exact B2 scan per unit; parent aggregation is `searchEmbeddingIndex`'s. */
export function searchShardFlat(
  loaded: LoadedShard,
  query: Float32Array,
  topK: number,
): ShardFlatResult {
  const hits: AnnSearchTaggedHit[] = [];
  const problems: string[] = [];
  let scannedChunks = 0;
  let chunkHits = 0;
  let scoredUnits = 0;
  for (const entry of loaded.entries) {
    const searched = isFlatUnit(entry)
      ? searchEmbeddingIndex(entry.snapshot, query, { topK })
      : isQuantUnit(entry)
        ? searchEmbeddingQuantIndex(
            {
              dimensions: entry.snapshot.meta.dimensions,
              records: entry.snapshot.records,
              codes: entry.snapshot.codes,
              scales: entry.snapshot.scales,
            },
            query,
            { topK, mode: "int8-only" },
          )
        : undefined;
    if (searched === undefined) {
      problems.push(`${entry.unit.kind}:${entry.key}: unsupported encoding`);
      continue;
    }
    if (!searched.ok) {
      problems.push(
        `${entry.unit.kind}:${entry.key}: ${searched.problem}${searched.detail === undefined ? "" : ` (${searched.detail})`}`,
      );
      continue;
    }
    scoredUnits += 1;
    scannedChunks += searched.scannedChunks;
    chunkHits += searched.chunkHits ?? 0;
    for (const hit of searched.hits) hits.push(tagHit(entry.unit, hit));
  }
  return { hits, scannedChunks, chunkHits, scoredUnits, problems };
}
