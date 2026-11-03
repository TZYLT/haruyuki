/**
 * Process-resident cache for the vector-recall index (feature 48, package B2).
 *
 * A recall turn walks every conversation of the active space, so the vectors
 * must not be re-read from disk each round: 23 MB is tolerable, the planned 10×
 * corpus (231 MB) is not (docs/48-1 §6.3, docs/48-2 §4.2). This module keeps one
 * validated {@link EmbeddingIndexSnapshot} per unit directory in a module-level
 * Map and only re-reads a unit when its `current.json` *pointer* changes.
 *
 * The steady-state check is `statSync(current.json)` plus a signature compare —
 * no `readFileSync`, no JSON parse, no checksum. Only when the signature moved
 * does the loader re-read the pointer, the generation files and the checksum.
 * Signature is `{size, mtimeMs, ctimeMs}`: a pointer rewrite always changes
 * ctime even on a filesystem with coarse mtime, so a same-size generation swap
 * cannot be missed.
 *
 * Corruption never throws: a unit that fails validation is cached as `unusable`
 * under the same signature, so a recall turn degrades to lexical recall instead
 * of retrying a broken file 68 times per round. The entry is retried as soon as
 * the pointer changes, and `invalidateEmbeddingIndex` forces it immediately.
 *
 * Layer: `backend/local/`. Imports only `embedding-format.ts`; no `cli/`,
 * `websocket/`, `reminders/` or `agent/` imports.
 */

import {
  EMBEDDING_INDEX_FILE_NAMES,
  type EmbeddingIndexMeta,
  type EmbeddingIndexProblem,
  type EmbeddingIndexQuant,
  type EmbeddingIndexSnapshot,
  readEmbeddingIndex,
  readEmbeddingIndexPointer,
  statEmbeddingIndexPointer,
} from "./embedding-format";

/**
 * Fields the caller requires the loaded space to match. Expectations are a
 * cache concern rather than a format concern: the same generation may be valid
 * for one caller's model/dimensions and not another's, so a mismatch must not
 * be stored as an unusable entry.
 */
export type EmbeddingIndexExpectation = {
  formatVersion?: number;
  chunkerVersion?: number;
  modelId?: string;
  dimensions?: number;
  quant?: EmbeddingIndexQuant;
  agentId?: string;
  spaceId?: string;
};

/**
 * Upper bound on resident units. One space usually has one unit per
 * conversation plus one per memory file; the cap only matters on pathological
 * stores. Least-recently-used entries are dropped, which never affects
 * correctness — the next load re-reads the generation.
 */
export const EMBEDDING_INDEX_CACHE_MAX_ENTRIES = 512;

/** Outcome of {@link loadEmbeddingIndex}. */
export type EmbeddingIndexLoadResult =
  | {
      ok: true;
      index: EmbeddingIndexSnapshot;
      /** `hit` = pointer signature unchanged, `loaded` = read from disk. */
      status: "hit" | "loaded";
    }
  | {
      ok: false;
      status: "unusable";
      problem: EmbeddingIndexProblem;
      detail?: string;
    };

/** Cheap health check; does not load vectors. */
export type EmbeddingIndexStatResult =
  | {
      ok: true;
      signature: {
        size: number;
        mtimeMs: number;
        ctimeMs: number;
      };
      /** True when the resident entry matches the on-disk pointer. */
      cached: boolean;
    }
  | { ok: false; problem: EmbeddingIndexProblem };

/** Snapshot of the module counters (tests and `/recall status` diagnostics). */
export type EmbeddingIndexCacheStats = {
  entries: number;
  /** Calls served from the resident snapshot. */
  hits: number;
  /** Calls without a matching resident entry. */
  misses: number;
  /** Calls that re-read the generation from disk. */
  reloads: number;
  /** Calls that returned `unusable`. */
  unusable: number;
};

type Signature = { size: number; mtimeMs: number; ctimeMs: number };

type CacheEntry =
  | {
      status: "ready";
      signature: Signature;
      index: EmbeddingIndexSnapshot;
    }
  | {
      status: "unusable";
      signature: Signature;
      problem: EmbeddingIndexProblem;
      detail?: string;
    };

const cache = new Map<string, CacheEntry>();
const counters = {
  hits: 0,
  misses: 0,
  reloads: 0,
  unusable: 0,
};

/**
 * Loads one unit, reusing the resident snapshot when the pointer is unchanged.
 *
 * `options.expectation` is re-checked against both cached and freshly read
 * metadata, so a space switch (different model/dimensions) degrades to
 * `unusable` instead of scoring with vectors from another space.
 */
