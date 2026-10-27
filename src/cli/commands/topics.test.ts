/**
 * `/topics` wiring (D-110): the command must reach the local backend's list,
 * honour `--all`, and refuse clearly on a backend that has no topic markers.
 * The copy itself is covered by `topic-list.test.ts`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type { DreamCommandScope } from "@/agent/reflection-runs";
import type { ConversationMessageCreateBody } from "@/backend";
import { __testSetBackend } from "@/backend";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import type { HeadlessTurnExecutor } from "@/backend/dev/headless-turn-executor";
import { LocalBackend } from "@/backend/local/local-backend";
import { refreshTopicIndexForConversation } from "@/backend/local/topic-index";
import { TOPIC_COMMAND_LOCAL_ONLY } from "@/cli/commands/topic";
import {
  handleTopicsCommand,
  handleTopicsSearchCommand,
} from "@/cli/commands/topics";
import { settingsManager } from "@/settings-manager";

const temporaryDirectories: string[] = [];

async function createStorageDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "topics-command-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  __testSetBackend(null);
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function lettaStreamFromChunks(
  chunks: LettaStreamingResponse[],
): Stream<LettaStreamingResponse> {
  return {
    controller: new AbortController(),
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

/** A local conversation with `turns` user turns, so markers have anchors. */
async function backendWithTurns(turns: number): Promise<{
  backend: LocalBackend;
  agentId: string;
  scope: DreamCommandScope;
}> {
  const backend = new LocalBackend({
    storageDir: await createStorageDirectory(),
    executor: okExecutor,
    memfsEnabled: false,
  });
  const agent = await backend.createAgent({
    name: "Local",
    system: "base {CORE_MEMORY}",
  });
  for (let turn = 0; turn < turns; turn += 1) {
    const stream = await backend.createConversationMessageStream("default", {
      agent_id: agent.id,
      messages: [{ role: "user", content: `question ${turn}` }],
    } as ConversationMessageCreateBody);
    for await (const _chunk of stream) {
      // drain
    }
  }
  return {
    backend,
    agentId: agent.id,
    scope: {
      agentId: agent.id,
      conversationId: "default",
    } as DreamCommandScope,
  };
}

