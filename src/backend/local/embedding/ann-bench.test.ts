/**
 * Unit tests for the B6 ANN benchmark (feature 48, package B6).
 *
 * The large 850k run is deliberately excluded: it is a manual benchmark, not a
 * CI-shaped test. Everything here stays at 1k–10k rows, and the heaviest case
 * (IVF recall at 10k) is one ~1.5 s run.
 */

import { describe, expect, test } from "bun:test";
import {
  ANN_BENCH_DEFAULT_DIMENSIONS,
  ANN_BENCH_DEFAULT_TOP_K,
  ANN_BENCH_KINDS,
  ANN_BENCH_SCALES,
  buildAnnIndex,
  buildFlatAnnIndex,
  buildIvfFlatAnnIndex,
  buildSimHashAnnIndex,
  defaultAnnBenchQueryCount,
  estimateIvfFlatIndexBytes,
  estimateSimHashIndexBytes,
  formatAnnBenchSummary,
  generateAnnBenchDataset,
  percentile,
  resolveAnnBenchScale,
  resolveIvfFlatOptions,
  runAnnBench,
} from "@/backend/local/embedding/ann-bench";
import type { EmbeddingIndexSnapshot } from "@/backend/local/embedding-format";
import { searchEmbeddingIndex } from "@/backend/local/embedding-search";
import {
  cosineSimilarity,
  EMBEDDING_FIXTURE_DIMENSIONS,
  EMBEDDING_FIXTURE_TEXTS,
  fakeEmbeddingVector,
} from "@/test-utils/embedding-fixture";

const SMALL = {
  count: 64,
  dimensions: 16,
  queryCount: 4,
  seed: 1234,
} as const;

function expectArrayEqual(
  left: ArrayLike<number>,
  right: ArrayLike<number>,
): void {
  expect(left.length).toBe(right.length);
  for (let index = 0; index < left.length; index += 1) {
    expect(left[index]).toBe(right[index]);
  }
}

describe("deterministic dataset", () => {
  test("same seed produces byte-identical corpus and queries", () => {
    const left = generateAnnBenchDataset(SMALL);
    const right = generateAnnBenchDataset(SMALL);
    expectArrayEqual(left.vectors, right.vectors);
    expectArrayEqual(left.queries, right.queries);
    expect(left.clusterCount).toBe(right.clusterCount);
  });

  test("a different seed produces different rows", () => {
    const left = generateAnnBenchDataset(SMALL);
    const right = generateAnnBenchDataset({ ...SMALL, seed: 99 });
    expect(left.vectors).not.toEqual(right.vectors);
  });

  test("rows and queries are L2-normalized", () => {
    const dataset = generateAnnBenchDataset(SMALL);
    for (const row of [0, 1, 2]) {
      const offset = row * dataset.dimensions;
      const view = dataset.vectors.subarray(
        offset,
        offset + dataset.dimensions,
      );
      const norm = Math.sqrt(
        [...view].reduce((sum, value) => sum + value ** 2, 0),
      );
      expect(norm).toBeCloseTo(1, 5);
    }
    const query = dataset.queries.subarray(0, dataset.dimensions);
    const norm = Math.sqrt(
      [...query].reduce((sum, value) => sum + value ** 2, 0),
    );
    expect(norm).toBeCloseTo(1, 5);
  });

  test("a run is reproducible in its structural fields", () => {
    const first = runAnnBench({
      scale: 1_000,
      queryCount: 8,
      candidates: ["flat", "ivf"],
    });
    const second = runAnnBench({
      scale: 1_000,
      queryCount: 8,
      candidates: ["flat", "ivf"],
    });
    expect(first.candidates.map((row) => row.kind)).toEqual(["flat", "ivf"]);
    for (const row of first.candidates) {
      const other = second.candidates.find(
        (candidate) => candidate.kind === row.kind,
      );
      expect(other).toBeDefined();
      if (other === undefined) continue;
      expect(other.indexBytes).toBe(row.indexBytes);
      expect(other.recallAt10).toBe(row.recallAt10);
      expect(other.recallAt50).toBe(row.recallAt50);
      expect(other.params).toEqual(row.params);
    }
    expect(first.summary).toContain("ANN benchmark");
    expect(first.summary).toContain("recall@10");
  });
});

