/**
 * `prepare → apply` orchestration for F-04.
 *
 * The claims under test are the ones the frozen seam is for: prepare is a pure
 * read plus one injected summarizer call, apply is a no-model write whose order
 * is rewrite → prefix → index (the fold and its markers travel together), and a
 * pick that cannot be honored writes nothing at all.
 */
import { describe, expect, test } from "bun:test";
import type {
  CompactionOverview,
  CompactionPreview,
  CompactionTopicDraft,
} from "@/backend/local/compaction-preview";
import {
  type ApplyCompactionPorts,
  applyCompaction,
  type CompactionApplyResult,
  type CompactionSummarizeInput,
  type PrepareCompactionPorts,
  prepareCompaction,
} from "@/backend/local/compaction-run";
import type { LocalConversationRewriteInput } from "@/backend/local/local-context-rewrite";
import type { LocalMessage } from "@/backend/local/local-message";
import type { LocalAgentRecord } from "@/backend/local/local-types";
import type { LocalTopicMarker } from "@/backend/local/topic-compaction";

const AGENT = {
  id: "agent-1",
  name: "Agent",
  model: "openai/gpt-5.5",
  model_settings: {},
  system: "",
} as unknown as LocalAgentRecord;

function textForTokens(tokens: number): string {
  return "x".repeat(tokens * 4);
}

function userMessage(id: string, tokens = 100): LocalMessage {
  return {
    id,
    role: "user",
    content: [{ type: "text", text: textForTokens(tokens) }],
    timestamp: 0,
  } as LocalMessage;
}

