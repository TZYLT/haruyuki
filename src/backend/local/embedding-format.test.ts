import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  readdirSync,
  readFileSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  buildEmbeddingChunkPlan,
  type EmbeddingChunkPlan,
  joinProseSpans,
} from "@/backend/local/embedding-chunk";
import {
  EMBEDDING_INDEX_CHUNKER_VERSION,
  EMBEDDING_INDEX_FILE_NAMES,
  EMBEDDING_INDEX_FORMAT_VERSION,
  EmbeddingIndexPathError,
  type EmbeddingIndexWriteResult,
  type EmbeddingVectorUnit,
  embeddingChunkRecordsFromPlan,
  embeddingGenerationDir,
  embeddingVectorUnitDir,
  getRecallVectorsRoot,
  hashEmbeddingText,
  readEmbeddingIndex,
  readEmbeddingIndexPointer,
  statEmbeddingIndexPointer,
  writeEmbeddingIndex,
} from "@/backend/local/embedding-format";
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

function unitDir(): string {
  return embeddingVectorUnitDir(unit, { root: dirs.root });
}

function planFor(text: string, parentId = "msg-1"): EmbeddingChunkPlan {
  return buildEmbeddingChunkPlan({ parentId, text });
}

function vectorsFor(plan: EmbeddingChunkPlan): Float32Array[] {
  return plan.chunks.map((chunk) => fakeEmbeddingVector(chunk.text));
}

function writePlan(
  plan: EmbeddingChunkPlan,
  options: {
    generation?: string;
    unitDir?: string;
    unit?: EmbeddingVectorUnit;
  } = {},
): EmbeddingIndexWriteResult {
  const targetUnit = options.unit ?? unit;
  return writeEmbeddingIndex({
    unitDir:
      options.unitDir ??
      embeddingVectorUnitDir(targetUnit, { root: dirs.root }),
    unit: targetUnit,
    modelId: "bge-small-zh-v1.5",
    dimensions: EMBEDDING_FIXTURE_DIMENSIONS,
    records: embeddingChunkRecordsFromPlan(plan),
    vectors: vectorsFor(plan),
    coverage: plan.coverage,
    ...(options.generation === undefined
      ? {}
      : { generation: options.generation }),
  });
}

function generationDir(result: EmbeddingIndexWriteResult): string {
  return embeddingGenerationDir(result.unitDir, result.generation);
}

function readMeta(result: EmbeddingIndexWriteResult): Record<string, unknown> {
  const raw = readFileSync(
    join(generationDir(result), EMBEDDING_INDEX_FILE_NAMES.meta),
    "utf8",
  );
  return JSON.parse(raw) as Record<string, unknown>;
}

function rewriteMeta(
  result: EmbeddingIndexWriteResult,
  patch: Record<string, unknown>,
): void {
  const path = join(generationDir(result), EMBEDDING_INDEX_FILE_NAMES.meta);
  const meta = readMeta(result);
  writeFileSync(path, `${JSON.stringify({ ...meta, ...patch })}\n`, "utf8");
}

describe("paths", () => {
  test("the recall root lives under the harness home", () => {
    const root = getRecallVectorsRoot();
    expect(root.endsWith("recall-vectors")).toBe(true);
    const harnessHome = process.env.HARUYUKI_HOME;
    if (harnessHome !== undefined && harnessHome.length > 0) {
      expect(root.startsWith(harnessHome)).toBe(true);
    }
  });

  test("a conversation unit is <root>/<agent>/<space>/<conversationKey>", () => {
    expect(embeddingVectorUnitDir(unit, { root: dirs.root })).toBe(
      join(dirs.root, "agent-1", "space-0123456789abcdef", "conv-1"),
    );
  });

  test("a memory unit is <root>/<agent>/<space>/memory/<fileKey>", () => {
    const memoryUnit: EmbeddingVectorUnit = {
      agentId: "agent-1",
      spaceId: "space-0123456789abcdef",
      memoryFileKey: "abc123",
    };
    expect(embeddingVectorUnitDir(memoryUnit, { root: dirs.root })).toBe(
      join(dirs.root, "agent-1", "space-0123456789abcdef", "memory", "abc123"),
    );
  });

  test("unsafe segments are rejected instead of escaping the root", () => {
    for (const segment of ["..", ".", "", "a/b", "C:\\x", "a b"]) {
      expect(() =>
        embeddingVectorUnitDir(
          {
            agentId: "agent-1",
            spaceId: "space-0123456789abcdef",
            conversationKey: segment,
          },
          { root: dirs.root },
        ),
      ).toThrow(EmbeddingIndexPathError);
    }
    expect(() =>
      embeddingVectorUnitDir(
        {
          agentId: "agent-1",
          spaceId: "space-0123456789abcdef",
          memoryFileKey: "../memory",
        },
        { root: dirs.root },
      ),
    ).toThrow(EmbeddingIndexPathError);
  });
});

