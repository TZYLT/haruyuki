/**
 * Dream tool declaration (F-06 Q-53, route §2.3 / §5).
 *
 * The declared payload is what the model sees and what the prefix freeze
 * captures on the conversation's first turn, so the gate has to be right at
 * that layer: a dream conversation carries the whole family, an ordinary one
 * carries none of the run-only tools, and the runtime context that the
 * permission checker will read is set from the same record.
 *
 * `SessionRead` is deliberately *not* dream-only (R-5.4.2): it is in the regular
 * presets so any agent can read an ordinary conversation back, and it appears in
 * a dream conversation because that conversation uses the same preset.
 *
 * `DreamNote` is the one dream-family name that is *also* ordinary (W15, design
 * §2.4): the run-unattended child and a normal session both leave notes for the
 * next run, so the tool is in both the family declaration and the presets.
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
import {
  DREAM_REQUIRED_TOOL_NAMES,
  DREAM_TOOL_NAMES,
} from "@/tools/dream-tool-names";
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

async function clientToolNames(
  agentId: string,
  conversationId: string,
  options: { include?: string[] } = {},
) {
  const prepared = await prepareToolExecutionContextForScope({
    agentId,
    conversationId,
    workingDirectory: homeDir,
    ...(options.include ? { clientToolset: { include: options.include } } : {}),
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
  test("a dream conversation declares the whole dream family and marks the run", async () => {
    const agent = await backend.createAgent({ name: "Dream declaration" });
    const session = await createDreamSession({
      agentId: agent.id,
      runId: "run-1",
    });

    const declared = await clientToolNames(agent.id, session.conversationId);
    expect(DREAM_TOOL_NAMES).toEqual([
      "MemoryCommit",
      "DreamStatus",
      "DreamDone",
      "DreamAuthorization",
      "DreamNote",
    ]);
    for (const toolName of DREAM_TOOL_NAMES) {
      expect(declared.names).toContain(toolName);
    }
    expect(declared.dreamRun).toBe(true);
  });

  test("an ordinary conversation declares no run-only dream tool", async () => {
    const agent = await backend.createAgent({ name: "Ordinary" });
    const conversation = await backend.createConversation({
      agent_id: agent.id,
    });

    const declared = await clientToolNames(agent.id, conversation.id);
    const runOnly = DREAM_TOOL_NAMES.filter(
      (toolName) => toolName !== "DreamNote",
    );
    for (const toolName of runOnly) {
      expect(declared.names).not.toContain(toolName);
    }
    expect(declared.dreamRun).toBe(false);
  });

  test("DreamNote is declared in ordinary sessions too, as the note entry point", async () => {
    // W15: the main agent leaves a note for the next dream run. If a normal
    // conversation never advertises the tool, the permission auto-allow and the
    // presets' own listing would both be unreachable in practice.
    const agent = await backend.createAgent({ name: "DreamNote everywhere" });
    const conversation = await backend.createConversation({
      agent_id: agent.id,
    });

    const declared = await clientToolNames(agent.id, conversation.id);
    expect(declared.names).toContain("DreamNote");
    expect(declared.dreamRun).toBe(false);
  });

  test("SessionRead is declared for both, because it is not dream-only", async () => {
    const agent = await backend.createAgent({ name: "SessionRead everywhere" });
    const session = await createDreamSession({
      agentId: agent.id,
      runId: "run-2",
    });
    const conversation = await backend.createConversation({
      agent_id: agent.id,
    });

    expect(
      (await clientToolNames(agent.id, session.conversationId)).names,
    ).toContain("SessionRead");
    expect((await clientToolNames(agent.id, conversation.id)).names).toContain(
      "SessionRead",
    );
  });

  test("a dream conversation still declares the ordinary tools its prompts require", async () => {
    // The dream prompts tell the tiers to read and edit memory files, which a
    // model-derived preset may not carry (codex has no Read/Edit/Write/Glob/Grep;
    // `none` is empty). Lead's declaration list adds them; this pins that the
    // declared payload the prompt describes is actually there.
    const agent = await backend.createAgent({ name: "Dream file tools" });
    const session = await createDreamSession({
      agentId: agent.id,
      runId: "run-4",
    });
    const declared = await clientToolNames(agent.id, session.conversationId);
    for (const toolName of DREAM_REQUIRED_TOOL_NAMES) {
      expect(declared.names).toContain(toolName);
    }
    expect(DREAM_REQUIRED_TOOL_NAMES).toContain("Read");
    expect(DREAM_REQUIRED_TOOL_NAMES).toContain("Write");
    expect(DREAM_REQUIRED_TOOL_NAMES).toContain("Edit");
    expect(DREAM_REQUIRED_TOOL_NAMES).toContain("Glob");
    expect(DREAM_REQUIRED_TOOL_NAMES).toContain("Grep");
    expect(DREAM_REQUIRED_TOOL_NAMES).toContain("SessionRead");
  });

  test("AskUserQuestion is excluded from a dream conversation", async () => {
    const agent = await backend.createAgent({ name: "No questions" });
    const session = await createDreamSession({
      agentId: agent.id,
      runId: "run-3",
    });
    const conversation = await backend.createConversation({
      agent_id: agent.id,
    });

    const requested = { include: ["AskUserQuestionAsync"] };
    const dream = await clientToolNames(
      agent.id,
      session.conversationId,
      requested,
    );
    const ordinary = await clientToolNames(
      agent.id,
      conversation.id,
      requested,
    );

    // Nobody is in a dream run to answer; the gate removes the interactive tool.
    expect(dream.names).not.toContain("AskUserQuestion");
    expect(ordinary.names).toContain("AskUserQuestion");
  });
});
