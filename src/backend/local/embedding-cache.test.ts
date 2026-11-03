import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  getEmbeddingIndexCacheStats,
  invalidateAllEmbeddingIndexes,
  invalidateEmbeddingIndex,
  invalidateEmbeddingQuantIndex,
  loadEmbeddingIndex,
  loadEmbeddingQuantIndex,
  peekEmbeddingIndex,
  peekEmbeddingQuantIndex,
  resetEmbeddingIndexCacheStats,
  statEmbeddingIndex,
} from "@/backend/local/embedding-cache";
import { buildEmbeddingChunkPlan } from "@/backend/local/embedding-chunk";
import {
  EMBEDDING_INDEX_FILE_NAMES,
  type EmbeddingVectorUnit,
  embeddingChunkRecordsFromPlan,
  embeddingGenerationDir,
  embeddingVectorUnitDir,
  writeEmbeddingIndex,
} from "@/backend/local/embedding-format";
import { writeEmbeddingQuantIndex } from "@/backend/local/embedding-quant-format";
import {
  createEmbeddingFixtureDirs,
  EMBEDDING_FIXTURE_DIMENSIONS,
  EMBEDDING_FIXTURE_TEXTS,
  type EmbeddingFixtureDirs,
  fakeEmbeddingVector,
} from "@/test-utils/embedding-fixture";

const conversationUnit: EmbeddingVectorUnit = {
  agentId: "agent-1",
  spaceId: "space-0123456789abcdef",
  conversationKey: "conv-1",
};

const otherUnit: EmbeddingVectorUnit = {
  agentId: "agent-1",
  spaceId: "space-0123456789abcdef",
  conversationKey: "conv-2",
};

let dirs: EmbeddingFixtureDirs;

beforeEach(() => {
  dirs = createEmbeddingFixtureDirs();
  invalidateAllEmbeddingIndexes();
  resetEmbeddingIndexCacheStats();
});

afterEach(() => {
  invalidateAllEmbeddingIndexes();
  dirs.cleanup();
});

function dirFor(unit: EmbeddingVectorUnit = conversationUnit): string {
  return embeddingVectorUnitDir(unit, { root: dirs.root });
}

function writeConversation(
  text: string,
  options: {
    parentId?: string;
    generation?: string;
    unit?: EmbeddingVectorUnit;
  } = {},
): string {
  const unit = options.unit ?? conversationUnit;
  const plan = buildEmbeddingChunkPlan({
    parentId: options.parentId ?? "msg-1",
    text,
  });
  const written = writeEmbeddingIndex({
    unitDir: dirFor(unit),
    unit,
    modelId: "bge-small-zh-v1.5",
    dimensions: EMBEDDING_FIXTURE_DIMENSIONS,
    records: embeddingChunkRecordsFromPlan(plan),
    vectors: plan.chunks.map((chunk) => fakeEmbeddingVector(chunk.text)),
    coverage: plan.coverage,
    ...(options.generation === undefined
      ? {}
      : { generation: options.generation }),
  });
  return written.generation;
}

/** Writes one int8 generation for the default unit and returns its identity. */
function writeQuantConversation(
  options: {
    text?: string;
    parentId?: string;
    generation?: string;
    rescore?: boolean;
    unit?: EmbeddingVectorUnit;
  } = {},
): string {
  const unit = options.unit ?? conversationUnit;
  const plan = buildEmbeddingChunkPlan({
    parentId: options.parentId ?? "msg-1",
    text: options.text ?? EMBEDDING_FIXTURE_TEXTS.chineseProse,
  });
  const written = writeEmbeddingQuantIndex({
    unitDir: dirFor(unit),
    unit,
    modelId: "bge-small-zh-v1.5",
    dimensions: EMBEDDING_FIXTURE_DIMENSIONS,
    records: embeddingChunkRecordsFromPlan(plan),
    vectors: plan.chunks.map((chunk) =>
      fakeEmbeddingVector(chunk.text, EMBEDDING_FIXTURE_DIMENSIONS),
    ),
    coverage: plan.coverage,
    ...(options.rescore === undefined ? {} : { rescore: options.rescore }),
    ...(options.generation === undefined
      ? {}
      : { generation: options.generation }),
  });
  return written.generation;
}

