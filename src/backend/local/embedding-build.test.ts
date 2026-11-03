/**
 * Tests for the incremental vector-index build (feature 48, package B3).
 *
 * Everything is synthetic and isolated under a fresh OS temp directory
 * (docs/31 §1.2 A2): the harness roots are redirected per test and restored
 * afterwards, so no real `~/.haruyuki` data is ever read or written. The embed
 * callback is a counting fake (`fakeEmbeddingVector`), which lets every reuse
 * and abort assertion be stated as an exact call count.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  buildEmbeddingIndex,
  type EmbeddingBuildResult,
  type EmbeddingEmbedCallback,
} from "@/backend/local/embedding-build";
import {
  buildEmbeddingChunkPlan,
  type EmbeddingChunk,
  type EmbeddingChunkPlan,
} from "@/backend/local/embedding-chunk";
import {
  type EmbeddingIndexSnapshot,
  type EmbeddingVectorUnit,
  embeddingChunkRecordsFromPlan,
  embeddingVectorUnitDir,
  hashEmbeddingText,
  readEmbeddingIndex,
  writeEmbeddingIndex,
} from "@/backend/local/embedding-format";
import { searchEmbeddingIndex } from "@/backend/local/embedding-search";
import {
  createEmbeddingFixtureDirs,
  EMBEDDING_FIXTURE_DIMENSIONS,
  EMBEDDING_FIXTURE_TEXTS,
  type EmbeddingFixtureDirs,
  fakeEmbeddingVector,
} from "@/test-utils/embedding-fixture";

const MODEL_ID = "bge-small-zh-v1.5";

const unit: EmbeddingVectorUnit = {
  agentId: "agent-1",
  spaceId: "space-0123456789abcdef",
  conversationKey: "conv-build-1",
};

const TEXT_A = "部署卡住的原因是 readiness 探针超时。";
const TEXT_B = "回滚脚本仍然可用，先回退再排查。";
const TEXT_CHANGED = "回滚脚本已经不可用，先重启服务再排查。";
/** Long sentence chain: exactly seven chunks with the fixture chunker. */
const LONG_TEXT = Array.from(
  { length: 80 },
  (_unused, index) => `这是第${index}句测试文本用于生成多个块。`,
).join("");

const originalHome = process.env.HARUYUKI_HOME;
const originalLocalBackendDir = process.env.LETTA_LOCAL_BACKEND_DIR;
let dirs: EmbeddingFixtureDirs;

function restoreHarnessEnv(): void {
  if (originalHome === undefined) {
    delete process.env.HARUYUKI_HOME;
  } else {
    process.env.HARUYUKI_HOME = originalHome;
  }
  if (originalLocalBackendDir === undefined) {
    delete process.env.LETTA_LOCAL_BACKEND_DIR;
  } else {
    process.env.LETTA_LOCAL_BACKEND_DIR = originalLocalBackendDir;
  }
}

beforeEach(() => {
  dirs = createEmbeddingFixtureDirs("haru-embedding-build-");
  process.env.HARUYUKI_HOME = dirs.homeDir;
  process.env.LETTA_LOCAL_BACKEND_DIR = dirs.localBackendDir;
});

afterEach(() => {
  dirs.cleanup();
  restoreHarnessEnv();
});

afterAll(() => {
  restoreHarnessEnv();
});

function unitDir(): string {
  return embeddingVectorUnitDir(unit, { root: dirs.root });
}

function makePlan(parentId: string, text: string): EmbeddingChunkPlan {
  return buildEmbeddingChunkPlan({ parentId, text });
}

function makePlans(
  entries: readonly (readonly [parentId: string, text: string])[],
): EmbeddingChunkPlan[] {
  return entries.map(([parentId, text]) => makePlan(parentId, text));
}

type EmbedRecorder = {
  embed: EmbeddingEmbedCallback;
  /** Text of every chunk sent to `embed`, one array per call. */
  calls: string[][];
  batchSizes: number[];
};

