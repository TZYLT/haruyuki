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
} from "./embedding-cache";
import {
  type EmbeddingIndexSnapshot,
  embeddingVectorUnitDir,
} from "./embedding-format";

export type LoadedUnit = {
  unit: AnnSearchUnit;
  key: string;
  snapshot: EmbeddingIndexSnapshot;
};

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