export function loadEmbeddingIndex(
  unitDir: string,
  options: {
    expectation?: EmbeddingIndexExpectation;
  } = {},
): EmbeddingIndexLoadResult {
  const stat = statEmbeddingIndexPointer(unitDir);
  const resident = cache.get(unitDir);
  if (!stat.ok) {
    cache.delete(unitDir);
    counters.unusable += 1;
    const result: EmbeddingIndexLoadResult = {
      ok: false,
      status: "unusable",
      problem: "missing",
      detail: `no readable ${EMBEDDING_INDEX_FILE_NAMES.current} in ${unitDir}`,
    };
    return result;
  }

  if (
    resident !== undefined &&
    sameSignature(resident.signature, stat.signature)
  ) {
    counters.hits += 1;
    touch(unitDir, resident);
    if (resident.status === "unusable") return unusableResult(resident);
    if (
      options.expectation !== undefined &&
      !matchesExpectation(resident.index.meta, options.expectation)
    ) {
      counters.unusable += 1;
      return {
        ok: false,
        status: "unusable",
        problem: "expectation-mismatch",
        detail: "resident generation does not match the requested space",
      };
    }
    return { ok: true, index: resident.index, status: "hit" };
  }

  counters.misses += 1;
  counters.reloads += 1;
  const pointerResult = readEmbeddingIndexPointer(unitDir);
  if (!pointerResult.ok) {
    return storeUnusable(
      unitDir,
      stat.signature,
      pointerResult.problem,
      pointerResult.detail,
    );
  }
  const readResult = readEmbeddingIndex(unitDir, {
    pointer: pointerResult.pointer,
  });
  if (!readResult.ok) {
    return storeUnusable(
      unitDir,
      pointerResult.signature,
      readResult.problem,
      readResult.detail,
    );
  }
  // Expectations are caller-scoped (a session may probe several spaces), so a
  // mismatch is *not* cached as unusable: the same generation can be valid for
  // the expectation the next caller passes.
  if (
    options.expectation !== undefined &&
    !matchesExpectation(readResult.snapshot.meta, options.expectation)
  ) {
    counters.unusable += 1;
    return {
      ok: false,
      status: "unusable",
      problem: "expectation-mismatch",
      detail: "generation does not match the requested space",
    };
  }
  store(unitDir, {
    status: "ready",
    signature: pointerResult.signature,
    index: readResult.snapshot,
  });
  return { ok: true, index: readResult.snapshot, status: "loaded" };
}

/**
 * The resident snapshot for a unit, without touching the disk. `undefined` when
 * the unit was never loaded, was invalidated, or is cached as unusable.
 */
export function peekEmbeddingIndex(
  unitDir: string,
): EmbeddingIndexSnapshot | undefined {
  const entry = cache.get(unitDir);
  return entry?.status === "ready" ? entry.index : undefined;
}

/**
 * Cheap stat of a unit's pointer. Reports whether a resident entry currently
 * matches it, without loading anything.
 */
export function statEmbeddingIndex(unitDir: string): EmbeddingIndexStatResult {
  const stat = statEmbeddingIndexPointer(unitDir);
  if (!stat.ok) return { ok: false, problem: "missing" };
  const resident = cache.get(unitDir);
  return {
    ok: true,
    signature: stat.signature,
    cached:
      resident !== undefined &&
      sameSignature(resident.signature, stat.signature),
  };
}

/** Drops one unit from the cache (for example after it was rebuilt/removed). */
export function invalidateEmbeddingIndex(unitDir: string): boolean {
  return cache.delete(unitDir);
}

/** Drops every resident unit; a space switch or a full rebuild calls this. */
export function invalidateAllEmbeddingIndexes(): void {
  cache.clear();
}

/** Clears the hit/miss counters; tests call this between cases. */
export function resetEmbeddingIndexCacheStats(): void {
  counters.hits = 0;
  counters.misses = 0;
  counters.reloads = 0;
  counters.unusable = 0;
}

/** Current cache size and counters. */
export function getEmbeddingIndexCacheStats(): EmbeddingIndexCacheStats {
  return { entries: cache.size, ...counters };
}

function storeUnusable(
  unitDir: string,
  signature: Signature,
  problem: EmbeddingIndexProblem,
  detail?: string,
): EmbeddingIndexLoadResult {
  counters.unusable += 1;
  store(unitDir, {
    status: "unusable",
    signature,
    problem,
    ...(detail === undefined ? {} : { detail }),
  });
  return {
    ok: false,
    status: "unusable",
    problem,
    ...(detail === undefined ? {} : { detail }),
  };
}

function unusableResult(
  entry: Extract<CacheEntry, { status: "unusable" }>,
): EmbeddingIndexLoadResult {
  counters.unusable += 1;
  return {
    ok: false,
    status: "unusable",
    problem: entry.problem,
    ...(entry.detail === undefined ? {} : { detail: entry.detail }),
  };
}

function store(unitDir: string, entry: CacheEntry): void {
  cache.delete(unitDir);
  cache.set(unitDir, entry);
  evictLeastRecentlyUsed();
}

function touch(unitDir: string, entry: CacheEntry): void {
  cache.delete(unitDir);
  cache.set(unitDir, entry);
}

function evictLeastRecentlyUsed(): void {
  while (cache.size > EMBEDDING_INDEX_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) return;
    cache.delete(oldest.value);
  }
}

function matchesExpectation(
  meta: EmbeddingIndexMeta,
  expectation: EmbeddingIndexExpectation,
): boolean {
  return (
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
    (expectation.spaceId === undefined || meta.spaceId === expectation.spaceId)
  );
}

function sameSignature(left: Signature, right: Signature): boolean {
  return (
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}
