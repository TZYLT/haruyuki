/**
 * Listener `/compact` (D-117): a channel with no picker must name the block, and
 * the mode words that only the cloud backend understands are refused by name.
 * The reminder re-arm is the behaviour this file originally existed for, so it is
 * kept — now on the trim path, which is the only local compaction path left.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type WebSocket from "ws";
import type { ConversationMessageCreateBody } from "@/backend";
import { __testSetBackend, type AgentCreateBody } from "@/backend";
import type { HeadlessTurnExecutor } from "@/backend/dev/headless-turn-executor";
import { LocalBackend } from "@/backend/local";
import { COMPACT_MODE_LOCAL_UNSUPPORTED } from "@/cli/helpers/compact-command";
import { __listenClientTestUtils } from "@/websocket/listener/client";
import { handleExecuteCommand } from "@/websocket/listener/commands";

class CompactTestSocket {
  readonly sentPayloads: string[] = [];
  readonly readyState = 1;

  send(data: string): void {
    this.sentPayloads.push(data);
  }
}

const temporaryDirectories: string[] = [];

async function createStorageDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "listener-compact-"));
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

/**
 * A local agent whose conversation has `turns` turns and, by default, one marker
 * anchored at the newest message. `markAfterTurn` moves that anchor earlier (so
 * its effective boundary can clamp onto the start of the context) and `mark:
 * false` leaves the conversation unmarked.
 */
async function localFixture(
  turns: number,
  options: { markAfterTurn?: number; mark?: boolean } = {},
): Promise<{
  backend: LocalBackend;
  agentId: string;
  runtime: ReturnType<
    typeof __listenClientTestUtils.getOrCreateConversationRuntime
  >;
  socket: CompactTestSocket;
}> {
  const shouldMark = options.mark ?? true;
  const markAfterTurn = options.markAfterTurn ?? turns;
  const backend = new LocalBackend({
    storageDir: await createStorageDirectory(),
    executor: okExecutor,
    complete: async () =>
      ({
        role: "assistant",
        content: [{ type: "text", text: "summary" }],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5.5",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
        },
        stopReason: "stop",
        timestamp: Date.now(),
      }) as never,
    memfsEnabled: false,
  });
  __testSetBackend(backend);
  const agent = await backend.createAgent({
    name: "Compact Reminder Agent",
    model: "openai/gpt-5.5",
    model_settings: {
      provider_type: "openai",
      context_window_limit: 2_000,
    },
  } as AgentCreateBody);
  for (let turn = 0; turn < turns; turn += 1) {
    const stream = await backend.createConversationMessageStream("default", {
      agent_id: agent.id,
      messages: [{ role: "user", content: `turn ${turn} ${"x".repeat(400)}` }],
    } as ConversationMessageCreateBody);
    for await (const _chunk of stream) {
      // drain
    }
    if (shouldMark && turn + 1 === markAfterTurn) {
      backend.markTopic({
        conversationId: "default",
        agentId: agent.id,
        title: "Alpha",
        createdBy: "agent",
      });
    }
  }
  const listener = __listenClientTestUtils.createListenerRuntime();
  const runtime = __listenClientTestUtils.getOrCreateConversationRuntime(
    listener,
    agent.id,
    "default",
  );
  return {
    backend,
    agentId: agent.id,
    runtime,
    socket: new CompactTestSocket(),
  };
}

async function runCompact(
  fixture: Awaited<ReturnType<typeof localFixture>>,
  args?: string,
): Promise<string> {
  await handleExecuteCommand(
    {
      type: "execute_command",
      command_id: "compact",
      request_id: "compact-1",
      runtime: { agent_id: fixture.agentId, conversation_id: "default" },
      ...(args === undefined ? {} : { args }),
    },
    fixture.socket as unknown as WebSocket,
    fixture.runtime,
    {},
  );
  return fixture.socket.sentPayloads.join("\n");
}

describe("listener compact command", () => {
  test("a numbered block trims and re-arms the one-shot context reminders", async () => {
    const fixture = await localFixture(8);
    fixture.runtime.reminderState.hasSentAgentInfo = true;
    fixture.runtime.reminderState.hasSentSessionContext = true;
    fixture.runtime.reminderState.hasSentSecretsInfo = true;

    const output = await runCompact(fixture, "2");

    expect(output).toContain("Context trimmed.");
    expect(output).toContain("topics:     Alpha");
    expect(fixture.runtime.reminderState.hasSentAgentInfo).toBe(false);
    expect(fixture.runtime.reminderState.hasSentSessionContext).toBe(false);
    expect(fixture.runtime.reminderState.pendingSessionContextReason).toBe(
      "post_compaction",
    );
    expect(fixture.runtime.reminderState.hasSentSecretsInfo).toBe(false);
  });

  test("a bare /compact says a channel without a picker needs a number", async () => {
    const fixture = await localFixture(8);

    const output = await runCompact(fixture);

    expect(output).toContain(
      "Choosing a cut point needs a terminal. Run /topic list to list the blocks",
    );
    expect(output).toContain("/compact <n>");
  });

  test("help is the shared usage", async () => {
    const fixture = await localFixture(2);

    const output = await runCompact(fixture, "help");

    expect(output).toContain("/compact <n>");
    expect(output).not.toContain("self_compact");
  });

  test("a mode argument is refused on the local backend", async () => {
    const fixture = await localFixture(2);

    const output = await runCompact(fixture, "sliding_window");

    expect(output).toContain("sliding_window");
    expect(output).toContain(COMPACT_MODE_LOCAL_UNSUPPORTED.slice(0, 40));
  });

  test("an out-of-range block is refused by name", async () => {
    const fixture = await localFixture(4);

    const output = await runCompact(fixture, "9");

    expect(output).toContain("There is no topic block 9");
    expect(output).toContain("compress by the rate");
  });

  test("with nothing to choose between, the rate decides instead of refusing (H-2)", async () => {
    // The marker sits right after the first turn, so its effective boundary
    // clamps onto the start of the context and no block is selectable: the same
    // state bare `/compact` finds on the TUI.
    const fixture = await localFixture(8, { markAfterTurn: 1 });

    const output = await runCompact(fixture);

    expect(output).toContain("Context trimmed.");
    expect(output).toContain("no marker defines a boundary here");
    expect(output).not.toContain("needs a terminal");
  });

  test("an unmarked conversation trims by the ratio without a picker (D-119)", async () => {
    const fixture = await localFixture(8, { mark: false });

    const output = await runCompact(fixture);

    expect(output).toContain("Context trimmed.");
    expect(output).toContain("no marker defines a boundary here");
  });

  test("invalid arguments carry the usage here too (L-2)", async () => {
    const fixture = await localFixture(2);

    const output = await runCompact(fixture, "nope");

    // The payload is JSON, so quotes arrive escaped; assert on the usage block
    // that `/compact nope` never used to include.
    expect(output).toContain("Unknown argument");
    expect(output).toContain("/compact [n]");
    expect(output).toContain("USAGE");
  });
});
