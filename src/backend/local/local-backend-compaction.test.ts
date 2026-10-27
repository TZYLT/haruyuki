/**
 * Backend-level coverage for F-04's write-back half (`applyCompaction`).
 *
 * The backend is where the ports meet the real store, so this is where the M2
 * exit criteria are proven end to end: a preview cuts the context exactly at the
 * picked message, the folded topic lands in the transcript as a `summarizer`
 * marker with its section, the write-back carries only the overview plus that
 * section, the compaction row records the folded topic ids, `listTopics`
 * projects the section back, and no model call happens anywhere.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type { ConversationMessageCreateBody } from "@/backend";
import type {
  HeadlessTurnExecutor,
  HeadlessTurnExecutorInput,
} from "@/backend/dev/headless-turn-executor";
import type {
  CompactionOverview,
  CompactionTopicDraft,
} from "@/backend/local/compaction-preview";
import { topicBlocksFromDrafts } from "@/backend/local/compaction-preview";
import { LocalBackend } from "@/backend/local/local-backend";
import type { LocalMessage } from "@/backend/local/local-message";
import { listTopicBlocks } from "@/backend/local/topic-compaction";
import { queryTopicIndex } from "@/backend/local/topic-index";

const temporaryDirectories: string[] = [];

async function createStorageDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "local-backend-compaction-"));
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

/** One scripted assistant reply per user turn, plus a call counter. */
function countingExecutor(counter: { count: number }): HeadlessTurnExecutor {
  return {
    async execute(_input: HeadlessTurnExecutorInput) {
      counter.count += 1;
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

function turnContent(label: string): string {
  return `${label} ${"x".repeat(400)}`;
}

interface Fixture {
  backend: LocalBackend;
  conversationId: string;
  agentId: string;
  calls: { count: number };
  sendTurn: (content: string) => Promise<void>;
}

async function fixture(storageDir: string, turns: number): Promise<Fixture> {
  const calls = { count: 0 };
  const backend = new LocalBackend({
    storageDir,
    executor: countingExecutor(calls),
    memfsEnabled: false,
  });
  const agent = await backend.createAgent({
    name: "Compaction",
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
        messages: [{ role: "user", content: turnContent(content) }],
      } as ConversationMessageCreateBody,
    );
    for await (const _chunk of stream) {
      // drain
    }
  };
  for (let index = 1; index <= turns; index += 1) {
    await sendTurn(`turn ${index}`);
  }
  return {
    backend,
    conversationId: conversation.id,
    agentId: agent.id,
    calls,
    sendTurn,
  };
}

function storedMessages(f: Fixture): LocalMessage[] {
  const store = (
    f.backend as unknown as {
      store: {
        listLocalMessages(
          conversationId: string,
          agentId: string,
        ): LocalMessage[];
      };
    }
  ).store;
  return store.listLocalMessages(f.conversationId, f.agentId);
}

function frozenReason(f: Fixture): unknown {
  const store = (
    f.backend as unknown as {
      store: {
        getCompiledSystemPrompt: (
          conversationId: string,
          agentId: string,
        ) => { frozenReason?: unknown } | undefined;
      };
    }
  ).store;
  return store.getCompiledSystemPrompt(f.conversationId, f.agentId)
    ?.frozenReason;
}

function transcriptPath(
  storageDir: string,
  conversationId: string,
  agentId: string,
): string {
  const key =
    conversationId === "default"
      ? `default:${agentId}`
      : `conversation:${conversationId}`;
  return join(
    storageDir,
    "conversations",
    Buffer.from(key).toString("base64url"),
    "messages.jsonl",
  );
}

function rowsWithType(raw: string, type: string): Record<string, unknown>[] {
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((row) => row.type === type);
}

function overview(): CompactionOverview {
  return {
    restricted: {
      open: "finish the migration",
      errors: "none",
      relationship: "steady",
      memoryIndex: "notes/plan.md",
    },
    narrative: "They talked through the migration.",
  };
}

/**
 * A preview that cuts the conversation in two topics: the first `split` turns
 * stay behind, everything from the split turn on is kept.
 */
function previewFor(
  f: Fixture,
  split: number,
  overrides: {
    topics?: CompactionTopicDraft[];
    degraded?: "refusal" | "format" | null;
    overview?: CompactionOverview;
  } = {},
) {
  const messages = storedMessages(f);
  const firstUser = messages[0]?.id ?? "";
  const splitUser = messages[(split - 1) * 2]?.id ?? "";
  const drafts = overrides.topics ?? [
    { title: "one", startMessageId: firstUser, section: "section: one" },
    { title: "two", startMessageId: splitUser, section: "section: two" },
  ];
  const blocks =
    drafts.length > 0 ? topicBlocksFromDrafts(messages, drafts) : [];
  return {
    conversationId: f.conversationId,
    agentId: f.agentId,
    model: "openai/gpt-5.5",
    createdAt: "2026-01-01T00:00:00.000Z",
    topics: drafts,
    overview: overrides.overview ?? overview(),
    blocks,
    numberedBlocks: listTopicBlocks(
      messages,
      f.backend.listTopicMarkers(f.conversationId, f.agentId),
    ).length,
    suggestionIndex: Math.max(1, blocks.length - 1),
    usage: {
      promptTokens: 100,
      cachedInputTokens: 0,
      completionTokens: 20,
      wallMs: 1000,
    },
    degraded: overrides.degraded ?? null,
    // The pick targets a message id, exactly like the picker's rows do.
    pickMessageId: splitUser,
  };
}

/**
 * A preview over the *current* context (which may already start with a summary)
 * with explicit topic drafts and pick message, for chained compactions.
 */
function previewWithTopics(
  f: Fixture,
  drafts: CompactionTopicDraft[],
  pickMessageId: string,
) {
  const messages = storedMessages(f);
  const blocks = topicBlocksFromDrafts(messages, drafts);
  return {
    conversationId: f.conversationId,
    agentId: f.agentId,
    model: "openai/gpt-5.5",
    createdAt: "2026-01-01T00:00:00.000Z",
    topics: drafts,
    overview: overview(),
    blocks,
    numberedBlocks: listTopicBlocks(
      messages,
      f.backend.listTopicMarkers(f.conversationId, f.agentId),
    ).length,
    suggestionIndex: Math.max(1, blocks.length - 1),
    usage: {
      promptTokens: 100,
      cachedInputTokens: 0,
      completionTokens: 20,
      wallMs: 1000,
    },
    degraded: null as null,
    pickMessageId,
  };
}

describe("LocalBackend.applyCompaction", () => {
  test("folds a picked topic: marker + section, overview-only write-back, no model call", async () => {
    const storageDir = await createStorageDirectory();
    const f = await fixture(storageDir, 6);
    const preview = previewFor(f, 4);
    const before = storedMessages(f);
    const callsBefore = f.calls.count;

    const result = await f.backend.applyCompaction({
      preview,
      pick: { kind: "message", messageId: preview.pickMessageId },
    });

    expect(result.executed).toBe(true);
    expect(result.foldedTitles).toEqual(["one"]);
    expect(result.foldedTopicIds).toHaveLength(1);
    expect(result.firstKeptMessageId).toBe(preview.pickMessageId);
    expect(result.numMessagesBefore).toBe(12);
    expect(result.numMessagesAfter).toBe(7);

    // Not a single provider call: the write-back is pure orchestration.
    expect(f.calls.count).toBe(callsBefore);

    const after = storedMessages(f);
    expect(after).toHaveLength(7);
    const summary = after[0];
    expect(summary?.metadata?.compaction?.summary).toContain("## 折叠话题");
    const packed = JSON.parse(
      (summary?.content[0] as { text: string }).text,
    ) as { type: string; message: string };
    expect(packed.type).toBe("system_alert");
    expect(packed.message).toContain("## 未决与后续");
    expect(packed.message).toContain("### one\nsection: one");
    expect(packed.message).not.toContain("section: two");

    const raw = await readFile(
      transcriptPath(storageDir, f.conversationId, f.agentId),
      "utf8",
    );
    const topicRows = rowsWithType(raw, "topic");
    expect(topicRows).toHaveLength(1);
    expect(topicRows[0]).toMatchObject({
      title: "one",
      summary: "section: one",
      createdBy: "summarizer",
      anchorMessageId: preview.pickMessageId,
    });
    const compactionRows = rowsWithType(raw, "compaction");
    expect(compactionRows).toHaveLength(1);
    expect(
      (
        compactionRows[0]?.details as {
          stats?: { folded_topic_ids?: string[] };
        }
      )?.stats?.folded_topic_ids,
    ).toEqual(result.foldedTopicIds);

    // The projection reads the section back off the marker.
    const list = f.backend.listTopics(f.conversationId, f.agentId);
    expect(list.blocks.map((block) => block.title)).toEqual(["one", null]);
    expect(list.blocks[0]?.summary).toBe("section: one");
    expect(list.blocks[1]?.summary).toBeUndefined();
    expect(list.markers[0]?.marker.createdBy).toBe("summarizer");
    expect(list.markers[0]?.marker.summary).toBe("section: one");

    // The apply refreshed the topic index, so the just-written marker is
    // queryable immediately (§5.11.5).
    const indexed = queryTopicIndex({
      agentId: f.agentId,
      conversationId: f.conversationId,
      storageDir,
    });
    expect(indexed).toHaveLength(1);
    expect(indexed[0]).toMatchObject({
      createdBy: "summarizer",
      title: "one",
      section: "section: one",
      anchorMessageId: preview.pickMessageId,
      evicted: false,
    });

    // A trim is a compaction application point: the prefix was refrozen.
    expect(frozenReason(f)).toBe("compaction");
    // The folded messages leave the context but stay on disk.
    expect(after.map((message) => message.id)).not.toContain(before[0]?.id);
  });

  test("the summarizer marker is exact: no boundary rewind", async () => {
    const storageDir = await createStorageDirectory();
    const f = await fixture(storageDir, 6);
    const preview = previewFor(f, 4);
    await f.backend.applyCompaction({
      preview,
      pick: { kind: "message", messageId: preview.pickMessageId },
    });

    const list = f.backend.listTopics(f.conversationId, f.agentId);
    // Block 1 is exactly the summary message: the marker's anchor is the first
    // kept message, not two user turns earlier.
    expect(list.blocks[0]?.messageCount).toBe(1);
    expect(list.blocks[0]?.rewindTurns).toBe(0);
    expect(list.blocks[1]?.boundaryMessageId).toBe(preview.pickMessageId);
  });

  test("two compactions in a row keep both summarizer sections and both anchors", async () => {
    const storageDir = await createStorageDirectory();
    const f = await fixture(storageDir, 8);

    // Compaction 1: fold turn 1-4, keep turn 5 on, anchored at the kept start.
    const initial = storedMessages(f);
    const firstSplit = initial[8]?.id ?? ""; // turn 5's user message
    await f.backend.applyCompaction({
      preview: previewWithTopics(
        f,
        [
          {
            title: "one",
            startMessageId: initial[0]?.id ?? "",
            section: "section: one",
          },
          { title: "two", startMessageId: firstSplit, section: "section: two" },
        ],
        firstSplit,
      ),
      pick: { kind: "message", messageId: firstSplit },
    });

    // Compaction 2: fold the summary message plus turns 5-6, keep turn 7 on.
    const afterFirst = storedMessages(f);
    expect(afterFirst[0]?.metadata?.compaction).toBeDefined();
    const keptStart = afterFirst[1]?.id ?? "";
    const secondSplit = afterFirst[5]?.id ?? ""; // turn 7's user message
    await f.backend.applyCompaction({
      preview: previewWithTopics(
        f,
        [
          {
            title: "two",
            startMessageId: afterFirst[0]?.id ?? "",
            section: "section: two",
          },
          {
            title: "three",
            startMessageId: secondSplit,
            section: "section: three",
          },
        ],
        secondSplit,
      ),
      pick: { kind: "message", messageId: secondSplit },
    });

    // Both markers survive, each anchored at the exact boundary of its cut:
    // the first at the message compaction 1 kept, the second at the message
    // compaction 2 keeps.
    const markers = f.backend.listTopicMarkers(f.conversationId, f.agentId);
    expect(markers.map((marker) => marker.title)).toEqual(["one", "two"]);
    expect(markers.map((marker) => marker.createdBy)).toEqual([
      "summarizer",
      "summarizer",
    ]);
    expect(markers.map((marker) => marker.anchorMessageId)).toEqual([
      firstSplit,
      secondSplit,
    ]);
    expect(markers.map((marker) => marker.summary)).toEqual([
      "section: one",
      "section: two",
    ]);

    // Both sections remain readable in `listTopics` and in the topic index; the
    // first anchor is now behind the cut, so its marker is marked evicted.
    const list = f.backend.listTopics(f.conversationId, f.agentId);
    expect(list.markers.map((view) => view.marker.summary)).toEqual([
      "section: one",
      "section: two",
    ]);
    expect(list.markers.map((view) => view.anchorInContext)).toEqual([
      false,
      true,
    ]);
    expect(list.blocks[0]?.summary).toBe("section: two");
    // The block projection folds the evicted marker's title into the block that
    // ends at the surviving boundary — the section itself stays on the marker
    // above, which is what `/topic list --all` reads.
    expect(list.blocks[0]?.absorbedTitles).toEqual(["one"]);

    const indexed = queryTopicIndex({
      agentId: f.agentId,
      conversationId: f.conversationId,
      storageDir,
    });
    expect(indexed.map((entry) => entry.section).sort()).toEqual([
      "section: one",
      "section: two",
    ]);

    // The second write-back carries only the just-cut section, and the folded
    // messages are gone from the context while the kept boundary is intact.
    const finalMessages = storedMessages(f);
    const packed = JSON.parse(
      (finalMessages[0]?.content[0] as { text: string }).text,
    ) as { message: string };
    expect(packed.message).toContain("### two");
    expect(packed.message).not.toContain("### one");
    expect(finalMessages).toHaveLength(5);
    expect(finalMessages[1]?.id).toBe(secondSplit);
    expect(finalMessages.map((message) => message.id)).not.toContain(keptStart);
    expect(finalMessages.map((message) => message.id)).not.toContain(
      afterFirst[0]?.id,
    );
  });

  test("applies a whole-section degradation without writing a marker", async () => {
    const storageDir = await createStorageDirectory();
    const f = await fixture(storageDir, 6);
    const preview = previewFor(f, 4, {
      topics: [],
      degraded: "format",
      overview: {
        restricted: { open: "", errors: "", relationship: "", memoryIndex: "" },
        narrative: "one whole-section summary",
      },
    });

    const result = await f.backend.applyCompaction({
      preview,
      pick: { kind: "ratio_suggestion" },
    });

    expect(result.executed).toBe(true);
    expect(result.foldedTopicIds).toEqual([]);
    expect(f.backend.listTopicMarkers(f.conversationId, f.agentId)).toEqual([]);

    const raw = await readFile(
      transcriptPath(storageDir, f.conversationId, f.agentId),
      "utf8",
    );
    expect(rowsWithType(raw, "topic")).toHaveLength(0);
    const summary = storedMessages(f)[0];
    const packed = JSON.parse(
      (summary?.content[0] as { text: string }).text,
    ) as { message: string };
    expect(packed.message).toContain("one whole-section summary");
    expect(packed.message).not.toContain("## 未决与后续");
    expect(packed.message).not.toContain("折叠话题");
    expect(frozenReason(f)).toBe("compaction");
  });

  test("a pick whose message is gone writes nothing", async () => {
    const storageDir = await createStorageDirectory();
    const f = await fixture(storageDir, 4);
    const preview = previewFor(f, 2);
    const beforeRaw = await readFile(
      transcriptPath(storageDir, f.conversationId, f.agentId),
      "utf8",
    );

    const result = await f.backend.applyCompaction({
      preview,
      pick: { kind: "message", messageId: "local-message-that-left" },
    });

    expect(result.executed).toBe(false);
    expect(result.noopReason).toBe("unknown_block");
    expect(f.backend.listTopicMarkers(f.conversationId, f.agentId)).toEqual([]);
    expect(
      await readFile(
        transcriptPath(storageDir, f.conversationId, f.agentId),
        "utf8",
      ),
    ).toBe(beforeRaw);
  });
});

/**
 * T3's index is only as fresh as its call sites. M2 owns the backend wiring for
 * three of them: a marker write, a fork copy, and a conversation delete.
 */
describe("topic-index call sites", () => {
  test("a marker is queryable immediately, a fork indexes its own copy, a delete drops the record", async () => {
    const storageDir = await createStorageDirectory();
    const f = await fixture(storageDir, 2);
    f.backend.markTopic({
      conversationId: f.conversationId,
      agentId: f.agentId,
      title: "Parent topic",
      summary: "parent section",
      createdBy: "user",
    });
    const parentIndexed = queryTopicIndex({
      agentId: f.agentId,
      conversationId: f.conversationId,
      storageDir,
    });
    expect(parentIndexed.map((entry) => entry.title)).toEqual(["Parent topic"]);
    expect(parentIndexed[0]?.section).toBe("parent section");

    const forked = await f.backend.forkConversation(f.conversationId, {});
    const childIndexed = queryTopicIndex({
      agentId: f.agentId,
      conversationId: forked.id,
      storageDir,
    });
    expect(childIndexed.map((entry) => entry.title)).toEqual(["Parent topic"]);
    // The fork's marker points at the child's copy of the message.
    expect(childIndexed[0]?.anchorMessageId).not.toBe(
      parentIndexed[0]?.anchorMessageId,
    );

    await f.backend.deleteConversation(f.conversationId);
    expect(
      queryTopicIndex({
        agentId: f.agentId,
        conversationId: f.conversationId,
        storageDir,
      }),
    ).toEqual([]);
  });
});
