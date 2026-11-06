/**
 * Shared contracts and helpers for the ANN query path (feature 48, package A6).
 *
 * This module owns the public types, the constants and the small pure helpers
 * used by the query path's other modules (`units` -> `flat`/`sidecar`/`ann` ->
 * `embedding-ann-search.ts`). It imports only B2/B7 module *types*, so it stays
 * a leaf: no `cli/`, `websocket/`, `reminders/` or `agent/` dependency.
 */

import type { EmbeddingIndexExpectation } from "./embedding-cache";
import type { EmbeddingVectorUnit } from "./embedding-format";
import type { EmbeddingSearchHit } from "./embedding-search";

/** Default parent depth of the vector arm (48-2 §4.7: 50). */
export const ANN_SEARCH_DEFAULT_TOP_K = 50;

/**
 * ANN returns chunk hits, and B2 aggregation needs a parent's best chunks in
 * that chunk top-k. A parent can contribute several chunks, so ask for a
 * multiple of the parent depth; the cap keeps the collector bounded.
 */
export const ANN_SEARCH_CHUNK_DEPTH_MULTIPLIER = 8;
export const ANN_SEARCH_MAX_CHUNK_DEPTH = 10_000;

/** How many flat-scan durations feed the observed p95 trigger. */
export const ANN_SEARCH_P95_WINDOW = 64;

/**
 * The single marker every degraded ANN query reports, in both the result and
 * `stats()`. A missing sidecar below the trigger is not degraded (that is the
 * normal flat path).
 */
export const ANN_SEARCH_DEGRADED = "ann-unavailable";

/** One unit of a vector space; structurally the same as E2's unit union. */
export type AnnSearchUnit =
  | { kind: "transcript"; conversationKey: string }
  | { kind: "memory"; file: string; memoryFileKey: string };

/** One B7 shard: every unit of one `(agentId, spaceId)` space. */
export type AnnSearchSpace = { agentId: string; spaceId: string };

/** A shard plus the units the caller wants searched (E2 lists them). */
export type AnnSearchShard = {
  agentId: string;
  spaceId: string;
  units: AnnSearchUnitSource;
};

/**
 * E2's unit callback takes a `RecallScope`. This port must not import
 * `reminders/` (layer rule), so the parameter is typed `never`: any callback
 * is assignable, and the runtime value is forwarded untouched.
 */
export type AnnSearchUnitSource =
  | readonly AnnSearchUnit[]
  | ((scope: never) => readonly AnnSearchUnit[]);

/** The query input E2's `RecallVectorSearchPort` passes (scope is forwarded). */
export type AnnSearchInput = {
  scope?: unknown;
  query: Float32Array;
  topK: number;
  shouldStop?: () => boolean;
};

/** One B2 parent hit tagged with the unit that produced it (E2's shape). */
export type AnnSearchTaggedHit =
  | { kind: "transcript"; conversationKey: string; hit: EmbeddingSearchHit }
  | { kind: "memory"; file: string; hit: EmbeddingSearchHit };

/** Why a degraded ANN query fell back; always paired with the marker. */
export type AnnSearchDegradedReason =
  | "sidecar-missing"
  | "sidecar-stale"
  | "sidecar-corrupt"
  | "sidecar-dimension-mismatch"
  | "sidecar-quant-mismatch"
  | "search-failed";

/**
 * Search outcome. Structurally assignable to E2's `RecallVectorSearchResult`;
 * `degraded` is additive and ignored by E2's consumer.
 */
export type AnnSearchResult =
  | {
      status: "searched";
      hits: readonly AnnSearchTaggedHit[];
      chunks: number;
      /**
       * Chunk hits before parent aggregation. The flat path counts chunks that
       * clear the score floor; the ANN path counts the chunk refs the ANN scan
       * selected (A6 has no floor to apply before B2 aggregation). Absent only
       * when no shard could report a count.
       */
      chunkHits?: number;
      truncated?: boolean;
      reason?: string;
      degraded?: typeof ANN_SEARCH_DEGRADED;
    }
  | {
      status: "empty";
      hits: readonly AnnSearchTaggedHit[];
      reason?: string;
      degraded?: typeof ANN_SEARCH_DEGRADED;
    }
  | {
      status: "unavailable";
      hits: readonly AnnSearchTaggedHit[];
      reason: string;
      degraded?: typeof ANN_SEARCH_DEGRADED;
    };

/** One search's observable shape; `kind` is the strongest path used. */
export type AnnSearchKind = "ann" | "flat";

