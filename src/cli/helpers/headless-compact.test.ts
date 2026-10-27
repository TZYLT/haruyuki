/**
 * F-04's `/compact` for the paths without a picker (M5).
 *
 * Three things are pinned here, in the order the milestone asks for them:
 *
 * 1. the input path recognises `/compact` and nothing else (§8-6: headless has
 *    no slash registry, so the string itself is the entry point);
 * 2. `prepare → pick → apply` is one shared run, and the 1-based block number is
 *    resolved to the block's boundary message id before `apply` sees it;
 * 3. the ledger records all three outcomes — completed, failed, cancelled — with
 *    the preview's model and numbers, into a temporary file (never the real
 *    `~/.haruyuki`: 《31》red line A).
 *
 * Plus the self-rescue smoke: a conversation that could not send another turn
 * compacts through this path and keeps going.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type { ConversationMessageCreateBody } from "@/backend";
import type { HeadlessTurnExecutor } from "@/backend/dev/headless-turn-executor";
import type {
  CompactionPreview,
  CompactPick,
} from "@/backend/local/compaction-preview";
import type { CompactionApplyResult } from "@/backend/local/compaction-run";
import { CompactionCancelledError } from "@/backend/local/compaction-summarizer";
import { LocalBackend } from "@/backend/local/local-backend";
import type { LocalTopicList } from "@/backend/local/local-topic-trim";
import {
  buildCompactionTopicReport,
  buildHeadlessCompactResultEnvelope,
  HEADLESS_SLASH_COMMANDS,
  handleHeadlessCompactCommand,
  parseHeadlessCompactInput,
  resolveCompactionPick,
  runLocalCompaction,
} from "@/cli/helpers/headless-compact";
import { readUsageLedger } from "@/usage/ledger";

const temporaryDirectories: string[] = [];

async function createStorageDirectory(
  prefix = "headless-compact-",
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
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

function lettaStreamFromChunks(
  chunks: LettaStreamingResponse[],
): Awaited<ReturnType<HeadlessTurnExecutor["execute"]>> {
  return {
    controller: new AbortController(),
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  } as never;
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

function previewFixture(
  overrides: Partial<CompactionPreview> = {},
): CompactionPreview {
  return {
    conversationId: "conv-1",
    agentId: "agent-1",
    model: "openai/gpt-5.5",
    createdAt: "2026-01-01T00:00:00.000Z",
    topics: [{ title: "one", startMessageId: "m1", section: "section one" }],
    overview: {
      restricted: { open: "", errors: "", relationship: "", memoryIndex: "" },
      narrative: "They talked it through.",
    },
    blocks: [
      {
        index: 1,
        title: "one",
        markerId: null,
        createdBy: "summarizer",
        summary: "section one",
        anchorMessageId: null,
        absorbedTitles: [],
        boundaryMessageId: "m1",
        startIndex: 0,
        endIndex: 2,
        rewindTurns: 0,
        startMarkerAnchorMessageId: null,
        messageCount: 2,
        tokens: 40,
        startsAt: "2026-01-01T00:00:00.000Z",
        sparse: false,
      },
      {
        index: 2,
        title: "two",
        markerId: null,
        createdBy: "summarizer",
        summary: "section two",
        anchorMessageId: null,
        absorbedTitles: [],
        boundaryMessageId: "m2",
        startIndex: 2,
        endIndex: 3,
        rewindTurns: 0,
        startMarkerAnchorMessageId: null,
        messageCount: 1,
        tokens: 20,
        startsAt: "2026-01-01T00:00:00.000Z",
        sparse: true,
      },
    ],
    numberedBlocks: 1,
    suggestionIndex: 2,
    usage: {
      promptTokens: 120,
      cachedInputTokens: 80,
      completionTokens: 30,
      wallMs: 1500,
    },
    degraded: null,
    ...overrides,
  };
}

function applyResultFixture(
  overrides: Partial<CompactionApplyResult> = {},
): CompactionApplyResult {
  return {
    executed: true,
    source: "topic_pick",
    topicTitle: "two",
    foldedTopicIds: ["marker-1"],
    foldedTitles: ["one"],
    numMessagesBefore: 6,
    numMessagesAfter: 3,
    summarizedMessageCount: 3,
    summarizedTokens: 600,
    retainedTokens: 200,
    retentionCapTokens: 400,
    stats: {},
    ...overrides,
  };
}

/** A backend whose `prepare`/`apply` are scripted, so the ledger states can be
 * driven without a provider. */
class ScriptedCompactionBackend extends LocalBackend {
  mode: "completed" | "failed" | "cancelled" = "completed";
  seenPick: CompactPick | null = null;

