/**
 * Unit tests for the production ANN index (feature 48, package B7).
 *
 * Everything is synthetic: clustered vectors from B6's deterministic dataset
 * generator, no ONNX, no network, no real harness data (docs/31 §1.2 A2). The
 * heavy 850k benchmark lives in `embedding/ann-bench.test.ts`/manual runs; here
 * the corpus stays at a few thousand rows.
 */

import { describe, expect, test } from "bun:test";
import { generateAnnBenchDataset } from "@/backend/local/embedding/ann-bench";
import {
  type AnnIndexBuildInput,
  AnnIndexError,
  type AnnIndexErrorCode,
  type AnnSearchResult,
  type AnnShardedSearchResult,
  type AnnShardInput,
  buildAnnIndex,
  buildFlatAnnIndex,
  buildShardedAnnIndex,
  deserializeAnnIndex,
  rebuildAnnShard,
  resolveAnnIvfOptions,
  searchShardedAnnIndex,
  shouldUseAnn,
} from "@/backend/local/embedding-ann-index";

const DIMENSIONS = 32;
const SEED = 0x48_b7_2026;

function dataset(
  count: number,
  options: { dimensions?: number; queryCount?: number; seed?: number } = {},
) {
  return generateAnnBenchDataset({
    count,
    dimensions: options.dimensions ?? DIMENSIONS,
    queryCount: options.queryCount ?? 6,
    seed: options.seed ?? SEED,
  });
}

function queryOf(
  data: ReturnType<typeof dataset>,
  index: number,
): Float32Array {
  const dimensions = data.dimensions;
  return data.queries.subarray(
    index * dimensions,
    (index + 1) * dimensions,
  ) as Float32Array;
}

function requireOk(
  result: AnnSearchResult,
): Extract<AnnSearchResult, { ok: true }> {
  expect(result.ok).toBe(true);
  if (!result.ok)
    throw new Error(`unexpected search failure: ${result.problem}`);
  return result;
}

function requireShardedOk(
  result: AnnShardedSearchResult,
): Extract<AnnShardedSearchResult, { ok: true }> {
  expect(result.ok).toBe(true);
  if (!result.ok)
    throw new Error(`unexpected search failure: ${result.problem}`);
  return result;
}

function ids(result: AnnSearchResult): number[] {
  return requireOk(result).hits.map((hit) => hit.id);
}

function recallAt(
  found: readonly number[],
  truth: readonly number[],
  k: number,
): number {
  const expected = new Set(truth.slice(0, k));
  if (expected.size === 0) return 1;
  return (
    found.slice(0, k).filter((id) => expected.has(id)).length / expected.size
  );
}

function expectAnnIndexError(
  action: () => unknown,
  code: AnnIndexErrorCode,
): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(AnnIndexError);
    expect((error as AnnIndexError).code).toBe(code);
    return;
  }
  throw new Error(`expected AnnIndexError(${code})`);
}

function expectBytesEqual(left: Uint8Array, right: Uint8Array): void {
  expect(left.byteLength).toBe(right.byteLength);
  for (let index = 0; index < left.byteLength; index += 1) {
    expect(left[index]).toBe(right[index]);
  }
}

function inputOf(data: ReturnType<typeof dataset>): AnnIndexBuildInput {
  return {
    vectors: data.vectors,
    count: data.count,
    dimensions: data.dimensions,
  };
}

describe("shouldUseAnn (48-2 §4.10 trigger)", () => {
  test("count trigger is strictly above 200k", () => {
    expect(shouldUseAnn(0)).toBe(false);
    expect(shouldUseAnn(199_999)).toBe(false);
    expect(shouldUseAnn(200_000)).toBe(false);
    expect(shouldUseAnn(200_001)).toBe(true);
    expect(shouldUseAnn(850_000)).toBe(true);
  });

  test("latency trigger is strictly above 150ms", () => {
    expect(shouldUseAnn(1_000, 0)).toBe(false);
    expect(shouldUseAnn(1_000, 150)).toBe(false);
    expect(shouldUseAnn(1_000, 150.001)).toBe(true);
    expect(shouldUseAnn(200_000, 10)).toBe(false);
  });

  test("missing latency means count-only; invalid input throws", () => {
    expect(shouldUseAnn(100_000)).toBe(false);
    expect(shouldUseAnn(100_000, undefined)).toBe(false);
    expectAnnIndexError(() => shouldUseAnn(-1), "invalid-input");
    expectAnnIndexError(() => shouldUseAnn(1.5), "invalid-input");
    expectAnnIndexError(() => shouldUseAnn(1_000, Number.NaN), "invalid-input");
    expectAnnIndexError(() => shouldUseAnn(1_000, -1), "invalid-input");
  });
});

