/**
 * Bounded retention of committed index generations (feature 48).
 *
 * Every case builds real generations through B2's writer under a fresh OS temp
 * directory (docs/31 §1.2 A2): no real harness path is read or written. The
 * assertions are about the *deletion surface* — which generations survive, what
 * is never touched, and that cleanup never throws.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  type Dirent,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEmbeddingChunkPlan } from "@/backend/local/embedding-chunk";
import {
  type EmbeddingVectorUnit,
  embeddingChunkRecordsFromPlan,
  embeddingCurrentPointerPath,
  writeEmbeddingIndex,
  writeEmbeddingIndexPointer,
} from "@/backend/local/embedding-format";
import {
  EMBEDDING_GENERATION_KEEP_PREVIOUS,
  previewEmbeddingGenerationPrune,
  pruneEmbeddingGenerations,
} from "@/backend/local/embedding-generation-prune";
import { fakeEmbeddingVector } from "@/test-utils/embedding-fixture";

const DIMENSIONS = 8;

const CONVERSATION_KEY = "conv-prune";

const UNIT: EmbeddingVectorUnit = {
  agentId: "agent-prune",
  spaceId: "space-prune",
  conversationKey: CONVERSATION_KEY,
};

const tempDirs: string[] = [];

function makeUnitDir(): string {
  const root = mkdtempSync(join(tmpdir(), "hryk-w2-prune-"));
  tempDirs.push(root);
  return join(root, UNIT.agentId, UNIT.spaceId, CONVERSATION_KEY);
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

let unitDir: string;

beforeEach(() => {
  unitDir = makeUnitDir();
});

function writeGeneration(generation: string) {
  const plan = buildEmbeddingChunkPlan({
    parentId: `msg-${generation}`,
    text: "部署卡住的原因是 readiness 探针超时。",
  });
  return writeEmbeddingIndex({
    unitDir,
    unit: UNIT,
    modelId: "bge-small-zh-v1.5",
    dimensions: DIMENSIONS,
    records: embeddingChunkRecordsFromPlan(plan),
    vectors: plan.chunks.map((chunk) =>
      fakeEmbeddingVector(chunk.text, DIMENSIONS),
    ),
    coverage: plan.coverage,
    generation,
  });
}

function generationDirs(): string[] {
  return readdirSync(unitDir, { withFileTypes: true })
    .filter((entry: Dirent) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

describe("pruneEmbeddingGenerations", () => {
  test("keeps the current and previous generation, removes the rest", () => {
    writeGeneration("gen-prune-a");
    writeGeneration("gen-prune-b");
    const written = writeGeneration("gen-prune-c");

    const preview = previewEmbeddingGenerationPrune(unitDir);
    expect(preview.current).toBe(written.generation);
    expect(preview.keep).toBe(EMBEDDING_GENERATION_KEEP_PREVIOUS);
    expect(preview.candidates.map((entry) => entry.generation)).toEqual([
      "gen-prune-a",
    ]);

    const result = pruneEmbeddingGenerations(unitDir);
    expect(result.deleted).toHaveLength(1);
    expect(result.warnings).toEqual([]);
    expect(generationDirs()).toEqual(["gen-prune-b", "gen-prune-c"]);
  });

  test("never removes the generation current.json points at", () => {
    const first = writeGeneration("gen-prune-old");
    writeGeneration("gen-prune-mid");
    writeGeneration("gen-prune-new");
    // Move the pointer back: the current generation is now the oldest one.
    writeEmbeddingIndexPointer(unitDir, first.pointer);

    const result = pruneEmbeddingGenerations(unitDir, { keep: 0 });
    expect(result.deleted.sort()).toHaveLength(2);
    expect(generationDirs()).toEqual(["gen-prune-old"]);
  });

  test("keeps the previous generation even when it is not adjacent", () => {
    const first = writeGeneration("gen-prune-1");
    const second = writeGeneration("gen-prune-2");
    writeGeneration("gen-prune-3");
    writeEmbeddingIndexPointer(unitDir, second.pointer);

    pruneEmbeddingGenerations(unitDir);
    // current = 2 → 3 is the previous window; 1 is out of it.
    expect(generationDirs()).toEqual(["gen-prune-2", "gen-prune-3"]);
    expect(first.generation).toBe("gen-prune-1");
  });

  test("leaves temp directories and plain files alone", () => {
    writeGeneration("gen-prune-a");
    writeGeneration("gen-prune-b");
    writeGeneration("gen-prune-c");
    mkdirSync(join(unitDir, ".tmp-crashed"));
    writeFileSync(join(unitDir, "notes.txt"), "keep me", "utf8");

    const result = pruneEmbeddingGenerations(unitDir);
    expect(result.deleted).toHaveLength(1);
    expect(generationDirs()).toEqual([
      ".tmp-crashed",
      "gen-prune-b",
      "gen-prune-c",
    ]);
    expect(
      readdirSync(unitDir, { withFileTypes: true }).some(
        (entry) => entry.isFile() && entry.name === "notes.txt",
      ),
    ).toBe(true);
  });

  test("a corrupt pointer keeps the newest generations as recovery material", () => {
    writeGeneration("gen-prune-a");
    writeGeneration("gen-prune-b");
    writeGeneration("gen-prune-c");
    writeFileSync(embeddingCurrentPointerPath(unitDir), "{not json", "utf8");

    const preview = previewEmbeddingGenerationPrune(unitDir);
    expect(preview.current).toBeNull();
    expect(preview.candidates).toHaveLength(2);

    const result = pruneEmbeddingGenerations(unitDir);
    expect(result.deleted).toHaveLength(2);
    expect(generationDirs()).toEqual(["gen-prune-c"]);
  });

  test("a missing unit directory is an empty no-op and never throws", () => {
    const missing = join(unitDir, "absent");
    expect(previewEmbeddingGenerationPrune(missing).candidates).toEqual([]);
    expect(pruneEmbeddingGenerations(missing)).toEqual({
      deleted: [],
      skipped: [],
      warnings: [],
    });
  });
});
