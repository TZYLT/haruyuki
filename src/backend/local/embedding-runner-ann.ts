/**
 * The ANN sidecar trigger for one finished build (48-2 §4.10, A6's write side).
 *
 * Split from `embedding-runner.ts` so the runner keeps room under the 1,000-line
 * ceiling for its own options and loop. Best effort: a sidecar failure never
 * fails a build that already committed its vectors; the query path simply keeps
 * scanning flat.
 *
 * The runner shape is structural rather than imported, so this module does not
 * form an import cycle with the runner that calls it.
 *
 * Layer: `backend/local/`. Same-layer imports only.
 */

import { debugWarn } from "@/utils/debug";
import { ANN_TRIGGER_CHUNK_COUNT } from "./embedding-ann-index";
import { writeAnnShardSidecar } from "./embedding-ann-search-sidecar";

/** The options this module reads; the runner passes itself. */
export type AnnSidecarRunnerOptions = {
  quant?: "f32" | "int8";
  annTriggerChunkCount?: number;
};

/** One unit, as the sidecar builder names it. */
export type AnnSidecarUnit = {
  unit:
    | { conversationKey: string }
    | { memoryFileKey: string }
    | { conversationKey?: undefined; memoryFileKey?: undefined };
};

/** The space identity the sidecar is written for. */
export type AnnSidecarIdentity = { agentId: string; spaceId: string };

/**
 * Write the sidecar when the space is big enough to need one.
 *
 * Below the trigger the exact B2 scan is the answer. int8-only spaces are
 * skipped: the sidecar carries float32 vectors, and an int8 space has no float32
 * view to build one from without paying the memory int8 was chosen to avoid.
 */
export function maybeWriteAnnSidecar(
  options: AnnSidecarRunnerOptions,
  units: readonly AnnSidecarUnit[],
  root: string,
  identity: AnnSidecarIdentity,
  totalChunks: number,
): void {
  if ((options.quant ?? "f32") !== "f32") return;
  const trigger = options.annTriggerChunkCount ?? ANN_TRIGGER_CHUNK_COUNT;
  if (totalChunks <= trigger || units.length === 0) return;
  const annUnits = units.map(({ unit }) =>
    "memoryFileKey" in unit && typeof unit.memoryFileKey === "string"
      ? { kind: "memory" as const, file: "", memoryFileKey: unit.memoryFileKey }
      : {
          kind: "transcript" as const,
          conversationKey:
            "conversationKey" in unit &&
            typeof unit.conversationKey === "string"
              ? unit.conversationKey
              : "",
        },
  );
  try {
    const written = writeAnnShardSidecar({
      space: { agentId: identity.agentId, spaceId: identity.spaceId },
      units: annUnits,
      root,
    });
    if (!written.ok) {
      debugWarn(
        "embedding",
        `ANN sidecar not written (${written.problem}${written.detail === undefined ? "" : `: ${written.detail}`}); queries keep scanning flat.`,
      );
    }
  } catch (error) {
    debugWarn(
      "embedding",
      `ANN sidecar could not be written: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
