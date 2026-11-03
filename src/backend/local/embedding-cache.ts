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
 * C9 adds a second resident map for `int8` generations
 * ({@link loadEmbeddingQuantIndex}): one entry per unit and mode, so
 * `int8-rescore` can hold the float32 originals while `int8-only` does not. The
 * f32 path is unchanged; the two readers refuse each other's quant rather than
 * mixing encodings.
 *
 * Layer: `backend/local/`. Imports only same-directory B2/C9 modules; no
 * `cli/`, `websocket/`, `reminders/` or `agent/` imports.
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
import {
  checkEmbeddingQuantSpace,
  type EmbeddingQuantMode,
} from "./embedding-quant";
import {
  type EmbeddingQuantIndexSnapshot,
  readEmbeddingQuantIndex,
} from "./embedding-quant-format";

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

/** Outcome of {@link loadEmbeddingQuantIndex}. */
export type EmbeddingQuantLoadResult =
  | {
      ok: true;
      index: EmbeddingQuantIndexSnapshot;
      /** `hit` = pointer signature unchanged, `loaded` = read from disk. */
      status: "hit" | "loaded";
      /** Mode actually served; `int8-rescore` only when originals are resident. */
      mode: EmbeddingQuantMode;
      /** True when exact float32 rescore cannot run from this snapshot. */
      rescoreUnavailable: boolean;
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
  /** Resident int8 snapshots, one per unit/mode pair. */
  quantEntries: number;
  quantHits: number;
  quantMisses: number;
  quantReloads: number;
  quantUnusable: number;
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

type QuantCacheEntry =
  | {
      status: "ready";
      signature: Signature;
      index: EmbeddingQuantIndexSnapshot;
      mode: EmbeddingQuantMode;
      rescoreUnavailable: boolean;
    }
  | {
      status: "unusable";
      signature: Signature;
      problem: EmbeddingIndexProblem;
      detail?: string;
    };

const cache = new Map<string, CacheEntry>();
const quantCache = new Map<string, QuantCacheEntry>();
const counters = {
  hits: 0,
  misses: 0,
  reloads: 0,
  unusable: 0,
};
const quantCounters = {
  quantHits: 0,
  quantMisses: 0,
  quantReloads: 0,
  quantUnusable: 0,
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
 * Loads one int8 generation, reusing the resident snapshot while the pointer is
 * unchanged. The cache keeps one entry per unit and mode: `int8-rescore` holds
 * the float32 originals for exact re-ranking, `int8-only` does not decode them
 * (they cost 4× the codes) and reports `rescoreUnavailable`.
 *
 * An int8 generation is a different on-disk encoding, not a different space:
 * the caller's expectation (quant/dimensions/model/agent/space) is still checked
 * and a mismatch returns `unusable`, so a quant switch falls back to lexical
 * recall instead of scoring against the wrong geometry.
 */
export function loadEmbeddingQuantIndex(
  unitDir: string,
  options: {
    /** Default `int8-rescore`; falls back to int8-only when nothing is stored. */
    mode?: EmbeddingQuantMode;
    expectation?: EmbeddingIndexExpectation;
  } = {},
): EmbeddingQuantLoadResult {
  const requestedMode: EmbeddingQuantMode = options.mode ?? "int8-rescore";
  const key = quantCacheKey(unitDir, requestedMode);
  const stat = statEmbeddingIndexPointer(unitDir);
  const resident = quantCache.get(key);
  if (!stat.ok) {
    quantCache.delete(key);
    quantCounters.quantUnusable += 1;
    return {
      ok: false,
      status: "unusable",
      problem: "missing",
      detail: `no readable ${EMBEDDING_INDEX_FILE_NAMES.current} in ${unitDir}`,
    };
  }
  if (
    resident !== undefined &&
    sameSignature(resident.signature, stat.signature)
  ) {
    quantCounters.quantHits += 1;
    touchQuant(key, resident);
    if (resident.status === "unusable") return quantUnusableResult(resident);
    if (
      options.expectation !== undefined &&
      checkEmbeddingQuantSpace(resident.index.meta, options.expectation) !==
        undefined
    ) {
      quantCounters.quantUnusable += 1;
      return {
        ok: false,
        status: "unusable",
        problem: "expectation-mismatch",
        detail: "resident generation does not match the requested space",
      };
    }
    return {
      ok: true,
      index: resident.index,
      status: "hit",
      mode: resident.mode,
      rescoreUnavailable: resident.rescoreUnavailable,
    };
  }

  quantCounters.quantMisses += 1;
  quantCounters.quantReloads += 1;
  const pointerResult = readEmbeddingIndexPointer(unitDir);
  if (!pointerResult.ok) {
    return storeQuantUnusable(
      key,
      stat.signature,
      pointerResult.problem,
      pointerResult.detail,
    );
  }
  const readResult = readEmbeddingQuantIndex(unitDir, {
    pointer: pointerResult.pointer,
    includeFloat32: requestedMode === "int8-rescore",
  });
  if (!readResult.ok) {
    return storeQuantUnusable(
      key,
      pointerResult.signature,
      readResult.problem,
      readResult.detail,
    );
  }
  // A caller-scoped expectation is not cached as unusable: the same generation
  // can be valid for the expectation the next caller passes.
  if (
    options.expectation !== undefined &&
    checkEmbeddingQuantSpace(readResult.snapshot.meta, options.expectation) !==
      undefined
  ) {
    quantCounters.quantUnusable += 1;
    return {
      ok: false,
      status: "unusable",
      problem: "expectation-mismatch",
      detail: "generation does not match the requested space",
    };
  }
  const snapshot = readResult.snapshot;
  storeQuant(key, {
    status: "ready",
    signature: pointerResult.signature,
    index: snapshot,
    mode: snapshot.mode,
    rescoreUnavailable: snapshot.rescoreUnavailable,
  });
  return {
    ok: true,
    index: snapshot,
    status: "loaded",
    mode: snapshot.mode,
    rescoreUnavailable: snapshot.rescoreUnavailable,
  };
}

/**
 * The resident int8 snapshot for a unit/mode, without touching the disk.
 * `undefined` when never loaded, invalidated, or cached as unusable.
 */
export function peekEmbeddingQuantIndex(
  unitDir: string,
  mode: EmbeddingQuantMode = "int8-rescore",
): EmbeddingQuantIndexSnapshot | undefined {
  const entry = quantCache.get(quantCacheKey(unitDir, mode));
  return entry?.status === "ready" ? entry.index : undefined;
}

/** Drops one unit's int8 snapshots (all modes) from the cache. */
export function invalidateEmbeddingQuantIndex(unitDir: string): boolean {
  return dropQuantEntries(unitDir);
}

/** The resident snapshot for a unit, without touching the disk. `undefined` when
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

/**
 * Drops one unit from both caches (for example after it was rebuilt/removed).
 * Returns whether any resident entry existed.
 */
export function invalidateEmbeddingIndex(unitDir: string): boolean {
  const droppedFloat32 = cache.delete(unitDir);
  const droppedInt8 = dropQuantEntries(unitDir);
  return droppedFloat32 || droppedInt8;
}

/** Drops every resident unit; a space switch or a full rebuild calls this. */
export function invalidateAllEmbeddingIndexes(): void {
  cache.clear();
  quantCache.clear();
}

/** Clears the hit/miss counters; tests call this between cases. */
export function resetEmbeddingIndexCacheStats(): void {
  counters.hits = 0;
  counters.misses = 0;
  counters.reloads = 0;
  counters.unusable = 0;
  quantCounters.quantHits = 0;
  quantCounters.quantMisses = 0;
  quantCounters.quantReloads = 0;
  quantCounters.quantUnusable = 0;
}

/** Current cache size and counters. */
export function getEmbeddingIndexCacheStats(): EmbeddingIndexCacheStats {
  return {
    entries: cache.size,
    ...counters,
    quantEntries: quantCache.size,
    ...quantCounters,
  };
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

function storeQuantUnusable(
  key: string,
  signature: Signature,
  problem: EmbeddingIndexProblem,
  detail?: string,
): EmbeddingQuantLoadResult {
  quantCounters.quantUnusable += 1;
  storeQuant(key, {
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

function quantUnusableResult(
  entry: Extract<QuantCacheEntry, { status: "unusable" }>,
): EmbeddingQuantLoadResult {
  quantCounters.quantUnusable += 1;
  return {
    ok: false,
    status: "unusable",
    problem: entry.problem,
    ...(entry.detail === undefined ? {} : { detail: entry.detail }),
  };
}

/** One int8 entry per unit and mode, so an int8-only load never evicts a
 * rescore-capable one merely because the caller switched profiles. */
function quantCacheKey(unitDir: string, mode: EmbeddingQuantMode): string {
  return `${unitDir}\u0000${mode}`;
}

function dropQuantEntries(unitDir: string): boolean {
  const prefix = `${unitDir}\u0000`;
  let removed = false;
  for (const key of quantCache.keys()) {
    if (key.startsWith(prefix)) {
      quantCache.delete(key);
      removed = true;
    }
  }
  return removed;
}

function storeQuant(key: string, entry: QuantCacheEntry): void {
  quantCache.delete(key);
  quantCache.set(key, entry);
  evictLeastRecentlyUsedQuant();
}

function touchQuant(key: string, entry: QuantCacheEntry): void {
  quantCache.delete(key);
  quantCache.set(key, entry);
}

function evictLeastRecentlyUsedQuant(): void {
  while (quantCache.size > EMBEDDING_INDEX_CACHE_MAX_ENTRIES) {
    const oldest = quantCache.keys().next();
    if (oldest.done) return;
    quantCache.delete(oldest.value);
  }
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