describe("default parameters (B6 decision table)", () => {
  test("nlist ≈ √count with the documented caps", () => {
    expect(resolveAnnIvfOptions(1_000)).toEqual({
      nlist: 32,
      nprobe: 4,
      trainSample: 1_000,
      iterations: 4,
    });
    expect(resolveAnnIvfOptions(100_000)).toEqual({
      nlist: 316,
      nprobe: 40,
      trainSample: 4_096,
      iterations: 4,
    });
    const large = resolveAnnIvfOptions(250_000);
    expect(large.nlist).toBe(256);
    expect(large.nprobe).toBe(32);
    expect(large.trainSample).toBe(4_096);
    expect(resolveAnnIvfOptions(0)).toEqual({
      nlist: 0,
      nprobe: 0,
      trainSample: 0,
      iterations: 0,
    });
  });

  test("explicit overrides are clamped coherently", () => {
    const resolved = resolveAnnIvfOptions(1_000, {
      nlist: 8,
      nprobe: 99,
      trainSample: 64,
      iterations: 2,
    });
    expect(resolved).toEqual({
      nlist: 8,
      nprobe: 8,
      trainSample: 64,
      iterations: 2,
    });
    expectAnnIndexError(
      () => resolveAnnIvfOptions(100, { nlist: 0 }),
      "invalid-options",
    );
    expectAnnIndexError(
      () => resolveAnnIvfOptions(100, { nprobe: 0 }),
      "invalid-options",
    );
    expectAnnIndexError(
      () => resolveAnnIvfOptions(100, { iterations: 0 }),
      "invalid-options",
    );
  });
});

describe("IVF build and search", () => {
  const data = dataset(2_000);

  test("default parameters keep recall@10 high against flat truth", () => {
    const index = buildAnnIndex(inputOf(data));
    const flat = buildFlatAnnIndex(inputOf(data));
    expect(index.kind).toBe("ivf");
    const stats = index.stats();
    expect(stats.count).toBe(2_000);
    expect(stats.dimensions).toBe(DIMENSIONS);
    expect(stats.params.nlist).toBe(resolveAnnIvfOptions(2_000).nlist);
    for (let query = 0; query < data.queryCount; query += 1) {
      const vector = queryOf(data, query);
      const truth = ids(flat.search(vector, 10));
      const result = requireOk(index.search(vector, 10));
      expect(
        recallAt(
          result.hits.map((hit) => hit.id),
          truth,
          10,
        ),
      ).toBeGreaterThanOrEqual(0.9);
      expect(result.scannedVectors).toBeLessThan(data.count);
    }
  });

  test("probing every list reproduces flat exactly", () => {
    const index = buildAnnIndex(inputOf(data), {
      ivf: { nlist: 16, nprobe: 16, trainSample: 256, iterations: 2 },
    });
    const flat = buildFlatAnnIndex(inputOf(data));
    const vector = queryOf(data, 0);
    const ann = requireOk(index.search(vector, 10));
    const exact = requireOk(flat.search(vector, 10));
    expect(ann.hits.map((hit) => hit.id)).toEqual(
      exact.hits.map((hit) => hit.id),
    );
    for (const [position, hit] of ann.hits.entries()) {
      expect(hit.score).toBeCloseTo(exact.hits[position]?.score ?? 0, 6);
    }
  });

  test("more probes scan more lists and never lose recall", () => {
    const vector = queryOf(data, 0);
    const truth = ids(buildFlatAnnIndex(inputOf(data)).search(vector, 10));
    const narrow = buildAnnIndex(inputOf(data), {
      ivf: { nlist: 16, nprobe: 1, trainSample: 256, iterations: 2 },
    });
    const full = buildAnnIndex(inputOf(data), {
      ivf: { nlist: 16, nprobe: 16, trainSample: 256, iterations: 2 },
    });
    const narrowResult = requireOk(narrow.search(vector, 10));
    const fullResult = requireOk(full.search(vector, 10));
    expect(narrowResult.scannedVectors).toBeLessThan(fullResult.scannedVectors);
    expect(
      recallAt(
        fullResult.hits.map((hit) => hit.id),
        truth,
        10,
      ),
    ).toBe(1);
    expect(
      recallAt(
        narrowResult.hits.map((hit) => hit.id),
        truth,
        10,
      ),
    ).toBeLessThanOrEqual(1);
  });

  test("an empty corpus builds and searches cleanly", () => {
    const empty: AnnIndexBuildInput = {
      vectors: new Float32Array(0),
      count: 0,
      dimensions: 16,
    };
    const index = buildAnnIndex(empty);
    expect(index.stats()).toEqual({
      kind: "ivf",
      count: 0,
      dimensions: 16,
      indexBytes: 36,
      params: { nlist: 0, nprobe: 0, trainSample: 0, iterations: 0 },
    });
    const result = requireOk(index.search(new Float32Array(16), 5));
    expect(result.hits).toEqual([]);
    expect(result.scannedVectors).toBe(0);
    const restored = deserializeAnnIndex(index.serialize(), empty);
    expect(restored.stats()).toEqual(index.stats());
  });

  test("build rejects malformed input and impossible options", () => {
    const bad = {
      vectors: new Float32Array(10),
      count: 3,
      dimensions: 4,
    };
    expectAnnIndexError(() => buildAnnIndex(bad), "invalid-input");
    expectAnnIndexError(
      () =>
        buildAnnIndex({
          vectors: new Float32Array(4),
          count: 1,
          dimensions: 0,
        }),
      "invalid-input",
    );
    expectAnnIndexError(
      () =>
        buildAnnIndex({
          vectors: [0, 1, 2, 3] as unknown as Float32Array,
          count: 1,
          dimensions: 4,
        }),
      "invalid-input",
    );
    expectAnnIndexError(
      () => buildAnnIndex(inputOf(data), { ivf: { nlist: 0 } }),
      "invalid-options",
    );
  });
});

