import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildEmbeddingChunkPlan } from "@/backend/local/embedding-chunk";
import {
  EMBEDDING_INDEX_FILE_NAMES,
  type EmbeddingChunkRecordInput,
  type EmbeddingVectorUnit,
  embeddingChunkRecordsFromPlan,
  embeddingGenerationDir,
  embeddingVectorUnitDir,
  readEmbeddingIndex,
  readEmbeddingIndexPointer,
  writeEmbeddingIndex,
} from "@/backend/local/embedding-format";
import {
  approximateEmbeddingInnerProduct,
  checkEmbeddingQuantSpace,
  dequantizeEmbeddingVector,
  dequantizeEmbeddingVectors,
  EMBEDDING_QUANT_INT8_MAX,
  type EmbeddingQuantChunkRecord,
  EmbeddingQuantError,
  estimateEmbeddingQuantVolume,
  measureEmbeddingQuantizationError,
  quantizeEmbeddingVector,
  quantizeEmbeddingVectors,
  searchEmbeddingQuantIndex,
} from "@/backend/local/embedding-quant";
import {
  EMBEDDING_QUANT_FLOAT32_FILE_NAME,
  readEmbeddingQuantIndex,
  writeEmbeddingQuantIndex,
} from "@/backend/local/embedding-quant-format";
import {
  createEmbeddingFixtureDirs,
  EMBEDDING_FIXTURE_DIMENSIONS,
  EMBEDDING_FIXTURE_TEXTS,
  type EmbeddingFixtureDirs,
  fakeEmbeddingVector,
} from "@/test-utils/embedding-fixture";

const unit: EmbeddingVectorUnit = {
  agentId: "agent-1",
  spaceId: "space-0123456789abcdef",
  conversationKey: "conv-1",
};

let dirs: EmbeddingFixtureDirs;

beforeEach(() => {
  dirs = createEmbeddingFixtureDirs();
});

afterEach(() => {
  dirs.cleanup();
});

function unitDir(): string {
  return embeddingVectorUnitDir(unit, { root: dirs.root });
}

function randomGenerator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function randomUnitVector(
  next: () => number,
  dimensions: number,
): Float32Array {
  const vector = new Float32Array(dimensions);
  let sumOfSquares = 0;
  for (let axis = 0; axis < dimensions; axis += 1) {
    const value = next() * 2 - 1;
    vector[axis] = value;
    sumOfSquares += value * value;
  }
  const norm = Math.sqrt(sumOfSquares);
  for (let axis = 0; axis < dimensions; axis += 1) {
    vector[axis] = (vector[axis] ?? 0) / norm;
  }
  return vector;
}

function dot(left: ArrayLike<number>, right: ArrayLike<number>): number {
  let sum = 0;
  const length = Math.min(left.length, right.length);
  for (let axis = 0; axis < length; axis += 1) {
    sum += (left[axis] ?? 0) * (right[axis] ?? 0);
  }
  return sum;
}

function makeRecord(
  parentId: string,
  row: number,
  dimensions: number,
  vectorScale: number,
  chunkIndex = 0,
): EmbeddingQuantChunkRecord {
  return {
    parentId,
    chunkIndex,
    startChar: 0,
    endChar: 10,
    spans: [{ startChar: 0, endChar: 10 }],
    focusChar: 0,
    textHash: `hash-${parentId}-${chunkIndex}`,
    norm: 1,
    vectorOffset: row * dimensions,
    vectorScale,
  };
}

function flattenVectors(vectors: readonly ArrayLike<number>[]): Float32Array {
  const dimensions = vectors[0]?.length ?? 0;
  const flat = new Float32Array(vectors.length * dimensions);
  for (const [row, vector] of vectors.entries()) {
    for (let axis = 0; axis < dimensions; axis += 1) {
      flat[row * dimensions + axis] = vector[axis] ?? 0;
    }
  }
  return flat;
}

function expectOk<T extends { ok: boolean }>(
  result: T,
): asserts result is Extract<T, { ok: true }> {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("expected an ok result");
}

function expectFailure<T extends { ok: boolean }>(
  result: T,
): asserts result is Extract<T, { ok: false }> {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a failure result");
}

