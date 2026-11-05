import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  buildEmbeddingChunkPlan,
  joinProseSpans,
} from "@/backend/local/embedding-chunk";
import {
  type EmbeddingIndexSnapshot,
  type EmbeddingVectorUnit,
  embeddingChunkRecordFromChunk,
  embeddingChunkRecordsFromPlan,
  embeddingVectorUnitDir,
  hashEmbeddingText,
  readEmbeddingIndex,
  writeEmbeddingIndex,
} from "@/backend/local/embedding-format";
import {
  EMBEDDING_SEARCH_DEFAULT_TOP_K,
  searchEmbeddingIndex,
} from "@/backend/local/embedding-search";
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

function unitDir(target: EmbeddingVectorUnit = unit): string {
  return embeddingVectorUnitDir(target, { root: dirs.root });
}

type ParentInput = { parentId: string; text: string };

/** Writes one generation from B1 plans and returns the validated snapshot. */
function writeAndLoad(
  parents: readonly ParentInput[],
  target: EmbeddingVectorUnit = unit,
): EmbeddingIndexSnapshot {
  const records = parents.flatMap((parent) =>
    embeddingChunkRecordsFromPlan(
      buildEmbeddingChunkPlan({
        parentId: parent.parentId,
        text: parent.text,
      }),
    ),
  );
  const vectors = parents.flatMap((parent) =>
    buildEmbeddingChunkPlan({
      parentId: parent.parentId,
      text: parent.text,
    }).chunks.map((chunk) => fakeEmbeddingVector(chunk.text)),
  );
  const coverage = {
    embeddedChars: parents.reduce(
      (total, parent) => total + parent.text.length,
      0,
    ),
    recallableChars: parents.reduce(
      (total, parent) => total + parent.text.length,
      0,
    ),
    ratio: 1,
  };
  writeEmbeddingIndex({
    unitDir: unitDir(target),
    unit: target,
    modelId: "bge-small-zh-v1.5",
    dimensions: EMBEDDING_FIXTURE_DIMENSIONS,
    records,
    vectors,
    coverage,
  });
  const read = readEmbeddingIndex(unitDir(target));
  if (!read.ok) {
    throw new Error(`fixture index did not load: ${read.problem}`);
  }
  return read.snapshot;
}

