/**
 * Unit scanner for a stored embedding space (feature 48, rework A2).
 *
 * A space directory is a derived cache, so this module's contract is "count
 * what is committed, ignore everything else, never throw": `current.json` is
 * the commit point. The tests write real B2 generations with the production
 * writer and then ask both shapes (lifecycle keys and recall units), so a
 * regression in the pointer/read logic shows up here rather than as a wrong
 * `ready` line in `/recall embedding status`.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEmbeddingChunkPlan } from "@/backend/local/embedding-chunk";
import {
  type EmbeddingVectorUnit,
  embeddingChunkRecordsFromPlan,
  embeddingVectorUnitDir,
  writeEmbeddingIndex,
} from "@/backend/local/embedding-format";
import {
  listEmbeddingSpaceUnitKeys,
  listEmbeddingSpaceUnits,
} from "@/backend/local/embedding-space-units";

const AGENT_ID = "agent-units";
const SPACE_ID = "space-units";
const DIMENSIONS = 8;
const MODEL_ID = "test-model";

const root = mkdtempSync(join(tmpdir(), "haru-space-units-"));
const spaceDir = join(root, AGENT_ID, SPACE_ID);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function unitVector(index: number): Float32Array {
  const vector = new Float32Array(DIMENSIONS);
  vector[index % DIMENSIONS] = 1;
  return vector;
}

/** Write one committed generation through the production writer. */
function writeUnit(
  unit: EmbeddingVectorUnit,
  options: { parentText?: string; modelId?: string } = {},
): string {
  const plan = buildEmbeddingChunkPlan(
    {
      parentId: "m-1",
      text: options.parentText ?? "财务系统每日对账一次，结果写入当日的台账。",
    },
    { targetTokens: 64, maxTokens: 96, overlapTokens: 0 },
  );
  const records = embeddingChunkRecordsFromPlan(plan);
  const unitDir = embeddingVectorUnitDir(unit, { root });
  mkdirSync(unitDir, { recursive: true });
  writeEmbeddingIndex({
    unitDir,
    unit,
    modelId: options.modelId ?? MODEL_ID,
    dimensions: DIMENSIONS,
    records,
    vectors: records.map((_, index) => unitVector(index)),
    coverage: plan.coverage,
  });
  return unitDir;
}

describe("listEmbeddingSpaceUnitKeys", () => {
  test("a missing space is empty, not an error", () => {
    expect(listEmbeddingSpaceUnitKeys(join(root, "absent", "space"))).toEqual(
      [],
    );
    expect(listEmbeddingSpaceUnits(join(root, "absent", "space"))).toEqual([]);
  });

  test("counts committed conversation and memory units with lifecycle keys", () => {
    writeUnit({
      agentId: AGENT_ID,
      spaceId: SPACE_ID,
      conversationKey: "conv-a",
    });
    writeUnit({
      agentId: AGENT_ID,
      spaceId: SPACE_ID,
      conversationKey: "conv-b",
    });
    writeUnit({
      agentId: AGENT_ID,
      spaceId: SPACE_ID,
      memoryFileKey: "file-key-1",
    });

    const keys = listEmbeddingSpaceUnitKeys(spaceDir);
    expect(keys).toEqual([
      { unitKey: "conv-a", kind: "conversation" },
      { unitKey: "conv-b", kind: "conversation" },
      { unitKey: "memory/file-key-1", kind: "memory" },
    ]);
  });

  test("ignores uncommitted units, staging leftovers and stray files", () => {
    const uncommitted = join(spaceDir, "conv-no-pointer");
    mkdirSync(uncommitted, { recursive: true });
    mkdirSync(join(spaceDir, ".tmp-staging"), { recursive: true });
    mkdirSync(join(spaceDir, "memory", ".tmp-memory-staging"), {
      recursive: true,
    });
    mkdirSync(join(spaceDir, "memory", "uncommitted-file"), {
      recursive: true,
    });

    const keys = listEmbeddingSpaceUnitKeys(spaceDir);
    expect(keys.map((unit) => unit.unitKey)).toEqual([
      "conv-a",
      "conv-b",
      "memory/file-key-1",
    ]);
  });

  test("a corrupt pointer removes the unit from the count", () => {
    const unitDir = writeUnit({
      agentId: AGENT_ID,
      spaceId: SPACE_ID,
      conversationKey: "conv-corrupt",
    });
    writeBrokenJson(join(unitDir, "current.json"));

    expect(
      listEmbeddingSpaceUnitKeys(spaceDir).map((unit) => unit.unitKey),
    ).not.toContain("conv-corrupt");
  });
});

describe("listEmbeddingSpaceUnits", () => {
  test("returns the transcript/memory shape the recall arm consumes", () => {
    expect(listEmbeddingSpaceUnits(spaceDir)).toEqual([
      { kind: "transcript", conversationKey: "conv-a" },
      { kind: "transcript", conversationKey: "conv-b" },
      { kind: "memory", file: "file-key-1", memoryFileKey: "file-key-1" },
    ]);
  });
});

function writeBrokenJson(path: string): void {
  // A half-written pointer is the shape a crashed writer leaves behind.
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "{ not json", "utf8");
}