// ---------------------------------------------------------------------------
// Encode / decode
// ---------------------------------------------------------------------------

describe("int8 encode and decode", () => {
  test("a round trip stays inside the per-vector error bound", () => {
    const next = randomGenerator(7);
    const vectors = Array.from({ length: 64 }, () => randomUnitVector(next, 8));
    const quantized = quantizeEmbeddingVectors(vectors, 8);
    const decoded = dequantizeEmbeddingVectors(quantized);
    expect(decoded.length).toBe(vectors.length * 8);

    const stats = measureEmbeddingQuantizationError(vectors, quantized);
    expect(stats.vectors).toBe(64);
    expect(stats.dimensions).toBe(8);
    // Rounding puts every component within half a step; the step is the
    // per-vector scale, which never exceeds max|v| / 127.
    expect(stats.maxScale).toBeLessThanOrEqual(1 / EMBEDDING_QUANT_INT8_MAX);
    expect(stats.maxAbsError).toBeLessThanOrEqual(stats.maxScale * 0.5 + 1e-9);
    expect(stats.meanAbsError).toBeLessThanOrEqual(stats.maxAbsError);
    expect(stats.rmsError).toBeGreaterThan(0);
    expect(stats.rmsError).toBeLessThanOrEqual(stats.maxAbsError);
    expect(stats.maxInnerProductError).toBeLessThan(0.01);

    for (const [row, vector] of vectors.entries()) {
      const scale = quantized.scales[row] ?? 0;
      for (let axis = 0; axis < 8; axis += 1) {
        const reconstructed = decoded[row * 8 + axis] ?? 0;
        expect(
          Math.abs((vector[axis] ?? 0) - reconstructed),
        ).toBeLessThanOrEqual(scale * 0.5 + 1e-9);
      }
    }
  });

  test("single-vector helpers agree with the batch form", () => {
    const vector = fakeEmbeddingVector(EMBEDDING_FIXTURE_TEXTS.chineseProse);
    const single = quantizeEmbeddingVector(vector);
    const batch = quantizeEmbeddingVectors([vector]);
    expect(Array.from(single.codes)).toEqual(Array.from(batch.codes));
    expect(single.scale).toBe(batch.scales[0] ?? 0);

    const reconstructed = dequantizeEmbeddingVector(
      single.codes,
      0,
      single.scale,
      vector.length,
    );
    for (let axis = 0; axis < vector.length; axis += 1) {
      expect(
        Math.abs((vector[axis] ?? 0) - (reconstructed[axis] ?? 0)),
      ).toBeLessThanOrEqual(single.scale * 0.5 + 1e-9);
    }
  });

  test("a zero vector keeps scale 0 and decodes to zeros", () => {
    const quantized = quantizeEmbeddingVectors([new Float32Array(8)], 8);
    expect(quantized.scales[0]).toBe(0);
    expect(Array.from(quantized.codes)).toEqual(Array.from(new Int8Array(8)));
    const decoded = dequantizeEmbeddingVectors(quantized);
    expect(Array.from(decoded)).toEqual(Array.from(new Float32Array(8)));
    const stats = measureEmbeddingQuantizationError(
      [new Float32Array(8)],
      quantized,
    );
    expect(stats.maxAbsError).toBe(0);
  });

  test("extreme magnitudes stay finite and bounded", () => {
    const extreme = [1e30, -1e30, 1e-30, 0];
    const quantized = quantizeEmbeddingVectors([extreme], 4);
    const scale = quantized.scales[0] ?? 0;
    expect(Number.isFinite(scale)).toBe(true);
    expect(scale).toBeGreaterThan(0);
    for (const code of quantized.codes) {
      expect(Math.abs(code)).toBeLessThanOrEqual(EMBEDDING_QUANT_INT8_MAX);
    }
    const decoded = dequantizeEmbeddingVectors(quantized);
    expect(Array.from(decoded).every(Number.isFinite)).toBe(true);
    // The dominant component quantizes to +127 and reconstructs the source.
    expect(decoded[0] ?? 0).toBeCloseTo(1e30, -24);
  });

  test("NaN and infinite components are rejected", () => {
    expect(() => quantizeEmbeddingVectors([[Number.NaN, 0]])).toThrow(
      EmbeddingQuantError,
    );
    expect(() =>
      quantizeEmbeddingVectors([[0, Number.POSITIVE_INFINITY]]),
    ).toThrow(EmbeddingQuantError);
    expect(() => quantizeEmbeddingVectors([new Float32Array(0)])).toThrow(
      EmbeddingQuantError,
    );
    expect(() => quantizeEmbeddingVectors([[1, 2]], 3)).toThrow(
      EmbeddingQuantError,
    );
    try {
      quantizeEmbeddingVectors([[Number.NaN]]);
    } catch (error) {
      expect(error).toBeInstanceOf(EmbeddingQuantError);
      expect((error as EmbeddingQuantError).code).toBe("invalid-vector");
    }
  });

  test("the approximate inner product tracks the exact one", () => {
    const next = randomGenerator(11);
    let worst = 0;
    for (let round = 0; round < 20; round += 1) {
      const query = randomUnitVector(next, 32);
      const vector = randomUnitVector(next, 32);
      const quantized = quantizeEmbeddingVectors([vector], 32);
      const approximate = approximateEmbeddingInnerProduct(
        quantized.codes,
        0,
        quantized.scales[0] ?? 0,
        query,
      );
      worst = Math.max(worst, Math.abs(approximate - dot(vector, query)));
    }
    expect(worst).toBeLessThan(0.02);
  });

  test("error statistics compare a reference batch by index", () => {
    const reference = [
      new Float32Array([1, 0, 0, 0]),
      new Float32Array([0, 1, 0, 0]),
    ];
    const quantized = quantizeEmbeddingVectors(reference);
    const stats = measureEmbeddingQuantizationError(reference, quantized);
    expect(stats.vectors).toBe(2);
    expect(stats.dimensions).toBe(4);
    // The float32 scale itself is rounded, so even an exact code adds a few
    // ULPs; the bound is half a code step plus that rounding noise.
    expect(stats.maxAbsError).toBeLessThanOrEqual(stats.maxScale * 0.5 + 1e-6);
    expect(() =>
      measureEmbeddingQuantizationError(
        [reference[0] ?? new Float32Array(4)],
        quantized,
      ),
    ).toThrow(EmbeddingQuantError);
  });
});