describe("determinism", () => {
  const data = dataset(600, { dimensions: 16 });

  test("equal input yields byte-equal sidecars and equal hits", () => {
    const options = { ivf: { nlist: 8, nprobe: 4, trainSample: 128 } };
    const first = buildAnnIndex(inputOf(data), options);
    const second = buildAnnIndex(inputOf(data), options);
    expect(first.stats()).toEqual(second.stats());
    expectBytesEqual(first.serialize(), second.serialize());
    for (let query = 0; query < data.queryCount; query += 1) {
      const vector = queryOf(data, query);
      expect(first.search(vector, 10)).toEqual(second.search(vector, 10));
    }
  });

  test("metadata is carried through build and round-trip", () => {
    const input: AnnIndexBuildInput = {
      ...inputOf(data),
      meta: { agentId: "agent", spaceId: "space", generation: "g1" },
    };
    const index = buildAnnIndex(input, { ivf: { nlist: 4, nprobe: 2 } });
    expect(index.meta).toEqual(input.meta);
    const restored = deserializeAnnIndex(index.serialize(), input);
    expect(restored.meta).toEqual(input.meta);
  });
});

describe("search validation", () => {
  const data = dataset(200, { dimensions: 16 });
  const index = buildFlatAnnIndex(inputOf(data));

  test("empty query, wrong width and bad k are typed failures", () => {
    expect(index.search(new Float32Array(0), 5)).toEqual(
      expect.objectContaining({ ok: false, problem: "empty-query" }),
    );
    expect(index.search(new Float32Array(15), 5)).toEqual(
      expect.objectContaining({ ok: false, problem: "dimension-mismatch" }),
    );
    for (const k of [0, -1, 1.5, Number.NaN]) {
      expect(index.search(queryOf(data, 0), k)).toEqual(
        expect.objectContaining({ ok: false, problem: "invalid-k" }),
      );
    }
  });

  test("top-k larger than the corpus returns every row", () => {
    const result = requireOk(index.search(queryOf(data, 0), 10_000));
    expect(result.hits).toHaveLength(data.count);
    expect(result.scannedVectors).toBe(data.count);
  });
});