describe("scales and defaults", () => {
  test("the brief's scales are present", () => {
    expect(ANN_BENCH_SCALES["1k"]).toBe(1_000);
    expect(ANN_BENCH_SCALES["10k"]).toBe(10_000);
    expect(ANN_BENCH_SCALES["100k"]).toBe(100_000);
    expect(ANN_BENCH_SCALES["850k"]).toBe(850_000);
  });

  test("named and raw scales resolve; defaults are 10k", () => {
    expect(resolveAnnBenchScale()).toEqual({ name: "10k", count: 10_000 });
    expect(resolveAnnBenchScale("1k")).toEqual({ name: "1k", count: 1_000 });
    expect(resolveAnnBenchScale(2_000)).toEqual({
      name: "custom",
      count: 2_000,
    });
  });

  test("defaults match the phase-1 model and query-arm budget", () => {
    expect(ANN_BENCH_DEFAULT_DIMENSIONS).toBe(512);
    expect(ANN_BENCH_DEFAULT_TOP_K).toBe(50);
    expect(defaultAnnBenchQueryCount(1_000)).toBe(64);
    expect(defaultAnnBenchQueryCount(850_000)).toBe(16);
    expect(ANN_BENCH_KINDS).toEqual(["flat", "ivf", "simhash"]);
  });

  test("invalid scale, count, dimensions and candidates throw", () => {
    expect(() => resolveAnnBenchScale("bogus" as never)).toThrow(RangeError);
    expect(() => resolveAnnBenchScale(0)).toThrow(RangeError);
    expect(() => resolveAnnBenchScale(-5)).toThrow(RangeError);
    expect(() => resolveAnnBenchScale(1.5)).toThrow(RangeError);
    expect(() => generateAnnBenchDataset({ count: 0 })).toThrow(RangeError);
    expect(() => runAnnBench({ scale: 0 })).toThrow(RangeError);
    expect(() => runAnnBench({ scale: "1k", dimensions: 0 })).toThrow(
      RangeError,
    );
    expect(() => runAnnBench({ scale: "1k", topK: 0 })).toThrow(RangeError);
    expect(() => runAnnBench({ scale: "1k", queryCount: 0 })).toThrow(
      RangeError,
    );
    expect(() => runAnnBench({ scale: "1k", candidates: [] })).toThrow(
      RangeError,
    );
  });
});

describe("percentiles", () => {
  test("nearest-rank p50/p95 over known samples", () => {
    const samples = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(samples, 50)).toBe(5);
    expect(percentile(samples, 95)).toBe(10);
    expect(percentile([7], 50)).toBe(7);
  });

  test("empty samples or an invalid percent throw", () => {
    expect(() => percentile([], 50)).toThrow(RangeError);
    expect(() => percentile([1], 0)).toThrow(RangeError);
    expect(() => percentile([1], 101)).toThrow(RangeError);
  });

  test("bench rows report a sane p50 ≤ p95", () => {
    const result = runAnnBench({ scale: 1_000, queryCount: 8 });
    for (const row of result.candidates) {
      expect(row.p50Ms).toBeGreaterThan(0);
      expect(row.p95Ms).toBeGreaterThanOrEqual(row.p50Ms);
    }
  });
});

describe("search input validation", () => {
  const dataset = generateAnnBenchDataset({ ...SMALL, count: 32 });
  const input = {
    vectors: dataset.vectors,
    count: dataset.count,
    dimensions: dataset.dimensions,
  };

  for (const kind of ANN_BENCH_KINDS) {
    test(`${kind} rejects empty queries, wrong dimensions and bad k`, () => {
      const index = buildAnnIndex(kind, input);
      expect(index.search(new Float32Array(0), 5)).toEqual(
        expect.objectContaining({ ok: false, problem: "empty-query" }),
      );
      expect(index.search(new Float32Array(dataset.dimensions + 1), 5)).toEqual(
        expect.objectContaining({ ok: false, problem: "dimension-mismatch" }),
      );
      expect(
        index.search(dataset.queries.subarray(0, dataset.dimensions), 0),
      ).toEqual(expect.objectContaining({ ok: false, problem: "invalid-k" }));
    });
  }

  test("build rejects a vector/count mismatch", () => {
    expect(() =>
      buildFlatAnnIndex({
        vectors: new Float32Array(3),
        count: 2,
        dimensions: 2,
      }),
    ).toThrow(RangeError);
    expect(() =>
      buildIvfFlatAnnIndex({
        vectors: new Float32Array(3),
        count: 2,
        dimensions: 2,
      }),
    ).toThrow(RangeError);
    expect(() =>
      buildSimHashAnnIndex({
        vectors: new Float32Array(3),
        count: 2,
        dimensions: 2,
      }),
    ).toThrow(RangeError);
  });

  test("top-k larger than the corpus returns every row", () => {
    const index = buildFlatAnnIndex({
      vectors: dataset.vectors.subarray(0, 4 * dataset.dimensions),
      count: 4,
      dimensions: dataset.dimensions,
    });
    const result = index.search(
      dataset.queries.subarray(0, dataset.dimensions),
      10,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hits).toHaveLength(4);
    expect(result.scannedVectors).toBe(4);
  });
});