// ---------------------------------------------------------------------------
// Rescore
// ---------------------------------------------------------------------------

describe("float32 top-50 rescore", () => {
  test("rescore restores the exact order when int8 codes tie", () => {
    const dimensions = 6;
    const base = new Float32Array([1, 0, 0.5, 0.2, -0.3, 0.1]);
    const candidates = 10;
    const vectors = Array.from({ length: candidates }, (_unused, index) => {
      const vector = new Float32Array(base);
      // A dominant first component (1) fixes maxAbs, so every row gets the
      // exact same scale; the perturbation is far below half a code step.
      vector[2] = (base[2] ?? 0) + index * 1e-5;
      return vector;
    });
    const quantized = quantizeEmbeddingVectors(vectors, dimensions);
    const records = vectors.map((_vector, row) =>
      makeRecord(
        `p-${row.toString().padStart(2, "0")}`,
        row,
        dimensions,
        quantized.scales[row] ?? 0,
      ),
    );
    // The codes really are identical: int8 alone cannot tell the rows apart.
    const firstRow = Array.from(quantized.codes.slice(0, dimensions));
    for (let row = 1; row < candidates; row += 1) {
      expect(
        Array.from(
          quantized.codes.slice(row * dimensions, (row + 1) * dimensions),
        ),
      ).toEqual(firstRow);
    }

    const int8Only = searchEmbeddingQuantIndex(
      {
        dimensions,
        records,
        codes: quantized.codes,
        scales: quantized.scales,
      },
      base,
      { topK: candidates, mode: "int8-only" },
    );
    expectOk(int8Only);
    expect(int8Only.hits.map((hit) => hit.parentId)).toEqual([
      "p-00",
      "p-01",
      "p-02",
      "p-03",
      "p-04",
      "p-05",
      "p-06",
      "p-07",
      "p-08",
      "p-09",
    ]);
    // Equal approximate scores: the order above is the parentId tie-break.
    const approximateScores = int8Only.hits.map((hit) => hit.score);
    for (const score of approximateScores) {
      expect(score).toBeCloseTo(approximateScores[0] ?? 0, 12);
    }

    const rescored = searchEmbeddingQuantIndex(
      {
        dimensions,
        records,
        codes: quantized.codes,
        scales: quantized.scales,
        exactVectors: flattenVectors(vectors),
      },
      base,
      { topK: candidates, mode: "int8-rescore" },
    );
    expectOk(rescored);
    expect(rescored.mode).toBe("int8-rescore");
    expect(rescored.rescoredChunks).toBe(candidates);
    expect(rescored.rescoreUnavailable).toBe(false);
    expect(rescored.hits.map((hit) => hit.parentId)).toEqual([
      "p-09",
      "p-08",
      "p-07",
      "p-06",
      "p-05",
      "p-04",
      "p-03",
      "p-02",
      "p-01",
      "p-00",
    ]);
    for (const [rank, hit] of rescored.hits.entries()) {
      const row = candidates - 1 - rank;
      const vector = vectors[row];
      if (vector === undefined) throw new Error("missing candidate vector");
      expect(hit.score).toBeCloseTo(dot(vector, base), 10);
    }
  });

  test("rescore recovers at least the int8-only top-k recall", () => {
    const dimensions = 16;
    const parents = 200;
    const topK = 10;
    const next = randomGenerator(23);
    const vectors = Array.from({ length: parents }, () =>
      randomUnitVector(next, dimensions),
    );
    const quantized = quantizeEmbeddingVectors(vectors, dimensions);
    const records = vectors.map((_vector, row) =>
      makeRecord(
        `m-${row.toString().padStart(3, "0")}`,
        row,
        dimensions,
        quantized.scales[row] ?? 0,
      ),
    );
    const exactVectors = flattenVectors(vectors);

    let int8Total = 0;
    let rescoreTotal = 0;
    for (let round = 0; round < 5; round += 1) {
      const query = randomUnitVector(next, dimensions);
      const expected = vectors
        .map((vector, row) => ({
          parentId: `m-${row.toString().padStart(3, "0")}`,
          score: dot(vector, query),
        }))
        .sort(
          (left, right) =>
            right.score - left.score ||
            left.parentId.localeCompare(right.parentId),
        )
        .slice(0, topK)
        .map((entry) => entry.parentId);

      const int8Only = searchEmbeddingQuantIndex(
        {
          dimensions,
          records,
          codes: quantized.codes,
          scales: quantized.scales,
        },
        query,
        { topK },
      );
      expectOk(int8Only);
      const int8Ids = new Set(int8Only.hits.map((hit) => hit.parentId));
      int8Total += expected.filter((id) => int8Ids.has(id)).length;

      const rescored = searchEmbeddingQuantIndex(
        {
          dimensions,
          records,
          codes: quantized.codes,
          scales: quantized.scales,
          exactVectors,
        },
        query,
        { topK },
      );
      expectOk(rescored);
      const rescoredIds = new Set(rescored.hits.map((hit) => hit.parentId));
      rescoreTotal += expected.filter((id) => rescoredIds.has(id)).length;
      expect(rescored.rescoredChunks).toBe(50);
      for (const hit of rescored.hits) {
        const row = Number(hit.parentId.slice(2));
        const vector = vectors[row];
        if (vector === undefined) throw new Error("missing scored vector");
        expect(hit.score).toBeCloseTo(dot(vector, query), 10);
      }
    }
    // Rescoring must not lose recall, and on this synthetic data it recovers
    // the exact top-k that the quantization noise can reorder.
    expect(rescoreTotal).toBeGreaterThanOrEqual(int8Total);
    expect(rescoreTotal).toBeGreaterThanOrEqual(topK * 5 - 1);
  });

  test("a missing float32 copy degrades with an explicit marker", () => {
    const next = randomGenerator(31);
    const dimensions = 8;
    const vectors = Array.from({ length: 20 }, () =>
      randomUnitVector(next, dimensions),
    );
    const quantized = quantizeEmbeddingVectors(vectors, dimensions);
    const records = vectors.map((_vector, row) =>
      makeRecord(`d-${row}`, row, dimensions, quantized.scales[row] ?? 0),
    );
    const query = vectors[0] ?? new Float32Array(dimensions);

    const fallback = searchEmbeddingQuantIndex(
      { dimensions, records, codes: quantized.codes, scales: quantized.scales },
      query,
      { topK: 5, mode: "int8-rescore" },
    );
    expectOk(fallback);
    expect(fallback.mode).toBe("int8-only");
    expect(fallback.rescoreUnavailable).toBe(true);
    expect(fallback.rescoredChunks).toBe(0);
    expect(fallback.hits.length).toBe(5);

    const forcedInt8 = searchEmbeddingQuantIndex(
      {
        dimensions,
        records,
        codes: quantized.codes,
        scales: quantized.scales,
        exactVectors: flattenVectors(vectors),
      },
      query,
      { topK: 5, mode: "int8-only" },
    );
    expectOk(forcedInt8);
    expect(forcedInt8.mode).toBe("int8-only");
    expect(forcedInt8.rescoreUnavailable).toBe(false);
    expect(forcedInt8.rescoredChunks).toBe(0);
  });

  test("invalid queries and index shapes are typed failures", () => {
    const dimensions = 4;
    const vectors = [new Float32Array([1, 0, 0, 0])];
    const quantized = quantizeEmbeddingVectors(vectors, dimensions);
    const records = [makeRecord("a", 0, dimensions, quantized.scales[0] ?? 0)];
    const input = {
      dimensions,
      records,
      codes: quantized.codes,
      scales: quantized.scales,
    };

    const empty = searchEmbeddingQuantIndex(input, new Float32Array(0));
    expectFailure(empty);
    expect(empty.problem).toBe("empty-query");

    const wrongWidth = searchEmbeddingQuantIndex(input, new Float32Array(3));
    expectFailure(wrongWidth);
    expect(wrongWidth.problem).toBe("dimension-mismatch");

    const broken = searchEmbeddingQuantIndex(
      { ...input, codes: new Int8Array(2) },
      vectors[0] ?? new Float32Array(dimensions),
    );
    expectFailure(broken);
    expect(broken.problem).toBe("invalid-index");
  });
});

