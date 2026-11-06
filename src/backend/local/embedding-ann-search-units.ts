/**
 * B2 unit loading for the ANN query path (feature 48, package A6).
 *
 * One shard is every unit of a `(agentId, spaceId)` space. Loading goes through
 * B2's resident cache (`loadEmbeddingIndex`) so a warm query costs one
 * `stat(current.json)` per unit, never a vectors re-read. Units that fail to
 * load are collected as reason strings, not thrown: recall degrades to what is
 * readable.
 */

import {
  type AnnSearchShard,
  type AnnSearchSpace,
  type AnnSearchUnit,
  type AnnSearchUnitSource,
  errorMessage,
  unitIdentity,
  unitIdentityKey,
  unitKeyOf,
} from "./embedding-ann-search-shared";
import {
  type EmbeddingIndexExpectation,
  loadEmbeddingIndex,
  loadEmbeddingQuantIndex,
} from "./embedding-cache";
import {
  type EmbeddingIndexQuant,
  type EmbeddingIndexSnapshot,
  embeddingVectorUnitDir,
} from "./embedding-format";
import type { EmbeddingQuantIndexSnapshot } from "./embedding-quant-format";

/** A B2 snapshot: float32 (`vectors.bin`) or native int8 (codes + scales). */
export type LoadedUnitSnapshot =
  | EmbeddingIndexSnapshot
  | EmbeddingQuantIndexSnapshot;

export type LoadedUnit = {
  unit: AnnSearchUnit;
  key: string;
  snapshot: LoadedUnitSnapshot;
};

/** A unit whose resident snapshot carries float32 vectors. */
export type FlatLoadedUnit = Omit<LoadedUnit, "snapshot"> & {
  snapshot: EmbeddingIndexSnapshot;
};

/** A unit whose resident snapshot carries int8 codes and per-row scales. */
export type QuantLoadedUnit = Omit<LoadedUnit, "snapshot"> & {
  snapshot: EmbeddingQuantIndexSnapshot;
};

/** The encoding of a loaded unit's snapshot (`int8` spaces use codes). */
export function unitSnapshotQuant(entry: LoadedUnit): EmbeddingIndexQuant {
  return entry.snapshot.meta.quant === "int8" ? "int8" : "f32";
}

export function isFlatUnit(entry: LoadedUnit): entry is FlatLoadedUnit {
  return entry.snapshot.meta.quant !== "int8";
}

export function isQuantUnit(entry: LoadedUnit): entry is QuantLoadedUnit {
  return entry.snapshot.meta.quant === "int8";
}

export type LoadedShard = {
  agentId: string;
  spaceId: string;
  /** Units requested by the caller (after de-duplication). */
  requested: number;
  /** Units whose B2 generation loaded and validated. */
  entries: LoadedUnit[];
  /** One line per unusable unit, for the result's reason text. */
  problems: string[];
  chunkCount: number;
  /** Uniform width of the usable units, `undefined` when mixed/empty. */
  dimensions: number | undefined;
};

export function resolveUnitSource(
  source: AnnSearchUnitSource,
  scope: unknown,
): readonly AnnSearchUnit[] {
  return typeof source === "function" ? source(scope as never) : source;
}

export function loadShard(
  shard: AnnSearchShard,
  root: string,
  expectation: EmbeddingIndexExpectation | undefined,
  scope: unknown,
): LoadedShard {
  const space: AnnSearchSpace = {
    agentId: shard.agentId,
    spaceId: shard.spaceId,
  };
  const units = resolveUnitSource(shard.units, scope);
  const entries: LoadedUnit[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  let requested = 0;
  for (const unit of units) {
    const key = unitKeyOf(unit);
    const identity = unitIdentityKey({ kind: unit.kind, key });
    if (seen.has(identity)) continue;
    seen.add(identity);
    requested += 1;
    let unitDir: string;
    try {
      unitDir = embeddingVectorUnitDir(unitIdentity(unit, space), { root });
    } catch (error) {
      problems.push(`${unit.kind}:${key}: ${errorMessage(error)}`);
      continue;
    }
    if ((expectation?.quant ?? "f32") === "int8") {
      // Native int8: the resident snapshot is codes + scales, never a float32
      // view (the memory int8 exists to avoid). `int8-only` also keeps a
      // legacy rescore file out of memory.
      const loaded = loadEmbeddingQuantIndex(unitDir, {
        mode: "int8-only",
        expectation,
      });
      if (!loaded.ok) {
        problems.push(
          `${unit.kind}:${key}: ${loaded.problem}${loaded.detail === undefined ? "" : ` (${loaded.detail})`}`,
        );
        continue;
      }
      entries.push({ unit, key, snapshot: loaded.index });
      continue;
    }
    const loaded = loadEmbeddingIndex(unitDir, { expectation });
    if (!loaded.ok) {
      problems.push(
        `${unit.kind}:${key}: ${loaded.problem}${loaded.detail === undefined ? "" : ` (${loaded.detail})`}`,
      );
      continue;
    }
    entries.push({ unit, key, snapshot: loaded.index });
  }
  const chunkCount = entries.reduce(
    (total, entry) => total + entry.snapshot.meta.chunkCount,
    0,
  );
  let dimensions: number | undefined;
  for (const entry of entries) {
    if (dimensions === undefined) dimensions = entry.snapshot.meta.dimensions;
    else if (dimensions !== entry.snapshot.meta.dimensions) {
      dimensions = undefined;
      break;
    }
  }
  return {
    agentId: space.agentId,
    spaceId: space.spaceId,
    requested,
    entries,
    problems,
    chunkCount,
    dimensions,
  };
}
