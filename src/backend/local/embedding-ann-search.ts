/**
 * ANN query path for the vector-recall index (feature 48, package A6) — public
 * entry.
 *
 * B7 (`embedding-ann-index.ts`) owns the pure-TS IVF-Flat index and its
 * serialized auxiliary form; B2 (`embedding-search.ts`) owns the brute-force
 * scan **and parent aggregation**. This entry decides per space shard whether
 * an ANN search is worth it, asks the sidecar reader for the persisted index,
 * delegates chunk→record mapping/parent aggregation to `-ann.ts`, and falls
 * back to B2's brute force whenever anything is wrong. It never throws on the
 * query path.
 *
 * Module split (all in this directory, one responsibility each):
 * - `embedding-ann-search-shared.ts` — public types, constants, pure helpers;
 * - `embedding-ann-search-units.ts` — B2 unit loading / shard shape;
 * - `embedding-ann-search-flat.ts` — exact B2 fallback scan;
 * - `embedding-ann-search-sidecar.ts` — sidecar format, writer, reader, cache;
 * - `embedding-ann-search-ann.ts` — ANN chunk→record mapping + B2 aggregation;
 * - this file — trigger, options/state/stats, the E2-compatible port, and the
 *   public re-exports so callers (E2/A5/A3/B5) keep one import site.
 *
 * Layer: `backend/local/`. Imports only same-directory B2/B7 modules and
 * `utils/`; no `cli/`, `websocket/`, `reminders/` or `agent/` imports — the
 * E2-compatible adapter is typed structurally for that reason.
 *
 * Contract (docs/48-2 §4.10, docs/48-3 §8.2/§10):
 *
 * 1. **Trigger is per shard.** A `(agentId, spaceId)` shard uses ANN when
 *    `shouldUseAnn(shardChunkCount, observedFlatP95)` says so (>200k chunks or
 *    >150 ms observed). Every other shard keeps the exact B2 scan, so a mixed
 *    space still fuses one global parent top-k. Tests inject the two
 *    thresholds instead of building a 200k corpus.
 * 2. **ANN reads persisted sidecars** written by `writeAnnShardSidecar`.
 * 3. **Chunk → record mapping + B2 aggregation** lives in `-ann.ts`; parent
 *    aggregation is B2's `searchEmbeddingIndex` on a synthetic subset, not a
 *    re-implementation.
 * 4. **Fallback is typed and silent.** Missing/stale/corrupt/dimension-mismatched
 *    sidecar, a failed ANN search or a unit that cannot be loaded all degrade
 *    that shard to the B2 scan and mark the query `degraded:
 *    "ann-unavailable"`; the result stays a normal search result.
 * 5. **Cold path uses signatures.** Unit snapshots come from the B2 resident
 *    cache; sidecar reads are cached by the `current.json` stat signature.
 *
 * Deviation from the package brief: `searchShardedAnnIndex` cannot consume
 * deserialized sidecars — B7 builds a `ShardedAnnIndex` only from raw vectors
 * and exposes no container assembler, so calling it would retrain the index
 * and defeat the sidecar. A6 therefore searches each deserialized shard
 * `AnnIndex` with the same API (`index.search`) and fuses hits with B7's
 * ordering rule (score desc, then shard key, then id). Recorded in the A6
 * hand-off.
 */

import {
  ANN_TRIGGER_CHUNK_COUNT,
  ANN_TRIGGER_P95_MS,
  shouldUseAnn,
} from "./embedding-ann-index";
import { searchShardAnn } from "./embedding-ann-search-ann";
import { searchShardFlat } from "./embedding-ann-search-flat";
import {
  ANN_SEARCH_CHUNK_DEPTH_MULTIPLIER,
  ANN_SEARCH_DEFAULT_TOP_K,
  ANN_SEARCH_DEGRADED,
  ANN_SEARCH_MAX_CHUNK_DEPTH,
  ANN_SEARCH_P95_WINDOW,
  type AnnAwareIndexSearch,
  type AnnSearchDegradedReason,
  type AnnSearchInput,
  type AnnSearchKind,
  type AnnSearchOptions,
  type AnnSearchResult,
  type AnnSearchStats,
  type AnnSearchTaggedHit,
  type AnnSearchTriggerOptions,
  type CreateAnnAwareIndexSearchOptions,
  type CreateAnnShardedSearchOptions,
  compareTaggedHits,
  errorMessage,
  percentile95,
} from "./embedding-ann-search-shared";
import {
  annShardSidecarDir,
  type SidecarCache,
} from "./embedding-ann-search-sidecar";
import { type LoadedShard, loadShard } from "./embedding-ann-search-units";
import type { EmbeddingIndexExpectation } from "./embedding-cache";
import { getRecallVectorsRoot } from "./embedding-format";

