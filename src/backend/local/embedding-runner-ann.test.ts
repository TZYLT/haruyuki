/**
 * The build-side half of A6 (feature 48 §4.10): a completed build writes the
 * ANN sidecar only when the space is big enough, and never for int8-only (the
 * format carries float32 vectors).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  ANN_SEARCH_MANIFEST_FILE_NAME,
  annShardSidecarDir,
} from "@/backend/local/embedding-ann-search";
import { buildEmbeddingChunkPlan } from "@/backend/local/embedding-chunk";
import type { EmbeddingVectorUnit } from "@/backend/local/embedding-format";
import { runEmbeddingBuild } from "@/backend/local/embedding-runner";
import {
  createEmbeddingFixtureDirs,
  EMBEDDING_FIXTURE_DIMENSIONS,
  EMBEDDING_FIXTURE_TEXTS,
  type EmbeddingFixtureDirs,
  fakeEmbeddingVector,
} from "@/test-utils/embedding-fixture";

const unit: EmbeddingVectorUnit = {
  agentId: "agent-ann-build",
  spaceId: "space-ann-0123456789",
  conversationKey: "conv-ann",
};

let dirs: EmbeddingFixtureDirs;

beforeEach(() => {
  dirs = createEmbeddingFixtureDirs();
});

afterEach(() => {
  dirs.cleanup();
});

function runUnit() {
  return {
    unit,
    plans: [
      buildEmbeddingChunkPlan({
        parentId: "msg-1",
        text: EMBEDDING_FIXTURE_TEXTS.longTable,
      }),
    ],
  };
}

async function build(options: {
  quant?: "f32" | "int8";
  annTriggerChunkCount?: number;
}) {
  return await runEmbeddingBuild({
    identity: { agentId: unit.agentId, spaceId: unit.spaceId },
    units: [runUnit()],
    embed: async (chunks) =>
      chunks.map((chunk) => fakeEmbeddingVector(chunk.text)),
    modelId: "bge-small-zh-v1.5",
    dimensions: EMBEDDING_FIXTURE_DIMENSIONS,
    root: dirs.root,
    ...options,
  });
}

function sidecarManifestPath(): string {
  return join(
    annShardSidecarDir(
      { agentId: unit.agentId, spaceId: unit.spaceId },
      { root: dirs.root },
    ),
    ANN_SEARCH_MANIFEST_FILE_NAME,
  );
}

describe("the ANN sidecar at build time", () => {
  test("a completed f32 build above the trigger writes the sidecar", async () => {
    const result = await build({ annTriggerChunkCount: 1 });
    expect(result.status).toBe("completed");
    expect(existsSync(sidecarManifestPath())).toBe(true);
  });

  test("a build below the trigger writes nothing", async () => {
    const result = await build({});
    expect(result.status).toBe("completed");
    expect(existsSync(sidecarManifestPath())).toBe(false);
  });

  test("int8-only never writes the float32 sidecar", async () => {
    const result = await build({
      quant: "int8",
      annTriggerChunkCount: 1,
    });
    expect(result.status).toBe("completed");
    expect(existsSync(sidecarManifestPath())).toBe(false);
  });
});
