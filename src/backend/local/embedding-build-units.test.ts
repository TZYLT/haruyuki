import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  resolveEmbeddingAgentMemoryDir,
  scanEmbeddingBuildUnits,
  summarizeEmbeddingUnits,
} from "@/backend/local/embedding-build-units";
import { parseMemoryVectorParentId } from "@/backend/local/embedding-memory";
import {
  createGate2Environment,
  type Gate2Environment,
  gate2MemoryDir,
  writeGate2Conversation,
  writeGate2MemoryFile,
} from "@/test-utils/embedding-gate2-fixtures";

const AGENT_ID = "agent-a1-units";

let env: Gate2Environment;
let storageDir: string;

const DEPLOY_NOTE =
  "部署窗口固定在每周三晚上十点。回滚脚本位于 tools/rollback.sh。执行前先确认数据库备份完成，然后核对监控面板，最后再通知值班同学。";

beforeEach(() => {
  env = createGate2Environment("haru-a1-units-");
  storageDir = env.localBackendDir;
});

afterEach(() => {
  env.restore();
  env.cleanup();
});

async function writeConversation(input: {
  directory: string;
  agentId?: string;
  hidden?: boolean;
  messages: readonly { id: string; role: "user" | "assistant"; text: string }[];
}): Promise<void> {
  await writeGate2Conversation({
    storageDir,
    directory: input.directory,
    conversationId: `conversation-${input.directory}`,
    agentId: input.agentId ?? AGENT_ID,
    messages: input.messages,
  });
  if (input.hidden === true) {
    writeFileSync(
      join(storageDir, "conversations", input.directory, "conversation.json"),
      `${JSON.stringify({
        id: `conversation-${input.directory}`,
        agent_id: input.agentId ?? AGENT_ID,
        hidden: true,
      })}\n`,
      "utf8",
    );
  }
}

function scan(
  overrides: Partial<Parameters<typeof scanEmbeddingBuildUnits>[0]> = {},
) {
  return scanEmbeddingBuildUnits({
    agentId: AGENT_ID,
    spaceId: "space-a1-units",
    storageDir,
    ...overrides,
  });
}

describe("resolveEmbeddingAgentMemoryDir", () => {
  test("matches the local backend's memory workspace", () => {
    expect(resolveEmbeddingAgentMemoryDir(storageDir, AGENT_ID)).toBe(
      gate2MemoryDir(storageDir, AGENT_ID),
    );
  });
});

