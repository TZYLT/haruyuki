import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalContextRewrites } from "@/backend/local/local-context-rewrite";
import {
  LOCAL_TRANSCRIPT_MESSAGE_FORMAT,
  LOCAL_TRANSCRIPT_PROVIDER_STACK,
  LOCAL_TRANSCRIPT_SCHEMA_VERSION,
} from "@/backend/local/local-transcript";
import type { StoredConversation } from "@/backend/local/local-types";
import {
  pruneRecallDedupWindow,
  type RecallDedupPorts,
  settleRecallDedup,
} from "@/backend/local/recall-dedup";
import {
  readRecallMessageTexts,
  transcriptRecallSnippet,
} from "@/backend/local/recall-snippets";

/**
 * The dedup window and the snippet reader are the two places where feature ②'s
 * claims touch durable state, so both are tested against a record rather than
 * through a turn.
 */

function fakePorts(initial: Record<string, number> = {}): {
  ports: RecallDedupPorts;
  current: () => Record<string, number>;
  writes: () => number;
} {
  let window = { ...initial };
  let writes = 0;
  return {
    ports: {
      read: () => ({ ...window }),
      write: (
        _conversationId: string,
        _agentId: string,
        next: Record<string, number>,
      ) => {
        writes += 1;
        window = { ...next };
      },
    },
    current: () => ({ ...window }),
    writes: () => writes,
  };
}

describe("pruneRecallDedupWindow", () => {
  test("keeps entries inside the window and drops the ones that aged out", () => {
    expect(pruneRecallDedupWindow({ a: 5, b: 1 }, 10, 10)).toEqual({
      a: 5,
      b: 1,
    });
    // Exactly K turns old has aged out; K-1 turns old is still inside.
    expect(pruneRecallDedupWindow({ edge: 0 }, 10, 10)).toEqual({});
    expect(pruneRecallDedupWindow({ edge: 1 }, 10, 10)).toEqual({ edge: 1 });
  });

  test("keepTurns 0 disables the window rather than keeping everything", () => {
    expect(pruneRecallDedupWindow({ a: 1 }, 1, 0)).toEqual({});
  });
});

describe("settleRecallDedup", () => {
  test("suppresses the stored window before merging this turn's injections", () => {
    const store = fakePorts({ old: 3 });
    const { suppressed, window } = settleRecallDedup(store.ports, {
      conversationId: "default",
      agentId: "agent-a",
      currentTurn: 5,
      keepTurns: 10,
      injected: { fresh: 5 },
    });
    // `fresh` was injected by this very turn, so it must not suppress itself.
    expect([...suppressed]).toEqual(["old"]);
    expect(window).toEqual({ old: 3, fresh: 5 });
    expect(store.current()).toEqual({ old: 3, fresh: 5 });
  });

  test("omitting injected only prunes, and a stale entry is written away", () => {
    const store = fakePorts({ stale: 1, live: 9 });
    const { suppressed, window } = settleRecallDedup(store.ports, {
      conversationId: "default",
      agentId: "agent-a",
      currentTurn: 10,
      keepTurns: 5,
    });
    expect([...suppressed]).toEqual(["live"]);
    expect(window).toEqual({ live: 9 });
  });
});

const CONVERSATION_ID = "conv-dedup";
const AGENT_ID = "agent-dedup";

function contextRewriteFixture(): {
  rewrites: LocalContextRewrites;
  conversation: StoredConversation;
  saves: () => number;
} {
  const conversation = {
    id: CONVERSATION_ID,
    agent_id: AGENT_ID,
    in_context_message_ids: [],
  } as unknown as StoredConversation;
  const state = { saves: 0 };
  const rewrites = new LocalContextRewrites({
    ensureConversation: () => conversation,
    conversationKey: (id, agent) => `${id}:${agent}`,
    conversationMessagesPath: () => undefined,
    ensureResidentMessages: () => {},
    inContextMessages: () => [],
    validateUnreadTranscriptHead: () => {},
    nextLocalMessageId: () => "msg",
    currentLocalMessageDate: () => "2026-01-01T00:00:00.000Z",
    setResidentMessages: () => {},
    saveConversation: () => {
      state.saves += 1;
    },
    persistConversation: () => {},
    rebuildMessageIndex: () => {},
    now: () => "2026-01-01T00:00:00.000Z",
    ensureTranscriptHeader: () => {},
    nextSessionEntryId: () => "entry",
    lastSessionEntryId: () => null,
    recordSessionEntryId: () => {},
  });
  return {
    rewrites,
    conversation,
    saves: () => state.saves,
  };
}

