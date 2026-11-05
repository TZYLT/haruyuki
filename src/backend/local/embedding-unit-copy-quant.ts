/**
 * Copies one **int8-only** unit generation (feature 48, B5's fork path).
 *
 * Kept out of `embedding-lifecycle.ts` (it is at the size ceiling) because it is
 * self-contained: read the source codes, decode one row at a time, and let the
 * quant writer commit a generation for the target unit. No lifecycle type is
 * imported, so this module stays a leaf and cannot create a cycle.
 *
 * Layer: `backend/local/`. Imports only the format/quant modules.
 */

import type { EmbeddingVectorUnit } from "./embedding-format";
import { dequantizeEmbeddingVectors } from "./embedding-quant";
import {
  readEmbeddingQuantIndex,
  writeEmbeddingQuantIndex,
} from "./embedding-quant-format";

export type CopyQuantUnitIndexResult =
  | {
      ok: true;
      sourceGeneration: string;
      targetGeneration: string;
      records: number;
    }
  | {
      ok: false;
      /** `source-unavailable` is "nothing to copy"; `write-failed` is IO. */
      problem: "source-unavailable" | "write-failed";
      detail: string;
    };

export interface CopyQuantUnitIndexInput {
  sourceUnitDir: string;
  targetUnitDir: string;
  targetUnit: EmbeddingVectorUnit;
}

/** Never throws: every failure is a typed result the caller maps to `failure`. */
export function copyQuantUnitIndex(
  input: CopyQuantUnitIndexInput,
): CopyQuantUnitIndexResult {
  const source = readEmbeddingQuantIndex(input.sourceUnitDir, {
    includeFloat32: false,
  });
  if (!source.ok) {
    return {
      ok: false,
      problem: "source-unavailable",
      detail: source.detail ?? source.problem,
    };
  }
  const { meta, records, codes, scales } = source.snapshot;
  const decoded = dequantizeEmbeddingVectors({
    dimensions: meta.dimensions,
    count: records.length,
    codes,
    scales,
  });
  const vectors: Float32Array[] = [];
  for (let row = 0; row < meta.chunkCount; row += 1) {
    const start = row * meta.dimensions;
    vectors.push(decoded.slice(start, start + meta.dimensions) as Float32Array);
  }
  try {
    const written = writeEmbeddingQuantIndex({
      unitDir: input.targetUnitDir,
      unit: input.targetUnit,
      modelId: meta.modelId,
      dimensions: meta.dimensions,
      records: records.map(({ vectorScale: _scale, ...record }) => record),
      vectors,
      coverage: meta.coverage,
      rescore: false,
    });
    return {
      ok: true,
      sourceGeneration: source.snapshot.generation,
      targetGeneration: written.generation,
      records: written.meta.chunkCount,
    };
  } catch (error) {
    return {
      ok: false,
      problem: "write-failed",
      detail: `cannot write target generation: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
