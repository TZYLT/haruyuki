import { describe, expect, test } from "bun:test";
import {
  applyInstructionPrefix,
  assertHiddenStateShape,
  assertModelVectorDimensions,
  chunkItems,
  countSequenceTokens,
  DEFAULT_BATCH_MAX_SIZE,
  DEFAULT_BATCH_MAX_TOKENS,
  decodeVectorBase64,
  type EmbeddingModelFeaturizeSpec,
  encodeVectorBase64,
  FeaturizeError,
  featurizeText,
  flattenVectors,
  l2Normalize,
  maskedClsPool,
  maskedLastTokenPool,
  maskedMeanPool,
  padTokenBatch,
  planTokenBatches,
  poolBatch,
  poolModelBatch,
  poolSequence,
  resolveAttentionMask,
  resolveFeaturizeSpec,
  resolveModelInputNames,
  resolveTokenTypeIds,
  sliceVector,
  sumSequenceTokens,
  type TokenizedSequence,
  truncateSequence,
} from "./featurize";
import { getBuiltinModelManifest } from "./model-manifest";

function norm(vector: Float32Array): number {
  let total = 0;
  for (let axis = 0; axis < vector.length; axis += 1) {
    const value = vector[axis] ?? 0;
    total += value * value;
  }
  return Math.sqrt(total);
}

function expectVectorClose(
  actual: Float32Array,
  expected: readonly number[],
  epsilon = 1e-6,
): void {
  expect(actual.length).toBe(expected.length);
  for (let axis = 0; axis < expected.length; axis += 1) {
    expect(actual[axis] ?? 0).toBeCloseTo(expected[axis] ?? 0, epsilon);
  }
}

/** Row-major `[sequences, tokens, dim]` filled from per-token values. */
function buildHidden(
  rows: readonly (readonly number[])[],
  dim: number,
): Float32Array {
  const tokens = rows[0]?.length ?? 0;
  const hidden = new Float32Array(rows.length * tokens * dim);
  rows.forEach((row, sequence) => {
    for (let token = 0; token < row.length; token += 1) {
      const value = row[token] ?? 0;
      for (let axis = 0; axis < dim; axis += 1) {
        hidden[(sequence * tokens + token) * dim + axis] = value * (axis + 1);
      }
    }
  });
  return hidden;
}

describe("resolveAttentionMask", () => {
  test("defaults to all ones when no mask is supplied", () => {
    expect(resolveAttentionMask({ inputIds: [1, 2, 3] })).toEqual([1, 1, 1]);
  });

  test("preserves supplied mask weights", () => {
    expect(
      resolveAttentionMask({ inputIds: [1, 2], attentionMask: [1, 0] }),
    ).toEqual([1, 0]);
  });

  test("rejects a mask with the wrong length", () => {
    expect(() =>
      resolveAttentionMask({ inputIds: [1, 2, 3], attentionMask: [1] }),
    ).toThrow(FeaturizeError);
  });

  test("rejects negative or non-finite weights", () => {
    expect(() =>
      resolveAttentionMask({ inputIds: [1], attentionMask: [-1] }),
    ).toThrow(/non-negative/);
    expect(() =>
      resolveAttentionMask({ inputIds: [1], attentionMask: [Number.NaN] }),
    ).toThrow(/non-negative/);
  });
});

describe("countSequenceTokens / truncateSequence", () => {
  test("counts tokens and rejects empty sequences", () => {
    expect(countSequenceTokens({ inputIds: [4, 5] })).toBe(2);
    expect(() => countSequenceTokens({ inputIds: [] })).toThrow(FeaturizeError);
  });

  test("truncation keeps the prefix and aligns the mask", () => {
    const sequence: TokenizedSequence = {
      inputIds: [1, 2, 3, 4, 5],
      attentionMask: [1, 1, 1, 1, 1],
    };
    expect(truncateSequence(sequence, 3)).toEqual({
      inputIds: [1, 2, 3],
      attentionMask: [1, 1, 1],
    });
  });

  test("truncation is a no-op when the sequence already fits", () => {
    const sequence: TokenizedSequence = { inputIds: [1, 2] };
    expect(truncateSequence(sequence, 2)).toBe(sequence);
  });

  test("rejects a non-positive cap", () => {
    expect(() => truncateSequence({ inputIds: [1, 2] }, 0)).toThrow(
      FeaturizeError,
    );
  });
});

