import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildEmbeddingChunkPlan } from "@/backend/local/embedding-chunk";
import {
  type EmbeddingVectorUnit,
  embeddingChunkRecordsFromPlan,
  writeEmbeddingIndex,
  writeEmbeddingIndexPointer,
} from "@/backend/local/embedding-format";
import {
  hasUsableEmbeddingSpace,
  readEmbeddingSpaceSummary,
} from "@/backend/local/embedding-space-status";
import {
  createEmbeddingFixtureDirs,
  type EmbeddingFixtureDirs,
} from "@/test-utils/embedding-fixture";

const DIMENSIONS = 8;
const MODEL_ID = "bge-small-zh-v1.5";

let dirs: EmbeddingFixtureDirs;
let previousHome: string | undefined;
let spaceDir: string;

beforeEach(() => {
  dirs = createEmbeddingFixtureDirs("haru-embedding-space-status-");
  previousHome = process.env.HARUYUKI_HOME;
  process.env.HARUYUKI_HOME = dirs.homeDir;
  spaceDir = join(dirs.root, "recall-vectors", "agent-a", "space-a");
  mkdirSync(spaceDir, { recursive: true });
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.HARUYUKI_HOME;
  else process.env.HARUYUKI_HOME = previousHome;
  dirs.cleanup();
});

type UnitCoordinates = {
  readonly agentId: string;
  readonly spaceId: string;
  readonly conversationKey?: string;
  readonly memoryFileKey?: string;
};

function unitDirFor(coordinates: UnitCoordinates): string {
  if (coordinates.conversationKey !== undefined) {
    return join(spaceDir, coordinates.conversationKey);
  }
  if (coordinates.memoryFileKey !== undefined) {
    return join(spaceDir, "memory", coordinates.memoryFileKey);
  }
  throw new Error("unit fixture needs a conversation or memory key");
}

function unitIdentity(coordinates: UnitCoordinates): EmbeddingVectorUnit {
  if (coordinates.conversationKey !== undefined) {
    return { ...coordinates, conversationKey: coordinates.conversationKey };
  }
  if (coordinates.memoryFileKey !== undefined) {
    return { ...coordinates, memoryFileKey: coordinates.memoryFileKey };
  }
  throw new Error("unit fixture needs a conversation or memory key");
}

/** Writes a real generation + pointer through the production writer. */
function writeUnit(
  coordinates: UnitCoordinates,
  text: string,
): {
  unitDir: string;
  chunks: number;
  embeddedChars: number;
  recallableChars: number;
} {
  const parentId =
    coordinates.conversationKey !== undefined
      ? "message-1"
      : `memory:notes/doc.md#L1-L2`;
  const plan = buildEmbeddingChunkPlan({ parentId, text });
  const records = embeddingChunkRecordsFromPlan(plan);
  const vectors = records.map(() => new Float32Array(DIMENSIONS).fill(0.25));
  const unitDir = unitDirFor(coordinates);
  writeEmbeddingIndex({
    unitDir,
    unit: unitIdentity(coordinates),
    modelId: MODEL_ID,
    dimensions: DIMENSIONS,
    records,
    vectors,
    coverage: plan.coverage,
  });
  return {
    unitDir,
    chunks: records.length,
    embeddedChars: plan.coverage.embeddedChars,
    recallableChars: plan.coverage.recallableChars,
  };
}