// ---------------------------------------------------------------------------
// Space switching and volume
// ---------------------------------------------------------------------------

describe("space switching and volume", () => {
  test("any quant/dimension/model/space mismatch is expectation-mismatch", () => {
    const meta = {
      formatVersion: 1,
      chunkerVersion: 1,
      agentId: "agent-1",
      spaceId: "space-a",
      unitKind: "conversation" as const,
      unitKey: "conv-1",
      modelId: "bge-small-zh-v1.5",
      dimensions: 512,
      quant: "int8" as const,
      parentCount: 1,
      chunkCount: 1,
      coverage: { embeddedChars: 1, recallableChars: 1, ratio: 1 },
      createdAt: "2026-01-01T00:00:00.000Z",
      checksum: "abc",
      recordsBytes: 1,
      vectorsBytes: 512,
      float32VectorsBytes: 0,
    };
    expect(
      checkEmbeddingQuantSpace(meta, {
        agentId: "agent-1",
        spaceId: "space-a",
        modelId: "bge-small-zh-v1.5",
        dimensions: 512,
        quant: "int8",
      }),
    ).toBeUndefined();
    expect(checkEmbeddingQuantSpace(meta, { quant: "f32" })).toBe(
      "expectation-mismatch",
    );
    expect(checkEmbeddingQuantSpace(meta, { dimensions: 1024 })).toBe(
      "expectation-mismatch",
    );
    expect(checkEmbeddingQuantSpace(meta, { modelId: "bge-m3" })).toBe(
      "expectation-mismatch",
    );
    expect(checkEmbeddingQuantSpace(meta, { spaceId: "space-b" })).toBe(
      "expectation-mismatch",
    );
    expect(checkEmbeddingQuantSpace(meta, { agentId: "agent-2" })).toBe(
      "expectation-mismatch",
    );
  });

  test("volume reports the 4x int8 win and the double-copy rescore cost", () => {
    const float32 = estimateEmbeddingQuantVolume({
      chunkCount: 1_000,
      dimensions: 512,
      quant: "f32",
    });
    expect(float32.vectorBytes).toBe(1_000 * 512 * 4);
    expect(float32.scaleBytes).toBe(0);
    expect(float32.rescoreBytes).toBe(0);
    expect(float32.totalBytes).toBe(2_048_000);
    expect(float32.compressionRatio).toBe(1);

    const int8 = estimateEmbeddingQuantVolume({
      chunkCount: 1_000,
      dimensions: 512,
      quant: "int8",
    });
    expect(int8.rescore).toBe(true);
    expect(int8.vectorBytes).toBe(512_000);
    expect(int8.scaleBytes).toBe(4_000);
    expect(int8.rescoreBytes).toBe(2_048_000);
    expect(int8.totalBytes).toBe(2_564_000);
    expect(int8.compressionRatio).toBeCloseTo(2_048_000 / 2_564_000, 12);

    const int8Only = estimateEmbeddingQuantVolume({
      chunkCount: 1_000,
      dimensions: 512,
      quant: "int8",
      rescore: false,
    });
    expect(int8Only.rescore).toBe(false);
    expect(int8Only.totalBytes).toBe(516_000);
    expect(int8Only.compressionRatio).toBeGreaterThan(3.9);
    expect(() =>
      estimateEmbeddingQuantVolume({
        chunkCount: -1,
        dimensions: 512,
        quant: "int8",
      }),
    ).toThrow(EmbeddingQuantError);
    expect(() =>
      estimateEmbeddingQuantVolume({
        chunkCount: 1,
        dimensions: 0,
        quant: "int8",
      }),
    ).toThrow(EmbeddingQuantError);
  });
});