describe("maskedMeanPool", () => {
  test("returns the weighted mean of unmasked tokens", () => {
    const hidden = Float32Array.from([1, 2, 3, 4, 5, 6]);
    const pooled = maskedMeanPool(hidden, { tokens: 2, dim: 3, mask: [1, 1] });
    expectVectorClose(pooled, [2.5, 3.5, 4.5]);
  });

  test("excludes zero-weighted (pad) tokens", () => {
    const hidden = Float32Array.from([1, 2, 3, 999, 999, 999]);
    const pooled = maskedMeanPool(hidden, { tokens: 2, dim: 3, mask: [1, 0] });
    expectVectorClose(pooled, [1, 2, 3]);
  });

  test("rejects a mask that sums to zero", () => {
    const hidden = new Float32Array(3);
    expect(() =>
      maskedMeanPool(hidden, { tokens: 1, dim: 3, mask: [0] }),
    ).toThrow(/sums to zero/);
  });

  test("rejects a hidden state with the wrong shape", () => {
    expect(() =>
      maskedMeanPool(new Float32Array(5), { tokens: 2, dim: 3, mask: [1, 1] }),
    ).toThrow(/Expected 6 hidden values/);
  });

  test("rejects non-finite hidden values", () => {
    const hidden = Float32Array.from([1, Number.NaN, 3]);
    expect(() =>
      maskedMeanPool(hidden, { tokens: 1, dim: 3, mask: [1] }),
    ).toThrow(/not a finite number/);
  });
});

describe("l2Normalize", () => {
  test("returns a unit vector and a new array", () => {
    const source = Float32Array.from([3, 4]);
    const normalized = l2Normalize(source);
    expect(norm(normalized)).toBeCloseTo(1, 6);
    expect(normalized[0] ?? 0).toBeCloseTo(0.6, 6);
    expect(normalized[1] ?? 0).toBeCloseTo(0.8, 6);
    expect(normalized).not.toBe(source);
  });

  test("rejects a zero vector", () => {
    expect(() => l2Normalize(new Float32Array(4))).toThrow(/zero norm/);
  });

  test("rejects non-finite values", () => {
    expect(() =>
      l2Normalize(Float32Array.from([Number.POSITIVE_INFINITY, 1])),
    ).toThrow(FeaturizeError);
  });

  test("is deterministic", () => {
    const source = Float32Array.from([1.5, -2.25, 7]);
    expect(Array.from(l2Normalize(source))).toEqual(
      Array.from(l2Normalize(source)),
    );
  });
});

describe("poolBatch", () => {
  test("pools each sequence independently and normalizes", () => {
    const hidden = buildHidden(
      [
        [1, 2],
        [3, 4],
      ],
      2,
    );
    const vectors = poolBatch({
      hidden,
      sequences: 2,
      tokens: 2,
      dim: 2,
      masks: [
        [1, 1],
        [1, 0],
      ],
    });
    expect(vectors.length).toBe(2);
    // Sequence 0: mean of [1,2] and [3,4] per axis, then normalized.
    expectVectorClose(
      vectors[0] ?? new Float32Array(0),
      [2 / Math.sqrt(8), 3 / Math.sqrt(18)].map(
        (value) => value / Math.hypot(2 / Math.sqrt(8), 3 / Math.sqrt(18)),
      ),
    );
    // Sequence 1: only the first token counts ([3, 6] because axis scales).
    expect(norm(vectors[1] ?? new Float32Array(0))).toBeCloseTo(1, 6);
  });

  test("padding cannot leak into a pooled vector", () => {
    // One sequence with a real first token and a pad token whose value would
    // change the mean if the mask were ignored.
    const padded = poolBatch({
      hidden: buildHidden([[1, 999]], 2),
      sequences: 1,
      tokens: 2,
      dim: 2,
      masks: [[1, 0]],
    });
    const single = poolBatch({
      hidden: buildHidden([[1]], 2),
      sequences: 1,
      tokens: 1,
      dim: 2,
      masks: [[1]],
    });
    expect(Array.from(padded[0] ?? [])).toEqual(Array.from(single[0] ?? []));
  });

  test("rejects a mask count that does not match the batch", () => {
    expect(() =>
      poolBatch({
        hidden: new Float32Array(2),
        sequences: 2,
        tokens: 1,
        dim: 1,
        masks: [[1]],
      }),
    ).toThrow(/Expected 2 attention masks/);
  });
});