function recordingEmbed(
  options: {
    beforeReturn?: (call: number, chunks: readonly EmbeddingChunk[]) => void;
  } = {},
): EmbedRecorder {
  const calls: string[][] = [];
  const batchSizes: number[] = [];
  const embed: EmbeddingEmbedCallback = async (chunks) => {
    calls.push(chunks.map((chunk) => chunk.text));
    batchSizes.push(chunks.length);
    options.beforeReturn?.(calls.length, chunks);
    return chunks.map((chunk) => fakeEmbeddingVector(chunk.text));
  };
  return { embed, calls, batchSizes };
}

function embeddedTexts(recorder: EmbedRecorder): string[] {
  return recorder.calls.flat();
}

function sumCoverageOf(plans: readonly EmbeddingChunkPlan[]): {
  embeddedChars: number;
  recallableChars: number;
  ratio: number;
} {
  let embeddedChars = 0;
  let recallableChars = 0;
  for (const plan of plans) {
    embeddedChars += plan.coverage.embeddedChars;
    recallableChars += plan.coverage.recallableChars;
  }
  return {
    embeddedChars,
    recallableChars,
    ratio: recallableChars === 0 ? 0 : embeddedChars / recallableChars,
  };
}

/** Writes a build result through B2 and reads the committed generation back. */
function writeResultSnapshot(
  result: Pick<EmbeddingBuildResult, "records" | "vectors" | "coverage">,
): EmbeddingIndexSnapshot {
  const written = writeEmbeddingIndex({
    unitDir: unitDir(),
    unit,
    modelId: MODEL_ID,
    dimensions: EMBEDDING_FIXTURE_DIMENSIONS,
    records: result.records,
    vectors: result.vectors,
    coverage: result.coverage,
  });
  const read = readEmbeddingIndex(written.unitDir, {
    pointer: written.pointer,
  });
  if (!read.ok) {
    throw new Error(`fixture index is unreadable: ${read.problem}`);
  }
  return read.snapshot;
}

/** Previous generation built straight from plans, without exercising B3. */
function snapshotOf(
  plans: readonly EmbeddingChunkPlan[],
): EmbeddingIndexSnapshot {
  const records = plans.flatMap((plan) => embeddingChunkRecordsFromPlan(plan));
  const vectors = plans.flatMap((plan) =>
    plan.chunks.map((chunk) => fakeEmbeddingVector(chunk.text)),
  );
  return writeResultSnapshot({
    records,
    vectors,
    coverage: sumCoverageOf(plans),
  });
}

function expectVector(actual: Float32Array | undefined, text: string): void {
  expect(actual).toBeDefined();
  if (actual === undefined) return;
  const expected = fakeEmbeddingVector(text);
  expect(actual.length).toBe(expected.length);
  expect(Array.from(actual)).toEqual(Array.from(expected));
}

describe("full build", () => {
  test("embeds every chunk and keeps records and vectors aligned", async () => {
    const recorder = recordingEmbed();
    const result = await buildEmbeddingIndex(
      makePlans([
        ["p-a", TEXT_A],
        ["p-b", TEXT_B],
      ]),
      { embed: recorder.embed },
    );

    expect(result.aborted).toBe(false);
    expect(result.reusedChunks).toBe(0);
    expect(result.embeddedChunks).toBe(2);
    expect(result.droppedParents).toEqual([]);
    expect(result.records.map((record) => record.parentId)).toEqual([
      "p-a",
      "p-b",
    ]);
    expect(result.records.map((record) => record.chunkIndex)).toEqual([0, 0]);
    expect(result.records.map((record) => record.textHash)).toEqual([
      hashEmbeddingText(TEXT_A),
      hashEmbeddingText(TEXT_B),
    ]);
    expectVector(result.vectors[0], TEXT_A);
    expectVector(result.vectors[1], TEXT_B);
    // One call per parent: batching never crosses parent boundaries.
    expect(recorder.calls).toEqual([[TEXT_A], [TEXT_B]]);
    expect(result.coverage).toEqual({
      embeddedChars: TEXT_A.length + TEXT_B.length,
      recallableChars: TEXT_A.length + TEXT_B.length,
      ratio: 1,
    });
  });

  test("reuse=false re-embeds the whole unit even when a snapshot exists", async () => {
    const plans = makePlans([["p-a", TEXT_A]]);
    const previous = snapshotOf(plans);
    const recorder = recordingEmbed();

    const result = await buildEmbeddingIndex(plans, {
      embed: recorder.embed,
      previous,
      reuse: false,
    });

    expect(result.reusedChunks).toBe(0);
    expect(result.embeddedChunks).toBe(1);
    expect(embeddedTexts(recorder)).toEqual([TEXT_A]);
  });

  test("batches one parent by the injected batch size", async () => {
    const recorder = recordingEmbed();
    const plans = makePlans([["p-long", LONG_TEXT]]);
    expect(plans[0]?.chunks.length).toBe(7);

    const result = await buildEmbeddingIndex(plans, {
      embed: recorder.embed,
      batchSize: 3,
    });

    expect(recorder.batchSizes).toEqual([3, 3, 1]);
    expect(result.embeddedChunks).toBe(7);
    expect(result.records.map((record) => record.chunkIndex)).toEqual([
      0, 1, 2, 3, 4, 5, 6,
    ]);
  });

  test("empty plans produce an empty result and report every old parent", async () => {
    const previous = snapshotOf(
      makePlans([
        ["p-a", TEXT_A],
        ["p-b", TEXT_B],
      ]),
    );
    const recorder = recordingEmbed();

    const result = await buildEmbeddingIndex([], {
      embed: recorder.embed,
      previous,
    });

    expect(result.records).toEqual([]);
    expect(result.vectors).toEqual([]);
    expect(result.droppedParents).toEqual(["p-a", "p-b"]);
    expect(result.coverage).toEqual({
      embeddedChars: 0,
      recallableChars: 0,
      ratio: 0,
    });
    expect(result.aborted).toBe(false);
    expect(recorder.calls).toHaveLength(0);
  });
});