describe("scanEmbeddingBuildUnits", () => {
  test("returns [] for a storage root with no conversations or memory", () => {
    expect(scan()).toEqual([]);
  });

  test("keeps only the agent's non-hidden conversations with a transcript", async () => {
    await writeConversation({
      directory: "conv-owned",
      messages: [{ id: "message-1", role: "user", text: DEPLOY_NOTE }],
    });
    await writeConversation({
      directory: "conv-other-agent",
      agentId: "agent-elsewhere",
      messages: [{ id: "message-2", role: "user", text: DEPLOY_NOTE }],
    });
    await writeConversation({
      directory: "conv-hidden",
      hidden: true,
      messages: [{ id: "message-3", role: "user", text: DEPLOY_NOTE }],
    });
    await writeConversation({ directory: "conv-empty", messages: [] });

    const units = scan();
    expect(units).toHaveLength(1);
    const owned = units[0];
    expect(owned?.unit).toEqual({
      agentId: AGENT_ID,
      spaceId: "space-a1-units",
      conversationKey: "conv-owned",
    });
    expect(owned?.plans).toHaveLength(1);
    const chunks = owned?.plans.flatMap((plan) => plan.chunks) ?? [];
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]?.parentId).toBe("message-1");
  });

  test("includes hidden conversations only when asked", async () => {
    await writeConversation({
      directory: "conv-visible",
      messages: [{ id: "message-1", role: "user", text: DEPLOY_NOTE }],
    });
    await writeConversation({
      directory: "conv-hidden",
      hidden: true,
      messages: [{ id: "message-2", role: "user", text: DEPLOY_NOTE }],
    });

    expect(scan()).toHaveLength(1);
    const withHidden = scan({ includeHidden: true });
    expect(withHidden).toHaveLength(2);
    expect(
      withHidden.map((unit) =>
        "conversationKey" in unit.unit ? unit.unit.conversationKey : "",
      ),
    ).toContain("conv-hidden");
  });

  test("builds chunk plans with the supplied chunk options", async () => {
    const longText = Array.from(
      { length: 12 },
      (_, index) =>
        `第 ${index} 句：部署窗口固定在每周三晚上十点，回滚脚本位于 tools/rollback.sh。`,
    ).join("");

    await writeConversation({
      directory: "conv-chunked",
      messages: [{ id: "message-1", role: "user", text: longText }],
    });

    const defaultUnits = scan();
    const fineUnits = scan({
      chunkOptions: { targetTokens: 8, maxTokens: 12, overlapTokens: 2 },
    });
    const defaultChunks = defaultUnits[0]?.plans[0]?.chunks.length ?? 0;
    const fineChunks = fineUnits[0]?.plans[0]?.chunks.length ?? 0;
    expect(defaultChunks).toBeGreaterThan(0);
    expect(fineChunks).toBeGreaterThan(defaultChunks);
  });

  test("creates one memory unit per file with absolute parent line spans", async () => {
    await writeGate2MemoryFile({
      storageDir,
      agentId: AGENT_ID,
      path: "notes/deploy.md",
      content: [
        "# 部署笔记",
        "",
        "第一段：部署窗口固定在每周三晚上十点，回滚脚本位于 tools/rollback.sh。",
        "",
        "第二段：回滚之前必须确认数据库备份完成，否则禁止继续执行回滚流程。",
        "",
      ].join("\n"),
    });

    const units = scan();
    const memoryUnits = units.filter((unit) => "memoryFileKey" in unit.unit);
    expect(memoryUnits).toHaveLength(1);
    const unit = memoryUnits[0];
    expect(unit === undefined).toBe(false);
    if (unit === undefined || !("memoryFileKey" in unit.unit)) return;
    expect(unit.unit.agentId).toBe(AGENT_ID);
    expect(unit.unit.spaceId).toBe("space-a1-units");
    expect(unit.unit.memoryFileKey.length).toBeGreaterThan(0);
    expect(unit.plans.length).toBeGreaterThan(0);
    expect(unit.parentLineSpan).toBeDefined();

    const chunks = unit.plans.flatMap((plan) => plan.chunks);
    expect(chunks.length).toBeGreaterThan(0);
    let sawLaterParagraph = false;
    for (const chunk of chunks) {
      const parent = parseMemoryVectorParentId(chunk.parentId);
      expect(parent).toBeDefined();
      if (parent === undefined) continue;
      if (parent.startLine > 1) sawLaterParagraph = true;
      const span = unit.parentLineSpan?.(chunk);
      expect(span).toBeDefined();
      if (span === undefined) continue;
      expect(span.startLine).toBeGreaterThanOrEqual(parent.startLine);
      expect(span.endLine).toBeLessThanOrEqual(parent.endLine);
      expect(span.endLine).toBeGreaterThanOrEqual(span.startLine);
    }
    expect(sawLaterParagraph).toBe(true);
  });

  test("honours an explicit memoryDir instead of the agent workspace", async () => {
    writeGate2MemoryFile({
      storageDir,
      agentId: AGENT_ID,
      path: "default.md",
      content: "默认记忆目录里的内容不应被显式 memoryDir 覆盖时读到。",
    });

    expect(scan()).toHaveLength(1);
    const customUnits = scan({ memoryDir: join(env.root, "custom-memory") });
    expect(
      customUnits.filter((unit) => "memoryFileKey" in unit.unit),
    ).toHaveLength(0);
  });

  test("stops before the first unit when shouldStop is already true", async () => {
    await writeConversation({
      directory: "conv-owned",
      messages: [{ id: "message-1", role: "user", text: DEPLOY_NOTE }],
    });
    expect(scan({ shouldStop: () => true })).toEqual([]);
  });
});

describe("summarizeEmbeddingUnits", () => {
  test("counts conversations, memory files and chunks", async () => {
    await writeConversation({
      directory: "conv-summary",
      messages: [{ id: "message-1", role: "user", text: DEPLOY_NOTE }],
    });
    await writeGate2MemoryFile({
      storageDir,
      agentId: AGENT_ID,
      path: "notes/summary.md",
      content: "摘要测试：部署窗口与回滚流程写在同一条记忆里。",
    });

    const units = scan();
    const summary = summarizeEmbeddingUnits(units);
    expect(summary.conversations).toBe(1);
    expect(summary.memoryFiles).toBe(1);
    const expectedChunks = units.reduce(
      (total, unit) =>
        total +
        unit.plans.reduce((count, plan) => count + plan.chunks.length, 0),
      0,
    );
    expect(summary.chunks).toBe(expectedChunks);
    expect(summary.chunks).toBeGreaterThan(0);
  });

  test("returns zeros for no units", () => {
    expect(summarizeEmbeddingUnits([])).toEqual({
      conversations: 0,
      memoryFiles: 0,
      chunks: 0,
    });
  });
});