export type {
  AnnAwareIndexSearch,
  AnnSearchDegradedReason,
  AnnSearchInput,
  AnnSearchKind,
  AnnSearchOptions,
  AnnSearchResult,
  AnnSearchShard,
  AnnSearchSpace,
  AnnSearchStats,
  AnnSearchTaggedHit,
  AnnSearchTriggerOptions,
  AnnSearchUnit,
  AnnSearchUnitSource,
  CreateAnnAwareIndexSearchOptions,
  CreateAnnShardedSearchOptions,
} from "./embedding-ann-search-shared";
export {
  ANN_SEARCH_CHUNK_DEPTH_MULTIPLIER,
  ANN_SEARCH_DEFAULT_TOP_K,
  ANN_SEARCH_DEGRADED,
  ANN_SEARCH_MAX_CHUNK_DEPTH,
  ANN_SEARCH_P95_WINDOW,
} from "./embedding-ann-search-shared";
export type {
  AnnShardSidecarManifest,
  AnnSidecarUnit,
  AnnSidecarWriteProblem,
  WriteAnnShardSidecarOptions,
  WriteAnnShardSidecarResult,
} from "./embedding-ann-search-sidecar";
export {
  ANN_SEARCH_INDEX_FILE_SUFFIX,
  ANN_SEARCH_MANIFEST_FILE_NAME,
  ANN_SEARCH_MANIFEST_VERSION,
  ANN_SEARCH_SIDECAR_CACHE_MAX_ENTRIES,
  ANN_SEARCH_SIDECAR_DIR_NAME,
  annShardSidecarDir,
  writeAnnShardSidecar,
} from "./embedding-ann-search-sidecar";

function requireNonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number`);
  }
  return value;
}

/**
 * Resolves the per-shard trigger. With no overrides this is B7's
 * `shouldUseAnn` unchanged (>200,000 chunks or >150 ms p95); tests lower
 * either threshold so a small synthetic corpus exercises the ANN path.
 */
export function resolveAnnSearchTrigger(
  options: AnnSearchTriggerOptions = {},
): (chunkCount: number, p95Ms: number | undefined) => boolean {
  if (options.shouldUseAnn !== undefined) return options.shouldUseAnn;
  const chunkLimit = options.chunkCount;
  const latencyLimit = options.p95Ms;
  if (chunkLimit === undefined && latencyLimit === undefined) {
    return (chunkCount, p95Ms) => shouldUseAnn(chunkCount, p95Ms);
  }
  const countThreshold =
    chunkLimit === undefined
      ? ANN_TRIGGER_CHUNK_COUNT
      : requireNonNegative(chunkLimit, "trigger.chunkCount");
  const p95Threshold =
    latencyLimit === undefined
      ? ANN_TRIGGER_P95_MS
      : requireNonNegative(latencyLimit, "trigger.p95Ms");
  return (chunkCount, p95Ms) =>
    chunkCount > countThreshold ||
    (p95Ms !== undefined && p95Ms > p95Threshold);
}

function resolveTopK(requested: number | undefined, fallback: number): number {
  const value =
    requested === undefined || !Number.isFinite(requested)
      ? fallback
      : Math.trunc(requested);
  return Math.max(0, value);
}

function resolveChunkDepth(
  chunkCount: number,
  parentDepth: number,
  override: number | undefined,
): number {
  if (chunkCount <= 0) return 0;
  const requested =
    override === undefined || !Number.isFinite(override)
      ? Math.max(parentDepth, parentDepth * ANN_SEARCH_CHUNK_DEPTH_MULTIPLIER)
      : Math.max(1, Math.trunc(override));
  return Math.min(chunkCount, requested, ANN_SEARCH_MAX_CHUNK_DEPTH);
}
type ResolvedOptions = AnnSearchOptions & {
  root: string;
  expectation?: EmbeddingIndexExpectation;
  trigger: (chunkCount: number, p95Ms: number | undefined) => boolean;
  now: () => number;
  topK: number;
  p95Window: number;
};

function resolveOptions(
  options: AnnSearchOptions & {
    root?: string;
    expectation?: EmbeddingIndexExpectation;
  },
): ResolvedOptions {
  if (options.topK !== undefined) requireNonNegative(options.topK, "topK");
  if (options.chunkDepth !== undefined) {
    requireNonNegative(options.chunkDepth, "chunkDepth");
  }
  return {
    ...options,
    root: options.root ?? getRecallVectorsRoot(),
    trigger: resolveAnnSearchTrigger(options.trigger),
    now: options.now ?? Date.now,
    topK: resolveTopK(options.topK, ANN_SEARCH_DEFAULT_TOP_K),
    p95Window:
      options.p95Window === undefined
        ? ANN_SEARCH_P95_WINDOW
        : Math.max(1, Math.trunc(options.p95Window)),
  };
}

type SearchState = {
  samples: number[];
  searches: number;
  annSearches: number;
  flatSearches: number;
  degradedSearches: number;
  kind: AnnSearchKind;
  scannedChunks: number;
  chunkCount: number;
  shards: number;
  annShards: number;
  degradedReason?: AnnSearchDegradedReason;
};

function createState(): SearchState {
  return {
    samples: [],
    searches: 0,
    annSearches: 0,
    flatSearches: 0,
    degradedSearches: 0,
    kind: "flat",
    scannedChunks: 0,
    chunkCount: 0,
    shards: 0,
    annShards: 0,
  };
}

function statsOf(state: SearchState): AnnSearchStats {
  return {
    kind: state.kind,
    scannedChunks: state.scannedChunks,
    chunkCount: state.chunkCount,
    p95Ms: percentile95(state.samples),
    searches: state.searches,
    annSearches: state.annSearches,
    flatSearches: state.flatSearches,
    degradedSearches: state.degradedSearches,
    shards: state.shards,
    annShards: state.annShards,
    ...(state.degradedReason === undefined
      ? {}
      : {
          degraded: ANN_SEARCH_DEGRADED,
          degradedReason: state.degradedReason,
        }),
  };
}

function recordFlatSample(
  state: SearchState,
  options: ResolvedOptions,
  startedAt: number,
): void {
  const endedAt = options.now();
  const duration = endedAt - startedAt;
  if (!Number.isFinite(duration)) return;
  state.samples.push(Math.max(0, duration));
  while (state.samples.length > options.p95Window) state.samples.shift();
}

function degradedReasonText(
  problem: AnnSearchDegradedReason,
  detail: string | undefined,
): string {
  return `${ANN_SEARCH_DEGRADED} (${problem}${detail === undefined ? "" : `: ${detail}`})`;
}

/**
 * Multi-shard search with per-shard trigger and one global parent top-k.
 *
 * The single-space adapter delegates here with a one-element shard list. Mixed
 * shards are supported on purpose: when a space is sharded again by
 * conversation (phase ③), a small shard can stay exact while a big one uses
 * ANN, and the fused top-k is still global rather than per-shard.
 */
export function createAnnShardedSearch(
  options: CreateAnnShardedSearchOptions,
): AnnAwareIndexSearch {
  if (!Array.isArray(options.shards) || options.shards.length === 0) {
    throw new RangeError("createAnnShardedSearch requires at least one shard");
  }
  const resolved = resolveOptions(options);
  const state = createState();
  const cache: SidecarCache = new Map();

  const runSearch = (input: AnnSearchInput): AnnSearchResult => {
    const topK = resolveTopK(input.topK, resolved.topK);
    const query = input.query;
    const shouldStop = input.shouldStop ?? (() => false);
    if (query.length === 0) {
      return {
        status: "unavailable",
        hits: [],
        reason: "query vector is empty",
      };
    }

    const loadedShards: LoadedShard[] = [];
    let requestedUnits = 0;
    for (const shard of options.shards) {
      const loaded = loadShard(
        shard,
        resolved.root,
        resolved.expectation,
        input.scope,
      );
      requestedUnits += loaded.requested;
      loadedShards.push(loaded);
    }
    const totalChunks = loadedShards.reduce(
      (total, loaded) => total + loaded.chunkCount,
      0,
    );
    if (requestedUnits === 0) {
      state.kind = "flat";
      state.chunkCount = 0;
      state.scannedChunks = 0;
      state.shards = loadedShards.length;
      state.annShards = 0;
      state.degradedReason = undefined;
      state.flatSearches += 1;
      return {
        status: "empty",
        hits: [],
        reason: "the vector space has no units yet",
      };
    }

    const observedP95 = percentile95(state.samples);
    const hits: AnnSearchTaggedHit[] = [];
    let scannedChunks = 0;
    let chunkHits = 0;
    let chunkHitsKnown = false;
    let scoredShards = 0;
    let annShards = 0;
    let truncated = false;
    let firstDegraded:
      | { problem: AnnSearchDegradedReason; detail?: string }
      | undefined;
    const reasons: string[] = [];

    for (const loaded of loadedShards) {
      if (loaded.entries.length === 0) {
        for (const problem of loaded.problems) reasons.push(problem);
        continue;
      }
      if (shouldStop()) {
        truncated = true;
        break;
      }
      let solvedByAnn = false;
      if (resolved.trigger(loaded.chunkCount, observedP95)) {
        const chunkDepth = resolveChunkDepth(
          loaded.chunkCount,
          topK,
          resolved.chunkDepth,
        );
        let sidecarDir: string;
        try {
          sidecarDir = annShardSidecarDir(loaded, { root: resolved.root });
        } catch (error) {
          sidecarDir = "";
          reasons.push(
            `${loaded.agentId}/${loaded.spaceId}: ${errorMessage(error)}`,
          );
        }
        if (sidecarDir !== "") {
          const ann = searchShardAnn(
            loaded,
            query,
            chunkDepth,
            sidecarDir,
            cache,
          );
          if (ann.ok) {
            solvedByAnn = true;
            annShards += 1;
            scoredShards += 1;
            scannedChunks += ann.scannedChunks;
            chunkHits += ann.chunkHits;
            chunkHitsKnown = true;
            hits.push(...ann.hits);
          } else {
            firstDegraded ??= { problem: ann.problem, detail: ann.detail };
            reasons.push(
              `${loaded.agentId}/${loaded.spaceId}: ${degradedReasonText(ann.problem, ann.detail)}`,
            );
          }
        } else {
          firstDegraded ??= { problem: "search-failed" };
        }
      }
      if (solvedByAnn) continue;
      const startedAt = resolved.now();
      const flat = searchShardFlat(loaded, query, topK);
      recordFlatSample(state, resolved, startedAt);
      scannedChunks += flat.scannedChunks;
      chunkHits += flat.chunkHits;
      chunkHitsKnown = true;
      hits.push(...flat.hits);
      if (flat.scoredUnits > 0) scoredShards += 1;
      for (const problem of flat.problems) reasons.push(problem);
      for (const problem of loaded.problems) reasons.push(problem);
    }

    state.kind = annShards > 0 ? "ann" : "flat";
    state.chunkCount = totalChunks;
    state.scannedChunks = scannedChunks;
    state.shards = loadedShards.length;
    state.annShards = annShards;
    state.degradedReason = firstDegraded?.problem;
    if (annShards > 0) state.annSearches += 1;
    else state.flatSearches += 1;
    if (firstDegraded !== undefined) state.degradedSearches += 1;

    if (scoredShards === 0) {
      return {
        status: "unavailable",
        hits: [],
        reason: `no usable vector index in the space (${reasons[0] ?? "unknown problem"})`,
      };
    }

    hits.sort(compareTaggedHits);
    const resultHits = topK === 0 ? [] : hits.slice(0, topK);
    const degraded =
      firstDegraded === undefined
        ? undefined
        : degradedReasonText(firstDegraded.problem, firstDegraded.detail);
    const reason = [degraded, ...reasons].filter(
      (part): part is string => part !== undefined && part.length > 0,
    );
    return {
      status: "searched",
      hits: resultHits,
      chunks: totalChunks,
      ...(chunkHitsKnown ? { chunkHits } : {}),
      ...(truncated ? { truncated: true } : {}),
      ...(reason.length === 0 ? {} : { reason: reason.join("; ") }),
      ...(firstDegraded === undefined ? {} : { degraded: ANN_SEARCH_DEGRADED }),
    };
  };

  // Last net for I7: recall may never be the reason a message fails to send,
  // so even an unexpected throw inside the port becomes an unavailable result.
  const search = (input: AnnSearchInput): AnnSearchResult => {
    state.searches += 1;
    try {
      return runSearch(input);
    } catch (error) {
      return {
        status: "unavailable",
        hits: [],
        reason: `vector search failed: ${errorMessage(error)}`,
      };
    }
  };

  return Object.assign(search, {
    stats: (): AnnSearchStats => statsOf(state),
  });
}

/**
 * The single-space, E2-compatible adapter.
 *
 * `createVectorRecallSource({ search })` accepts the returned value directly
 * (it is a function with the same call signature); the extra `stats()` sibling
 * powers `/recall status` diagnostics without changing the port.
 */
export function createAnnAwareIndexSearch(
  options: CreateAnnAwareIndexSearchOptions,
): AnnAwareIndexSearch {
  return createAnnShardedSearch({
    ...options,
    shards: [
      {
        agentId: options.space.agentId,
        spaceId: options.space.spaceId,
        units: options.units,
      },
    ],
  });
}