  /**
   * The numbering table `/compact <n>` resolves against (§5.6.3): the
   * pre-summarizer blocks. Scripted here rather than walked from a transcript,
   * because this suite drives the ledger and the pick, not the store.
   */
  override listTopics(): LocalTopicList {
    const blocks = previewFixture().blocks;
    return {
      blocks,
      markers: [],
      contextMessageCount: 6,
      contextTokens: 600,
      retentionCapTokens: 400,
      suggestedBlockIndex: 1,
    };
  }

  override async prepareCompaction(): Promise<CompactionPreview> {
    if (this.mode === "cancelled") throw new CompactionCancelledError();
    if (this.mode === "failed") throw new Error("provider refused");
    return previewFixture();
  }

  override async applyCompaction(input: {
    preview: CompactionPreview;
    pick: CompactPick;
  }): Promise<CompactionApplyResult> {
    this.seenPick = input.pick;
    return applyResultFixture();
  }
}

async function scriptedBackend(): Promise<ScriptedCompactionBackend> {
  return new ScriptedCompactionBackend({
    storageDir: await createStorageDirectory("headless-compact-scripted-"),
    executor: okExecutor,
    memfsEnabled: false,
  });
}

async function ledgerRows(path: string) {
  return readUsageLedger({ path, prune: false });
}

describe("parseHeadlessCompactInput", () => {
  test("recognises the command, its block number, and its help", () => {
    expect(parseHeadlessCompactInput("/compact")).toEqual({ kind: "compact" });
    expect(parseHeadlessCompactInput("  /compact 2 ")).toEqual({
      kind: "compact",
      blockIndex: 2,
    });
    expect(parseHeadlessCompactInput("/compact help")).toEqual({
      kind: "help",
    });
  });

  test("leaves ordinary prompt text alone", () => {
    expect(parseHeadlessCompactInput("please /compact this")).toBeNull();
    expect(parseHeadlessCompactInput("/compactable")).toBeNull();
    expect(parseHeadlessCompactInput("/clear")).toBeNull();
    expect(parseHeadlessCompactInput("")).toBeNull();
  });

  test("rejects the arguments this mode cannot honour", () => {
    expect(parseHeadlessCompactInput("/compact 0")).toEqual({
      kind: "invalid",
      message: "Block numbers start at 1.",
    });
    expect(parseHeadlessCompactInput("/compact nope")).toMatchObject({
      kind: "invalid",
    });
    const mode = parseHeadlessCompactInput("/compact sliding_window");
    expect(mode).toMatchObject({ kind: "invalid" });
    expect(mode?.kind === "invalid" ? mode.message : "").toContain(
      "sliding_window",
    );
  });

  test("reports /compact as the one command headless answers", () => {
    expect(HEADLESS_SLASH_COMMANDS).toEqual(["compact"]);
  });
});

describe("resolveCompactionPick", () => {
  test("no number means the rate's default selection", () => {
    expect(resolveCompactionPick(previewFixture().blocks, undefined)).toEqual({
      kind: "ratio_suggestion",
    });
  });

  test("a block number becomes that block's boundary message id", () => {
    // 1-based: block 2 is the second row, never `blocks[2]`.
    expect(resolveCompactionPick(previewFixture().blocks, 2)).toEqual({
      kind: "message",
      messageId: "m2",
    });
  });

  test("an out-of-range number is refused by name, with the table size", () => {
    expect(() => resolveCompactionPick(previewFixture().blocks, 9)).toThrow(
      "There is no topic block 9: this context has 2 blocks",
    );
    expect(() => resolveCompactionPick(previewFixture().blocks, 9)).toThrow(
      "compress by the rate",
    );
  });
});