describe("serialization (auxiliary sidecar only)", () => {
  const data = dataset(500, { dimensions: 16 });
  const options = {
    ivf: { nlist: 8, nprobe: 4, trainSample: 256, iterations: 2 },
  };

  test("IVF round-trips stats, search and bytes", () => {
    const input = inputOf(data);
    const index = buildAnnIndex(input, options);
    const sidecar = index.serialize();
    expect(sidecar.byteLength).toBe(index.stats().indexBytes);
    expect(sidecar.byteLength).toBe(36 + 8 * 16 * 4 + (8 + 1) * 4 + 500 * 4);
    const restored = deserializeAnnIndex(sidecar, input);
    expect(restored.kind).toBe("ivf");
    expect(restored.stats()).toEqual(index.stats());
    expectBytesEqual(restored.serialize(), sidecar);
    for (let query = 0; query < data.queryCount; query += 1) {
      const vector = queryOf(data, query);
      expect(restored.search(vector, 10)).toEqual(index.search(vector, 10));
    }
  });

  test("flat round-trips with a header-only sidecar", () => {
    const input = inputOf(data);
    const index = buildFlatAnnIndex(input);
    const sidecar = index.serialize();
    expect(sidecar.byteLength).toBe(36);
    expect(index.stats().indexBytes).toBe(36);
    const restored = deserializeAnnIndex(sidecar, input);
    expect(restored.kind).toBe("flat");
    expect(restored.stats()).toEqual(index.stats());
    expect(restored.search(queryOf(data, 0), 10)).toEqual(
      index.search(queryOf(data, 0), 10),
    );
  });

  test("corrupt sidecars fail with a typed corrupt-serialized error", () => {
    const input = inputOf(data);
    const sidecar = buildAnnIndex(input, options).serialize();
    const mutated = sidecar.slice();
    mutated[40] = (mutated[40] ?? 0) ^ 0xff;
    expectAnnIndexError(
      () => deserializeAnnIndex(mutated, input),
      "corrupt-serialized",
    );
    const badMagic = sidecar.slice();
    badMagic[0] = 0;
    expectAnnIndexError(
      () => deserializeAnnIndex(badMagic, input),
      "corrupt-serialized",
    );
    expectAnnIndexError(
      () => deserializeAnnIndex(sidecar.subarray(0, 10), input),
      "corrupt-serialized",
    );
    expectAnnIndexError(
      () =>
        deserializeAnnIndex(sidecar, {
          ...input,
          count: input.count - 1,
          vectors: input.vectors.subarray(0, (input.count - 1) * 16),
        }),
      "corrupt-serialized",
    );
    const unknownKind = sidecar.slice();
    unknownKind[6] = 9;
    expectAnnIndexError(
      () => deserializeAnnIndex(unknownKind, input),
      "corrupt-serialized",
    );
    const flatWithPayload = buildFlatAnnIndex(input).serialize();
    const padded = new Uint8Array(flatWithPayload.byteLength + 4);
    padded.set(flatWithPayload);
    expectAnnIndexError(
      () => deserializeAnnIndex(padded, input),
      "corrupt-serialized",
    );
  });
});

function shardInput(
  agentId: string,
  spaceId: string,
  data: ReturnType<typeof dataset>,
): AnnShardInput {
  return {
    agentId,
    spaceId,
    vectors: data.vectors,
    count: data.count,
    dimensions: data.dimensions,
  };
}

function combinedFlatTruth(
  shards: readonly AnnShardInput[],
  query: Float32Array,
  k: number,
): { agentId: string; spaceId: string; id: number }[] {
  const dimensions = shards[0]?.dimensions ?? 0;
  const total = shards.reduce((sum, shard) => sum + shard.count, 0);
  const vectors = new Float32Array(total * dimensions);
  const offsets: number[] = [];
  let offset = 0;
  for (const shard of shards) {
    offsets.push(offset);
    vectors.set(shard.vectors, offset * dimensions);
    offset += shard.count;
  }
  const flat = requireOk(
    buildFlatAnnIndex({ vectors, count: total, dimensions }).search(query, k),
  );
  return flat.hits.map((hit) => {
    for (let index = shards.length - 1; index >= 0; index -= 1) {
      const shard = shards[index];
      const start = offsets[index] ?? 0;
      if (shard !== undefined && hit.id >= start) {
        return {
          agentId: shard.agentId,
          spaceId: shard.spaceId,
          id: hit.id - start,
        };
      }
    }
    throw new Error(`unknown global id ${hit.id}`);
  });
}