describe("readEmbeddingSpaceSummary", () => {
  test("returns the all-zero summary for a missing directory", () => {
    expect(
      readEmbeddingSpaceSummary(join(dirs.root, "does-not-exist")),
    ).toEqual({
      chunks: 0,
      conversations: 0,
      memoryFiles: 0,
      dimensions: null,
      quant: null,
      modelId: null,
      builtAt: null,
      coverage: null,
    });
  });

  test("aggregates conversation and memory units from pointers and meta", () => {
    const conversation = writeUnit(
      { agentId: "agent-a", spaceId: "space-a", conversationKey: "conv-1" },
      "部署窗口固定在每周三晚上十点。回滚脚本位于 tools/rollback.sh。",
    );
    const memory = writeUnit(
      { agentId: "agent-a", spaceId: "space-a", memoryFileKey: "doc-abc" },
      "回滚之前必须确认数据库备份完成，否则禁止继续执行回滚流程。",
    );

    const summary = readEmbeddingSpaceSummary(spaceDir);
    expect(summary.conversations).toBe(1);
    expect(summary.memoryFiles).toBe(1);
    expect(summary.chunks).toBe(conversation.chunks + memory.chunks);
    expect(summary.dimensions).toBe(DIMENSIONS);
    expect(summary.quant).toBe("f32");
    expect(summary.builtAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const expectedCoverage =
      (conversation.embeddedChars + memory.embeddedChars) /
      (conversation.recallableChars + memory.recallableChars);
    expect(summary.coverage).toBeCloseTo(expectedCoverage, 6);
  });

  test("ignores staging leftovers and non-directory entries", () => {
    writeUnit(
      { agentId: "agent-a", spaceId: "space-a", conversationKey: "conv-1" },
      "部署窗口固定在每周三晚上十点，回滚脚本位于 tools/rollback.sh。",
    );
    writeFileSync(join(spaceDir, "stray.txt"), "x", "utf8");
    mkdirSync(join(spaceDir, ".tmp-123"), { recursive: true });

    const summary = readEmbeddingSpaceSummary(spaceDir);
    expect(summary.conversations).toBe(1);
    expect(summary.memoryFiles).toBe(0);
  });

  test("tolerates a corrupt pointer without throwing", () => {
    const unit = writeUnit(
      { agentId: "agent-a", spaceId: "space-a", conversationKey: "conv-1" },
      "合法单元的文本内容用于覆盖正常聚合路径。",
    );
    writeFileSync(join(unit.unitDir, "current.json"), "{ not json", "utf8");

    const summary = readEmbeddingSpaceSummary(spaceDir);
    expect(summary.conversations).toBe(0);
    expect(summary.chunks).toBe(0);
    expect(summary.builtAt).toBeNull();
  });

  test("reports null dimensions/quant when units disagree", () => {
    writeUnit(
      { agentId: "agent-a", spaceId: "space-a", conversationKey: "conv-1" },
      "第一个单元使用的是 8 维 float32 向量空间，用于制造冲突。",
    );
    writeEmbeddingIndexPointer(join(spaceDir, "conv-2"), {
      formatVersion: 1,
      generation: "gen-missing",
      chunkCount: 3,
      parentCount: 1,
      dimensions: 16,
      quant: "int8",
      checksum: "abc",
      updatedAt: "2030-01-01T00:00:00.000Z",
    });

    const summary = readEmbeddingSpaceSummary(spaceDir);
    expect(summary.conversations).toBe(2);
    expect(summary.chunks).toBeGreaterThanOrEqual(3);
    expect(summary.dimensions).toBeNull();
    expect(summary.quant).toBeNull();
    expect(summary.builtAt).toBe("2030-01-01T00:00:00.000Z");
    // The second unit has no generation, so coverage only reflects the first.
    expect(summary.coverage).not.toBeNull();
  });

  test("reports null coverage when no generation meta can be read", () => {
    writeEmbeddingIndexPointer(join(spaceDir, "conv-1"), {
      formatVersion: 1,
      generation: "gen-missing",
      chunkCount: 2,
      parentCount: 1,
      dimensions: DIMENSIONS,
      quant: "f32",
      checksum: "abc",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const summary = readEmbeddingSpaceSummary(spaceDir);
    expect(summary.conversations).toBe(1);
    expect(summary.chunks).toBe(2);
    expect(summary.coverage).toBeNull();
  });
});

describe("hasUsableEmbeddingSpace", () => {
  test("is false for a missing or empty space", () => {
    expect(hasUsableEmbeddingSpace(join(dirs.root, "missing"))).toBe(false);
    expect(hasUsableEmbeddingSpace(spaceDir)).toBe(false);
  });

  test("is true once one unit has a valid pointer", () => {
    writeUnit(
      { agentId: "agent-a", spaceId: "space-a", conversationKey: "conv-1" },
      "这条内容会被写成一个可用的会话单元，从而让空间可用。",
    );
    expect(hasUsableEmbeddingSpace(spaceDir)).toBe(true);
  });

  test("is false when the only pointer is corrupt", () => {
    const unit = writeUnit(
      { agentId: "agent-a", spaceId: "space-a", memoryFileKey: "doc-abc" },
      "这条内容会被写成一个可用的记忆单元，随后指针被破坏。",
    );
    writeFileSync(join(unit.unitDir, "current.json"), "{}", "utf8");
    expect(hasUsableEmbeddingSpace(spaceDir)).toBe(false);
  });
});
