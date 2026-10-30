/**
 * Dream tool declaration (F-06 Q-53, route §2.3).
 *
 * The declared payload is what the model sees and what the prefix freeze
 * captures on the conversation's first turn, so the gate has to be right at
 * that layer: a dream conversation carries the family, an ordinary one never
 * does, and the runtime context that the permission checker will read is set
 * from the same record.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDreamSession } from "@/agent/dream-session";
import { __testSetBackend } from "@/backend";
import { DeterministicPongExecutor } from "@/backend/dev/headless-turn-executor";
import { LocalBackend } from "@/backend/local/local-backend";
import { settingsManager } from "@/settings-manager";
import { toolFilter } from "@/tools/filter";
import { getExecutionContextById } from "@/tools/manager";
import { prepareToolExecutionContextForScope } from "@/tools/toolset";

const originalHome = process.env.HOME;
let homeDir: string;
let storageDir: string;
let backend: LocalBackend;

beforeEach(async () => {
  await settingsManager.reset();
  homeDir = await mkdtemp(join(tmpdir(), "haruyuki-dream-declaration-home-"));
  storageDir = await mkdtemp(
    join(tmpdir(), "haruyuki-dream-declaration-store-"),
  );
  process.env.HOME = homeDir;
  process.env.HARUYUKI_HOME = join(homeDir, ".haruyuki");
  delete process.env.LETTA_LOCAL_BACKEND_DIR;
  toolFilter.reset();
  await settingsManager.initialize();
  backend = new LocalBackend({
    storageDir,
    executor: new DeterministicPongExecutor(),
    memfsEnabled: false,
  });
  __testSetBackend(backend);
});

afterEach(async () => {
  __testSetBackend(null);
  toolFilter.reset();
  await settingsManager.reset();
  await rm(homeDir, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
  process.env.HOME = originalHome;
  delete process.env.HARUYUKI_HOME;
});

async function clientToolNames(agentId: string, conversationId: string) {
  const prepared = await prepareToolExecutionContextForScope({
    agentId,
    conversationId,
    workingDirectory: homeDir,
  });
  const execution = getExecutionContextById(
    prepared.preparedToolContext.contextId,
  );
  return {
    names: prepared.preparedToolContext.clientTools.map((tool) => tool.name),
    dreamRun: execution?.runtimeContext.dreamRun === true,
  };
}

describe("dream tool declaration", () => {
  test("a dream conversation declares MemoryCommit and marks the run", async () => {
    const agent = await backend.createAgent({ name: "Dream declaration" });
    const session = await createDreamSession({
      agentId: agent.id,
      runId: "run-1",
    });

    const declared = await clientToolNames(agent.id, session.conversationId);
    expect(declared.names).toContain("MemoryCommit");
    expect(declared.dreamRun).toBe(true);
  });

  test("an ordinary conversation never declares the dream family", async () => {
    const agent = await backend.createAgent({ name: "Ordinary" });
    const conversation = await backend.createConversation({
      agent_id: agent.id,
    });

    const declared = await clientToolNames(agent.id, conversation.id);
    expect(declared.names).not.toContain("MemoryCommit");
    expect(declared.dreamRun).toBe(false);
  });
});