function shardedAddresses(
  result: AnnShardedSearchResult,
): { agentId: string; spaceId: string; id: number }[] {
  return requireShardedOk(result).hits.map((hit) => ({
    agentId: hit.agentId,
    spaceId: hit.spaceId,
    id: hit.id,
  }));
}

describe("sharded index", () => {
  const dataA = dataset(120, { dimensions: 16, seed: 11, queryCount: 3 });
  const dataB = dataset(90, { dimensions: 16, seed: 12, queryCount: 3 });
  const shardA = shardInput("agent-a", "space-1", dataA);
  const shardB = shardInput("agent-b", "space-2", dataB);
  const shards: [AnnShardInput, AnnShardInput] = [shardA, shardB];

  test("small shards fall back to flat and merge to the global top-k", () => {
    const index = buildShardedAnnIndex(shards);
    expect(index.kind).toBe("sharded");
    expect(index.dimensions).toBe(16);
    expect(index.shardKeys()).toEqual([
      { agentId: "agent-a", spaceId: "space-1" },
      { agentId: "agent-b", spaceId: "space-2" },
    ]);
    expect(index.shard("agent-a", "space-1")?.kind).toBe("flat");
    expect(index.shard("agent-b", "space-2")?.kind).toBe("flat");
    expect(index.shard("missing", "space")).toBeUndefined();

    const stats = index.stats();
    expect(stats).toEqual({
      kind: "sharded",
      shardCount: 2,
      count: 210,
      dimensions: 16,
      indexBytes: 72,
      params: { shards: 2, ivfShards: 0, flatShards: 2 },
    });

    for (let query = 0; query < 3; query += 1) {
      const vector = queryOf(dataA, query);
      const result = requireShardedOk(index.search(vector, 10));
      expect(shardedAddresses(result)).toEqual(
        combinedFlatTruth(shards, vector, 10),
      );
    }
  });

  test("searchShardedAnnIndex defaults to top-50", () => {
    const index = buildShardedAnnIndex(shards);
    const result = requireShardedOk(
      searchShardedAnnIndex(index, queryOf(dataA, 0)),
    );
    expect(result.hits).toHaveLength(50);
    const explicit = requireShardedOk(
      searchShardedAnnIndex(index, queryOf(dataA, 0), { topK: 7 }),
    );
    expect(explicit.hits).toHaveLength(7);
  });

  test("forcing IVF still equals flat when every list is probed", () => {
    const index = buildShardedAnnIndex(shards, {
      flatThreshold: 0,
      ivf: { nlist: 4, nprobe: 4, trainSample: 64, iterations: 2 },
    });
    expect(index.shard("agent-a", "space-1")?.kind).toBe("ivf");
    expect(index.shard("agent-b", "space-2")?.kind).toBe("ivf");
    const vector = queryOf(dataA, 0);
    expect(shardedAddresses(index.search(vector, 10))).toEqual(
      combinedFlatTruth(shards, vector, 10),
    );
    const stats = index.stats();
    expect(stats.params.ivfShards).toBe(2);
    expect(stats.params.flatShards).toBe(0);
  });

  test("tie-breaking across shards is deterministic", () => {
    const vector = new Float32Array(4);
    vector[0] = 1;
    const index = buildShardedAnnIndex([
      {
        agentId: "b",
        spaceId: "space",
        vectors: vector.slice(),
        count: 1,
        dimensions: 4,
      },
      {
        agentId: "a",
        spaceId: "space",
        vectors: vector.slice(),
        count: 1,
        dimensions: 4,
      },
    ]);
    const hits = requireShardedOk(index.search(vector, 2)).hits;
    expect(hits.map((hit) => hit.agentId)).toEqual(["a", "b"]);
  });

  test("typed failures and invalid shard sets", () => {
    const index = buildShardedAnnIndex(shards);
    expect(index.search(new Float32Array(0), 5)).toEqual(
      expect.objectContaining({ ok: false, problem: "empty-query" }),
    );
    expect(index.search(new Float32Array(15), 5)).toEqual(
      expect.objectContaining({ ok: false, problem: "dimension-mismatch" }),
    );
    expect(index.search(new Float32Array(16), 0)).toEqual(
      expect.objectContaining({ ok: false, problem: "invalid-k" }),
    );
    expectAnnIndexError(() => buildShardedAnnIndex([]), "invalid-input");
    expectAnnIndexError(
      () => buildShardedAnnIndex([shardA, shardA]),
      "invalid-input",
    );
    expectAnnIndexError(
      () => buildShardedAnnIndex([shardA, { ...shardB, dimensions: 8 }]),
      "invalid-input",
    );
    expectAnnIndexError(
      () => buildShardedAnnIndex([{ ...shardA, agentId: "" }]),
      "invalid-input",
    );
  });
});

