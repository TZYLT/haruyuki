/**
 * Exact B2 fallback scan for the ANN query path (feature 48, package A6).
 *
 * When a shard is below the trigger, or its sidecar is missing/stale/corrupt,
 * the query keeps B2's brute-force scan and its parent aggregation. The caller
 * marks the result `degraded:ann-unavailable`; this module only reports what
 * was scanned and which units could not be scored.
 */

import { type AnnSearchTaggedHit, tagHit } from "./embedding-ann-search-shared";
import type { LoadedShard } from "./embedding-ann-search-units";
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
    const searched = searchEmbeddingIndex(entry.snapshot, query, { topK });
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