describe("write and read round trip", () => {
  test("a chunk plan survives the round trip byte for byte", () => {
    const text = EMBEDDING_FIXTURE_TEXTS.chineseProse;
    const plan = planFor(text);
    expect(plan.chunks.length).toBeGreaterThan(0);
    const written = writePlan(plan);
    const read = readEmbeddingIndex(unitDir());
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const snapshot = read.snapshot;

    expect(snapshot.generation).toBe(written.generation);
    expect(snapshot.meta.formatVersion).toBe(EMBEDDING_INDEX_FORMAT_VERSION);
    expect(snapshot.meta.chunkerVersion).toBe(EMBEDDING_INDEX_CHUNKER_VERSION);
    expect(snapshot.meta.modelId).toBe("bge-small-zh-v1.5");
    expect(snapshot.meta.dimensions).toBe(EMBEDDING_FIXTURE_DIMENSIONS);
    expect(snapshot.meta.quant).toBe("f32");
    expect(snapshot.meta.chunkCount).toBe(plan.chunks.length);
    expect(snapshot.meta.parentCount).toBe(1);
    expect(snapshot.meta.coverage.ratio).toBeCloseTo(plan.coverage.ratio, 6);
    expect(snapshot.meta.checksum).toHaveLength(64);
    expect(snapshot.records).toHaveLength(plan.chunks.length);
    expect(snapshot.vectors).toHaveLength(
      plan.chunks.length * EMBEDDING_FIXTURE_DIMENSIONS,
    );

    for (const [index, chunk] of plan.chunks.entries()) {
      const record = snapshot.records[index];
      expect(record).toBeDefined();
      if (record === undefined) continue;
      expect(record.parentId).toBe(chunk.parentId);
      expect(record.chunkIndex).toBe(chunk.chunkIndex);
      expect(record.startChar).toBe(chunk.startChar);
      expect(record.endChar).toBe(chunk.endChar);
      expect(record.spans).toEqual(chunk.spans);
      expect(record.focusChar).toBe(chunk.focusChar);
      expect(record.textHash).toBe(hashEmbeddingText(chunk.text));
      expect(record.vectorOffset).toBe(
        index * EMBEDDING_FIXTURE_DIMENSIONS * 4,
      );
      // The chunk text is reproducible from the original text plus spans;
      // B4 injects only after this check passes.
      expect(joinProseSpans(text, record.spans)).toBe(chunk.text);
      expect(record.norm).toBeCloseTo(1, 5);
      const expected = fakeEmbeddingVector(chunk.text);
      for (let axis = 0; axis < EMBEDDING_FIXTURE_DIMENSIONS; axis += 1) {
        expect(
          snapshot.vectors[index * EMBEDDING_FIXTURE_DIMENSIONS + axis],
        ).toBe(Math.fround(expected[axis] ?? 0));
      }
    }
  });

  test("meta byte counts match the generation files", () => {
    const written = writePlan(planFor(EMBEDDING_FIXTURE_TEXTS.chineseProse));
    const meta = readMeta(written);
    const generation = generationDir(written);
    const recordsBytes = readFileSync(
      join(generation, EMBEDDING_INDEX_FILE_NAMES.records),
    ).byteLength;
    const vectorsBytes = readFileSync(
      join(generation, EMBEDDING_INDEX_FILE_NAMES.vectors),
    ).byteLength;
    expect(meta.recordsBytes).toBe(recordsBytes);
    expect(meta.vectorsBytes).toBe(vectorsBytes);
    expect(meta.checksum).toHaveLength(64);
  });

  test("the pointer is a single committed file and no temp files remain", () => {
    const written = writePlan(planFor(EMBEDDING_FIXTURE_TEXTS.chineseProse));
    const entries = readdirSync(written.unitDir).sort();
    expect(entries).toEqual([written.generation, "current.json"].sort());
    for (const entry of entries) {
      expect(entry.startsWith(".tmp-")).toBe(false);
      expect(entry.startsWith(".current-")).toBe(false);
    }

    const pointer = readEmbeddingIndexPointer(written.unitDir);
    expect(pointer.ok).toBe(true);
    if (!pointer.ok) return;
    expect(pointer.pointer.formatVersion).toBe(EMBEDDING_INDEX_FORMAT_VERSION);
    expect(pointer.pointer.generation).toBe(written.generation);
    expect(pointer.pointer.chunkCount).toBe(written.meta.chunkCount);
    expect(pointer.signature.size).toBeGreaterThan(0);

    const stat = statEmbeddingIndexPointer(written.unitDir);
    expect(stat.ok).toBe(true);
    if (stat.ok) expect(stat.signature.size).toBeGreaterThan(0);
  });

  test("a memory unit keeps the parent line span", () => {
    const memoryUnit: EmbeddingVectorUnit = {
      agentId: "agent-1",
      spaceId: "space-0123456789abcdef",
      memoryFileKey: "mem-file",
    };
    const plan = planFor(
      "记忆文件里的第一段。第二段在这里。",
      "memory:notes.md",
    );
    const targetDir = embeddingVectorUnitDir(memoryUnit, { root: dirs.root });
    const records = embeddingChunkRecordsFromPlan(plan, {
      parentLineSpan: (chunk) => ({
        startLine: chunk.chunkIndex + 1,
        endLine: chunk.chunkIndex + 3,
      }),
    });
    writeEmbeddingIndex({
      unitDir: targetDir,
      unit: memoryUnit,
      modelId: "bge-small-zh-v1.5",
      dimensions: EMBEDDING_FIXTURE_DIMENSIONS,
      records,
      vectors: vectorsFor(plan),
      coverage: plan.coverage,
    });
    const read = readEmbeddingIndex(targetDir);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.snapshot.meta.unitKind).toBe("memory");
    expect(read.snapshot.meta.unitKey).toBe("mem-file");
    for (const [index, record] of read.snapshot.records.entries()) {
      expect(record.parentLineSpan).toEqual({
        startLine: index + 1,
        endLine: index + 3,
      });
    }
  });

  test("an empty plan writes an empty, readable generation", () => {
    const plan = planFor(EMBEDDING_FIXTURE_TEXTS.codeOnly);
    expect(plan.chunks).toHaveLength(0);
    writePlan(plan);
    const read = readEmbeddingIndex(unitDir());
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.snapshot.meta.chunkCount).toBe(0);
    expect(read.snapshot.records).toHaveLength(0);
    expect(read.snapshot.vectors).toHaveLength(0);
  });

  test("multiple parents share one generation", () => {
    const first = buildEmbeddingChunkPlan({
      parentId: "msg-a",
      text: EMBEDDING_FIXTURE_TEXTS.chineseProse,
    });
    const second = buildEmbeddingChunkPlan({
      parentId: "msg-b",
      text: EMBEDDING_FIXTURE_TEXTS.mixedProse,
    });
    const chunks = [...first.chunks, ...second.chunks];
    const records = chunks.map((chunk) => ({
      parentId: chunk.parentId,
      chunkIndex: chunk.chunkIndex,
      startChar: chunk.startChar,
      endChar: chunk.endChar,
      spans: chunk.spans,
      focusChar: chunk.focusChar,
      textHash: hashEmbeddingText(chunk.text),
    }));
    writeEmbeddingIndex({
      unitDir: unitDir(),
      unit,
      modelId: "bge-small-zh-v1.5",
      dimensions: EMBEDDING_FIXTURE_DIMENSIONS,
      records,
      vectors: chunks.map((chunk) => fakeEmbeddingVector(chunk.text)),
      coverage: { embeddedChars: 10, recallableChars: 20, ratio: 0.5 },
    });
    const read = readEmbeddingIndex(unitDir());
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.snapshot.meta.parentCount).toBe(2);
    expect(read.snapshot.meta.chunkCount).toBe(chunks.length);
  });
});