describe("resident cache", () => {
  test("the first load reads the generation and later loads hit", () => {
    writeConversation(EMBEDDING_FIXTURE_TEXTS.chineseProse);

    const first = loadEmbeddingIndex(dirFor());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.status).toBe("loaded");
    expect(first.index.meta.chunkCount).toBeGreaterThan(0);
    expect(peekEmbeddingIndex(dirFor())).toBe(first.index);

    const second = loadEmbeddingIndex(dirFor());
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.status).toBe("hit");
    // Same object: a hit must not rebuild the snapshot.
    expect(second.index).toBe(first.index);

    const stats = getEmbeddingIndexCacheStats();
    expect(stats.entries).toBe(1);
    expect(stats.reloads).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.hits).toBe(1);
  });

  test("68 loads of one unit re-read it exactly once", () => {
    writeConversation(EMBEDDING_FIXTURE_TEXTS.chineseProse);
    for (let round = 0; round < 68; round += 1) {
      const result = loadEmbeddingIndex(dirFor());
      expect(result.ok).toBe(true);
    }
    const stats = getEmbeddingIndexCacheStats();
    expect(stats.reloads).toBe(1);
    expect(stats.hits).toBe(67);
  });

  test("a committed generation swap invalidates the resident snapshot", () => {
    const firstGeneration = writeConversation(
      EMBEDDING_FIXTURE_TEXTS.chineseProse,
      { generation: "gen-cache-1" },
    );
    const first = loadEmbeddingIndex(dirFor());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.index.generation).toBe(firstGeneration);

    const secondGeneration = writeConversation(
      EMBEDDING_FIXTURE_TEXTS.mixedProse,
      { parentId: "msg-2", generation: "gen-cache-2" },
    );
    const second = loadEmbeddingIndex(dirFor());
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.status).toBe("loaded");
    expect(second.index.generation).toBe(secondGeneration);
    expect(second.index.records[0]?.parentId).toBe("msg-2");
    expect(getEmbeddingIndexCacheStats().reloads).toBe(2);
  });

  test("two units are cached independently", () => {
    writeConversation(EMBEDDING_FIXTURE_TEXTS.chineseProse);
    writeConversation(EMBEDDING_FIXTURE_TEXTS.mixedProse, {
      unit: otherUnit,
      parentId: "msg-other",
    });
    expect(loadEmbeddingIndex(dirFor()).ok).toBe(true);
    expect(loadEmbeddingIndex(dirFor(otherUnit)).ok).toBe(true);
    expect(getEmbeddingIndexCacheStats().entries).toBe(2);

    invalidateAllEmbeddingIndexes();
    expect(getEmbeddingIndexCacheStats().entries).toBe(0);
    expect(peekEmbeddingIndex(dirFor())).toBeUndefined();
    expect(loadEmbeddingIndex(dirFor()).ok).toBe(true);
  });
});

