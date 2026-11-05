/**
 * int8-only round trip (feature 48, C9 + B2).
 *
 * The build writes codes only when the space's precision is int8; the query
 * reader scores those codes directly and the next incremental build reuses them
 * (decoded per row). These three are one contract: changing any of them alone
 * would make an int8 space either unreadable or re-embedded from scratch on
 * every build.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadEmbeddingQuantIndex } from "@/backend/local/embedding-cache";
import { buildEmbeddingChunkPlan } from "@/backend/local/embedding-chunk";
import {
  type EmbeddingVectorUnit,
  embeddingVectorUnitDir,
  readEmbeddingIndex,
  readEmbeddingIndexPointer,
} from "@/backend/local/embedding-format";
import { searchEmbeddingQuantIndex } from "@/backend/local/embedding-quant";
import { EMBEDDING_QUANT_FLOAT32_FILE_NAME } from "@/backend/local/embedding-quant-format";
import {
  type EmbeddingRunUnit,
  runEmbeddingBuild,
} from "@/backend/local/embedding-runner";
import {
  createEmbeddingFixtureDirs,
  EMBEDDING_FIXTURE_DIMENSIONS,
  EMBEDDING_FIXTURE_TEXTS,
  type EmbeddingFixtureDirs,
  fakeEmbeddingVector,
} from "@/test-utils/embedding-fixture";

const unit: EmbeddingVectorUnit = {
  agentId: "agent-int8",
  spaceId: "space-int8-0123456789",
  conversationKey: "conv-int8",
};

let dirs: EmbeddingFixtureDirs;

beforeEach(() => {
  dirs = createEmbeddingFixtureDirs();
});

afterEach(() => {
  dirs.cleanup();
});

function plan() {
  return buildEmbeddingChunkPlan({
    parentId: "msg-1",
    text: EMBEDDING_FIXTURE_TEXTS.longTable,
  });
}

function runUnit(): EmbeddingRunUnit {
  return { unit, plans: [plan()] };
}

function unitDir(): string {
  return embeddingVectorUnitDir(unit, { root: dirs.root });
}

/** Embeds every chunk as the vector of its own text (exact-match queries). */
function exactEmbed() {
  let calls = 0;
  return {
    embed: async (chunks: readonly { text: string }[]) => {
      calls += 1;
      return chunks.map((chunk) => fakeEmbeddingVector(chunk.text));
    },
    calls: () => calls,
  };
}

describe("int8-only storage", () => {
  test("the build commits codes without float32 originals", async () => {
    const embed = exactEmbed();
    const result = await runEmbeddingBuild({
      identity: { agentId: unit.agentId, spaceId: unit.spaceId },
      units: [runUnit()],
      embed: embed.embed,
      modelId: "bge-small-zh-v1.5",
      dimensions: EMBEDDING_FIXTURE_DIMENSIONS,
      root: dirs.root,
      quant: "int8",
    });
    expect(result.status).toBe("completed");
    expect(result.completedUnits).toBe(1);

    const pointer = readEmbeddingIndexPointer(unitDir());
    expect(pointer.ok).toBe(true);
    if (!pointer.ok) return;
    expect(pointer.pointer.quant).toBe("int8");
    expect(
      existsSync(
        join(
          unitDir(),
          pointer.pointer.generation,
          EMBEDDING_QUANT_FLOAT32_FILE_NAME,
        ),
      ),
    ).toBe(false);
    // The float32 reader must refuse this generation: it is a different space.
    expect(readEmbeddingIndex(unitDir()).ok).toBe(false);
  });

  test("a query scores the codes and returns the matching parent", async () => {
    await runEmbeddingBuild({
      identity: { agentId: unit.agentId, spaceId: unit.spaceId },
      units: [runUnit()],
      embed: exactEmbed().embed,
      modelId: "bge-small-zh-v1.5",
      dimensions: EMBEDDING_FIXTURE_DIMENSIONS,
      root: dirs.root,
      quant: "int8",
    });

    const loaded = loadEmbeddingQuantIndex(unitDir(), {
      expectation: { quant: "int8" },
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const chunks = plan().chunks;
    const target = chunks[1];
    expect(target).toBeDefined();
    if (target === undefined) return;
    const found = searchEmbeddingQuantIndex(
      {
        dimensions: loaded.index.meta.dimensions,
        records: loaded.index.records,
        codes: loaded.index.codes,
        scales: loaded.index.scales,
      },
      fakeEmbeddingVector(target.text),
      { minScore: 0.5 },
    );
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.hits[0]?.parentId).toBe("msg-1");
    expect(found.chunkHits).toBeGreaterThan(0);
  });

  test("the next incremental build reuses the decoded vectors", async () => {
    const first = exactEmbed();
    await runEmbeddingBuild({
      identity: { agentId: unit.agentId, spaceId: unit.spaceId },
      units: [runUnit()],
      embed: first.embed,
      modelId: "bge-small-zh-v1.5",
      dimensions: EMBEDDING_FIXTURE_DIMENSIONS,
      root: dirs.root,
      quant: "int8",
    });

    const second = exactEmbed();
    const result = await runEmbeddingBuild({
      identity: { agentId: unit.agentId, spaceId: unit.spaceId },
      units: [runUnit()],
      embed: second.embed,
      modelId: "bge-small-zh-v1.5",
      dimensions: EMBEDDING_FIXTURE_DIMENSIONS,
      root: dirs.root,
      quant: "int8",
    });
    expect(result.status).toBe("completed");
    expect(result.reusedChunks).toBe(plan().chunks.length);
    expect(result.embeddedChunks).toBe(0);
    expect(second.calls()).toBe(0);
  });
});