describe("generations", () => {
  test("a newer generation wins; the old one stays on disk", () => {
    const first = writePlan(
      planFor(EMBEDDING_FIXTURE_TEXTS.chineseProse, "msg-old"),
      { generation: "gen-test-1" },
    );
    const second = writePlan(
      planFor(EMBEDDING_FIXTURE_TEXTS.mixedProse, "msg-new"),
      { generation: "gen-test-2" },
    );
    expect(first.generation).not.toBe(second.generation);
    expect(existsSync(embeddingGenerationDir(unitDir(), "gen-test-1"))).toBe(
      true,
    );

    const read = readEmbeddingIndex(unitDir());
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.snapshot.generation).toBe("gen-test-2");
    expect(read.snapshot.records[0]?.parentId).toBe("msg-new");
  });

  test("a failed generation write keeps the previous pointer", () => {
    writePlan(planFor(EMBEDDING_FIXTURE_TEXTS.chineseProse, "msg-old"), {
      generation: "gen-stable",
    });
    expect(() =>
      writePlan(planFor(EMBEDDING_FIXTURE_TEXTS.mixedProse, "msg-new"), {
        generation: "gen-stable",
      }),
    ).toThrow();

    const read = readEmbeddingIndex(unitDir());
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.snapshot.generation).toBe("gen-stable");
    expect(read.snapshot.records[0]?.parentId).toBe("msg-old");
  });

  test("a caller-supplied generation must be a safe segment", () => {
    expect(() =>
      writePlan(planFor(EMBEDDING_FIXTURE_TEXTS.chineseProse), {
        generation: "../escape",
      }),
    ).toThrow(EmbeddingIndexPathError);
  });
});