describe("flattenVectors / sliceVector", () => {
  test("round-trips rows through a flat buffer", () => {
    const rows = [Float32Array.from([1, 2]), Float32Array.from([3, 4])];
    const flat = flattenVectors(rows, 2);
    expect(Array.from(flat)).toEqual([1, 2, 3, 4]);
    expect(Array.from(sliceVector(flat, 1, 2))).toEqual([3, 4]);
  });

  test("infers the width from the first vector", () => {
    const flat = flattenVectors([
      Float32Array.from([1, 2, 3]),
      Float32Array.from([4, 5, 6]),
    ]);
    expect(flat.length).toBe(6);
  });

  test("rejects mismatched widths and out-of-range slices", () => {
    expect(() =>
      flattenVectors([Float32Array.from([1, 2]), Float32Array.from([3])], 2),
    ).toThrow(/Vector 1 has length 1/);
    expect(() => sliceVector(Float32Array.from([1, 2]), 1, 2)).toThrow(
      /needs 4 values/,
    );
  });

  test("flattens an empty list", () => {
    expect(flattenVectors([]).length).toBe(0);
  });
});

describe("base64 vector framing", () => {
  test("round-trips little-endian float32 exactly", () => {
    const vector = Float32Array.from([0.5, -1.25, 1e-3, 123.5]);
    const encoded = encodeVectorBase64(vector);
    expect(Array.from(decodeVectorBase64(encoded))).toEqual(Array.from(vector));
  });

  test("decodes with an expected dimension", () => {
    const encoded = encodeVectorBase64(Float32Array.from([1, 2, 3]));
    expect(Array.from(decodeVectorBase64(encoded, 3))).toEqual([1, 2, 3]);
    expect(() => decodeVectorBase64(encoded, 2)).toThrow(/expected 2/);
  });

  test("rejects empty or unpadded base64", () => {
    expect(() => decodeVectorBase64("")).toThrow(FeaturizeError);
    expect(() => decodeVectorBase64("AAAAA")).toThrow(/padded base64/);
  });

  test("rejects characters outside the base64 alphabet", () => {
    expect(() => decodeVectorBase64("AAAA****")).toThrow(
      /outside the base64 alphabet/,
    );
  });

  test("rejects a byte length that is not a whole float32", () => {
    // 6 bytes -> not divisible by 4.
    expect(() =>
      decodeVectorBase64(Buffer.from([1, 2, 3, 4, 5, 6]).toString("base64")),
    ).toThrow(/whole number of float32/);
  });
});