describe("incremental reuse", () => {
  test("an unchanged unit embeds nothing", async () => {
    const plans = makePlans([
      ["p-a", TEXT_A],
      ["p-b", TEXT_B],
    ]);
    const previous = snapshotOf(plans);
    const recorder = recordingEmbed();

    const result = await buildEmbeddingIndex(plans, {
      embed: recorder.embed,
      previous,
    });

    expect(result.reusedChunks).toBe(2);
    expect(result.embeddedChunks).toBe(0);
    expect(recorder.calls).toHaveLength(0);
    expect(result.records.map((record) => record.parentId)).toEqual([
      "p-a",
      "p-b",
    ]);
    expectVector(result.vectors[0], TEXT_A);
    expectVector(result.vectors[1], TEXT_B);
  });

  test("only the changed chunk is embedded", async () => {
    const previous = snapshotOf([
      makePlan("p-a", TEXT_A),
      makePlan("p-b", TEXT_B),
    ]);
    const recorder = recordingEmbed();

    const result = await buildEmbeddingIndex(
      makePlans([
        ["p-a", TEXT_A],
        ["p-b", TEXT_CHANGED],
      ]),
      { embed: recorder.embed, previous },
    );

    expect(result.reusedChunks).toBe(1);
    expect(result.embeddedChunks).toBe(1);
    expect(embeddedTexts(recorder)).toEqual([TEXT_CHANGED]);
    expect(result.records.map((record) => record.parentId)).toEqual([
      "p-a",
      "p-b",
    ]);
    expectVector(result.vectors[0], TEXT_A);
    expectVector(result.vectors[1], TEXT_CHANGED);
  });

  test("a new parent never reuses another parent's vector", async () => {
    const previous = snapshotOf([makePlan("p-a", TEXT_A)]);
    const recorder = recordingEmbed();

    const result = await buildEmbeddingIndex(makePlans([["p-b", TEXT_A]]), {
      embed: recorder.embed,
      previous,
    });

    expect(result.reusedChunks).toBe(0);
    expect(result.embeddedChunks).toBe(1);
    expect(embeddedTexts(recorder)).toEqual([TEXT_A]);
    expect(result.droppedParents).toEqual(["p-a"]);
  });

  test("records follow the new plan order when everything is reused", async () => {
    const previous = snapshotOf([
      makePlan("p-a", TEXT_A),
      makePlan("p-b", TEXT_B),
    ]);
    const recorder = recordingEmbed();

    const result = await buildEmbeddingIndex(
      makePlans([
        ["p-b", TEXT_B],
        ["p-a", TEXT_A],
      ]),
      { embed: recorder.embed, previous },
    );

    expect(result.reusedChunks).toBe(2);
    expect(recorder.calls).toHaveLength(0);
    expect(result.records.map((record) => record.parentId)).toEqual([
      "p-b",
      "p-a",
    ]);
    expectVector(result.vectors[0], TEXT_B);
    expectVector(result.vectors[1], TEXT_A);
  });

  test("a different space width disables reuse instead of mixing vectors", async () => {
    const plans = makePlans([["p-a", TEXT_A]]);
    const previous = snapshotOf(plans);
    const embed: EmbeddingEmbedCallback = async (chunks) =>
      chunks.map((chunk) => fakeEmbeddingVector(chunk.text, 4));

    const result = await buildEmbeddingIndex(plans, {
      embed,
      previous,
      dimensions: 4,
    });

    expect(result.reusedChunks).toBe(0);
    expect(result.embeddedChunks).toBe(1);
    expect(result.vectors[0]?.length).toBe(4);
  });
});