describe("context_management keeps its fields independent", () => {
  test("settling the topic nudge does not delete the recall window", () => {
    // Regression: `setTopicNudgeSent` used to replace (or delete) the whole
    // `context_management` object, which silently dropped any sibling key. Two
    // features share this field now, so each must edit only its own.
    const fixture = contextRewriteFixture();
    fixture.rewrites.setRecallInjectedTurns(CONVERSATION_ID, AGENT_ID, {
      "memory:a.md": 7,
    });
    expect(fixture.conversation.context_management).toEqual({
      recall_injected_turns: { "memory:a.md": 7 },
    });

    fixture.rewrites.setTopicNudgeSent(CONVERSATION_ID, AGENT_ID, true);
    expect(fixture.conversation.context_management).toEqual({
      recall_injected_turns: { "memory:a.md": 7 },
      nudge_sent_for_streak: true,
    });

    fixture.rewrites.setTopicNudgeSent(CONVERSATION_ID, AGENT_ID, false);
    expect(fixture.conversation.context_management).toEqual({
      recall_injected_turns: { "memory:a.md": 7 },
    });

    fixture.rewrites.setRecallInjectedTurns(CONVERSATION_ID, AGENT_ID, {});
    expect(fixture.conversation.context_management).toBeUndefined();
  });

  test("a damaged window reads as nothing recorded", () => {
    const fixture = contextRewriteFixture();
    (
      fixture.conversation as { context_management?: unknown }
    ).context_management = {
      recall_injected_turns: { good: 3, "": 4, bad: "x", nan: Number.NaN },
    };
    expect(
      fixture.rewrites.readRecallInjectedTurns(CONVERSATION_ID, AGENT_ID),
    ).toEqual({ good: 3 });
  });
});

async function writeTranscript(
  conversationDir: string,
  rows: unknown[],
): Promise<void> {
  await mkdir(conversationDir, { recursive: true });
  await writeFile(
    join(conversationDir, "manifest.json"),
    `${JSON.stringify({
      schema_version: LOCAL_TRANSCRIPT_SCHEMA_VERSION,
      message_format: LOCAL_TRANSCRIPT_MESSAGE_FORMAT,
      provider_stack: LOCAL_TRANSCRIPT_PROVIDER_STACK,
      created_at: "2026-01-01T00:00:00.000Z",
    })}\n`,
  );
  await writeFile(
    join(conversationDir, "messages.jsonl"),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
}

function messageRow(
  id: string,
  role: string,
  text: string,
  second: number,
): unknown {
  return {
    type: "message",
    id: `row-${id}`,
    parentId: null,
    timestamp: `2026-01-01T00:00:${String(second).padStart(2, "0")}.000Z`,
    message: { id, role, content: [{ type: "text", text }] },
  };
}

describe("transcript snippets", () => {
  test("reads the corpus boundary once and can cut several snippets from it", async () => {
    const root = await mkdtemp(join(tmpdir(), "haru-recall-snippets-"));
    // A Windows path cannot hold a colon, which is exactly why the store encodes
    // conversation keys into directory names; a snippet reader takes whatever the
    // directory is actually called, so a plain name is a faithful fixture.
    const conversationDir = join(root, "conversation-conv-1");
    try {
      await writeTranscript(conversationDir, [
        messageRow("m1", "user", "first question", 1),
        messageRow("m2", "assistant", "first answer", 2),
        {
          type: "compaction",
          id: "row-compaction",
          timestamp: "2026-01-01T00:00:03.000Z",
          message: {
            id: "summary",
            role: "user",
            content: [{ type: "text", text: "generated summary" }],
          },
        },
        messageRow(
          "m3",
          "user",
          "<system-reminder>injected</system-reminder>real question",
          4,
        ),
        {
          type: "message",
          id: "row-tool",
          parentId: null,
          timestamp: "2026-01-01T00:00:05.000Z",
          message: {
            id: "m4",
            role: "toolResult",
            content: [{ type: "text", text: "tool output" }],
          },
        },
        messageRow("m5", "assistant", "final answer", 6),
      ]);

      const messages = readRecallMessageTexts(conversationDir);
      expect(messages.map((entry) => [entry.id, entry.text])).toEqual([
        ["m1", "first question"],
        ["m2", "first answer"],
        // The compaction summary is generated text, and the reminder block is not
        // something anyone said — the same boundary the index ingests with.
        ["m3", "real question"],
        ["m5", "final answer"],
      ]);

      expect(
        transcriptRecallSnippet({ messages, messageId: "m3", neighbors: 1 }),
      ).toEqual({
        messageId: "m3",
        timestamp: "2026-01-01T00:00:04.000Z",
        text: "assistant: first answer\n\nuser: real question\n\nassistant: final answer",
        messageIds: ["m2", "m3", "m5"],
      });

      // Clamped at both ends. The tool result was never a corpus row, so the
      // neighbours are the four readable messages, in order.
      expect(
        transcriptRecallSnippet({ messages, messageId: "m1", neighbors: 2 })
          ?.messageIds,
      ).toEqual(["m1", "m2", "m3"]);
      expect(
        transcriptRecallSnippet({ messages, messageId: "m5", neighbors: 2 })
          ?.messageIds,
      ).toEqual(["m2", "m3", "m5"]);

      // An id the transcript does not have is a disagreement, not a hit.
      expect(
        transcriptRecallSnippet({
          messages,
          messageId: "missing",
          neighbors: 1,
        }),
      ).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a missing transcript yields nothing rather than throwing", () => {
    expect(readRecallMessageTexts(join(tmpdir(), "haru-no-such-dir"))).toEqual(
      [],
    );
  });
});