// ---------------------------------------------------------------------------
// int8 generation and B2 format coexistence
// ---------------------------------------------------------------------------

function writeQuantGeneration(options: {
  text?: string;
  rescore?: boolean;
  generation?: string;
  parentId?: string;
}): {
  generation: string;
  records: EmbeddingChunkRecordInput[];
  vectors: Float32Array[];
} {
  const plan = buildEmbeddingChunkPlan({
    parentId: options.parentId ?? "msg-1",
    text: options.text ?? EMBEDDING_FIXTURE_TEXTS.chineseProse,
  });
  const records = embeddingChunkRecordsFromPlan(plan);
  const vectors = plan.chunks.map((chunk) =>
    fakeEmbeddingVector(chunk.text, EMBEDDING_FIXTURE_DIMENSIONS),
  );
  const written = writeEmbeddingQuantIndex({
    unitDir: unitDir(),
    unit,
    modelId: "bge-small-zh-v1.5",
    dimensions: EMBEDDING_FIXTURE_DIMENSIONS,
    records,
    vectors,
    coverage: plan.coverage,
    ...(options.rescore === undefined ? {} : { rescore: options.rescore }),
    ...(options.generation === undefined
      ? {}
      : { generation: options.generation }),
  });
  return { generation: written.generation, records, vectors };
}