describe("tolerant reads", () => {
  test("a missing unit reports missing", () => {
    const read = readEmbeddingIndex(join(dirs.root, "nope"));
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.problem).toBe("missing");
    expect(statEmbeddingIndexPointer(join(dirs.root, "nope")).ok).toBe(false);
  });

  test("an unparseable current.json reports unreadable", () => {
    const written = writePlan(planFor(EMBEDDING_FIXTURE_TEXTS.chineseProse));
    writeFileSync(
      join(written.unitDir, EMBEDDING_INDEX_FILE_NAMES.current),
      "{not json",
      "utf8",
    );
    const read = readEmbeddingIndex(written.unitDir);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.problem).toBe("unreadable");
  });

  test("a partial vectors.bin reports corrupt", () => {
    const written = writePlan(planFor(EMBEDDING_FIXTURE_TEXTS.chineseProse));
    const vectorsPath = join(
      generationDir(written),
      EMBEDDING_INDEX_FILE_NAMES.vectors,
    );
    truncateSync(vectorsPath, 8);
    const read = readEmbeddingIndex(written.unitDir);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.problem).toBe("corrupt");
  });

  test("a same-size byte flip reports a checksum mismatch", () => {
    const written = writePlan(planFor(EMBEDDING_FIXTURE_TEXTS.chineseProse));
    const vectorsPath = join(
      generationDir(written),
      EMBEDDING_INDEX_FILE_NAMES.vectors,
    );
    const bytes = readFileSync(vectorsPath);
    bytes[0] = bytes[0] === 0 ? 1 : 0;
    writeFileSync(vectorsPath, bytes);
    const read = readEmbeddingIndex(written.unitDir);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.problem).toBe("checksum-mismatch");
  });

  test("a truncated records file reports corrupt", () => {
    const written = writePlan(planFor(EMBEDDING_FIXTURE_TEXTS.chineseProse));
    const recordsPath = join(
      generationDir(written),
      EMBEDDING_INDEX_FILE_NAMES.records,
    );
    const bytes = readFileSync(recordsPath);
    writeFileSync(recordsPath, bytes.subarray(0, bytes.length - 5));
    const read = readEmbeddingIndex(written.unitDir);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.problem).toBe("corrupt");
  });

  test("a deleted meta file reports missing", () => {
    const written = writePlan(planFor(EMBEDDING_FIXTURE_TEXTS.chineseProse));
    unlinkSync(join(generationDir(written), EMBEDDING_INDEX_FILE_NAMES.meta));
    const read = readEmbeddingIndex(written.unitDir);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.problem).toBe("missing");
  });

  test("an unknown format version is ignored, not migrated", () => {
    const written = writePlan(planFor(EMBEDDING_FIXTURE_TEXTS.chineseProse));
    rewriteMeta(written, { formatVersion: 99 });
    const read = readEmbeddingIndex(written.unitDir);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.problem).toBe("version-mismatch");
  });

  test("an unknown chunker version is ignored so it can rebuild", () => {
    const written = writePlan(planFor(EMBEDDING_FIXTURE_TEXTS.chineseProse));
    rewriteMeta(written, { chunkerVersion: 999 });
    const read = readEmbeddingIndex(written.unitDir);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.problem).toBe("version-mismatch");
  });

  test("a pointer from another format version is ignored", () => {
    const written = writePlan(planFor(EMBEDDING_FIXTURE_TEXTS.chineseProse));
    const pointerPath = join(
      written.unitDir,
      EMBEDDING_INDEX_FILE_NAMES.current,
    );
    const pointer = JSON.parse(readFileSync(pointerPath, "utf8")) as Record<
      string,
      unknown
    >;
    writeFileSync(
      pointerPath,
      `${JSON.stringify({ ...pointer, formatVersion: 99 })}\n`,
      "utf8",
    );
    const read = readEmbeddingIndex(written.unitDir);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.problem).toBe("version-mismatch");
  });
});

