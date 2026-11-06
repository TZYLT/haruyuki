/**
 * C3/C6 → A3 embed adapters for the embedding build (feature 48).
 *
 * A3's runner calls an `EmbeddingEmbedCallback`; the runtime clients speak their
 * own batch shape. This module is the thin translation layer, and it is
 * deliberately strict: a cancelled batch or a count mismatch must abort the
 * unit (the checkpoint then retries it) rather than commit a short vector
 * matrix under the wrong chunk ids.
 *
 * Split out of `embedding-build-host.ts` when the host's start-admission guard
 * pushed that file past the 1,000-line ceiling; the behaviour is unchanged.
 *
 * Layer: `cli/helpers/`. Imports a `backend/local/` type only.
 */

import type { EmbeddingEmbedCallback } from "@/backend/local/embedding-build";

/** The runtime-client shape this adapter wraps (C3's worker facade). */
export interface EmbeddingBuiltinEmbedSource {
  embedBatched(
    texts: readonly string[],
    options?: { batchSize?: number; signal?: AbortSignal },
  ): Promise<{ vectors: readonly (Float32Array | null)[]; cancelled: boolean }>;
}

function assertVectors(
  vectors: readonly (Float32Array | null)[],
  expected: number,
  cancelled: boolean,
  source: string,
): readonly Float32Array[] {
  if (cancelled) {
    throw new Error(
      `${source} cancelled the batch before committing vectors; the unit will be retried from its checkpoint.`,
    );
  }
  if (vectors.length !== expected) {
    throw new Error(
      `${source} returned ${vectors.length} vector(s) for ${expected} chunk(s).`,
    );
  }
  return vectors.map((vector, index) => {
    if (!(vector instanceof Float32Array)) {
      throw new Error(`${source} returned no vector for chunk ${index + 1}.`);
    }
    return vector;
  });
}

export function createBuiltinEmbedAdapter(
  source: EmbeddingBuiltinEmbedSource,
  options: { batchSize?: number; signal?: AbortSignal } = {},
): EmbeddingEmbedCallback {
  return async (chunks) => {
    const output = await source.embedBatched(
      chunks.map((chunk) => chunk.text),
      options,
    );
    return assertVectors(
      output.vectors,
      chunks.length,
      output.cancelled,
      "The embedding worker",
    );
  };
}
