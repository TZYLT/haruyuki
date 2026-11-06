/**
 * Native int8 IVF index (feature 48, D-23) — unit tests.
 *
 * Everything is synthetic and deterministic (seeded clustered corpus): no
 * ONNX, no network, no real harness data. The float32 reference is B7's own
 * `buildAnnIndex` over the dequantized rows, so the two indexes are compared on
 * the same vectors they were trained from.
 */

import { describe, expect, test } from "bun:test";
import { generateAnnBenchDataset } from "@/backend/local/embedding/ann-bench";
import {
  ANN_INDEX_SERIAL_HEADER_BYTES,
  type AnnIndex,
  AnnIndexError,
  buildAnnIndex,
  buildFlatAnnIndex,
  deserializeAnnIndex,
  resolveAnnIvfOptions,
} from "@/backend/local/embedding-ann-index";
import {
  ANN_INT8_SERIAL_KIND,
  type AnnInt8BuildInput,
  type AnnInt8UnitRows,
  buildAnnInt8Index,
  deserializeAnnInt8Index,
} from "@/backend/local/embedding-ann-int8";
import {
  approximateEmbeddingInnerProduct,
  dequantizeEmbeddingVector,
  quantizeEmbeddingVectors,
} from "@/backend/local/embedding-quant";

const DIMENSIONS = 8;
const SEED = 0x48_dd_2026;
const META = {
  agentId: "agent-int8",
  spaceId: "space-int8-0001",
  generation: "gen-int8",
};

type Dataset = ReturnType<typeof generateAnnBenchDataset>;

function dataset(count: number, queryCount = 4): Dataset {
  return generateAnnBenchDataset({
    count,
    dimensions: DIMENSIONS,
    seed: SEED,
    queryCount,
  });
}

function rowVector(data: Dataset, row: number): Float32Array {
  return data.vectors.subarray(
    row * data.dimensions,
    (row + 1) * data.dimensions,
  ) as Float32Array;
}

function queryOf(data: Dataset, index = 0): Float32Array {
  return data.queries.subarray(
    index * data.dimensions,
    (index + 1) * data.dimensions,
  ) as Float32Array;
}

/** Quantizes `[from, to)` into one unit row set. */
function unitRows(
  data: Dataset,
  ranges: ReadonlyArray<readonly [number, number]>,
): AnnInt8UnitRows[] {
  return ranges.map(([from, to]) => {
    const vectors = Array.from({ length: to - from }, (_unused, index) =>
      rowVector(data, from + index),
    );
    const quantized = quantizeEmbeddingVectors(vectors, data.dimensions);
    return {
      codes: quantized.codes,
      scales: quantized.scales,
      count: quantized.count,
    };
  });
}

function inputOf(
  data: Dataset,
  ranges: ReadonlyArray<readonly [number, number]>,
): AnnInt8BuildInput {
  const units = unitRows(data, ranges);
  return {
    units,
    count: units.reduce((total, unit) => total + unit.count, 0),
    dimensions: data.dimensions,
    meta: META,
  };
}

/** All IVF lists probed: exact results, comparable with a brute-force scan. */
function exactIvf(count: number) {
  const resolved = resolveAnnIvfOptions(count);
  return {
    nlist: resolved.nlist,
    nprobe: resolved.nlist,
    trainSample: resolved.trainSample,
    iterations: resolved.iterations,
  };
}

type Hit = { id: number; score: number };

/** The brute-force int8 scan, ordered like B7's top-k collector. */
function bruteForce(
  input: AnnInt8BuildInput,
  query: Float32Array,
  k: number,
): Hit[] {
  const hits: Hit[] = [];
  let id = 0;
  for (const unit of input.units) {
    for (let row = 0; row < unit.count; row += 1) {
      hits.push({
        id,
        score: approximateEmbeddingInnerProduct(
          unit.codes,
          row * input.dimensions,
          unit.scales[row] ?? 0,
          query,
        ),
      });
      id += 1;
    }
  }
  hits.sort((left, right) =>
    left.score === right.score ? left.id - right.id : right.score - left.score,
  );
  return hits.slice(0, k);
}

function search(index: AnnIndex, query: Float32Array, k: number): Hit[] {
  const result = index.search(query, k);
  if (!result.ok) {
    throw new Error(`search failed: ${result.problem} ${result.detail ?? ""}`);
  }
  return result.hits.map((hit) => ({ id: hit.id, score: hit.score }));
}