describe("brute-force search", () => {
  test("an exact chunk match scores ~1 and reports the matched chunk", () => {
    const text = EMBEDDING_FIXTURE_TEXTS.longTable;
    const plan = buildEmbeddingChunkPlan({ parentId: "msg-long", text });
    expect(plan.chunks.length).toBeGreaterThan(1);
    const snapshot = writeAndLoad([{ parentId: "msg-long", text }]);
    const target = plan.chunks[1];
    expect(target).toBeDefined();
    if (target === undefined) return;

    const result = searchEmbeddingIndex(
      snapshot,
      fakeEmbeddingVector(target.text),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hits.length).toBeGreaterThan(0);
    const best = result.hits[0];
    expect(best).toBeDefined();
    if (best === undefined) return;
    expect(best.parentId).toBe("msg-long");
    expect(best.chunkIndex).toBe(target.chunkIndex);
    expect(best.score).toBeGreaterThan(0.99);
    expect(best.focusChar).toBe(target.focusChar);
    expect(best.startChar).toBe(target.startChar);
    expect(best.endChar).toBe(target.endChar);
    expect(best.textHash).toBe(hashEmbeddingText(target.text));
    expect(result.scannedChunks).toBe(plan.chunks.length);
  });

  test("chunks of one parent aggregate to the best chunk, one hit per parent", () => {
    const text = EMBEDDING_FIXTURE_TEXTS.longTable;
    const plan = buildEmbeddingChunkPlan({ parentId: "msg-long", text });
    const snapshot = writeAndLoad([{ parentId: "msg-long", text }]);
    const target = plan.chunks[plan.chunks.length - 1];
    expect(target).toBeDefined();
    if (target === undefined) return;

    const result = searchEmbeddingIndex(
      snapshot,
      fakeEmbeddingVector(target.text),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.chunkIndex).toBe(target.chunkIndex);
  });

  test("chunkHits counts chunks that clear the floor, before aggregation", () => {
    const text = EMBEDDING_FIXTURE_TEXTS.longTable;
    const plan = buildEmbeddingChunkPlan({ parentId: "msg-long", text });
    const snapshot = writeAndLoad([{ parentId: "msg-long", text }]);
    const target = plan.chunks[1];
    expect(target).toBeDefined();
    if (target === undefined) return;

    const result = searchEmbeddingIndex(
      snapshot,
      fakeEmbeddingVector(target.text),
      { minScore: 0.99 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hits).toHaveLength(1);
    expect(result.chunkHits).toBe(1);
    expect(result.scannedChunks).toBe(plan.chunks.length);
  });

  test("top-k limits parent hits and sorts by score", () => {
    const parents: ParentInput[] = [
      { parentId: "msg-a", text: EMBEDDING_FIXTURE_TEXTS.chineseProse },
      { parentId: "msg-b", text: EMBEDDING_FIXTURE_TEXTS.mixedProse },
      { parentId: "msg-c", text: EMBEDDING_FIXTURE_TEXTS.logLines },
    ];
    const snapshot = writeAndLoad(parents);
    const result = searchEmbeddingIndex(
      snapshot,
      fakeEmbeddingVector(EMBEDDING_FIXTURE_TEXTS.mixedProse),
      { topK: 2 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hits).toHaveLength(2);
    expect(result.hits[0]?.parentId).toBe("msg-b");
    expect(result.hits[0]?.score).toBeGreaterThanOrEqual(
      result.hits[1]?.score ?? 0,
    );
    expect(result.scannedChunks).toBe(3);
  });

  test("topK 0 returns no hits but still reports the scan", () => {
    const snapshot = writeAndLoad([
      { parentId: "msg-a", text: EMBEDDING_FIXTURE_TEXTS.chineseProse },
    ]);
    const result = searchEmbeddingIndex(
      snapshot,
      fakeEmbeddingVector(EMBEDDING_FIXTURE_TEXTS.chineseProse),
      { topK: 0 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hits).toHaveLength(0);
    expect(result.scannedChunks).toBe(1);
  });

  test("the default top-k is the query-arm budget", () => {
    expect(EMBEDDING_SEARCH_DEFAULT_TOP_K).toBe(50);
  });

  test("equal scores break ties by parent id, deterministically", () => {
    const text = EMBEDDING_FIXTURE_TEXTS.chineseProse;
    const snapshot = writeAndLoad([
      { parentId: "msg-b", text },
      { parentId: "msg-a", text },
    ]);
    const result = searchEmbeddingIndex(snapshot, fakeEmbeddingVector(text));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hits.map((hit) => hit.parentId)).toEqual(["msg-a", "msg-b"]);
  });

  test("minScore filters hits", () => {
    const snapshot = writeAndLoad([
      { parentId: "msg-a", text: EMBEDDING_FIXTURE_TEXTS.chineseProse },
      { parentId: "msg-b", text: EMBEDDING_FIXTURE_TEXTS.mixedProse },
    ]);
    const query = fakeEmbeddingVector(EMBEDDING_FIXTURE_TEXTS.chineseProse);
    const all = searchEmbeddingIndex(snapshot, query, { minScore: 0 });
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    for (const hit of all.hits) expect(hit.score).toBeGreaterThanOrEqual(0);

    const none = searchEmbeddingIndex(snapshot, query, { minScore: 1.1 });
    expect(none.ok).toBe(true);
    if (!none.ok) return;
    expect(none.hits).toHaveLength(0);
  });
});

describe("empty and invalid input", () => {
  test("an empty index returns no hits", () => {
    const snapshot = writeAndLoad([
      { parentId: "msg-code", text: EMBEDDING_FIXTURE_TEXTS.codeOnly },
    ]);
    expect(snapshot.meta.chunkCount).toBe(0);
    const result = searchEmbeddingIndex(
      snapshot,
      fakeEmbeddingVector("anything"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hits).toHaveLength(0);
    expect(result.scannedChunks).toBe(0);
  });

  test("a dimension mismatch is a fallback condition, not a throw", () => {
    const snapshot = writeAndLoad([
      { parentId: "msg-a", text: EMBEDDING_FIXTURE_TEXTS.chineseProse },
    ]);
    const result = searchEmbeddingIndex(
      snapshot,
      new Float32Array(EMBEDDING_FIXTURE_DIMENSIONS + 1),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toBe("dimension-mismatch");
  });

  test("an empty query is rejected", () => {
    const snapshot = writeAndLoad([
      { parentId: "msg-a", text: EMBEDDING_FIXTURE_TEXTS.chineseProse },
    ]);
    const result = searchEmbeddingIndex(snapshot, new Float32Array(0));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toBe("empty-query");
  });

  test("an index whose counts disagree with meta is rejected", () => {
    const snapshot = writeAndLoad([
      { parentId: "msg-a", text: EMBEDDING_FIXTURE_TEXTS.chineseProse },
    ]);
    const broken: EmbeddingIndexSnapshot = {
      ...snapshot,
      records: snapshot.records.slice(0, -1),
    };
    const result = searchEmbeddingIndex(
      broken,
      new Float32Array(EMBEDDING_FIXTURE_DIMENSIONS),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toBe("invalid-index");
  });

  test("an invalid vector offset is rejected", () => {
    const snapshot = writeAndLoad([
      { parentId: "msg-a", text: EMBEDDING_FIXTURE_TEXTS.chineseProse },
    ]);
    const first = snapshot.records[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    const broken: EmbeddingIndexSnapshot = {
      ...snapshot,
      records: [{ ...first, vectorOffset: 2 }, ...snapshot.records.slice(1)],
    };
    const result = searchEmbeddingIndex(
      broken,
      new Float32Array(EMBEDDING_FIXTURE_DIMENSIONS),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toBe("invalid-index");
  });
});

describe("B1 chunker integration and B4 injection mapping", () => {
  test("every chunk is retrievable and maps back onto the original text", () => {
    const text = [
      EMBEDDING_FIXTURE_TEXTS.chineseProse,
      EMBEDDING_FIXTURE_TEXTS.mixedProse,
      EMBEDDING_FIXTURE_TEXTS.longTable,
      EMBEDDING_FIXTURE_TEXTS.codeHeavy,
    ].join("\n\n");
    const parentId = "msg-integration";
    const plan = buildEmbeddingChunkPlan({ parentId, text });
    expect(plan.chunks.length).toBeGreaterThan(1);
    const snapshot = writeAndLoad([{ parentId, text }]);

    for (const chunk of plan.chunks) {
      const result = searchEmbeddingIndex(
        snapshot,
        fakeEmbeddingVector(chunk.text),
        { topK: 1 },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      const best = result.hits[0];
      expect(best).toBeDefined();
      if (best === undefined) continue;
      expect(best.parentId).toBe(parentId);
      expect(best.chunkIndex).toBe(chunk.chunkIndex);
      expect(best.startChar).toBe(chunk.startChar);
      expect(best.endChar).toBe(chunk.endChar);
      expect(best.focusChar).toBe(chunk.focusChar);
      expect(best.textHash).toBe(hashEmbeddingText(chunk.text));
      // B4 verifies the hash against text re-derived from the original before
      // injecting; the record's spans are what makes that possible.
      const record = snapshot.records[chunk.chunkIndex];
      expect(record).toBeDefined();
      if (record === undefined) continue;
      expect(hashEmbeddingText(joinProseSpans(text, record.spans))).toBe(
        best.textHash,
      );
    }
  });

  test("a memory hit carries the parent line span for B4", () => {
    const memoryUnit: EmbeddingVectorUnit = {
      agentId: "agent-1",
      spaceId: "space-0123456789abcdef",
      memoryFileKey: "mem-notes",
    };
    const text = EMBEDDING_FIXTURE_TEXTS.chineseProse;
    const plan = buildEmbeddingChunkPlan({
      parentId: "memory:notes.md",
      text,
    });
    const target = plan.chunks[0];
    expect(target).toBeDefined();
    if (target === undefined) return;
    const record = embeddingChunkRecordFromChunk(target, {
      startLine: 4,
      endLine: 9,
    });
    writeEmbeddingIndex({
      unitDir: unitDir(memoryUnit),
      unit: memoryUnit,
      modelId: "bge-small-zh-v1.5",
      dimensions: EMBEDDING_FIXTURE_DIMENSIONS,
      records: [record],
      vectors: [fakeEmbeddingVector(target.text)],
      coverage: plan.coverage,
    });
    const read = readEmbeddingIndex(unitDir(memoryUnit));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const result = searchEmbeddingIndex(
      read.snapshot,
      fakeEmbeddingVector(target.text),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hits[0]?.parentLineSpan).toEqual({
      startLine: 4,
      endLine: 9,
    });
  });
});