describe("IVF quality", () => {
  test("recall@10 is ≥ 0.9 at 10k rows with the default parameters", () => {
    const result = runAnnBench({
      scale: "10k",
      queryCount: 16,
      candidates: ["flat", "ivf"],
    });
    const ivf = result.candidates.find((row) => row.kind === "ivf");
    expect(ivf).toBeDefined();
    if (ivf === undefined) return;
    expect(ivf.recallAt10).toBeGreaterThanOrEqual(0.9);
    expect(ivf.recallAt50).toBeGreaterThanOrEqual(0.95);
    expect(ivf.meanScannedVectors).toBeLessThan(result.count);
    expect(ivf.p50Ms).toBeLessThan(50);
    expect(ivf.params.nlist).toBeGreaterThan(0);
    expect(ivf.params.nprobe).toBeGreaterThan(0);
    expect(ivf.buildMs).toBeGreaterThan(0);
  }, 30_000);

  test("simhash runs and is deterministic across builds", () => {
    const dataset = generateAnnBenchDataset({ ...SMALL, count: 256 });
    const input = {
      vectors: dataset.vectors,
      count: dataset.count,
      dimensions: dataset.dimensions,
    };
    const options = { bits: 32, bands: 4 };
    const first = buildSimHashAnnIndex(input, options);
    const second = buildSimHashAnnIndex(input, options);
    const query = dataset.queries.subarray(0, dataset.dimensions);
    expect(first.search(query, 10)).toEqual(second.search(query, 10));
  });
});

describe("index byte estimates", () => {
  test("IVF estimate equals stats and serialized bytes", () => {
    const dataset = generateAnnBenchDataset({ ...SMALL, count: 100 });
    const options = { nlist: 4, nprobe: 2, trainSample: 100, iterations: 2 };
    const index = buildIvfFlatAnnIndex(
      {
        vectors: dataset.vectors,
        count: dataset.count,
        dimensions: dataset.dimensions,
      },
      options,
    );
    const stats = index.stats();
    const estimate = estimateIvfFlatIndexBytes(
      dataset.count,
      dataset.dimensions,
      options,
    );
    expect(stats.indexBytes).toBe(estimate);
    expect(index.serialize().byteLength).toBe(estimate);
    expect(stats.params).toEqual({
      nlist: 4,
      nprobe: 2,
      trainSample: 100,
      iterations: 2,
    });
  });

  test("simhash estimate equals stats; serialize is the signature section", () => {
    const dataset = generateAnnBenchDataset({ ...SMALL, count: 100 });
    const options = { bits: 32, bands: 4 };
    const index = buildSimHashAnnIndex(
      {
        vectors: dataset.vectors,
        count: dataset.count,
        dimensions: dataset.dimensions,
      },
      options,
    );
    const stats = index.stats();
    expect(stats.indexBytes).toBe(
      estimateSimHashIndexBytes(dataset.count, options),
    );
    expect(index.serialize().byteLength).toBe(dataset.count * 4);
  });

  test("run rows expose vectors + index memory accounting", () => {
    const result = runAnnBench({
      scale: 1_000,
      queryCount: 4,
      candidates: ["flat", "ivf", "simhash"],
    });
    for (const row of result.candidates) {
      expect(row.vectorsBytes).toBe(1_000 * 512 * 4);
      expect(row.memoryBytes).toBe(row.vectorsBytes + row.indexBytes);
    }
    const flat = result.candidates.find((row) => row.kind === "flat");
    expect(flat?.indexBytes).toBe(0);
    expect(flat?.memoryBytes).toBe(flat?.vectorsBytes);
  });

  test("resolved IVF parameters stay inside their bounds", () => {
    const resolved = resolveIvfFlatOptions(10_000);
    expect(resolved.nlist).toBeLessThanOrEqual(10_000);
    expect(resolved.nprobe).toBeLessThanOrEqual(resolved.nlist);
    expect(resolved.trainSample).toBeLessThanOrEqual(10_000);
    expect(resolved.iterations).toBeGreaterThan(0);
  });
});