describe("rebuildAnnShard (generation-aligned incremental rebuild)", () => {
  const dataA = dataset(120, { dimensions: 16, seed: 21 });
  const dataB = dataset(90, { dimensions: 16, seed: 22 });
  const shardA = shardInput("agent-a", "space-1", dataA);
  const shardB = shardInput("agent-b", "space-2", dataB);

  test("only the replaced shard changes; others are the same objects", () => {
    const index = buildShardedAnnIndex([shardA, shardB]);
    const originalA = index.shard("agent-a", "space-1");
    const originalB = index.shard("agent-b", "space-2");
    expect(originalA).toBeDefined();
    expect(originalB).toBeDefined();

    const next = dataset(150, { dimensions: 16, seed: 23 });
    const rebuilt = rebuildAnnShard(
      index,
      shardInput("agent-a", "space-1", next),
    );
    expect(rebuilt).not.toBe(index);
    expect(rebuilt.shard("agent-a", "space-1")).not.toBe(originalA);
    expect(rebuilt.shard("agent-b", "space-2")).toBe(originalB);
    expect(rebuilt.stats().count).toBe(240);
    expect(rebuilt.shardKeys()).toEqual(index.shardKeys());

    const vector = new Float32Array(16);
    vector.set(next.vectors.subarray(0, 16));
    const hits = requireShardedOk(rebuilt.search(vector, 1)).hits;
    expect(hits[0]).toEqual(
      expect.objectContaining({
        agentId: "agent-a",
        spaceId: "space-1",
        id: 0,
      }),
    );
  });

  test("rebuilding adds a shard and undefined builds a fresh handle", () => {
    const index = buildShardedAnnIndex([shardA]);
    const next = dataset(60, { dimensions: 16, seed: 24 });
    const added = rebuildAnnShard(
      index,
      shardInput("agent-c", "space-3", next),
    );
    expect(added.stats().shardCount).toBe(2);
    expect(added.stats().count).toBe(180);
    expect(added.shard("agent-c", "space-3")).toBeDefined();

    const fresh = rebuildAnnShard(undefined, shardA);
    expect(fresh.stats().shardCount).toBe(1);
    expect(fresh.stats().count).toBe(120);
  });

  test("a width change is rejected instead of mixing spaces", () => {
    const index = buildShardedAnnIndex([shardA]);
    const otherWidth = dataset(20, { dimensions: 8, seed: 25 });
    expectAnnIndexError(
      () =>
        rebuildAnnShard(index, shardInput("agent-d", "space-4", otherWidth)),
      "invalid-input",
    );
  });
});

describe("stats and sidecar accounting", () => {
  test("IVF indexBytes matches the serialized sidecar and the estimate", () => {
    const data = dataset(700, { dimensions: 16 });
    const options = {
      ivf: { nlist: 12, nprobe: 3, trainSample: 256, iterations: 2 },
    };
    const index = buildAnnIndex(inputOf(data), options);
    const stats = index.stats();
    expect(stats.indexBytes).toBeGreaterThan(0);
    expect(index.serialize().byteLength).toBe(stats.indexBytes);
    expect(
      stats.indexBytes - (12 * 16 * 4 + (12 + 1) * 4 + data.count * 4),
    ).toBeGreaterThan(0);
    expect(stats.params).toEqual({
      nlist: 12,
      nprobe: 3,
      trainSample: 256,
      iterations: 2,
    });
  });

  test("flat and sharded sidecars report their resident sizes", () => {
    const data = dataset(100, { dimensions: 8 });
    expect(buildFlatAnnIndex(inputOf(data)).stats().indexBytes).toBe(36);
    const shards = [
      shardInput("a", "s", data),
      shardInput("b", "s", dataset(80, { dimensions: 8, seed: 26 })),
    ];
    const index = buildShardedAnnIndex(shards);
    expect(index.stats().indexBytes).toBe(72);
  });
});