function expectCorrupt(run: () => unknown): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AnnIndexError);
  expect((caught as AnnIndexError).code).toBe("corrupt-serialized");
}

describe("native int8 IVF", () => {
  test("exact probing reproduces the brute-force int8 scan", () => {
    const data = dataset(300);
    // Two units so global row ids cross a unit boundary.
    const input = inputOf(data, [
      [0, 120],
      [120, 300],
    ]);
    const index = buildAnnInt8Index(input, {
      ivf: exactIvf(input.count),
    });
    for (let query = 0; query < 3; query += 1) {
      const queryVector = queryOf(data, query);
      expect(search(index, queryVector, 10)).toEqual(
        bruteForce(input, queryVector, 10),
      );
    }
  });

  test("the same option resolution as B7 drives the lists", () => {
    const data = dataset(200);
    const input = inputOf(data, [[0, 200]]);
    const index = buildAnnInt8Index(input);
    const stats = index.stats();
    const options = resolveAnnIvfOptions(input.count);
    expect(stats.kind).toBe("ivf");
    expect(stats.count).toBe(200);
    expect(stats.dimensions).toBe(DIMENSIONS);
    expect(stats.params).toEqual({ ...options, int8: 1 });
    expect(stats.indexBytes).toBe(
      ANN_INDEX_SERIAL_HEADER_BYTES +
        options.nlist * DIMENSIONS * 4 +
        (options.nlist + 1) * 4 +
        200 * 4,
    );
    expect(index.meta).toEqual(META);
  });

  test("partial probing keeps most of the exact top-k", () => {
    const data = dataset(600);
    const input = inputOf(data, [[0, 600]]);
    const options = resolveAnnIvfOptions(input.count);
    const exact = buildAnnInt8Index(input, { ivf: exactIvf(input.count) });
    const probed = buildAnnInt8Index(input, {
      ivf: { ...options, nprobe: 2 },
    });
    const queryVector = queryOf(data, 0);
    const expected = new Set(
      search(exact, queryVector, 10).map((hit) => hit.id),
    );
    const observed = search(probed, queryVector, 10);
    const agree = observed.filter((hit) => expected.has(hit.id)).length;
    expect(agree / expected.size).toBeGreaterThanOrEqual(0.5);
  });

  test("serialization round-trips to the same hits", () => {
    const data = dataset(250);
    const input = inputOf(data, [
      [0, 90],
      [90, 250],
    ]);
    const built = buildAnnInt8Index(input, { ivf: { nprobe: 4 } });
    const bytes = built.serialize();
    expect(bytes[6]).toBe(ANN_INT8_SERIAL_KIND);
    const restored = deserializeAnnInt8Index(bytes, input);
    expect(restored.stats()).toEqual(built.stats());
    for (let query = 0; query < 3; query += 1) {
      const queryVector = queryOf(data, query);
      expect(search(restored, queryVector, 8)).toEqual(
        search(built, queryVector, 8),
      );
    }
  });

  test("assignment equals the float32 index built on the dequantized rows", () => {
    const data = dataset(240);
    const input = inputOf(data, [[0, 240]]);
    const dequantized = new Float32Array(input.count * DIMENSIONS);
    let row = 0;
    for (const unit of input.units) {
      for (let local = 0; local < unit.count; local += 1) {
        dequantized.set(
          dequantizeEmbeddingVector(
            unit.codes,
            local * DIMENSIONS,
            unit.scales[local] ?? 0,
            DIMENSIONS,
          ),
          row * DIMENSIONS,
        );
        row += 1;
      }
    }
    const options = exactIvf(input.count);
    const int8Index = buildAnnInt8Index(input, { ivf: options });
    const flatIndex = buildAnnIndex(
      {
        vectors: dequantized,
        count: input.count,
        dimensions: DIMENSIONS,
        meta: META,
      },
      { ivf: options },
    );
    for (let query = 0; query < 3; query += 1) {
      const queryVector = queryOf(data, query);
      expect(search(int8Index, queryVector, 10).map((hit) => hit.id)).toEqual(
        search(flatIndex, queryVector, 10).map((hit) => hit.id),
      );
    }
  });

  test("zero-scale rows score zero and never produce NaN", () => {
    const data = dataset(40);
    const vectors = Array.from({ length: 40 }, (_unused, index) =>
      index === 7 ? new Float32Array(DIMENSIONS) : rowVector(data, index),
    );
    const quantized = quantizeEmbeddingVectors(vectors, DIMENSIONS);
    const input: AnnInt8BuildInput = {
      units: [{ codes: quantized.codes, scales: quantized.scales, count: 40 }],
      count: 40,
      dimensions: DIMENSIONS,
    };
    const index = buildAnnInt8Index(input, { ivf: exactIvf(40) });
    const hits = search(index, queryOf(data, 0), 40);
    expect(hits.every((hit) => Number.isFinite(hit.score))).toBe(true);
    expect(hits.some((hit) => hit.id === 7 && hit.score === 0)).toBe(true);
  });

  test("an empty corpus round-trips and searches empty", () => {
    const input: AnnInt8BuildInput = {
      units: [],
      count: 0,
      dimensions: DIMENSIONS,
      meta: META,
    };
    const index = buildAnnInt8Index(input);
    const queryVector = new Float32Array(DIMENSIONS).fill(0.5);
    expect(search(index, queryVector, 5)).toEqual([]);
    const restored = deserializeAnnInt8Index(index.serialize(), input);
    expect(search(restored, queryVector, 5)).toEqual([]);
    expect(restored.stats().indexBytes).toBe(ANN_INDEX_SERIAL_HEADER_BYTES);
  });

  test("the header kind separates int8 from float32 layouts", () => {
    const data = dataset(20);
    const input = inputOf(data, [[0, 20]]);
    const int8Bytes = buildAnnInt8Index(input, {
      ivf: exactIvf(20),
    }).serialize();
    const f32Bytes = buildFlatAnnIndex({
      vectors: data.vectors.slice(0, 20 * DIMENSIONS),
      count: 20,
      dimensions: DIMENSIONS,
    }).serialize();
    expectCorrupt(() => deserializeAnnInt8Index(f32Bytes, input));
    // A float32 reader must reject kind 2 as well.
    expectCorrupt(() =>
      deserializeAnnIndex(int8Bytes, {
        vectors: data.vectors.slice(0, 20 * DIMENSIONS),
        count: 20,
        dimensions: DIMENSIONS,
      }),
    );
  });

  test("corrupt payloads are rejected with typed errors", () => {
    const data = dataset(60);
    const input = inputOf(data, [[0, 60]]);
    const bytes = buildAnnInt8Index(input, { ivf: exactIvf(60) }).serialize();
    expectCorrupt(() => deserializeAnnInt8Index(bytes.subarray(0, 10), input));
    const badMagic = bytes.slice();
    badMagic[0] = 0;
    expectCorrupt(() => deserializeAnnInt8Index(badMagic, input));
    const badChecksum = bytes.slice();
    badChecksum[badChecksum.length - 1] =
      ((badChecksum[badChecksum.length - 1] ?? 0) ^ 0xff) & 0xff;
    expectCorrupt(() => deserializeAnnInt8Index(badChecksum, input));
    const badShape = bytes.slice();
    new DataView(badShape.buffer).setUint32(8, 59, true);
    expectCorrupt(() => deserializeAnnInt8Index(badShape, input));
  });

  test("input validation names the offending unit", () => {
    const data = dataset(30);
    const rows = unitRows(data, [[0, 30]]);
    const unit = rows[0];
    expect(unit).toBeDefined();
    if (unit === undefined) return;
    expect(() =>
      buildAnnInt8Index({
        units: [unit],
        count: 31,
        dimensions: DIMENSIONS,
      }),
    ).toThrow(/units hold 30 rows/);
    expect(() =>
      buildAnnInt8Index({
        units: [{ ...unit, codes: unit.codes.subarray(0, 10) }],
        count: 30,
        dimensions: DIMENSIONS,
      }),
    ).toThrow(/expected 30 × 8/);
    const negative = new Float32Array(unit.scales);
    negative[0] = -1;
    expect(() =>
      buildAnnInt8Index({
        units: [{ ...unit, scales: negative }],
        count: 30,
        dimensions: DIMENSIONS,
      }),
    ).toThrow(/invalid scale/);
  });

  test("dimension and k errors are the ANN contract, not throws", () => {
    const data = dataset(40);
    const input = inputOf(data, [[0, 40]]);
    const index = buildAnnInt8Index(input, { ivf: exactIvf(40) });
    const wrongWidth = new Float32Array(DIMENSIONS - 1);
    const wrong = index.search(wrongWidth, 3);
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.problem).toBe("dimension-mismatch");
    const badK = index.search(queryOf(data), 0);
    expect(badK.ok).toBe(false);
    if (!badK.ok) expect(badK.problem).toBe("invalid-k");
  });
});