describe("failure and invalidation", () => {
  test("a corrupt generation is unusable and the failure is cached", () => {
    const generation = writeConversation(EMBEDDING_FIXTURE_TEXTS.chineseProse, {
      generation: "gen-corrupt",
    });
    truncateSync(
      join(
        embeddingGenerationDir(dirFor(), generation),
        EMBEDDING_INDEX_FILE_NAMES.vectors,
      ),
      8,
    );

    const first = loadEmbeddingIndex(dirFor());
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.status).toBe("unusable");
    expect(first.problem).toBe("corrupt");

    const second = loadEmbeddingIndex(dirFor());
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.problem).toBe("corrupt");
    // The broken file is not re-read while its pointer is unchanged.
    expect(getEmbeddingIndexCacheStats().reloads).toBe(1);
    expect(getEmbeddingIndexCacheStats().unusable).toBe(2);
    expect(peekEmbeddingIndex(dirFor())).toBeUndefined();
  });

  test("a rebuilt unit recovers after an unusable read", () => {
    const generation = writeConversation(EMBEDDING_FIXTURE_TEXTS.chineseProse, {
      generation: "gen-broken",
    });
    truncateSync(
      join(
        embeddingGenerationDir(dirFor(), generation),
        EMBEDDING_INDEX_FILE_NAMES.vectors,
      ),
      8,
    );
    expect(loadEmbeddingIndex(dirFor()).ok).toBe(false);

    writeConversation(EMBEDDING_FIXTURE_TEXTS.mixedProse, {
      generation: "gen-fixed",
    });
    const recovered = loadEmbeddingIndex(dirFor());
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    expect(recovered.status).toBe("loaded");
    expect(recovered.index.generation).toBe("gen-fixed");
  });

  test("invalidate forces the next load to read the disk again", () => {
    writeConversation(EMBEDDING_FIXTURE_TEXTS.chineseProse);
    expect(loadEmbeddingIndex(dirFor()).ok).toBe(true);
    expect(invalidateEmbeddingIndex(dirFor())).toBe(true);
    expect(invalidateEmbeddingIndex(dirFor())).toBe(false);
    const reloaded = loadEmbeddingIndex(dirFor());
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) return;
    expect(reloaded.status).toBe("loaded");
    expect(getEmbeddingIndexCacheStats().reloads).toBe(2);
  });

  test("a missing pointer is unusable and not cached", () => {
    const result = loadEmbeddingIndex(join(dirs.root, "absent"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toBe("missing");
    expect(getEmbeddingIndexCacheStats().entries).toBe(0);
    expect(getEmbeddingIndexCacheStats().unusable).toBe(1);
  });

  test("an expectation mismatch is unusable on both load paths", () => {
    writeConversation(EMBEDDING_FIXTURE_TEXTS.chineseProse);
    const cold = loadEmbeddingIndex(dirFor(), {
      expectation: { modelId: "another-model" },
    });
    expect(cold.ok).toBe(false);
    if (cold.ok) return;
    expect(cold.problem).toBe("expectation-mismatch");

    const loaded = loadEmbeddingIndex(dirFor(), {
      expectation: { modelId: "bge-small-zh-v1.5" },
    });
    expect(loaded.ok).toBe(true);
    const reloadsBefore = getEmbeddingIndexCacheStats().reloads;

    const hitPath = loadEmbeddingIndex(dirFor(), {
      expectation: { dimensions: EMBEDDING_FIXTURE_DIMENSIONS + 1 },
    });
    expect(hitPath.ok).toBe(false);
    if (hitPath.ok) return;
    expect(hitPath.problem).toBe("expectation-mismatch");
    // The mismatch came from the resident meta; no generation re-read needed.
    expect(getEmbeddingIndexCacheStats().reloads).toBe(reloadsBefore);
  });

  test("a garbage pointer is unusable", () => {
    writeConversation(EMBEDDING_FIXTURE_TEXTS.chineseProse);
    const pointerPath = join(dirFor(), EMBEDDING_INDEX_FILE_NAMES.current);
    writeFileSync(pointerPath, "{not json", "utf8");
    const result = loadEmbeddingIndex(dirFor());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toBe("unreadable");
  });
});

describe("stat", () => {
  test("stat reports whether the resident snapshot matches the pointer", () => {
    const before = statEmbeddingIndex(dirFor());
    expect(before.ok).toBe(false);

    writeConversation(EMBEDDING_FIXTURE_TEXTS.chineseProse);
    const cold = statEmbeddingIndex(dirFor());
    expect(cold.ok).toBe(true);
    if (!cold.ok) return;
    expect(cold.cached).toBe(false);
    expect(cold.signature.size).toBeGreaterThan(0);

    expect(loadEmbeddingIndex(dirFor()).ok).toBe(true);
    const warm = statEmbeddingIndex(dirFor());
    expect(warm.ok).toBe(true);
    if (!warm.ok) return;
    expect(warm.cached).toBe(true);

    writeConversation(EMBEDDING_FIXTURE_TEXTS.mixedProse, {
      generation: "gen-after-stat",
    });
    const stale = statEmbeddingIndex(dirFor());
    expect(stale.ok).toBe(true);
    if (!stale.ok) return;
    expect(stale.cached).toBe(false);

    const pointer = JSON.parse(
      readFileSync(join(dirFor(), EMBEDDING_INDEX_FILE_NAMES.current), "utf8"),
    ) as { generation: string };
    expect(pointer.generation).toBe("gen-after-stat");
  });
});