describe("writer validation", () => {
  const plan = buildEmbeddingChunkPlan({
    parentId: "msg-1",
    text: EMBEDDING_FIXTURE_TEXTS.chineseProse,
  });

  function input(
    overrides: Partial<Parameters<typeof writeEmbeddingIndex>[0]> = {},
  ): Parameters<typeof writeEmbeddingIndex>[0] {
    return {
      unitDir: unitDir(),
      unit,
      modelId: "bge-small-zh-v1.5",
      dimensions: EMBEDDING_FIXTURE_DIMENSIONS,
      records: embeddingChunkRecordsFromPlan(plan),
      vectors: vectorsFor(plan),
      coverage: plan.coverage,
      ...overrides,
    };
  }

  test("record and vector counts must agree", () => {
    expect(() =>
      writeEmbeddingIndex(input({ vectors: vectorsFor(plan).slice(0, -1) })),
    ).toThrow(/count mismatch/);
  });

  test("a wrongly sized vector is rejected", () => {
    const vectors = vectorsFor(plan);
    vectors[0] = new Float32Array(EMBEDDING_FIXTURE_DIMENSIONS + 1);
    expect(() => writeEmbeddingIndex(input({ vectors }))).toThrow(/expected/);
  });

  test("a non-finite vector is rejected", () => {
    const vectors = vectorsFor(plan);
    const broken = vectors[0];
    if (broken !== undefined) broken[0] = Number.NaN;
    expect(() => writeEmbeddingIndex(input({ vectors }))).toThrow(/not finite/);
  });

  test("a negative chunk index is rejected", () => {
    const records = embeddingChunkRecordsFromPlan(plan);
    const first = records[0];
    if (first !== undefined) first.chunkIndex = -1;
    expect(() => writeEmbeddingIndex(input({ records }))).toThrow(
      /invalid chunkIndex/,
    );
  });

  test("an invalid char range is rejected", () => {
    const records = embeddingChunkRecordsFromPlan(plan);
    const first = records[0];
    if (first !== undefined) first.endChar = first.startChar - 1;
    expect(() => writeEmbeddingIndex(input({ records }))).toThrow(
      /invalid char range/,
    );
  });

  test("invalid dimensions are rejected", () => {
    expect(() => writeEmbeddingIndex(input({ dimensions: 0 }))).toThrow(
      /positive integer/,
    );
  });
});
