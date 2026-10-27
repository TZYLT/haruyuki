/**
 * Listener `/compact` (F-04, M5): a channel with no picker compresses by the
 * rate's default selection, a numbered block keeps that block, and the response
 * carries the overview and cut-point table (`topic_report`) for a desktop client
 * that has no terminal of its own.
 *
 * The multi-step flow is what changed here: it used to call the trim path
 * directly and refuse a bare `/compact` outright ("Choosing a cut point needs a
 * terminal"). `prepare` is scripted below — a provider call is not this file's
 * subject — but every step after it (`apply`, the receipt, the reflection tail,
 * the reminders) is the real one.
 *
 * The reminder re-arm is the behaviour this file originally existed for, so it is
 * kept.
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
import type { CompactionPreview } from "@/backend/local/compaction-preview";
import type { CompactionApplyResult } from "@/backend/local/compaction-run";
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
const originalHaruyukiHome = process.env.HARUYUKI_HOME;

async function createStorageDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "listener-compact-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  __testSetBackend(null);
  // 《31》red line A: the ledger this path writes must never land in the real
  // `~/.haruyuki`. Each fixture points HARUYUKI_HOME at its own temp root.
  if (originalHaruyukiHome === undefined) delete process.env.HARUYUKI_HOME;
  else process.env.HARUYUKI_HOME = originalHaruyukiHome;
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

/** The in-context message ids, read through the store the way the backend does. */
function inContextIds(
  backend: LocalBackend,
  conversationId: string,
  agentId: string,
): string[] {
  const store = (
    backend as unknown as {
      store: {
        listLocalMessages(
          conversationId: string,
          agentId: string,
        ): { id: string }[];
      };
    }
  ).store;
  return store
    .listLocalMessages(conversationId, agentId)
    .map((message) => message.id);
}

/**
 * A local conversation with `turns` turns. `prepare` is scripted from the live
 * message list: by default two topics ("Alpha" then "Beta"), or one unmarked
 * block when `unmarked` is set — the state a bare `/compact` finds before any
 * marker exists.
 */