describe("skipped and deleted parents", () => {
  test("a skipVector parent adds coverage but no records", async () => {
    const plans = makePlans([
      ["p-a", TEXT_A],
      ["p-code", EMBEDDING_FIXTURE_TEXTS.codeOnly],
    ]);
    expect(plans[1]?.skipVector).toBe(true);
    const recorder = recordingEmbed();

    const result = await buildEmbeddingIndex(plans, {
      embed: recorder.embed,
    });

    expect(result.records.map((record) => record.parentId)).toEqual(["p-a"]);
    expect(result.embeddedChunks).toBe(1);
    expect(embeddedTexts(recorder)).toEqual([TEXT_A]);
    expect(result.coverage).toEqual(sumCoverageOf(plans));
  });

  test("deleted parents are reported but stay out of the output", async () => {
    const previous = snapshotOf([
      makePlan("p-a", TEXT_A),
      makePlan("p-b", TEXT_B),
    ]);
    const recorder = recordingEmbed();

    const result = await buildEmbeddingIndex(makePlans([["p-a", TEXT_A]]), {
      embed: recorder.embed,
      previous,
    });

    expect(result.droppedParents).toEqual(["p-b"]);
    expect(result.records.map((record) => record.parentId)).toEqual(["p-a"]);
    expect(result.reusedChunks).toBe(1);
    expect(result.embeddedChunks).toBe(0);
  });
});

