/**
 * Backend-level coverage for listTopics (D-104).
 *
 * The list is read-only: it reports the blocks of the current context, the
 * markers behind them, and the retention target the compression rate implies.
 * The claims under test are that blocks are cut at the effective boundaries,
 * that the rewind is a setting the backend resolves once for every channel, and
 * that the compaction settings write path keeps the halves it was not asked to
 * change.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type { ConversationMessageCreateBody } from "@/backend";
import type {
  HeadlessTurnExecutor,
  HeadlessTurnExecutorInput,
} from "@/backend/dev/headless-turn-executor";
import { LocalBackend } from "@/backend/local/local-backend";
import { settingsManager } from "@/settings-manager";

const temporaryDirectories: string[] = [];

async function createStorageDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "local-topic-trim-backend-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** One assistant message per user turn, so each turn is two context messages. */
function oneTurnExecutor(): HeadlessTurnExecutor {
  return {
    async execute(_input: HeadlessTurnExecutorInput) {
      const chunks: LettaStreamingResponse[] = [
        {
          message_type: "assistant_message",
          content: [{ type: "text", text: "ok" }],
        } as LettaStreamingResponse,
        {
          message_type: "stop_reason",
          stop_reason: "end_turn",
        } as LettaStreamingResponse,
      ];
      return {
        controller: new AbortController(),
        async *[Symbol.asyncIterator]() {
          for (const chunk of chunks) yield chunk;
        },
      } as never;
    },
  };
}

/**
 * ~100 tokens of user content per turn. The retention target is a share of that
 * transcript, so the window no longer decides how much a cut keeps.
 */
function turnContent(label: string): string {
  return `${label} ${"x".repeat(400)}`;
}

interface Fixture {
  backend: LocalBackend;
  conversationId: string;
  agentId: string;
  sendTurn: (content: string) => Promise<void>;
}

async function fixture(input: { storageDir: string }): Promise<Fixture> {
  const backend = new LocalBackend({
    storageDir: input.storageDir,
    executor: oneTurnExecutor(),
    memfsEnabled: false,
  });
  const agent = await backend.createAgent({
    name: "Topics",
    model: "openai/gpt-5.5",
    model_settings: {
      provider_type: "openai",
      context_window_limit: 2_000,
    },
  } as never);
  const conversation = await backend.createConversation({
    agent_id: agent.id,
  } as never);
  return {
    backend,
    conversationId: conversation.id,
    agentId: agent.id,
    async sendTurn(content: string) {
      const stream = await backend.createConversationMessageStream(
        conversation.id,
        {
          agent_id: agent.id,
          messages: [{ role: "user", content: turnContent(content) }],
        } as ConversationMessageCreateBody,
      );
      for await (const _chunk of stream) {
        // drain
      }
    },
  };
}

describe("LocalBackend.listTopics", () => {
  test("reports blocks cut at effective boundaries and no markers when unmarked", async () => {
    const storageDir = await createStorageDirectory();
    const f = await fixture({ storageDir });
    for (const turn of ["one", "two", "three", "four"]) await f.sendTurn(turn);

    const unmarked = f.backend.listTopics(f.conversationId, f.agentId);
    expect(unmarked.markers).toEqual([]);
    expect(unmarked.blocks).toHaveLength(1);
    expect(unmarked.blocks[0]?.title).toBeNull();
    expect(unmarked.blocks[0]?.messageCount).toBe(unmarked.contextMessageCount);
    // The target is (1 - rate) of the transcript being compressed (default 0.3),
    // not a share of the model's window.
    expect(unmarked.retentionCapTokens).toBe(
      Math.floor(unmarked.contextTokens * 0.7),
    );

    // A marker at the end of turn 4 rewinds two turns, so the block ends on
    // turn 3's start and the trailing "current topic" block keeps turn 3 on.
    f.backend.markTopic({
      conversationId: f.conversationId,
      agentId: f.agentId,
      title: "Alpha",
      createdBy: "agent",
    });

    const marked = f.backend.listTopics(f.conversationId, f.agentId);
    expect(marked.blocks).toHaveLength(2);
    expect(marked.blocks[0]?.title).toBe("Alpha");
    expect(marked.blocks[0]?.rewindTurns).toBe(0);
    expect(marked.blocks[1]?.title).toBeNull();
    expect(marked.blocks[1]?.rewindTurns).toBe(2);
    expect(marked.markers).toEqual([
      {
        marker: expect.objectContaining({ title: "Alpha" }),
        anchorInContext: true,
      },
    ]);
  });
});

/**
 * D-115: the rewind is a setting, and the backend is where its default is
 * resolved — otherwise every channel would have to pass the same number.
 */