describe("int8 on-disk generation", () => {
  test("writes B2's layout, refuses the f32 reader, and round-trips", () => {
    const written = writeQuantGeneration({ generation: "gen-i8-round" });
    const directory = unitDir();
    const pointer = readEmbeddingIndexPointer(directory);
    expectOk(pointer);
    expect(pointer.pointer.quant).toBe("int8");
    expect(pointer.pointer.generation).toBe("gen-i8-round");
    expect(pointer.pointer.chunkCount).toBe(written.records.length);

    // B2's f32 reader must not silently decode int8 bytes as float32.
    const float32Read = readEmbeddingIndex(directory);
    expectFailure(float32Read);
    expect(float32Read.problem).toBe("unsupported-quant");

    const read = readEmbeddingQuantIndex(directory);
    expectOk(read);
    const snapshot = read.snapshot;
    expect(snapshot.meta.quant).toBe("int8");
    expect(snapshot.meta.modelId).toBe("bge-small-zh-v1.5");
    expect(snapshot.meta.dimensions).toBe(EMBEDDING_FIXTURE_DIMENSIONS);
    expect(snapshot.mode).toBe("int8-rescore");
    expect(snapshot.rescoreUnavailable).toBe(false);
    expect(snapshot.records.map((record) => record.parentId)).toEqual(
      written.records.map((record) => record.parentId),
    );

    const expectedCodes = quantizeEmbeddingVectors(
      written.vectors,
      EMBEDDING_FIXTURE_DIMENSIONS,
    );
    expect(Array.from(snapshot.codes)).toEqual(Array.from(expectedCodes.codes));
    expect(Array.from(snapshot.scales)).toEqual(
      Array.from(expectedCodes.scales),
    );
    expect(Array.from(snapshot.exactVectors ?? [])).toEqual(
      Array.from(flattenVectors(written.vectors)),
    );
    for (const [row, record] of snapshot.records.entries()) {
      expect(record.vectorOffset).toBe(row * EMBEDDING_FIXTURE_DIMENSIONS);
      expect(record.vectorScale).toBe(expectedCodes.scales[row] ?? 0);
    }

    // The snapshot is directly searchable; the query is one stored chunk.
    const probe = fakeEmbeddingVector(
      buildEmbeddingChunkPlan({
        parentId: "msg-1",
        text: EMBEDDING_FIXTURE_TEXTS.chineseProse,
      }).chunks[0]?.text ?? "",
      EMBEDDING_FIXTURE_DIMENSIONS,
    );
    const result = searchEmbeddingQuantIndex(
      {
        dimensions: snapshot.meta.dimensions,
        records: snapshot.records,
        codes: snapshot.codes,
        scales: snapshot.scales,
        ...(snapshot.exactVectors === undefined
          ? {}
          : { exactVectors: snapshot.exactVectors }),
      },
      probe,
      { topK: 3 },
    );
    expectOk(result);
    expect(result.hits[0]?.parentId).toBe("msg-1");
    expect(result.rescoredChunks).toBeGreaterThan(0);

    // A second read is byte-identical: the generation is immutable.
    const again = readEmbeddingQuantIndex(directory);
    expectOk(again);
    expect(Array.from(again.snapshot.codes)).toEqual(
      Array.from(snapshot.codes),
    );
  });

  test("int8-only stores no float32 copy and reports it", () => {
    const written = writeQuantGeneration({
      rescore: false,
      generation: "gen-i8-only",
    });
    const directory = unitDir();
    const expectedGenerationDir = embeddingGenerationDir(
      directory,
      written.generation,
    );
    expect(
      existsSync(
        join(expectedGenerationDir, EMBEDDING_QUANT_FLOAT32_FILE_NAME),
      ),
    ).toBe(false);

    const read = readEmbeddingQuantIndex(directory);
    expectOk(read);
    expect(read.snapshot.meta.float32VectorsBytes).toBe(0);
    expect(read.snapshot.exactVectors).toBeUndefined();
    expect(read.snapshot.mode).toBe("int8-only");
    expect(read.snapshot.rescoreUnavailable).toBe(true);

    const result = searchEmbeddingQuantIndex(
      {
        dimensions: read.snapshot.meta.dimensions,
        records: read.snapshot.records,
        codes: read.snapshot.codes,
        scales: read.snapshot.scales,
      },
      written.vectors[0] ?? new Float32Array(EMBEDDING_FIXTURE_DIMENSIONS),
      { topK: 5, mode: "int8-rescore" },
    );
    expectOk(result);
    expect(result.mode).toBe("int8-only");
    expect(result.rescoreUnavailable).toBe(true);
  });

  test("a damaged int8 generation is a typed problem, not a throw", () => {
    const written = writeQuantGeneration({ generation: "gen-i8-bad" });
    truncateSync(
      join(
        embeddingGenerationDir(unitDir(), written.generation),
        EMBEDDING_INDEX_FILE_NAMES.vectors,
      ),
      4,
    );
    const read = readEmbeddingQuantIndex(unitDir());
    expectFailure(read);
    expect(read.problem).toBe("corrupt");
  });

  test("the int8 reader refuses a missing pointer and an f32 pointer", () => {
    expectFailure(readEmbeddingQuantIndex(join(dirs.root, "absent")));

    const plan = buildEmbeddingChunkPlan({
      parentId: "msg-f32",
      text: EMBEDDING_FIXTURE_TEXTS.mixedProse,
    });
    writeEmbeddingIndex({
      unitDir: unitDir(),
      unit,
      modelId: "bge-small-zh-v1.5",
      dimensions: EMBEDDING_FIXTURE_DIMENSIONS,
      records: embeddingChunkRecordsFromPlan(plan),
      vectors: plan.chunks.map((chunk) =>
        fakeEmbeddingVector(chunk.text, EMBEDDING_FIXTURE_DIMENSIONS),
      ),
      coverage: plan.coverage,
    });
    const read = readEmbeddingQuantIndex(unitDir());
    expectFailure(read);
    expect(read.problem).toBe("unsupported-quant");
  });

  test("a B2 float32 generation still round-trips alongside int8", () => {
    const plan = buildEmbeddingChunkPlan({
      parentId: "msg-f32",
      text: EMBEDDING_FIXTURE_TEXTS.table,
    });
    const vectors = plan.chunks.map((chunk) =>
      fakeEmbeddingVector(chunk.text, EMBEDDING_FIXTURE_DIMENSIONS),
    );
    writeEmbeddingIndex({
      unitDir: unitDir(),
      unit,
      modelId: "bge-small-zh-v1.5",
      dimensions: EMBEDDING_FIXTURE_DIMENSIONS,
      records: embeddingChunkRecordsFromPlan(plan),
      vectors,
      coverage: plan.coverage,
    });
    const read = readEmbeddingIndex(unitDir());
    expectOk(read);
    const rows = Array.from(
      { length: read.snapshot.meta.chunkCount },
      (_unused, row) =>
        read.snapshot.vectors.subarray(
          row * EMBEDDING_FIXTURE_DIMENSIONS,
          (row + 1) * EMBEDDING_FIXTURE_DIMENSIONS,
        ),
    );
    const quantized = quantizeEmbeddingVectors(
      rows,
      EMBEDDING_FIXTURE_DIMENSIONS,
    );
    const stats = measureEmbeddingQuantizationError(rows, quantized);
    expect(stats.maxAbsError).toBeLessThanOrEqual(stats.maxScale * 0.5 + 1e-9);
  });

  test("the writer rejects non-finite vectors and misaligned batches", () => {
    const plan = buildEmbeddingChunkPlan({
      parentId: "msg-1",
      text: EMBEDDING_FIXTURE_TEXTS.chineseProse,
    });
    const vectors = plan.chunks.map((chunk) =>
      fakeEmbeddingVector(chunk.text, EMBEDDING_FIXTURE_DIMENSIONS),
    );
    const badVectors = vectors.map((vector) =>
      vector.length === EMBEDDING_FIXTURE_DIMENSIONS
        ? vector.slice()
        : new Float32Array(EMBEDDING_FIXTURE_DIMENSIONS),
    );
    if (badVectors[0] !== undefined) badVectors[0][0] = Number.NaN;
    expect(() =>
      writeEmbeddingQuantIndex({
        unitDir: unitDir(),
        unit,
        modelId: "bge-small-zh-v1.5",
        dimensions: EMBEDDING_FIXTURE_DIMENSIONS,
        records: embeddingChunkRecordsFromPlan(plan),
        vectors: badVectors,
        coverage: plan.coverage,
      }),
    ).toThrow(EmbeddingQuantError);
    expect(() =>
      writeEmbeddingQuantIndex({
        unitDir: unitDir(),
        unit,
        modelId: "bge-small-zh-v1.5",
        dimensions: EMBEDDING_FIXTURE_DIMENSIONS,
        records: embeddingChunkRecordsFromPlan(plan),
        vectors: vectors.slice(0, vectors.length - 1),
        coverage: plan.coverage,
      }),
    ).toThrow(EmbeddingQuantError);
  });

  test("reading never throws even for unparseable json files", () => {
    const written = writeQuantGeneration({ generation: "gen-i8-json" });
    const generationDir = embeddingGenerationDir(unitDir(), written.generation);
    writeFileSync(
      join(generationDir, EMBEDDING_INDEX_FILE_NAMES.meta),
      "not json",
      "utf8",
    );
    const read = readEmbeddingQuantIndex(unitDir());
    expectFailure(read);
    expect(read.problem).toBe("unreadable");
  });
});
