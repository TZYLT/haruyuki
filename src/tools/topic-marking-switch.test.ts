/**
 * The `topic_marking_enabled` switch (D-118).
 *
 * Two layers, tested separately because they have different jobs:
 *
 * - **Declaration**: the switch (and the local backend) decide whether
 *   `TopicMark` appears in `client_tools`. What is declared goes into the frozen
 *   prefix, so this is where the token saving happens.
 * - **Call**: the tool stays resolvable, so a turn frozen before the switch
 *   flipped still refuses with a reason instead of "Tool not found".
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type { ConversationMessageCreateBody } from "@/backend";
import { __testSetBackend } from "@/backend";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import type { HeadlessTurnExecutor } from "@/backend/dev/headless-turn-executor";
import { LocalBackend } from "@/backend/local/local-backend";
import { settingsManager } from "@/settings-manager";
import { shouldIncludeTopicMarking } from "@/settings-tool-gates";
import { shouldDeclareTopicMarkingTool } from "@/tools/declaration-gates";
import { TOPIC_MARK_DISABLED, topic_mark } from "@/tools/impl/topic-mark";
import { clearCapturedToolExecutionContexts } from "@/tools/manager";
import { prepareToolExecutionContextForResolvedTarget } from "@/tools/toolset";

function lettaStreamFromChunks(
  chunks: LettaStreamingResponse[],
): Stream<LettaStreamingResponse> {
  const controller = new AbortController();
  return {
    controller,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  } as unknown as Stream<LettaStreamingResponse>;
}

const okExecutor: HeadlessTurnExecutor = {
  async execute() {
    return lettaStreamFromChunks([
      {
        message_type: "assistant_message",
        content: [{ type: "text", text: "ok" }],
      } as LettaStreamingResponse,
      {
        message_type: "stop_reason",
        stop_reason: "end_turn",
      } as LettaStreamingResponse,
    ]);
  },
};

async function sendTurn(
  backend: LocalBackend,
  agentId: string,
  content: string,
  clientTools: unknown[],
): Promise<void> {
  const stream = await backend.createConversationMessageStream("default", {
    agent_id: agentId,
    messages: [{ role: "user", content }],
    client_tools: clientTools,
  } as unknown as ConversationMessageCreateBody);
  for await (const _chunk of stream) {
    // drain
  }
}

const originalHome = process.env.HOME;
let testHomeDir: string;

beforeEach(async () => {
  await settingsManager.reset();
  testHomeDir = await mkdtemp(join(tmpdir(), "topic-marking-switch-home-"));
  process.env.HOME = testHomeDir;
  await settingsManager.initialize();
});

afterEach(async () => {
  clearCapturedToolExecutionContexts();
  __testSetBackend(null);
  await settingsManager.reset();
  await rm(testHomeDir, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

function disableTopicMarking(): void {
  settingsManager.updateSettings({ topicMarkingEnabled: false });
}

/** A local backend stands in for "the declaration is meaningful here". */
function useLocalBackend(): void {
  __testSetBackend(
    new LocalBackend({
      storageDir: join(testHomeDir, "local-backend"),
      memfsEnabled: false,
    }),
  );
}

async function declaredToolNames(): Promise<string[]> {
  const prepared = await prepareToolExecutionContextForResolvedTarget({
    toolsetPreference: "letta",
  });
  return prepared.preparedToolContext.clientTools.map((tool) => tool.name);
}

describe("the switch value", () => {
  test("defaults to on with nothing configured", () => {
    expect(settingsManager.getSettings().topicMarkingEnabled).toBe(true);
    expect(shouldIncludeTopicMarking()).toBe(true);
  });

  test("false turns it off", () => {
    disableTopicMarking();
    expect(shouldIncludeTopicMarking()).toBe(false);
  });
});

describe("the declaration layer", () => {
  test("declares TopicMark on the local backend with the switch on", async () => {
    useLocalBackend();
    expect(shouldDeclareTopicMarkingTool()).toBe(true);
    const declared = await declaredToolNames();
    expect(declared).toContain("TopicMark");
    // The reader rides with the writer: they are one feature.
    expect(declared).toContain("TopicQuery");
  });

  test("stops declaring it when the switch is off", async () => {
    useLocalBackend();
    disableTopicMarking();

    const declared = await declaredToolNames();
    expect(declared).not.toContain("TopicMark");
    expect(declared).not.toContain("TopicQuery");
    // The rest of the preset is untouched.
    expect(declared).toContain("Read");
  });

  test("never declares it on a non-local backend", async () => {
    __testSetBackend(new FakeHeadlessBackend());
    expect(shouldDeclareTopicMarkingTool()).toBe(false);
    const declared = await declaredToolNames();
    expect(declared).not.toContain("TopicMark");
    expect(declared).not.toContain("TopicQuery");
  });

  test("keeps the tool loaded so a stale declaration can still be refused", async () => {
    useLocalBackend();
    disableTopicMarking();

    const prepared = await prepareToolExecutionContextForResolvedTarget({
      toolsetPreference: "letta",
    });
    expect(
      prepared.preparedToolContext.clientTools.map((t) => t.name),
    ).not.toContain("TopicMark");
    // "Loaded" is the execution registry: dropping it from the payload must not
    // make the tool unresolvable.
    expect(prepared.preparedToolContext.loadedToolNames).toContain("TopicMark");
  });
});

describe("the next application point", () => {
  test("reports the removal as pending until an application point", async () => {
    const backend = new LocalBackend({
      storageDir: join(testHomeDir, "pending"),
      executor: okExecutor,
      memfsEnabled: false,
    });
    useLocalBackend();
    const agent = await backend.createAgent({
      name: "Local",
      system: "base {CORE_MEMORY}",
    });

    // Turn 1 freezes the declaration set that still carries the marker tool.
    const before = await prepareToolExecutionContextForResolvedTarget({
      toolsetPreference: "letta",
    });
    await sendTurn(
      backend,
      agent.id,
      "q1",
      before.preparedToolContext.clientTools,
    );

    disableTopicMarking();
    const after = await prepareToolExecutionContextForResolvedTarget({
      toolsetPreference: "letta",
    });
    await sendTurn(
      backend,
      agent.id,
      "q2",
      after.preparedToolContext.clientTools,
    );

    // The prefix is frozen, so the switch is *registered* rather than applied.
    const pending = await backend.getContextPending("default", agent.id);
    expect(pending.tools.removed).toContain("TopicMark");
    expect(pending.tools.changed).toBe(true);
  });
});

describe("the call layer", () => {
  test("refuses with the disabled reason and writes nothing", async () => {
    const backend = new LocalBackend({
      storageDir: join(testHomeDir, "call-layer"),
      memfsEnabled: false,
    });
    const agent = await backend.createAgent({
      name: "Local",
      system: "base {CORE_MEMORY}",
    });
    disableTopicMarking();

    const result = await topic_mark(
      { title: "Should not land" },
      { backend, agentId: agent.id, conversationId: "default" },
    );
    expect(result).toEqual({
      content: TOPIC_MARK_DISABLED,
      status: "error",
    });
    expect(backend.listTopicMarkers("default", agent.id)).toEqual([]);
  });
});