describe("cancellation", () => {
  test("an already-aborted signal returns an empty checkpoint", async () => {
    const controller = new AbortController();
    controller.abort();
    const recorder = recordingEmbed();

    const result = await buildEmbeddingIndex(makePlans([["p-a", TEXT_A]]), {
      embed: recorder.embed,
      signal: controller.signal,
    });

    expect(result.aborted).toBe(true);
    expect(result.records).toEqual([]);
    expect(result.vectors).toEqual([]);
    expect(recorder.calls).toHaveLength(0);
    // Coverage is the unit's target, independent of how far the build got.
    expect(result.coverage.embeddedChars).toBe(TEXT_A.length);
  });

  test("aborting between parents keeps the completed parent", async () => {
    const controller = new AbortController();
    const recorder = recordingEmbed({
      beforeReturn: (call) => {
        if (call === 1) controller.abort();
      },
    });

    const result = await buildEmbeddingIndex(
      makePlans([
        ["p-a", TEXT_A],
        ["p-b", TEXT_B],
      ]),
      { embed: recorder.embed, signal: controller.signal },
    );

    expect(result.aborted).toBe(true);
    expect(result.records.map((record) => record.parentId)).toEqual(["p-a"]);
    expect(result.embeddedChunks).toBe(1);
    expect(embeddedTexts(recorder)).toEqual([TEXT_A]);
  });

  test("aborting mid-parent keeps the embedded prefix", async () => {
    const controller = new AbortController();
    const recorder = recordingEmbed({
      beforeReturn: (call) => {
        if (call === 1) controller.abort();
      },
    });
    const plans = makePlans([["p-long", LONG_TEXT]]);

    const result = await buildEmbeddingIndex(plans, {
      embed: recorder.embed,
      signal: controller.signal,
      batchSize: 2,
    });

    expect(result.aborted).toBe(true);
    expect(recorder.batchSizes).toEqual([2]);
    expect(result.records.map((record) => record.chunkIndex)).toEqual([0, 1]);
    expect(result.embeddedChunks).toBe(2);
    expectVector(result.vectors[0], plans[0]?.chunks[0]?.text ?? "");
    expectVector(result.vectors[1], plans[0]?.chunks[1]?.text ?? "");
  });

  test("the isAborted predicate also stops between parents", async () => {
    let stopped = false;
    const recorder = recordingEmbed({
      beforeReturn: () => {
        stopped = true;
      },
    });

    const result = await buildEmbeddingIndex(
      makePlans([
        ["p-a", TEXT_A],
        ["p-b", TEXT_B],
      ]),
      { embed: recorder.embed, isAborted: () => stopped },
    );

    expect(result.aborted).toBe(true);
    expect(result.records.map((record) => record.parentId)).toEqual(["p-a"]);
  });

  test("a resumed build reuses the aborted parent's prefix", async () => {
    const plans = makePlans([["p-long", LONG_TEXT]]);
    const chunkCount = plans[0]?.chunks.length ?? 0;
    const controller = new AbortController();
    const first = recordingEmbed({
      beforeReturn: (call) => {
        if (call === 1) controller.abort();
      },
    });
    const checkpoint = await buildEmbeddingIndex(plans, {
      embed: first.embed,
      signal: controller.signal,
      batchSize: 2,
    });
    expect(checkpoint.aborted).toBe(true);
    expect(checkpoint.records).toHaveLength(2);

    const snapshot = writeResultSnapshot(checkpoint);
    const resumedRecorder = recordingEmbed();
    const resumed = await buildEmbeddingIndex(plans, {
      embed: resumedRecorder.embed,
      previous: snapshot,
    });

    expect(resumed.aborted).toBe(false);
    expect(resumed.reusedChunks).toBe(2);
    expect(resumed.embeddedChunks).toBe(chunkCount - 2);
    expect(resumed.records).toHaveLength(chunkCount);
    expect(embeddedTexts(resumedRecorder)).toEqual(
      (plans[0]?.chunks ?? []).slice(2).map((chunk) => chunk.text),
    );
  });
});

describe("contract checks", () => {
  test("throws when embed returns the wrong vector count", async () => {
    await expect(
      buildEmbeddingIndex(makePlans([["p-a", TEXT_A]]), {
        embed: async () => [],
      }),
    ).rejects.toThrow("embed() returned 0 vectors for 1 chunks.");
  });

  test("throws when embed returns mixed vector widths", async () => {
    const embed: EmbeddingEmbedCallback = async (chunks) =>
      chunks.map((chunk, index) =>
        fakeEmbeddingVector(chunk.text, index === 0 ? 8 : 4),
      );

    await expect(
      buildEmbeddingIndex(makePlans([["p-long", LONG_TEXT]]), { embed }),
    ).rejects.toThrow("embed() returned mixed widths");
  });

  test("attaches a memory parent's line span to every record", async () => {
    const recorder = recordingEmbed();
    const parentId = "memory:notes/deploy.md#L3-L3";

    const result = await buildEmbeddingIndex(makePlans([[parentId, TEXT_A]]), {
      embed: recorder.embed,
      parentLineSpan: () => ({ startLine: 3, endLine: 3 }),
    });

    expect(result.records[0]?.parentId).toBe(parentId);
    expect(result.records[0]?.parentLineSpan).toEqual({
      startLine: 3,
      endLine: 3,
    });
  });

  test("the result feeds the B2 writer and search finds the parent", async () => {
    const recorder = recordingEmbed();
    const result = await buildEmbeddingIndex(
      makePlans([
        ["p-a", TEXT_A],
        ["p-b", TEXT_B],
      ]),
      { embed: recorder.embed },
    );
    const snapshot = writeResultSnapshot(result);

    expect(snapshot.meta.chunkCount).toBe(2);
    expect(snapshot.meta.parentCount).toBe(2);
    const search = searchEmbeddingIndex(snapshot, fakeEmbeddingVector(TEXT_B));
    expect(search.ok).toBe(true);
    if (!search.ok) return;
    expect(search.hits[0]?.parentId).toBe("p-b");
  });
});