async function localFixture(
  turns: number,
  options: { unmarked?: boolean } = {},
): Promise<{
  backend: LocalBackend;
  agentId: string;
  runtime: ReturnType<
    typeof __listenClientTestUtils.getOrCreateConversationRuntime
  >;
  socket: CompactTestSocket;
}> {
  const storageDir = await createStorageDirectory();
  process.env.HARUYUKI_HOME = storageDir;
  const backend = new (class extends LocalBackend {
    override async prepareCompaction(input: {
      conversationId: string;
      agentId?: string;
      signal?: AbortSignal;
    }): Promise<CompactionPreview> {
      const agentId =
        input.agentId ??
        (
          backend as unknown as {
            store: { resolveAgentIdForConversation(id: string): string };
          }
        ).store.resolveAgentIdForConversation(input.conversationId);
      const ids = inContextIds(backend, input.conversationId, agentId);
      const first = ids[0] ?? "";
      const splitIndex = Math.max(1, Math.floor(ids.length / 2));
      const split = ids[splitIndex] ?? first;
      const blocks = options.unmarked
        ? [
            {
              index: 1,
              title: null,
              markerId: null,
              createdBy: null,
              summary: undefined,
              anchorMessageId: null,
              absorbedTitles: [],
              boundaryMessageId: first,
              startIndex: 0,
              endIndex: ids.length,
              rewindTurns: 0,
              startMarkerAnchorMessageId: null,
              messageCount: ids.length,
              tokens: 900,
              startsAt: "2026-01-01T00:00:00.000Z",
              sparse: false,
            },
          ]
        : [
            {
              index: 1,
              title: "Alpha",
              markerId: null,
              createdBy: "summarizer" as const,
              summary: "alpha section",
              anchorMessageId: split,
              absorbedTitles: [],
              boundaryMessageId: first,
              startIndex: 0,
              endIndex: splitIndex,
              rewindTurns: 0,
              startMarkerAnchorMessageId: null,
              messageCount: splitIndex,
              tokens: 400,
              startsAt: "2026-01-01T00:00:00.000Z",
              sparse: false,
            },
            {
              index: 2,
              title: "Beta",
              markerId: null,
              createdBy: "summarizer" as const,
              summary: "beta section",
              anchorMessageId: null,
              absorbedTitles: [],
              boundaryMessageId: split,
              startIndex: splitIndex,
              endIndex: ids.length,
              rewindTurns: 0,
              startMarkerAnchorMessageId: null,
              messageCount: ids.length - splitIndex,
              tokens: 500,
              startsAt: "2026-01-01T00:00:00.000Z",
              sparse: false,
            },
          ];
      return {
        conversationId: input.conversationId,
        agentId,
        model: "openai/gpt-5.5",
        createdAt: "2026-01-01T00:00:00.000Z",
        topics: options.unmarked
          ? []
          : [
              {
                title: "Alpha",
                startMessageId: first,
                section: "alpha section",
              },
              { title: "Beta", startMessageId: split, section: "beta section" },
            ],
        overview: {
          restricted: {
            open: "",
            errors: "",
            relationship: "",
            memoryIndex: "",
          },
          narrative: options.unmarked ? "" : "They talked through Alpha.",
        },
        blocks,
        numberedBlocks: blocks.length,
        suggestionIndex: blocks.length,
        usage: {
          promptTokens: 900,
          cachedInputTokens: 400,
          completionTokens: 120,
          wallMs: 2000,
        },
        degraded: options.unmarked ? "whole-section" : null,
      };
    }
  })({
    storageDir,
    executor: okExecutor,
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

/** The `execute_command_response` frame, parsed. */
function responsePayload(
  fixture: Awaited<ReturnType<typeof localFixture>>,
): Record<string, unknown> {
  const raw = [...fixture.socket.sentPayloads]
    .reverse()
    .find((payload) => payload.includes('"execute_command_response"'));
  if (!raw) throw new Error("no execute_command_response was sent");
  return JSON.parse(raw) as Record<string, unknown>;
}

describe("listener compact command", () => {
  test("a numbered block trims and re-arms the one-shot context reminders", async () => {
    const fixture = await localFixture(8);
    fixture.runtime.reminderState.hasSentAgentInfo = true;
    fixture.runtime.reminderState.hasSentSessionContext = true;
    fixture.runtime.reminderState.hasSentSecretsInfo = true;

    const output = await runCompact(fixture, "2");

    expect(output).toContain("Compaction complete.");
    expect(output).toContain("(Alpha)");
    expect(fixture.runtime.reminderState.hasSentAgentInfo).toBe(false);
    expect(fixture.runtime.reminderState.hasSentSessionContext).toBe(false);
    expect(fixture.runtime.reminderState.pendingSessionContextReason).toBe(
      "post_compaction",
    );
    expect(fixture.runtime.reminderState.hasSentSecretsInfo).toBe(false);
  });

  test("the response carries the overview and the cut-point table", async () => {
    const fixture = await localFixture(8);

    await runCompact(fixture, "2");

    const response = responsePayload(fixture);
    expect(response.success).toBe(true);
    const report = response.topic_report as {
      overview: string;
      blocks: { index: number; title: string | null }[];
      suggestion_index: number;
      degraded: boolean;
      applied: { executed: boolean; folded_topics: string[] };
    };
    expect(report.overview).toContain("They talked through Alpha.");
    expect(report.blocks.map((block) => block.index)).toEqual([1, 2]);
    expect(report.blocks[1]?.title).toBe("Beta");
    expect(report.suggestion_index).toBe(2);
    expect(report.degraded).toBe(false);
    expect(report.applied.executed).toBe(true);
    expect(report.applied.folded_topics).toEqual(["Alpha"]);
  });

  test("a bare /compact compresses by the rate instead of refusing (H-2)", async () => {
    const fixture = await localFixture(8);

    const output = await runCompact(fixture);

    expect(output).toContain("Compaction complete.");
    expect(output).toContain("no marker defines a boundary here");
    expect(output).not.toContain("needs a terminal");
    expect(responsePayload(fixture).topic_report).toBeDefined();
  });

  test("an unmarked conversation trims by the ratio without a picker (D-119)", async () => {
    const fixture = await localFixture(8, { unmarked: true });

    const output = await runCompact(fixture);

    expect(output).toContain("Compaction complete.");
    expect(output).toContain("no marker defines a boundary here");
    expect(output).toContain("this run produced no topics");
    const report = responsePayload(fixture).topic_report as {
      degraded: boolean;
      blocks: unknown[];
    };
    expect(report.degraded).toBe(true);
    expect(report.blocks).toHaveLength(1);
  });

  test("help is the shared usage", async () => {
    const fixture = await localFixture(2);

    const output = await runCompact(fixture, "help");

    expect(output).toContain("/compact <n>");
    expect(output).not.toContain("self_compact");
    // Nothing ran, so the response has no report to carry.
    expect(responsePayload(fixture).topic_report).toBeUndefined();
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

  test("invalid arguments carry the usage here too (L-2)", async () => {
    const fixture = await localFixture(2);

    const output = await runCompact(fixture, "nope");

    // The payload is JSON, so quotes arrive escaped; assert on the usage block
    // that `/compact nope` never used to include.
    expect(output).toContain("Unknown argument");
    expect(output).toContain("/compact [n]");
    expect(output).toContain("USAGE");
  });

  test("a cut the write-back refuses does not trigger reflection", async () => {
    // The route this replaces: a compaction that could not reduce the context
    // must not queue reflection work. The retired one-step
    // `compactConversationMessages` is a throwing stub — reaching it at all
    // would fail the test, which is the point.
    const storageDir = await createStorageDirectory();
    process.env.HARUYUKI_HOME = storageDir;
    const backend = new (class extends LocalBackend {
      override async compactConversationMessages(): Promise<never> {
        throw new Error("the retired one-step compaction must not be reached");
      }

      override async prepareCompaction(): Promise<CompactionPreview> {
        return {
          conversationId: "default",
          agentId: "agent",
          model: "openai/gpt-5.5",
          createdAt: "2026-01-01T00:00:00.000Z",
          topics: [],
          overview: {
            restricted: {
              open: "",
              errors: "",
              relationship: "",
              memoryIndex: "",
            },
            narrative: "",
          },
          blocks: [],
          numberedBlocks: 0,
          suggestionIndex: 1,
          usage: {
            promptTokens: 0,
            cachedInputTokens: 0,
            completionTokens: 0,
            wallMs: 0,
          },
          degraded: "whole-section",
        };
      }

      override async applyCompaction(): Promise<CompactionApplyResult> {
        return {
          executed: false,
          source: "ratio_suggestion",
          noopReason: "empty_context",
          topicTitle: null,
          foldedTopicIds: [],
          foldedTitles: [],
          numMessagesBefore: 0,
          numMessagesAfter: 0,
          summarizedMessageCount: 0,
          summarizedTokens: 0,
          retainedTokens: 0,
          retentionCapTokens: null,
          stats: {},
        };
      }
    })({
      storageDir,
      executor: okExecutor,
      memfsEnabled: false,
    });
    __testSetBackend(backend);
    const agent = await backend.createAgent({
      name: "Noop Compact Agent",
      model: "openai/gpt-5.5",
      model_settings: {
        provider_type: "openai",
        context_window_limit: 2_000,
      },
    } as AgentCreateBody);
    const listener = __listenClientTestUtils.createListenerRuntime();
    const runtime = __listenClientTestUtils.getOrCreateConversationRuntime(
      listener,
      agent.id,
      "default",
    );
    const socket = new CompactTestSocket();

    await handleExecuteCommand(
      {
        type: "execute_command",
        command_id: "compact",
        request_id: "compact-noop-run-1",
        runtime: { agent_id: agent.id, conversation_id: "default" },
      },
      socket as unknown as WebSocket,
      runtime,
      {},
    );

    expect(runtime.contextTracker.pendingReflectionTrigger).toBe(false);
    expect(socket.sentPayloads.join("\n")).toContain("Nothing was written");
  });
});
