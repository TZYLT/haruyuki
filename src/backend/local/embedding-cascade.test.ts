import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  removeEmbeddingAgentVectorRoot,
  removeEmbeddingConversationVectorUnits,
} from "./embedding-cascade";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "hryk-embedding-cascade-"));
}

function writeUnit(
  root: string,
  agentId: string,
  spaceId: string,
  unitKey: string,
  generation = "g1",
): string {
  const unitDir = join(root, agentId, spaceId, unitKey);
  mkdirSync(join(unitDir, generation), { recursive: true });
  writeFileSync(join(unitDir, "current.json"), JSON.stringify({ generation }));
  writeFileSync(join(unitDir, generation, "meta.json"), "{}");
  return unitDir;
}

describe("removeEmbeddingConversationVectorUnits", () => {
  test("invalidates the unit in every space and leaves other units alone", () => {
    const root = tempRoot();
    try {
      const target = writeUnit(root, "agent-a", "space-1", "conv-a");
      writeUnit(root, "agent-a", "space-2", "conv-a");
      const neighbour = writeUnit(root, "agent-a", "space-1", "conv-b");
      const result = removeEmbeddingConversationVectorUnits(
        "agent-a",
        "conv-a",
        {
          root,
        },
      );
      expect(result.removedUnits).toBe(2);
      expect(result.removedAgentRoot).toBe(false);
      expect(existsSync(join(target, "current.json"))).toBe(false);
      expect(existsSync(join(neighbour, "current.json"))).toBe(true);
      expect(existsSync(join(neighbour, "g1", "meta.json"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("never throws for a missing agent root", () => {
    const root = tempRoot();
    try {
      expect(
        removeEmbeddingConversationVectorUnits("missing-agent", "conv-a", {
          root,
        }).removedUnits,
      ).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses an unsafe agent id and a traversal unit key", () => {
    const root = tempRoot();
    try {
      const unsafeAgent = removeEmbeddingConversationVectorUnits(
        "../escape",
        "conv-a",
        { root },
      );
      expect(unsafeAgent.removedUnits).toBe(0);
      expect(unsafeAgent.warnings[0]).toContain("unsafe agent id");

      writeUnit(root, "agent-a", "space-1", "conv-a");
      const unsafeKey = removeEmbeddingConversationVectorUnits(
        "agent-a",
        "../escape",
        { root },
      );
      expect(unsafeKey.removedUnits).toBe(0);
      expect(unsafeKey.warnings.join(" ")).toContain("unsafe-unit-key");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("removeEmbeddingAgentVectorRoot", () => {
  test("removes the agent's spaces and nothing else", () => {
    const root = tempRoot();
    try {
      writeUnit(root, "agent-a", "space-1", "conv-a");
      writeUnit(root, "agent-b", "space-1", "conv-b");
      const result = removeEmbeddingAgentVectorRoot("agent-a", { root });
      expect(result.removedAgentRoot).toBe(true);
      expect(existsSync(join(root, "agent-a"))).toBe(false);
      expect(existsSync(join(root, "agent-b", "space-1", "conv-b"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses an id that could escape the recall root", () => {
    const root = tempRoot();
    try {
      const escaped = join(root, "..", "not-ours");
      mkdirSync(escaped, { recursive: true });
      const result = removeEmbeddingAgentVectorRoot("..", { root });
      expect(result.removedAgentRoot).toBe(false);
      expect(result.warnings[0]).toContain("unsafe agent id");
      expect(existsSync(escaped)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