describe("the boundary rewind follows topicBoundaryRewindTurns (D-115)", () => {
  const originalHome = process.env.HOME;
  let testHomeDir: string;

  beforeEach(async () => {
    await settingsManager.reset();
    testHomeDir = await mkdtemp(join(tmpdir(), "topic-rewind-settings-"));
    process.env.HOME = testHomeDir;
    await settingsManager.initialize();
  });

  afterEach(async () => {
    await settingsManager.reset();
    await rm(testHomeDir, { recursive: true, force: true });
    process.env.HOME = originalHome;
  });

  /** Six turns with a marker at the end of the sixth, so a rewind can move. */
  async function markedConversation(): Promise<Fixture> {
    const f = await fixture({ storageDir: await createStorageDirectory() });
    for (const turn of ["one", "two", "three", "four", "five", "six"]) {
      await f.sendTurn(turn);
    }
    f.backend.markTopic({
      conversationId: f.conversationId,
      agentId: f.agentId,
      title: "Alpha",
      createdBy: "agent",
    });
    return f;
  }

  test("the effective boundary moves with the configured rewind", async () => {
    const f = await markedConversation();

    const byDefault = f.backend.listTopics(f.conversationId, f.agentId);
    expect(byDefault.blocks[1]?.rewindTurns).toBe(2);

    settingsManager.updateSettings({ topicBoundaryRewindTurns: 0 });
    const noRewind = f.backend.listTopics(f.conversationId, f.agentId);
    expect(noRewind.blocks[1]?.rewindTurns).toBe(0);
    expect(noRewind.blocks[1]?.startIndex ?? -1).toBeGreaterThan(
      byDefault.blocks[1]?.startIndex ?? -1,
    );
    expect(noRewind.blocks[1]?.messageCount ?? 0).toBeLessThan(
      byDefault.blocks[1]?.messageCount ?? 0,
    );

    settingsManager.updateSettings({ topicBoundaryRewindTurns: 3 });
    const rewound = f.backend.listTopics(f.conversationId, f.agentId);
    expect(rewound.blocks[1]?.rewindTurns).toBe(3);
    expect(rewound.blocks[1]?.startIndex ?? -1).toBeLessThan(
      byDefault.blocks[1]?.startIndex ?? -1,
    );
  });
});

/**
 * The `/compaction` overlay writes through `updateAgent` with only the fields the
 * user changed. Both halves of the setting therefore have to survive a patch that
 * omits them — the picker's "pick a mode" and "edit the rate" paths rely on it.
 */
describe("the compaction settings write path", () => {
  async function agentWithSettings(compactionSettings: {
    mode: string;
    sliding_window_percentage?: number;
  }): Promise<{ backend: LocalBackend; agentId: string }> {
    const backend = new LocalBackend({
      storageDir: await createStorageDirectory(),
      executor: oneTurnExecutor(),
      memfsEnabled: false,
    });
    const agent = await backend.createAgent({
      name: "Rate",
      model: "openai/gpt-5.5",
      compaction_settings: compactionSettings,
    } as never);
    return { backend, agentId: agent.id };
  }

  test("a rate-only patch keeps the mode and every other stored field", async () => {
    const { backend, agentId } = await agentWithSettings({
      mode: "sliding_window",
      sliding_window_percentage: 0.3,
    });
    // A stored summarizer model and prompt are the fields a wholesale write
    // would drop. They go in at create time because a patch that touches neither
    // `mode` nor a local-setting key is not a compaction write at all.
    await backend.updateAgent(agentId, {
      compaction_settings: { prompt: "custom summary prompt" },
    } as never);
    await backend.updateAgent(agentId, {
      compaction_settings: {
        model: "custom/summarizer",
        mode: "sliding_window",
      },
    } as never);

    await backend.updateAgent(agentId, {
      compaction_settings: { sliding_window_percentage: 0.42 },
    } as never);

    const reloaded = await backend.retrieveAgent(agentId);
    expect(reloaded.compaction_settings).toMatchObject({
      mode: "sliding_window",
      model: "custom/summarizer",
      prompt: "custom summary prompt",
      sliding_window_percentage: 0.42,
    });
  });

  test("a mode-only patch keeps the stored rate", async () => {
    const { backend, agentId } = await agentWithSettings({
      mode: "sliding_window",
      sliding_window_percentage: 0.42,
    });

    await backend.updateAgent(agentId, {
      compaction_settings: { mode: "sliding_window" },
    } as never);

    const reloaded = await backend.retrieveAgent(agentId);
    expect(reloaded.compaction_settings).toMatchObject({
      mode: "sliding_window",
      sliding_window_percentage: 0.42,
    });
  });
});