describe("chunkItems", () => {
  test("splits into consecutive chunks", () => {
    expect(chunkItems([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  test("returns no chunks for an empty list", () => {
    expect(chunkItems([], 3)).toEqual([]);
  });

  test("rejects a non-positive size", () => {
    expect(() => chunkItems([1], 0)).toThrow(FeaturizeError);
  });
});

describe("planTokenBatches", () => {
  function sequence(length: number): TokenizedSequence {
    return { inputIds: Array.from({ length }, () => 1) };
  }

  test("uses the documented defaults", () => {
    expect(DEFAULT_BATCH_MAX_SIZE).toBe(8);
    expect(DEFAULT_BATCH_MAX_TOKENS).toBe(1_700);
  });

  test("caps by sequence count while preserving order", () => {
    const batches = planTokenBatches([sequence(1), sequence(1), sequence(1)], {
      maxBatchSize: 2,
    });
    expect(batches.map((batch) => batch.length)).toEqual([2, 1]);
    expect(batches[0]?.[0]).toBeDefined();
  });

  test("caps by token budget", () => {
    const batches = planTokenBatches(
      [sequence(10), sequence(10), sequence(10)],
      {
        maxBatchSize: 8,
        maxBatchTokens: 25,
      },
    );
    expect(batches.map((batch) => batch.length)).toEqual([2, 1]);
    expect(sumSequenceTokens(batches[1] ?? [])).toBe(10);
  });

  test("emits a single oversized sequence alone", () => {
    const batches = planTokenBatches([sequence(50), sequence(1)], {
      maxBatchTokens: 10,
    });
    expect(batches.map((batch) => batch.length)).toEqual([1, 1]);
  });

  test("returns no batches for an empty plan", () => {
    expect(planTokenBatches([])).toEqual([]);
  });

  test("rejects a zero-token sequence", () => {
    expect(() => planTokenBatches([sequence(0)])).toThrow(FeaturizeError);
  });

  test("rejects an invalid batch size", () => {
    expect(() => planTokenBatches([sequence(1)], { maxBatchSize: 0 })).toThrow(
      FeaturizeError,
    );
  });
});

describe("padTokenBatch", () => {
  test("pads ids with the pad token and masks padding with zero", () => {
    const batch = padTokenBatch(
      [{ inputIds: [5, 6, 7] }, { inputIds: [8] }],
      0,
    );
    expect(batch.sequences).toBe(2);
    expect(batch.tokens).toBe(3);
    expect(batch.tokenTotal).toBe(4);
    expect(Array.from(batch.inputIds)).toEqual([5, 6, 7, 8, 0, 0]);
    expect(Array.from(batch.attentionMask)).toEqual([1, 1, 1, 1, 0, 0]);
    expect(batch.masks).toEqual([
      [1, 1, 1],
      [1, 0, 0],
    ]);
  });

  test("honours a custom pad token id", () => {
    const batch = padTokenBatch([{ inputIds: [4] }, { inputIds: [7, 8] }], 9);
    expect(Array.from(batch.inputIds)).toEqual([4, 9, 7, 8]);
    expect(Array.from(batch.attentionMask)).toEqual([1, 0, 1, 1]);
  });

  test("rejects an empty batch", () => {
    expect(() => padTokenBatch([])).toThrow(FeaturizeError);
  });
});

describe("assertHiddenStateShape", () => {
  test("accepts a well-formed token-level output", () => {
    expect(() =>
      assertHiddenStateShape(new Float32Array(2 * 3 * 4), 2, 3, 4),
    ).not.toThrow();
  });

  test("rejects an invalid width or value count", () => {
    expect(() => assertHiddenStateShape(new Float32Array(8), 2, 1, 0)).toThrow(
      /invalid output width/,
    );
    expect(() => assertHiddenStateShape(new Float32Array(7), 2, 1, 4)).toThrow(
      /expected 8/,
    );
  });
});

describe("determinism", () => {
  test("the same hidden state yields bit-identical vectors", () => {
    const hidden = buildHidden([[1, 2, 3]], 3);
    const run = (): number[] =>
      Array.from(
        poolBatch({
          hidden,
          sequences: 1,
          tokens: 3,
          dim: 3,
          masks: [[1, 1, 0]],
        })[0] ?? [],
      );
    expect(run()).toEqual(run());
  });
});

describe("token_type_ids (BGE has them, XLM-R/Qwen do not)", () => {
  test("defaults to zeros and preserves supplied segment ids", () => {
    expect(resolveTokenTypeIds({ inputIds: [1, 2, 3] })).toEqual([0, 0, 0]);
    expect(
      resolveTokenTypeIds({ inputIds: [1, 2], tokenTypeIds: [0, 1] }),
    ).toEqual([0, 1]);
  });

  test("rejects a length mismatch or an invalid segment id", () => {
    expect(() =>
      resolveTokenTypeIds({ inputIds: [1, 2], tokenTypeIds: [0] }),
    ).toThrow(/token type ids/);
    expect(() =>
      resolveTokenTypeIds({ inputIds: [1], tokenTypeIds: [-1] }),
    ).toThrow(/non-negative integer/);
    expect(() =>
      resolveTokenTypeIds({ inputIds: [1], tokenTypeIds: [0.5] }),
    ).toThrow(FeaturizeError);
  });

  test("truncation keeps segment ids aligned", () => {
    expect(
      truncateSequence({ inputIds: [1, 2, 3], tokenTypeIds: [0, 1, 1] }, 2),
    ).toEqual({ inputIds: [1, 2], tokenTypeIds: [0, 1] });
  });

  test("padding emits segment ids only when present, with zero padding", () => {
    const without = padTokenBatch([{ inputIds: [5, 6] }, { inputIds: [7] }], 0);
    expect(without.tokenTypeIds).toBeUndefined();
    const withIds = padTokenBatch(
      [{ inputIds: [5, 6], tokenTypeIds: [0, 1] }, { inputIds: [7] }],
      0,
    );
    expect(Array.from(withIds.tokenTypeIds ?? [])).toEqual([0, 1, 0, 0]);
    expect(Array.from(withIds.attentionMask)).toEqual([1, 1, 1, 0]);
    const forced = padTokenBatch([{ inputIds: [1] }], 9, {
      includeTokenTypeIds: true,
    });
    expect(Array.from(forced.tokenTypeIds ?? [])).toEqual([0]);
  });
});

describe("pooling strategies", () => {
  const hidden = Float32Array.from([1, 2, 3, 4, 5, 6]); // 2 tokens x dim 3.

  test("CLS takes the first token and refuses a masked first token", () => {
    expectVectorClose(
      maskedClsPool(hidden, { tokens: 2, dim: 3, mask: [1, 1] }),
      [1, 2, 3],
    );
    expect(() =>
      maskedClsPool(hidden, { tokens: 2, dim: 3, mask: [0, 1] }),
    ).toThrow(/first token/);
  });

  test("last-token pool takes the last unmasked token", () => {
    expectVectorClose(
      maskedLastTokenPool(hidden, { tokens: 2, dim: 3, mask: [1, 1] }),
      [4, 5, 6],
    );
    expectVectorClose(
      maskedLastTokenPool(Float32Array.from([1, 2, 3, 999, 999, 999]), {
        tokens: 2,
        dim: 3,
        mask: [1, 0],
      }),
      [1, 2, 3],
    );
    expect(() =>
      maskedLastTokenPool(hidden, { tokens: 2, dim: 3, mask: [0, 0] }),
    ).toThrow(/unmasked token/);
  });

  test("poolSequence and poolBatch dispatch by the declared strategy", () => {
    const options = {
      hidden,
      sequences: 1,
      tokens: 2,
      dim: 3,
      masks: [[1, 1]],
    };
    const mean = poolBatch(options)[0] ?? [];
    const cls = poolBatch({ ...options, pooling: "cls" })[0] ?? [];
    const last = poolBatch({ ...options, pooling: "last" })[0] ?? [];
    expect(Array.from(cls)).toEqual(
      Array.from(l2Normalize(Float32Array.from([1, 2, 3]))),
    );
    expect(Array.from(last)).toEqual(
      Array.from(l2Normalize(Float32Array.from([4, 5, 6]))),
    );
    expect(Array.from(mean)).not.toEqual(Array.from(cls));
    expectVectorClose(
      poolSequence(hidden, { tokens: 2, dim: 3, mask: [1, 1], pooling: "cls" }),
      [1, 2, 3],
    );
    expect(() => poolBatch({ ...options, pooling: "median" as never })).toThrow(
      /Unknown pooling strategy/,
    );
  });
});

describe("model manifest bridge (three families)", () => {
  const bge = getBuiltinModelManifest("bge-small-zh-v1.5");
  const m3 = getBuiltinModelManifest("bge-m3");
  const qwen = getBuiltinModelManifest("qwen3-embedding-0.6b");

  test("resolves inputs, pooling, dimensions and max tokens per family", () => {
    const bgeSpec = resolveFeaturizeSpec(bge);
    expect(bgeSpec.pooling).toBe("mean");
    expect(bgeSpec.dimensions).toBe(512);
    expect(bgeSpec.maxTokens).toBe(512);
    expect(resolveModelInputNames(bgeSpec.inputNames).tokenTypeIds).toBe(
      "token_type_ids",
    );
    const m3Spec = resolveFeaturizeSpec(m3);
    expect(m3Spec.pooling).toBe("cls");
    expect(m3Spec.dimensions).toBe(1_024);
    expect(m3Spec.maxTokens).toBe(8_192);
    expect(resolveModelInputNames(m3Spec.inputNames).tokenTypeIds).toBeNull();
    const qwenSpec = resolveFeaturizeSpec(qwen);
    expect(qwenSpec.pooling).toBe("last");
    expect(qwenSpec.dimensions).toBe(1_024);
    expect(qwenSpec.maxTokens).toBe(32_768);
    expect(resolveModelInputNames(qwenSpec.inputNames).tokenTypeIds).toBeNull();
  });

  test("query/document instruction prefixes follow the manifest", () => {
    expect(
      featurizeText("为什么", resolveFeaturizeSpec(bge), "query"),
    ).toStartWith("为这个句子");
    expect(featurizeText("正文", resolveFeaturizeSpec(bge), "document")).toBe(
      "正文",
    );
    expect(featurizeText("为什么", resolveFeaturizeSpec(m3), "query")).toBe(
      "为什么",
    );
    const qwenSpec = resolveFeaturizeSpec(qwen);
    expect(featurizeText("why", qwenSpec, "query")).toStartWith("Instruct:");
    expect(featurizeText("why", qwenSpec, "document")).toBe("why");
    expect(() => featurizeText("", qwenSpec, "query")).toThrow(/empty/);
  });

  test("the same hidden state pools differently per family", () => {
    const hidden = Float32Array.from([1, 2, 3, 4, 5, 6]);
    const options = {
      hidden,
      sequences: 1,
      tokens: 2,
      dim: 3,
      masks: [[1, 1]],
    };
    const spec = (
      pooling: "mean" | "cls" | "last",
    ): EmbeddingModelFeaturizeSpec => ({
      inputNames: ["input_ids", "attention_mask"],
      pooling,
      dimensions: 3,
      maxTokens: 8,
      queryInstruction: null,
      documentInstruction: null,
    });
    const mean = poolModelBatch({ ...options, spec: spec("mean") })[0] ?? [];
    const cls = poolModelBatch({ ...options, spec: spec("cls") })[0] ?? [];
    const last = poolModelBatch({ ...options, spec: spec("last") })[0] ?? [];
    expect(Array.from(cls)).toEqual(
      Array.from(l2Normalize(Float32Array.from([1, 2, 3]))),
    );
    expect(Array.from(last)).toEqual(
      Array.from(l2Normalize(Float32Array.from([4, 5, 6]))),
    );
    expect(Array.from(mean)).not.toEqual(Array.from(cls));
    expect(Array.from(mean)).not.toEqual(Array.from(last));
  });

  test("rejects input names or dimensions the model cannot feed", () => {
    expect(() =>
      resolveModelInputNames(["input_ids", "attention_mask", "pixel_values"]),
    ).toThrow(/Unsupported model input/);
    expect(() =>
      resolveModelInputNames(["input_ids", "input_ids", "attention_mask"]),
    ).toThrow(/more than once/);
    expect(() => resolveModelInputNames(["input_ids"])).toThrow(
      /input_ids and attention_mask/,
    );
    expect(() => resolveModelInputNames([])).toThrow(FeaturizeError);
    const spec = resolveFeaturizeSpec(bge);
    expect(() =>
      assertModelVectorDimensions(new Float32Array(512), spec),
    ).not.toThrow();
    expect(() =>
      assertModelVectorDimensions(new Float32Array(1_024), spec),
    ).toThrow(/512-dimensional/);
    expect(() =>
      poolModelBatch({
        hidden: Float32Array.from([1, 2, 3, 1, 2, 3]),
        sequences: 1,
        tokens: 2,
        dim: 3,
        masks: [[1, 1]],
        spec: { ...spec, dimensions: 4 },
      }),
    ).toThrow(/4-dimensional/);
    expect(() => applyInstructionPrefix("x", { kind: "query" })).not.toThrow();
  });
});