describe("runLocalCompaction ledger", () => {
  test("records a completed run with the preview's model and numbers", async () => {
    const backend = await scriptedBackend();
    const ledgerPath = join(await createStorageDirectory(), "usage.jsonl");

    const outcome = await runLocalCompaction({
      backend,
      conversationId: "conv-1",
      agentId: "agent-1",
      ledgerPath,
    });

    expect(outcome.kind).toBe("completed");
    const rows = await ledgerRows(ledgerPath);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe("compaction");
    expect(rows[0]?.outcome).toBe("completed");
    expect(rows[0]?.model).toBe("openai/gpt-5.5");
    expect(rows[0]?.sessionId).toBe("conv-1");
    expect(rows[0]?.prompt).toBe(120);
    expect(rows[0]?.cachedInput).toBe(80);
    expect(rows[0]?.completion).toBe(30);
  });

  test("records a failed run without inventing a model", async () => {
    const backend = await scriptedBackend();
    backend.mode = "failed";
    const ledgerPath = join(await createStorageDirectory(), "usage.jsonl");

    await expect(
      runLocalCompaction({
        backend,
        conversationId: "conv-1",
        agentId: "agent-1",
        ledgerPath,
      }),
    ).rejects.toThrow("provider refused");

    const rows = await ledgerRows(ledgerPath);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe("failed");
    // A call that never answered has no model to name; guessing one would be
    // aggregated as if the summarizer had run on it.
    expect(rows[0]?.model).toBe("");
    expect(rows[0]?.prompt).toBe(0);
  });

  test("records a cancelled run and writes nothing else", async () => {
    const backend = await scriptedBackend();
    backend.mode = "cancelled";
    const ledgerPath = join(await createStorageDirectory(), "usage.jsonl");

    const outcome = await runLocalCompaction({
      backend,
      conversationId: "conv-1",
      agentId: "agent-1",
      ledgerPath,
    });

    expect(outcome).toEqual({
      kind: "cancelled",
      receipt: "Cancelled: the context is unchanged.",
    });
    const rows = await ledgerRows(ledgerPath);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe("cancelled");
  });

  test("a numbered run hands apply the message id, never the row number", async () => {
    const backend = await scriptedBackend();

    const outcome = await runLocalCompaction({
      backend,
      conversationId: "conv-1",
      agentId: "agent-1",
      blockIndex: 2,
      ledgerPath: join(await createStorageDirectory(), "usage.jsonl"),
    });

    expect(outcome.kind).toBe("completed");
    expect(backend.seenPick).toEqual({ kind: "message", messageId: "m2" });
  });

  test("a failure with no agent to name writes no row, and no conversation", async () => {
    const backend = await scriptedBackend();
    backend.mode = "failed";
    const ledgerPath = join(await createStorageDirectory(), "usage.jsonl");

    await expect(
      runLocalCompaction({
        backend,
        conversationId: "conversation-that-does-not-exist",
        ledgerPath,
      }),
    ).rejects.toThrow("provider refused");

    // Bookkeeping must not reach for `retrieveConversation`: on the local backend
    // that *creates* an unknown conversation, which would turn a zero-write
    // failure into a write (§5.9.1).
    expect(await ledgerRows(ledgerPath)).toHaveLength(0);
    const conversations = (await backend.listConversations()) as unknown as {
      getPaginatedItems?: () => { id: string }[];
      items?: { id: string }[];
    };
    const ids = (
      conversations.getPaginatedItems?.() ??
      conversations.items ??
      []
    ).map((conversation) => conversation.id);
    expect(ids).not.toContain("conversation-that-does-not-exist");
  });
});

describe("buildCompactionTopicReport", () => {
  test("carries the overview, the table, and what the write-back did", () => {
    const report = buildCompactionTopicReport(
      previewFixture(),
      applyResultFixture(),
    );

    expect(report.overview).toContain("They talked it through.");
    expect(report.blocks.map((block) => block.boundary_message_id)).toEqual([
      "m1",
      "m2",
    ]);
    expect(report.blocks[0]?.summary).toBe("section one");
    expect(report.suggestion_index).toBe(2);
    expect(report.numbered_blocks).toBe(1);
    expect(report.degraded).toBe(false);
    expect(report.usage).toEqual({
      prompt_tokens: 120,
      cached_input_tokens: 80,
      completion_tokens: 30,
      wall_ms: 1500,
    });
    expect(report.applied).toEqual({
      executed: true,
      kept_topic: "two",
      folded_topics: ["one"],
      messages_before: 6,
      messages_after: 3,
    });
  });
});

/**
 * The self-rescue smoke: a conversation past the window compacts through the
 * headless entry point and the next turn still works. `prepare` is scripted
 * (a provider call is not this test's subject) but `apply` is the real one, so
 * the write-back, the frozen-prefix refresh, and the post-compaction transcript
 * are all exercised.
 */