describe("flat truth consistency", () => {
  const texts = [
    EMBEDDING_FIXTURE_TEXTS.chineseProse,
    EMBEDDING_FIXTURE_TEXTS.mixedProse,
    EMBEDDING_FIXTURE_TEXTS.longTable,
    EMBEDDING_FIXTURE_TEXTS.crlf,
    EMBEDDING_FIXTURE_TEXTS.fullwidth,
    EMBEDDING_FIXTURE_TEXTS.jsonLines,
    EMBEDDING_FIXTURE_TEXTS.logLines,
    EMBEDDING_FIXTURE_TEXTS.codeHeavy,
  ];
  const dimensions = EMBEDDING_FIXTURE_DIMENSIONS;
  const vectors = new Float32Array(texts.length * dimensions);
  texts.forEach((text, row) => {
    vectors.set(fakeEmbeddingVector(text, dimensions), row * dimensions);
  });
  const count = texts.length;
  const queryText = EMBEDDING_FIXTURE_TEXTS.mixedProse;
  const query = fakeEmbeddingVector(queryText, dimensions);

  test("flat hits match a manual cosine ranking", () => {
    const index = buildFlatAnnIndex({ vectors, count, dimensions });
    const result = index.search(query, 5);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const manual = texts
      .map((text, id) => ({
        id,
        score: cosineSimilarity(query, fakeEmbeddingVector(text, dimensions)),
      }))
      .sort((left, right) => right.score - left.score || left.id - right.id)
      .slice(0, 5);
    expect(result.hits.map((hit) => hit.id)).toEqual(
      manual.map((hit) => hit.id),
    );
    for (const [position, hit] of result.hits.entries()) {
      expect(hit.score).toBeCloseTo(manual[position]?.score ?? 0, 5);
    }
  });

  test("flat hits agree with B2's committed searchEmbeddingIndex", () => {
    const records = texts.map((_text, row) => ({
      parentId: `chunk-${row.toString().padStart(4, "0")}`,
      chunkIndex: 0,
      startChar: 0,
      endChar: 1,
      spans: [],
      focusChar: 0,
      textHash: "",
      norm: 1,
      vectorOffset: row * dimensions * 4,
    }));
    const snapshot: EmbeddingIndexSnapshot = {
      unitDir: "",
      generation: "test",
      pointer: {
        formatVersion: 1,
        generation: "test",
        chunkCount: count,
        parentCount: count,
        dimensions,
        quant: "f32",
        checksum: "",
        updatedAt: "",
      },
      meta: {
        formatVersion: 1,
        chunkerVersion: 1,
        agentId: "agent",
        spaceId: "space",
        unitKind: "conversation",
        unitKey: "conversation",
        modelId: "fake",
        dimensions,
        quant: "f32",
        parentCount: count,
        chunkCount: count,
        coverage: { embeddedChars: 0, recallableChars: 0, ratio: 1 },
        createdAt: "",
        checksum: "",
        recordsBytes: 0,
        vectorsBytes: vectors.byteLength,
      },
      records,
      vectors,
    };
    const b2 = searchEmbeddingIndex(snapshot, query, { topK: 5 });
    expect(b2.ok).toBe(true);
    if (!b2.ok) return;
    const flat = buildFlatAnnIndex({ vectors, count, dimensions }).search(
      query,
      5,
    );
    expect(flat.ok).toBe(true);
    if (!flat.ok) return;
    expect(flat.hits.map((hit) => hit.id)).toEqual(
      b2.hits.map((hit) => {
        const match = /^chunk-(\d+)$/.exec(hit.parentId);
        return Number(match?.[1] ?? -1);
      }),
    );
    for (const [position, hit] of flat.hits.entries()) {
      expect(hit.score).toBeCloseTo(b2.hits[position]?.score ?? 0, 6);
    }
  });
});

describe("summary", () => {
  test("renders every candidate and the phase-③ trigger note beyond 200k", () => {
    const small = runAnnBench({ scale: 1_000, queryCount: 4 });
    expect(formatAnnBenchSummary(small)).toContain("flat");
    expect(small.summary).not.toContain("phase-③ trigger");
    const big = {
      ...small,
      scaleName: "custom" as const,
      count: 850_000,
    };
    expect(formatAnnBenchSummary(big)).toContain("phase-③ trigger");
  });
});