function assistantMessage(id: string, tokens = 100): LocalMessage {
  return {
    id,
    role: "assistant",
    content: [{ type: "text", text: textForTokens(tokens) }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.5",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop",
    timestamp: 0,
  } as LocalMessage;
}

/** Four exchanges, 100 tokens per message: `u1,a1,…,u4,a4`. */
function conversation(): LocalMessage[] {
  const messages: LocalMessage[] = [];
  for (let turn = 1; turn <= 4; turn += 1) {
    messages.push(userMessage(`u${turn}`));
    messages.push(assistantMessage(`a${turn}`));
  }
  return messages;
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

function draft(title: string, startMessageId: string): CompactionTopicDraft {
  return { title, startMessageId, section: `section: ${title}` };
}

function preview(
  overrides: Partial<CompactionPreview> = {},
): CompactionPreview {
  return {
    conversationId: "conv-1",
    agentId: "agent-1",
    model: "openai/gpt-5.5",
    createdAt: "2026-01-01T00:00:00.000Z",
    topics: [draft("one", "u1"), draft("two", "u3")],
    overview: overview(),
    blocks: [],
    numberedBlocks: 1,
    suggestionIndex: 2,
    usage: {
      promptTokens: 10,
      cachedInputTokens: 4,
      completionTokens: 5,
      wallMs: 100,
    },
    degraded: null,
    ...overrides,
  };
}

interface ApplyFixture {
  ports: ApplyCompactionPorts;
  calls: string[];
  rewrites: LocalConversationRewriteInput[];
  markers: LocalTopicMarker[];
}

function applyFixture(input: {
  messages: LocalMessage[];
  markers?: LocalTopicMarker[];
  percentage?: number;
}): ApplyFixture {
  const calls: string[] = [];
  const rewrites: LocalConversationRewriteInput[] = [];
  const markers = [...(input.markers ?? [])];
  return {
    calls,
    rewrites,
    markers,
    ports: {
      listMessages: () => input.messages,
      readMarkers: () => markers,
      compactionSettings: () => ({
        slidingWindowPercentage: input.percentage ?? 0.3,
      }),
      rewrite: (rewrite) => {
        calls.push("rewrite");
        rewrites.push(rewrite);
        const drafts = rewrite.topicMarkers ?? [];
        const topicEntryIds = drafts.map(
          (_marker, position) => `entry-${position + 1}`,
        );
        drafts.forEach((marker, position) => {
          markers.push({
            id: `entry-${position + 1}`,
            title: marker.title,
            createdBy: marker.createdBy,
            anchorMessageId: marker.anchorMessageId,
            createdAt: "2026-01-01T00:00:00.000Z",
            ...(marker.summary === undefined
              ? {}
              : { summary: marker.summary }),
          });
        });
        return {
          numMessagesBefore: input.messages.length,
          numMessagesAfter: (rewrite.remainingMessages?.length ?? 0) + 1,
          topicEntryIds,
          ...(rewrite.stats === undefined
            ? {}
            : { stats: { ...rewrite.stats, folded_topic_ids: topicEntryIds } }),
          summaryMessage: {
            id: "summary-1",
            role: "user",
            content: [{ type: "text", text: rewrite.packedSummary }],
            timestamp: 0,
          } as LocalMessage,
        };
      },
      refreshFrozenPrefix: async () => {
        calls.push("prefix");
      },
      clearTopicNudgeStreak: () => {
        calls.push("nudge");
      },
      refreshIndex: () => {
        calls.push("index");
      },
    },
  };
}

function packedSummaryOf(rewrite: LocalConversationRewriteInput): {
  type: string;
  message: string;
} {
  return JSON.parse(rewrite.packedSummary) as { type: string; message: string };
}

/** Every marker any apply attempt handed to the rewrite (there may be none). */
function topicMarkersOf(
  fixture: ApplyFixture,
): LocalConversationRewriteInput["topicMarkers"] {
  return fixture.rewrites.flatMap((rewrite) => rewrite.topicMarkers ?? []);
}

describe("prepareCompaction", () => {
  interface PrepareFixture {
    ports: PrepareCompactionPorts;
    calls: CompactionSummarizeInput[];
  }

  function prepareFixture(input: {
    messages: LocalMessage[];
    markers?: LocalTopicMarker[];
    percentage?: number;
    result?: Awaited<ReturnType<CompactionSummarizePort>>;
  }): PrepareFixture {
    const calls: CompactionSummarizeInput[] = [];
    return {
      calls,
      ports: {
        storageDir: "J:/tmp/storage",
        listMessages: () => input.messages,
        readMarkers: () => input.markers ?? [],
        compactionSettings: () => ({
          slidingWindowPercentage: input.percentage ?? 0.3,
        }),
        frozenAgent: () => AGENT,
        summarize: async (summarizeInput) => {
          calls.push(summarizeInput);
          return (
            input.result ?? {
              topics: [draft("one", "u1"), draft("two", "u3")],
              overview: overview(),
              degraded: null,
              usage: {
                promptTokens: 1,
                cachedInputTokens: 0,
                completionTokens: 2,
                wallMs: 3,
              },
            }
          );
        },
      },
    };
  }

  type CompactionSummarizePort = PrepareCompactionPorts["summarize"];

  test("runs the injected summarizer on the frozen agent and shapes the preview", async () => {
    const messages = conversation();
    const fixture = prepareFixture({ messages, percentage: 0.6 });
    const prepared = await prepareCompaction(fixture.ports, {
      conversationId: "conv-1",
      agentId: "agent-1",
    });

    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0]).toMatchObject({
      agent: AGENT,
      agentId: "agent-1",
      conversationId: "conv-1",
      storageDir: "J:/tmp/storage",
    });
    expect(prepared.degraded).toBeNull();
    expect(prepared.model).toBe(AGENT.model);
    expect(prepared.topics.map((topic) => topic.title)).toEqual(["one", "two"]);
    expect(prepared.blocks.map((block) => block.title)).toEqual(["one", "two"]);
    expect(prepared.blocks.map((block) => block.summary)).toEqual([
      "section: one",
      "section: two",
    ]);
    expect(prepared.numberedBlocks).toBe(1);
    expect(prepared.usage).toEqual({
      promptTokens: 1,
      cachedInputTokens: 0,
      completionTokens: 2,
      wallMs: 3,
    });
    // The rate keeps the newest ~40%: the second topic is the row it lands on.
    expect(prepared.blocks[prepared.suggestionIndex - 1]?.title).toBe("two");
  });

  test("passes a cancellation signal through to the summarizer", async () => {
    const fixture = prepareFixture({ messages: conversation() });
    const controller = new AbortController();
    await prepareCompaction(fixture.ports, {
      conversationId: "conv-1",
      agentId: "agent-1",
      signal: controller.signal,
    });
    expect(fixture.calls[0]?.signal).toBe(controller.signal);
  });

  test("degrades to the marker blocks when the topics are structurally invalid", async () => {
    const messages = conversation();
    const marker: LocalTopicMarker = {
      id: "marker-1",
      title: "existing",
      createdBy: "agent",
      anchorMessageId: "a2",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const fixture = prepareFixture({
      messages,
      markers: [marker],
      result: {
        topics: [draft("ghost", "missing")],
        overview: overview(),
        degraded: null,
        usage: {
          promptTokens: 1,
          cachedInputTokens: 0,
          completionTokens: 2,
          wallMs: 3,
        },
      },
    });
    const prepared = await prepareCompaction(fixture.ports, {
      conversationId: "conv-1",
      agentId: "agent-1",
    });

    expect(prepared.degraded).toBe("format");
    expect(prepared.topics).toEqual([]);
    // A marker rewound onto the start of the context produces no block of its
    // own: its title is absorbed into the single trailing block.
    expect(prepared.blocks.map((block) => block.title)).toEqual([null]);
    expect(prepared.blocks[0]?.absorbedTitles).toEqual(["existing"]);
    expect(prepared.numberedBlocks).toBe(1);
  });

  test("honours the summarizer's own degradation and keeps its cause", async () => {
    const fixture = prepareFixture({
      messages: conversation(),
      result: {
        topics: [draft("one", "u1")],
        overview: {
          restricted: {
            open: "",
            errors: "",
            relationship: "",
            memoryIndex: "",
          },
          narrative: "one whole-section summary",
        },
        degraded: "refusal",
        usage: {
          promptTokens: 1,
          cachedInputTokens: 0,
          completionTokens: 2,
          wallMs: 3,
        },
      },
    });
    const prepared = await prepareCompaction(fixture.ports, {
      conversationId: "conv-1",
      agentId: "agent-1",
    });
    expect(prepared.degraded).toBe("refusal");
    expect(prepared.topics).toEqual([]);
  });

  test("does not spend a model call on an empty context", async () => {
    const fixture = prepareFixture({ messages: [] });
    const prepared = await prepareCompaction(fixture.ports, {
      conversationId: "conv-1",
      agentId: "agent-1",
    });
    expect(fixture.calls).toEqual([]);
    expect(prepared).toMatchObject({
      model: AGENT.model,
      topics: [],
      blocks: [],
      numberedBlocks: 0,
      // No call was made, so nothing degraded: the apply path refuses with
      // `empty_context` before writing anything.
      degraded: null,
    });
  });
});

describe("applyCompaction", () => {
  test("writes the folded topic as a summarizer marker, then the overview plus its section", async () => {
    const messages = conversation();
    const fixture = applyFixture({ messages });
    const result = await applyCompaction(fixture.ports, {
      preview: preview(),
      pick: { kind: "message", messageId: "u3" },
    });

    expect(result.executed).toBe(true);
    expect(result.source).toBe("topic_pick");
    expect(result.foldedTitles).toEqual(["one"]);
    expect(result.foldedTopicIds).toEqual(["entry-1"]);
    expect(result.numMessagesBefore).toBe(8);
    expect(result.numMessagesAfter).toBe(5);
    expect(result.firstKeptMessageId).toBe("u3");
    expect(result.summaryMessageId).toBe("summary-1");
    expect(result.stats.folded_topic_ids).toEqual(["entry-1"]);
    expect(result.stats.trim?.summarized_titles).toEqual(["one"]);

    // §5.5.2/§5.5.4: one marker, anchored on the exact boundary (the next
    // topic's first message), carrying the section, created by the summarizer.
    // It travels *with* the rewrite instead of as an earlier separate write, so
    // the fold and its boundary map can only be written in one order (T-5).
    expect(fixture.rewrites[0]?.topicMarkers).toEqual([
      {
        title: "one",
        summary: "section: one",
        createdBy: "summarizer",
        anchorMessageId: "u3",
      },
    ]);
    expect(fixture.calls).toEqual(["rewrite", "nudge", "prefix", "index"]);

    const rewrite = fixture.rewrites[0];
    expect(rewrite?.remainingMessages?.map((message) => message.id)).toEqual([
      "u3",
      "a3",
      "u4",
      "a4",
    ]);
    const packed = packedSummaryOf(rewrite as LocalConversationRewriteInput);
    expect(packed.type).toBe("system_alert");
    // Overview + only the just-folded section; the kept topic's section must not
    // ride along (§5.8.2, §6 "摘要不膨胀").
    expect(packed.message).toContain("## 未决与后续");
    expect(packed.message).toContain("## 折叠话题");
    expect(packed.message).toContain("### one\nsection: one");
    expect(packed.message).not.toContain("section: two");
  });

  test("calls no model and no writer at all when the pick cannot be honored", async () => {
    const messages = conversation();
    const fixture = applyFixture({ messages });
    const result = await applyCompaction(fixture.ports, {
      preview: preview(),
      pick: { kind: "message", messageId: "gone" },
    });

    // Refusing beats letting the rate choose a different cut for a pick whose
    // identity (a message id) no longer exists.
    expect(result.executed).toBe(false);
    expect(result.noopReason).toBe("unknown_block");
    expect(result.stats).toEqual({});
    expect(fixture.calls).toEqual([]);
    expect(topicMarkersOf(fixture)).toEqual([]);
    expect(fixture.rewrites).toEqual([]);
  });

  test("a preview computed on an older context is refused, not applied", async () => {
    const messages = conversation();
    const fixture = applyFixture({ messages });
    // Every anchor the preview named is gone: another rewrite (a second
    // `/compact`, or the turn's own auto-compaction) landed while the summarizer
    // was running. Applying it would write the older overview over the newer one
    // and drop the sections the first fold had already recorded.
    const result = await applyCompaction(fixture.ports, {
      preview: preview({
        topics: [draft("one", "gone-1"), draft("two", "gone-2")],
      }),
      pick: { kind: "ratio_suggestion" },
    });

    expect(result.executed).toBe(false);
    expect(result.noopReason).toBe("stale_preview");
    expect(fixture.calls).toEqual([]);
    expect(topicMarkersOf(fixture)).toEqual([]);
    expect(fixture.rewrites).toEqual([]);
  });

  test("an empty context is a no-op", async () => {
    const fixture = applyFixture({ messages: [] });
    const result = await applyCompaction(fixture.ports, {
      preview: preview({ topics: [], blocks: [] }),
      pick: { kind: "ratio_suggestion" },
    });
    expect(result.executed).toBe(false);
    expect(result.noopReason).toBe("empty_context");
    expect(fixture.calls).toEqual([]);
  });

  test("a ratio pick cuts by the rate and folds the topics it crossed", async () => {
    const messages = conversation();
    const fixture = applyFixture({ messages, percentage: 0.3 });
    const result = await applyCompaction(fixture.ports, {
      preview: preview(),
      pick: { kind: "ratio_suggestion" },
    });

    expect(result.executed).toBe(true);
    expect(result.source).toBe("ratio_suggestion");
    expect(result.retainedTokens).toBeLessThanOrEqual(
      result.retentionCapTokens ?? 0,
    );
    expect(result.foldedTitles).toEqual(["one"]);
    expect(fixture.rewrites).toHaveLength(1);
  });

  test("never double-marks an anchor a marker already holds", async () => {
    const messages = conversation();
    const fixture = applyFixture({
      messages,
      markers: [
        {
          id: "existing",
          title: "already here",
          createdBy: "user",
          anchorMessageId: "u3",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    const result = await applyCompaction(fixture.ports, {
      preview: preview(),
      pick: { kind: "message", messageId: "u3" },
    });

    expect(result.executed).toBe(true);
    expect(topicMarkersOf(fixture)).toEqual([]);
    expect(result.foldedTopicIds).toEqual([]);
    // The section still rides on the write-back; only the duplicate marker is
    // suppressed.
    expect(result.foldedTitles).toEqual(["one"]);
    expect(
      packedSummaryOf(fixture.rewrites[0] as LocalConversationRewriteInput)
        .message,
    ).toContain("section: one");
  });

  test("the whole-section degradation writes the narrative and no marker", async () => {
    const messages = conversation();
    const fixture = applyFixture({ messages });
    const result: CompactionApplyResult = await applyCompaction(fixture.ports, {
      preview: preview({
        topics: [],
        degraded: "format",
        overview: {
          restricted: {
            open: "",
            errors: "",
            relationship: "",
            memoryIndex: "",
          },
          narrative: "one whole-section summary",
        },
      }),
      pick: { kind: "ratio_suggestion" },
    });

    expect(result.executed).toBe(true);
    expect(result.foldedTopicIds).toEqual([]);
    expect(topicMarkersOf(fixture)).toEqual([]);
    const packed = packedSummaryOf(
      fixture.rewrites[0] as LocalConversationRewriteInput,
    );
    expect(packed.message).toContain("one whole-section summary");
    expect(packed.message).not.toContain("## 未决与后续");
    expect(packed.message).not.toContain("折叠话题");
  });

  test("reports the packed summary's weight, not the bare summary's", async () => {
    const messages = conversation();
    const fixture = applyFixture({ messages });
    const result = await applyCompaction(fixture.ports, {
      preview: preview(),
      pick: { kind: "message", messageId: "u3" },
    });

    const rewrite = fixture.rewrites[0] as LocalConversationRewriteInput;
    // §5.14: "tokens after" is the *pressure baseline* for the next send, and
    // what the next turn re-estimates is the packed `system_alert` message.
    // Measuring the bare summary (the old behaviour) under-reported by the size
    // of the envelope the message actually carries.
    expect(result.stats.context_tokens_after).toBe(
      result.retainedTokens + Math.ceil(rewrite.packedSummary.length / 4),
    );
    expect(rewrite.packedSummary.length).toBeGreaterThan(
      packedSummaryOf(rewrite).message.length,
    );
  });

  test("does not call the model while applying", async () => {
    // The ports object has no `complete`/provider member at all, so an apply
    // that needed one would not typecheck; this pins the runtime shape too.
    const fixture = applyFixture({ messages: conversation() });
    const result = await applyCompaction(fixture.ports, {
      preview: preview(),
      pick: { kind: "message", messageId: "u3" },
    });
    expect(result.executed).toBe(true);
    expect(Object.keys(fixture.ports).sort()).toEqual([
      "clearTopicNudgeStreak",
      "compactionSettings",
      "listMessages",
      "readMarkers",
      "refreshFrozenPrefix",
      "refreshIndex",
      "rewrite",
    ]);
  });
});