async function selfRescueFixture(turns: number) {
  const storageDir = await createStorageDirectory("headless-compact-rescue-");
  const backend = new (class extends LocalBackend {
    override async prepareCompaction(input: {
      conversationId: string;
      agentId?: string;
    }): Promise<CompactionPreview> {
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
      const agentId =
        input.agentId ??
        (
          backend as unknown as {
            store: { resolveAgentIdForConversation(id: string): string };
          }
        ).store.resolveAgentIdForConversation(input.conversationId);
      const current = store.listLocalMessages(input.conversationId, agentId);
      const split = current[2]?.id ?? current[0]?.id ?? "";
      return previewFixture({
        conversationId: input.conversationId,
        agentId,
        topics: [
          {
            title: "one",
            startMessageId: current[0]?.id ?? "",
            section: "section one",
          },
          { title: "two", startMessageId: split, section: "section two" },
        ],
        blocks: [
          {
            index: 1,
            title: "one",
            markerId: null,
            createdBy: "summarizer",
            summary: "section one",
            anchorMessageId: split,
            absorbedTitles: [],
            boundaryMessageId: current[0]?.id ?? "",
            startIndex: 0,
            endIndex: 2,
            rewindTurns: 0,
            startMarkerAnchorMessageId: null,
            messageCount: 2,
            tokens: 40,
            startsAt: "2026-01-01T00:00:00.000Z",
            sparse: false,
          },
          {
            index: 2,
            title: "two",
            markerId: null,
            createdBy: "summarizer",
            summary: "section two",
            anchorMessageId: null,
            absorbedTitles: [],
            boundaryMessageId: split,
            startIndex: 2,
            endIndex: current.length,
            rewindTurns: 0,
            startMarkerAnchorMessageId: null,
            messageCount: current.length - 2,
            tokens: 60,
            startsAt: "2026-01-01T00:00:00.000Z",
            sparse: false,
          },
        ],
        suggestionIndex: 2,
        numberedBlocks: 2,
      });
    }
  })({
    storageDir,
    executor: okExecutor,
    memfsEnabled: false,
  });

  const agent = await backend.createAgent({
    name: "Headless Compact",
    model: "openai/gpt-5.5",
    model_settings: {
      provider_type: "openai",
      context_window_limit: 2_000,
    },
  } as never);
  const conversation = await backend.createConversation({
    agent_id: agent.id,
  } as never);
  const sendTurn = async (content: string): Promise<void> => {
    const stream = await backend.createConversationMessageStream(
      conversation.id,
      {
        agent_id: agent.id,
        messages: [{ role: "user", content: `${content} ${"x".repeat(400)}` }],
      } as ConversationMessageCreateBody,
    );
    for await (const _chunk of stream) {
      // drain
    }
  };
  for (let index = 1; index <= turns; index += 1) {
    await sendTurn(`turn ${index}`);
  }
  const inContextCount = (): number => {
    const store = (
      backend as unknown as {
        store: {
          listLocalMessages(conversationId: string, agentId: string): unknown[];
        };
      }
    ).store;
    return store.listLocalMessages(conversation.id, agent.id).length;
  };
  return {
    backend,
    agentId: agent.id,
    conversationId: conversation.id,
    inContextCount,
    sendTurn,
  };
}

describe("headless /compact self-rescue", () => {
  test("compacts through the input path, then the next turn still runs", async () => {
    const fixture = await selfRescueFixture(6);
    const before = fixture.inContextCount();
    const ledgerPath = join(await createStorageDirectory(), "usage.jsonl");

    const result = await handleHeadlessCompactCommand({
      backend: fixture.backend,
      conversationId: fixture.conversationId,
      agentId: fixture.agentId,
      request: { kind: "compact" },
      ledgerPath,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("Compaction complete.");
    expect(result.topic_report?.applied.executed).toBe(true);
    expect(fixture.inContextCount()).toBeLessThan(before);

    // The point of the entry point: the conversation is usable afterwards.
    await fixture.sendTurn("after compaction");
    expect(fixture.inContextCount()).toBeGreaterThan(0);

    const rows = await ledgerRows(ledgerPath);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe("compaction");
    expect(rows[0]?.outcome).toBe("completed");
  });

  test("help never touches the model or the context", async () => {
    const fixture = await selfRescueFixture(2);
    const before = fixture.inContextCount();

    const result = await handleHeadlessCompactCommand({
      backend: fixture.backend,
      conversationId: fixture.conversationId,
      agentId: fixture.agentId,
      request: { kind: "help" },
      ledgerPath: join(await createStorageDirectory(), "usage.jsonl"),
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("/compact <n>");
    expect(fixture.inContextCount()).toBe(before);
  });

  test("the result envelope is a headless result event with no turn usage", async () => {
    const fixture = await selfRescueFixture(2);
    const result = await handleHeadlessCompactCommand({
      backend: fixture.backend,
      conversationId: fixture.conversationId,
      agentId: fixture.agentId,
      request: { kind: "compact" },
      ledgerPath: join(await createStorageDirectory(), "usage.jsonl"),
    });

    const envelope = buildHeadlessCompactResultEnvelope({
      result,
      sessionId: "session-1",
      agentId: fixture.agentId,
      conversationId: fixture.conversationId,
    });

    expect(envelope.type).toBe("result");
    expect(envelope.subtype).toBe("success");
    expect(envelope.is_error).toBe(false);
    expect(envelope.result).toBe(result.output);
    expect(envelope.num_turns).toBe(0);
    expect(envelope.usage?.completion_tokens).toBe(0);
  });
});