describe("int8 cache", () => {
  test("loads an int8 generation by pointer and hits on the second call", () => {
    const generation = writeQuantConversation({ generation: "gen-i8-cache" });
    const first = loadEmbeddingQuantIndex(dirFor(), { mode: "int8-rescore" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.status).toBe("loaded");
    expect(first.mode).toBe("int8-rescore");
    expect(first.rescoreUnavailable).toBe(false);
    expect(first.index.generation).toBe(generation);
    expect(first.index.meta.quant).toBe("int8");
    expect(first.index.exactVectors).toBeDefined();
    expect(peekEmbeddingQuantIndex(dirFor(), "int8-rescore")).toBe(first.index);

    const second = loadEmbeddingQuantIndex(dirFor(), {
      mode: "int8-rescore",
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.status).toBe("hit");
    // Same object: a hit must not rebuild the snapshot.
    expect(second.index).toBe(first.index);

    const stats = getEmbeddingIndexCacheStats();
    expect(stats.quantEntries).toBe(1);
    expect(stats.quantReloads).toBe(1);
    expect(stats.quantMisses).toBe(1);
    expect(stats.quantHits).toBe(1);
    expect(stats.quantUnusable).toBe(0);
  });

  test("int8-only keeps the float32 originals out of memory", () => {
    writeQuantConversation();
    const rescore = loadEmbeddingQuantIndex(dirFor());
    expect(rescore.ok).toBe(true);
    if (!rescore.ok) return;
    expect(rescore.mode).toBe("int8-rescore");
    expect(rescore.index.exactVectors).toBeDefined();

    const int8Only = loadEmbeddingQuantIndex(dirFor(), { mode: "int8-only" });
    expect(int8Only.ok).toBe(true);
    if (!int8Only.ok) return;
    expect(int8Only.status).toBe("loaded");
    expect(int8Only.mode).toBe("int8-only");
    expect(int8Only.index.exactVectors).toBeUndefined();
    expect(int8Only.rescoreUnavailable).toBe(true);
    // One entry per unit/mode: the modes are cached independently.
    expect(getEmbeddingIndexCacheStats().quantEntries).toBe(2);
    expect(peekEmbeddingQuantIndex(dirFor(), "int8-only")).toBe(int8Only.index);
    expect(peekEmbeddingQuantIndex(dirFor(), "int8-rescore")).toBe(
      rescore.index,
    );

    invalidateAllEmbeddingIndexes();
    expect(getEmbeddingIndexCacheStats().quantEntries).toBe(0);
    expect(peekEmbeddingQuantIndex(dirFor(), "int8-only")).toBeUndefined();
  });

  test("an int8-only generation reports rescore as unavailable", () => {
    writeQuantConversation({ rescore: false });
    const loaded = loadEmbeddingQuantIndex(dirFor(), { mode: "int8-rescore" });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.mode).toBe("int8-only");
    expect(loaded.rescoreUnavailable).toBe(true);
    expect(loaded.index.exactVectors).toBeUndefined();
    expect(loaded.index.meta.float32VectorsBytes).toBe(0);
    // The requested mode still owns the entry so switching profiles does not
    // evict the other one.
    expect(peekEmbeddingQuantIndex(dirFor(), "int8-rescore")).toBe(
      loaded.index,
    );
  });

  test("the two readers refuse each other's quant", () => {
    writeQuantConversation();
    const float32Load = loadEmbeddingIndex(dirFor());
    expect(float32Load.ok).toBe(false);
    if (float32Load.ok) return;
    expect(float32Load.problem).toBe("unsupported-quant");
    expect(getEmbeddingIndexCacheStats().entries).toBe(1);

    invalidateAllEmbeddingIndexes();
    writeConversation(EMBEDDING_FIXTURE_TEXTS.chineseProse);
    const quantLoad = loadEmbeddingQuantIndex(dirFor(), {
      mode: "int8-rescore",
    });
    expect(quantLoad.ok).toBe(false);
    if (quantLoad.ok) return;
    expect(quantLoad.problem).toBe("unsupported-quant");
  });

  test("a quant/dimension/model mismatch is unusable on both paths", () => {
    writeQuantConversation();
    const cold = loadEmbeddingQuantIndex(dirFor(), {
      expectation: { quant: "f32" },
    });
    expect(cold.ok).toBe(false);
    if (cold.ok) return;
    expect(cold.problem).toBe("expectation-mismatch");

    const loaded = loadEmbeddingQuantIndex(dirFor(), {
      expectation: {
        quant: "int8",
        modelId: "bge-small-zh-v1.5",
        dimensions: EMBEDDING_FIXTURE_DIMENSIONS,
        agentId: "agent-1",
        spaceId: "space-0123456789abcdef",
      },
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const reloadsBefore = getEmbeddingIndexCacheStats().quantReloads;

    const hitPath = loadEmbeddingQuantIndex(dirFor(), {
      expectation: { dimensions: EMBEDDING_FIXTURE_DIMENSIONS + 1 },
    });
    expect(hitPath.ok).toBe(false);
    if (hitPath.ok) return;
    expect(hitPath.problem).toBe("expectation-mismatch");
    // The mismatch came from the resident meta; no generation re-read needed.
    expect(getEmbeddingIndexCacheStats().quantReloads).toBe(reloadsBefore);
  });

  test("a committed int8 generation swap invalidates the snapshot", () => {
    writeQuantConversation({ generation: "gen-i8-1" });
    const first = loadEmbeddingQuantIndex(dirFor());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.index.generation).toBe("gen-i8-1");

    writeQuantConversation({
      generation: "gen-i8-2",
      text: EMBEDDING_FIXTURE_TEXTS.mixedProse,
      parentId: "msg-2",
    });
    const second = loadEmbeddingQuantIndex(dirFor());
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.status).toBe("loaded");
    expect(second.index.generation).toBe("gen-i8-2");
    expect(second.index.records[0]?.parentId).toBe("msg-2");
    expect(getEmbeddingIndexCacheStats().quantReloads).toBe(2);
  });

  test("invalidation drops int8 entries from both caches", () => {
    writeQuantConversation();
    expect(loadEmbeddingQuantIndex(dirFor()).ok).toBe(true);
    expect(peekEmbeddingQuantIndex(dirFor())).toBeDefined();
    expect(invalidateEmbeddingQuantIndex(dirFor())).toBe(true);
    expect(peekEmbeddingQuantIndex(dirFor())).toBeUndefined();
    expect(invalidateEmbeddingQuantIndex(dirFor())).toBe(false);

    expect(loadEmbeddingQuantIndex(dirFor()).ok).toBe(true);
    expect(getEmbeddingIndexCacheStats().quantReloads).toBe(2);
    // The unit-scoped invalidator also owns the int8 entries.
    expect(invalidateEmbeddingIndex(dirFor())).toBe(true);
    expect(peekEmbeddingQuantIndex(dirFor())).toBeUndefined();
  });

  test("an int8 generation is cached as unusable while the pointer is stale", () => {
    const generation = writeQuantConversation({
      generation: "gen-i8-broken",
    });
    truncateSync(
      join(
        embeddingGenerationDir(dirFor(), generation),
        EMBEDDING_INDEX_FILE_NAMES.vectors,
      ),
      4,
    );
    const first = loadEmbeddingQuantIndex(dirFor());
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.problem).toBe("corrupt");
    const second = loadEmbeddingQuantIndex(dirFor());
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.problem).toBe("corrupt");
    // The broken generation is not re-read while its pointer is unchanged.
    expect(getEmbeddingIndexCacheStats().quantReloads).toBe(1);
    expect(getEmbeddingIndexCacheStats().quantUnusable).toBe(2);
  });
});