async function withTemporaryHome(run: () => Promise<void>): Promise<void> {
  const previousHome = process.env.HOME;
  process.env.HOME = await createStorageDirectory();
  await settingsManager.reset();
  await settingsManager.initialize();
  try {
    await run();
  } finally {
    await settingsManager.reset();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
}

describe("handleTopicsCommand", () => {
  test("help documents both forms and how a trim is picked", async () => {
    const output = await handleTopicsCommand(["help"]);
    expect(output).toContain("/topic list --all");
    expect(output).toContain("/compact <n>");
  });

  test("rejects an unknown option instead of silently ignoring it", async () => {
    const output = await handleTopicsCommand(["--everything"]);
    expect(output).toContain('Unknown option "--everything"');
    expect(output).toContain("USAGE");
  });

  test("requires an active agent", async () => {
    await expect(
      handleTopicsCommand([], { conversationId: "c" } as DreamCommandScope),
    ).rejects.toThrow("require an active agent");
  });

  test("reports the local-only rule on a non-local backend", async () => {
    __testSetBackend(new FakeHeadlessBackend());
    expect(await handleTopicsCommand([], { agentId: "agent-x" })).toBe(
      TOPIC_COMMAND_LOCAL_ONLY,
    );
  });

  test("lists the blocks a marker created", async () => {
    const { backend, agentId, scope } = await backendWithTurns(4);
    backend.markTopic({
      conversationId: "default",
      agentId,
      title: "Auth token refresh",
      createdBy: "user",
    });

    const output = await handleTopicsCommand([], scope, { backend });
    expect(output).toContain("Topic blocks in the current context");
    expect(output).toContain("Auth token refresh");
    expect(output).toContain("Current topic (not marked finished)");
    expect(output).toContain("/compact <n> keeps block n");
  });

  test("--context lists this conversation's markers in conversation order", async () => {
    const { backend, agentId, scope } = await backendWithTurns(4);
    backend.markTopic({
      conversationId: "default",
      agentId,
      title: "Auth token refresh",
      createdBy: "agent",
    });

    const output = await handleTopicsCommand(["--context"], scope, {
      backend,
    });
    expect(output).toContain("Every topic marker in this conversation (1,");
    expect(output).toContain("oldest first");
    expect(output).toContain("Auth token refresh");
    expect(output).toContain("agent");
    expect(output).toContain("in the current context");
  });

  test("--all lists this agent's markers newest first, across conversations", async () => {
    const { backend, agentId, scope } = await backendWithTurns(2);
    backend.markTopic({
      conversationId: "default",
      agentId,
      title: "First topic",
      createdBy: "user",
    });
    backend.markTopic({
      conversationId: "default",
      agentId,
      title: "Second topic",
      createdBy: "user",
    });

    const output = await handleTopicsCommand(["--all"], scope, { backend });
    expect(output).toContain("newest first");
    // A time-ordered list: the marker written last comes first.
    expect(output.indexOf("Second topic")).toBeLessThan(
      output.indexOf("First topic"),
    );
  });

  test("--all and --context are different views, not synonyms", async () => {
    const { backend, agentId, scope } = await backendWithTurns(2);
    backend.markTopic({
      conversationId: "default",
      agentId,
      title: "Only topic",
      createdBy: "user",
    });

    const all = await handleTopicsCommand(["--all"], scope, { backend });
    const context = await handleTopicsCommand(["--context"], scope, {
      backend,
    });
    expect(all).toContain("newest first");
    expect(context).toContain("oldest first");
  });

  test("an unmarked context explains both marking channels", async () => {
    const { scope, backend } = await backendWithTurns(2);
    const output = await handleTopicsCommand([], scope, { backend });
    expect(output).toContain("No topic markers in this conversation yet.");
    expect(output).toContain("TopicMark");
  });

  test("an unmarked context says so when the agent channel is off", async () => {
    await withTemporaryHome(async () => {
      settingsManager.updateSettings({ topicMarkingEnabled: false });
      const { scope, backend } = await backendWithTurns(2);
      const output = await handleTopicsCommand([], scope, { backend });
      expect(output).toContain("Topic marking is switched off");
      expect(output).not.toContain("TopicMark");
    });
  });

  test("an empty context is reported, not invented", async () => {
    const backend = new LocalBackend({
      storageDir: await createStorageDirectory(),
      executor: okExecutor,
      memfsEnabled: false,
    });
    const agent = await backend.createAgent({
      name: "Local",
      system: "base {CORE_MEMORY}",
    });
    const output = await handleTopicsCommand(
      [],
      { agentId: agent.id, conversationId: "default" } as DreamCommandScope,
      { backend },
    );
    expect(output).toBe("There is nothing in this conversation's context yet.");
  });
});

describe("handleTopicsSearchCommand", () => {
  test("finds a marker through the per-agent index", async () => {
    const { backend, agentId, scope } = await backendWithTurns(4);
    backend.markTopic({
      conversationId: "default",
      agentId,
      title: "Auth token refresh",
      createdBy: "user",
    });
    // The index is the read path; the transcript is the source of truth (§5.11.1).
    refreshTopicIndexForConversation(
      agentId,
      "default",
      backend.getLocalStorageDir(),
    );

    const output = await handleTopicsSearchCommand(["auth"], scope, {
      backend,
    });

    expect(output).toContain('Topic markers matching "auth" (1, newest first)');
    expect(output).toContain("Auth token refresh");
    expect(output).toContain("default");
    expect(output).toContain("user");
  });

  test("an unmatched keyword says so instead of returning an empty string", async () => {
    const { backend, agentId, scope } = await backendWithTurns(4);
    backend.markTopic({
      conversationId: "default",
      agentId,
      title: "Auth token refresh",
      createdBy: "user",
    });
    refreshTopicIndexForConversation(
      agentId,
      "default",
      backend.getLocalStorageDir(),
    );

    const output = await handleTopicsSearchCommand(["deploy"], scope, {
      backend,
    });
    expect(output).toBe('No topic markers match "deploy".');
  });

  test("no keyword lists every indexed topic", async () => {
    const { backend, agentId, scope } = await backendWithTurns(4);
    backend.markTopic({
      conversationId: "default",
      agentId,
      title: "Auth token refresh",
      createdBy: "agent",
    });
    refreshTopicIndexForConversation(
      agentId,
      "default",
      backend.getLocalStorageDir(),
    );

    const output = await handleTopicsSearchCommand([], scope, { backend });
    expect(output).toContain("Topic markers for this agent (1, newest first)");
    expect(output).toContain("Auth token refresh");
  });

  test("searching writes no marker (the C-22 bug)", async () => {
    const { backend, agentId, scope } = await backendWithTurns(4);
    backend.markTopic({
      conversationId: "default",
      agentId,
      title: "Auth token refresh",
      createdBy: "user",
    });
    refreshTopicIndexForConversation(
      agentId,
      "default",
      backend.getLocalStorageDir(),
    );

    await handleTopicsSearchCommand(["search"], scope, { backend });

    // The registry used to read the first word of `/topic …` as a title, so this
    // command recorded a topic called "search" (route C-22).
    expect(
      backend.listTopics("default", agentId).markers.map((v) => v.marker.title),
    ).toEqual(["Auth token refresh"]);
  });

  test("requires an active agent", async () => {
    await expect(
      handleTopicsSearchCommand([], {
        conversationId: "c",
      } as DreamCommandScope),
    ).rejects.toThrow("requires an active agent");
  });

  test("reports the local-only rule on a non-local backend", async () => {
    __testSetBackend(new FakeHeadlessBackend());
    expect(
      await handleTopicsSearchCommand(["auth"], { agentId: "agent-x" }),
    ).toBe(TOPIC_COMMAND_LOCAL_ONLY);
  });

  test("help prints the shared usage", async () => {
    const output = await handleTopicsSearchCommand(["help"]);
    expect(output).toContain("/topic search <kw>");
  });
});

describe("the /topic registry dispatch", () => {
  test("`search` reaches the search handler and records no marker", async () => {
    const { backend, agentId } = await backendWithTurns(4);
    backend.markTopic({
      conversationId: "default",
      agentId,
      title: "Auth token refresh",
      createdBy: "user",
    });
    refreshTopicIndexForConversation(
      agentId,
      "default",
      backend.getLocalStorageDir(),
    );
    // The registry resolves its backend through `getBackend()`, not through deps.
    __testSetBackend(backend);
    const { executeCommand } = await import("@/cli/commands/registry");

    const result = await executeCommand("/topic search auth", {
      agentId,
      conversationId: "default",
    } as DreamCommandScope);

    expect(result.output).toContain("Topic markers matching");
    expect(result.output).toContain("Auth token refresh");
    // The marker count is the assertion that matters: the bug's damage was a row.
    expect(
      backend.listTopics("default", agentId).markers.map((v) => v.marker.title),
    ).toEqual(["Auth token refresh"]);
  });
});
