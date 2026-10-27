/**
 * Unit coverage for the topic-list shell (D-104).
 *
 * The planner itself is covered by `topic-compaction.test.ts`; what matters here
 * is the shell's contract: the blocks are cut at the effective boundaries, a
 * marker whose anchor left the context is reported as dead instead of producing
 * an empty block, and the retention target is a share of the transcript being
 * compressed — not of the model's window.
 *
 * The list is read-only, so the write members of the port object throw: a list
 * that started writing would fail here rather than pass silently.
 */
import { describe, expect, test } from "bun:test";
import type { LocalMessage } from "@/backend/local/local-message";
import {
  type LocalTopicTrimPorts,
  listLocalTopics,
  retentionCapTokensFor,
} from "@/backend/local/local-topic-trim";
import type { LocalTopicMarker } from "@/backend/local/topic-compaction";

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
    timestamp: 0,
  } as LocalMessage;
}

/** `turns` turns of 100 tokens each: `u1, a1, u2, a2, …`. */
function conversation(turns: number): LocalMessage[] {
  const messages: LocalMessage[] = [];
  for (let turn = 1; turn <= turns; turn += 1) {
    messages.push(userMessage(`u${turn}`));
    messages.push(assistantMessage(`a${turn}`));
  }
  return messages;
}

function marker(
  id: string,
  title: string,
  anchorMessageId: string,
): LocalTopicMarker {
  return {
    id,
    title,
    createdBy: "agent",
    anchorMessageId,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function ports(input: {
  messages: LocalMessage[];
  markers?: LocalTopicMarker[];
  contextWindow?: number;
  percentage?: number;
}): LocalTopicTrimPorts {
  return {
    resolveAgentId: () => "agent-1",
    listMessages: () => input.messages,
    readMarkers: () => input.markers ?? [],
    contextWindow: () => input.contextWindow,
    compactionSettings: () => ({
      slidingWindowPercentage: input.percentage ?? 0.3,
    }),
    rewrite: () => {
      throw new Error("the topic list never writes");
    },
    refreshFrozenPrefix: async () => {
      throw new Error("the topic list never rewrites the frozen prefix");
    },
  };
}

describe("retentionCapTokensFor", () => {
  test("keeps (1 - rate) of the length being compressed", () => {
    // The base is the transcript being compressed, not the model's window.
    expect(retentionCapTokensFor(100_000, 0.3)).toBe(70_000);
    expect(retentionCapTokensFor(1_000, 0.3)).toBe(700);
  });

  test("an unmeasurable length has no target", () => {
    expect(retentionCapTokensFor(undefined, 0.3)).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(retentionCapTokensFor(0, 0.3)).toBe(Number.POSITIVE_INFINITY);
    expect(retentionCapTokensFor(Number.NaN, 0.3)).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  test("an unusable rate is normalized the way the planner normalizes it (M-3)", () => {
    // The sliding-window planner reads the same setting: `NaN`/missing is the
    // default 0.3, `<= 0` is its smallest step (0.1), and anything above 1
    // compresses everything. The cap must not disagree with it.
    expect(retentionCapTokensFor(1_000, Number.NaN)).toBe(700);
    expect(retentionCapTokensFor(1_000, 0)).toBe(900);
    expect(retentionCapTokensFor(1_000, -2)).toBe(900);
    expect(retentionCapTokensFor(1_000, 1.5)).toBe(0);
  });
});

describe("listLocalTopics", () => {
  test("cuts blocks at effective boundaries and flags dead anchors", () => {
    const messages = conversation(6);
    const list = listLocalTopics(
      ports({
        messages,
        markers: [
          marker("t1", "Topic A", "a6"),
          marker("t2", "Gone", "trimmed-away"),
        ],
        contextWindow: 1_000,
        percentage: 0.3,
      }),
      { conversationId: "default" },
    );

    // Rewind 2 from turn 6 lands on turn 4; the second marker's anchor is gone,
    // so it is absorbed into the first block instead of emitting an empty one.
    expect(list.blocks.map((block) => block.boundaryMessageId)).toEqual([
      "u1",
      "u4",
    ]);
    expect(list.blocks[0]?.absorbedTitles).toEqual(["Gone"]);
    expect(list.blocks[1]?.title).toBeNull();
    expect(list.markers.map((view) => view.anchorInContext)).toEqual([
      true,
      false,
    ]);
    expect(list.contextMessageCount).toBe(12);
    expect(list.contextTokens).toBe(1_200);
    expect(list.contextWindow).toBe(1_000);
    // 1,200 transcript tokens compressed at 0.3: the target keeps 840.
    expect(list.retentionCapTokens).toBe(840);
  });

  test("an unmarked context is one block, with its target from the transcript (not the window)", () => {
    const list = listLocalTopics(
      ports({ messages: conversation(2), contextWindow: undefined }),
      { conversationId: "default" },
    );

    expect(list.blocks).toHaveLength(1);
    expect(list.blocks[0]?.title).toBeNull();
    expect(list.markers).toEqual([]);
    // 4 messages x 100 tokens = 400; the window is unknown and irrelevant here.
    expect(list.retentionCapTokens).toBe(280);
    expect(list.contextWindow).toBeUndefined();
  });
});