export type AnnSearchStats = {
  /** `ann` when at least one shard used the ANN path, else `flat`. */
  kind: AnnSearchKind;
  /** Vectors actually examined (B2 scan rows or B7 list rows). */
  scannedChunks: number;
  /** Chunks in the usable corpus of the last query. */
  chunkCount: number;
  /** Observed p95 of flat scans (ms), `0` until a flat scan is sampled. */
  p95Ms: number;
  searches: number;
  annSearches: number;
  flatSearches: number;
  degradedSearches: number;
  shards: number;
  annShards: number;
  degraded?: typeof ANN_SEARCH_DEGRADED;
  degradedReason?: AnnSearchDegradedReason;
};

/**
 * The injected, E2-compatible search port. A function (so
 * `createVectorRecallSource({ search })` accepts it as-is) plus diagnostics.
 */
export type AnnAwareIndexSearch = ((
  input: AnnSearchInput,
) => AnnSearchResult) & {
  stats(): AnnSearchStats;
};

/** Test/host overrides for the 48-2 §4.10 trigger thresholds. */
export type AnnSearchTriggerOptions = {
  /** Override the 200k chunk trigger. */
  chunkCount?: number;
  /** Override the 150 ms p95 trigger. */
  p95Ms?: number;
  /** Full override, receives the observed p95 (`undefined` when unsampled). */
  shouldUseAnn?: (chunkCount: number, p95Ms: number | undefined) => boolean;
};

export type AnnSearchOptions = {
  topK?: number;
  /** Chunk hits requested from each ANN shard before parent aggregation. */
  chunkDepth?: number;
  trigger?: AnnSearchTriggerOptions;
  /** Clock for the flat p95 samples; injectable for deterministic tests. */
  now?: () => number;
  /** Flat-scan sample window; defaults to {@link ANN_SEARCH_P95_WINDOW}. */
  p95Window?: number;
};

export type CreateAnnShardedSearchOptions = AnnSearchOptions & {
  /** Shards to search; the single-space adapter passes exactly one. */
  shards: readonly AnnSearchShard[];
  /** Vector root; defaults to `getRecallVectorsRoot()` (`HARUYUKI_HOME` aware). */
  root?: string;
  /** Extra B2 generation expectations (model/dimensions/quant/format). */
  expectation?: EmbeddingIndexExpectation;
};

export type CreateAnnAwareIndexSearchOptions = AnnSearchOptions & {
  space: AnnSearchSpace;
  units: AnnSearchUnitSource;
  root?: string;
  expectation?: EmbeddingIndexExpectation;
};

export function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** Nearest-rank p95 over the trailing flat-scan window; `0` with no samples. */
export function percentile95(samples: readonly number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * 0.95) - 1),
  );
  return sorted[index] ?? 0;
}

export function unitKeyOf(unit: AnnSearchUnit): string {
  return unit.kind === "transcript" ? unit.conversationKey : unit.memoryFileKey;
}

/** Stable identity of one unit inside a shard: kind + transcript/memory key. */
export function unitIdentityKey(unit: { kind: string; key: string }): string {
  return `${unit.kind}\u0000${unit.key}`;
}

export function unitIdentity(
  unit: AnnSearchUnit,
  space: AnnSearchSpace,
): EmbeddingVectorUnit {
  return unit.kind === "transcript"
    ? {
        agentId: space.agentId,
        spaceId: space.spaceId,
        conversationKey: unit.conversationKey,
      }
    : {
        agentId: space.agentId,
        spaceId: space.spaceId,
        memoryFileKey: unit.memoryFileKey,
      };
}

export function tagHit(
  unit: AnnSearchUnit,
  hit: EmbeddingSearchHit,
): AnnSearchTaggedHit {
  return unit.kind === "transcript"
    ? { kind: "transcript", conversationKey: unit.conversationKey, hit }
    : { kind: "memory", file: unit.file, hit };
}

export function taggedHitKey(item: AnnSearchTaggedHit): string {
  const unit = item.kind === "transcript" ? item.conversationKey : item.file;
  return `${item.kind}\u0000${unit}\u0000${item.hit.parentId}\u0000${item.hit.chunkIndex}`;
}

export function compareTaggedHits(
  left: AnnSearchTaggedHit,
  right: AnnSearchTaggedHit,
): number {
  if (right.hit.score !== left.hit.score) {
    return right.hit.score - left.hit.score;
  }
  return compareText(taggedHitKey(left), taggedHitKey(right));
}
