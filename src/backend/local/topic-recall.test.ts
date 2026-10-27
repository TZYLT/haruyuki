/**
 * The topic recall projection: what is kept, where a span starts and ends, and
 * what happens when the budget bites.
 *
 * Two claims matter beyond the individual assertions. First, a marker whose anchor
 * was folded out of the context still reads in full — the transcript only ever
 * grows, so recall must never depend on residency. Second, the text carries no
 * message id and no path: the whole point of T-10 is that a reader gets prose, not
 * a handle into storage.
 *
 * Every fixture lives under a temporary root; nothing here can reach the real
 * `~/.haruyuki`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyLocalUsage, type LocalMessage } from "./local-message";
import {
  cleanMessageTextForRecall,
  readTopicRecallSpan,
  recallTopicConversation,
  renderTopicRecall,
  TOPIC_RECALL_EXCERPT_MAX_CHARS,
  TOPIC_RECALL_FULL_MAX_CHARS,
  TOPIC_RECALL_MIN_MAX_CHARS,
} from "./topic-recall";

const AGENT_ID = "agent-recall";
const CONVERSATION_ID = "default";
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createStorageDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "topic-recall-"));
  temporaryDirectories.push(directory);
  return directory;
}

/** The same keyed directory name `LocalStore` derives for a conversation. */
function conversationDirectoryKey(): string {
  return Buffer.from(`${CONVERSATION_ID}:${AGENT_ID}`).toString("base64url");
}

function writeConversation(
  storageDir: string,
  rows: readonly Record<string, unknown>[],
  inContextMessageIds: readonly string[],
): void {
  const directory = join(
    storageDir,
    "conversations",
    conversationDirectoryKey(),
  );
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "conversation.json"),
    `${JSON.stringify({
      id: CONVERSATION_ID,
      agent_id: AGENT_ID,
      in_context_message_ids: inContextMessageIds,
    })}\n`,
    "utf8",
  );
  writeFileSync(
    join(directory, "messages.jsonl"),
    `${[
      {
        type: "session",
        version: 3,
        id: CONVERSATION_ID,
        timestamp: new Date(0).toISOString(),
        cwd: "C:\\fixture",
      },
      ...rows,
    ]
      .map((row) => JSON.stringify(row))
      .join("\n")}\n`,
    "utf8",
  );
}

const BASE_MILLIS = Date.parse("2026-10-27T10:00:00.000Z");

function stamp(offsetMinutes = 0): number {
  return BASE_MILLIS + offsetMinutes * 60_000;
}

function messageRow(
  id: string,
  message: Record<string, unknown>,
): Record<string, unknown> {
  const timestamp = new Date(
    typeof message.timestamp === "number" ? message.timestamp : BASE_MILLIS,
  ).toISOString();
  return {
    type: "message",
    id: `entry-${id}`,
    parentId: null,
    timestamp,
    message,
  };
}

function userMessageRow(
  id: string,
  text: string,
  offsetMinutes = 0,
): Record<string, unknown> {
  return messageRow(id, {
    id,
    role: "user",
    content: [{ type: "text", text }],
    timestamp: stamp(offsetMinutes),
  });
}

function assistantMessageRow(
  id: string,
  input: {
    text?: string;
    thinking?: string;
    toolCall?: string;
    offsetMinutes?: number;
  } = {},
): Record<string, unknown> {
  const content: Record<string, unknown>[] = [];
  if (input.thinking !== undefined) {
    content.push({ type: "thinking", thinking: input.thinking });
  }
  if (input.toolCall !== undefined) {
    content.push({
      type: "toolCall",
      id: `call-${id}`,
      name: input.toolCall,
      arguments: { path: "docs/releases.md" },
    });
  }
  if (input.text !== undefined)
    content.push({ type: "text", text: input.text });
  return messageRow(id, {
    id,
    role: "assistant",
    content,
    api: "anthropic",
    provider: "anthropic",
    model: "fixture",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: stamp(input.offsetMinutes ?? 0),
  });
}

function toolResultRow(id: string, text: string): Record<string, unknown> {
  return messageRow(id, {
    id,
    role: "toolResult",
    toolCallId: `call-${id}`,
    toolName: "Write",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: stamp(0),
  });
}

function compactionRow(
  id: string,
  summary: string,
  packedText: string,
): Record<string, unknown> {
  const message = {
    id,
    role: "user",
    metadata: {
      created_at: new Date(stamp(4)).toISOString(),
      agent_id: AGENT_ID,
      conversation_id: CONVERSATION_ID,
      compaction: {
        summary,
        stats: { messages_count_before: 9, messages_count_after: 2 },
      },
    },
    content: [{ type: "text", text: packedText }],
    timestamp: stamp(4),
  };
  return {
    type: "compaction",
    id: `entry-${id}`,
    parentId: null,
    timestamp: new Date(stamp(4)).toISOString(),
    summary,
    firstKeptEntryId: null,
    tokensBefore: 100,
    message,
  };
}

function topicRow(input: {
  id: string;
  title: string;
  createdBy: "agent" | "user" | "summarizer";
  anchorMessageId: string | null;
  timestamp?: string;
}): Record<string, unknown> {
  return {
    type: "topic",
    id: input.id,
    parentId: null,
    timestamp: input.timestamp ?? new Date(stamp(9)).toISOString(),
    title: input.title,
    createdBy: input.createdBy,
    anchorMessageId: input.anchorMessageId,
    turnsSincePrevious: 1,
  };
}

const PACKED_SUMMARY =
  '{"type":"system_alert","level":"info","content":"packed summary payload"}';

/**
 * Eight messages, four markers, and one of each thing recall must drop.
 *
 * m1 user · m2 assistant (thinking + toolCall + text) · m3 toolResult ·
 * [t1 user, anchor m3] · m4 user (reminder + text) · m5 compaction summary ·
 * [t2 summarizer, anchor m5] · m6 assistant · m7 user · [t3 agent, anchor m7]
 * · [t4 user, anchor m7] · m8 assistant.
 *
 * The spans that follow from it: t1 = m1..m3, t2 = m4 only (the summarizer's
 * anchor is excluded), t3 = m5..m7 (it owns the anchor t2 excluded), t4 = empty
 * (it landed on t3's point).
 */
function seedFixture(): string {
  const storageDir = createStorageDirectory();
  writeConversation(
    storageDir,
    [
      userMessageRow("m1", "Where should the release notes live?", 0),
      assistantMessageRow("m2", {
        thinking: "PRIVATE-THINKING-TEXT",
        toolCall: "Write",
        text: "In docs/releases.md.",
        offsetMinutes: 1,
      }),
      toolResultRow("m3", "wrote 12 lines"),
      topicRow({
        id: "t1",
        title: "Release notes",
        createdBy: "user",
        anchorMessageId: "m3",
      }),
      userMessageRow(
        "m4",
        "<system-reminder>AUTO-CONTEXT-TEXT</system-reminder>\nShould we also publish to the wiki?",
        2,
      ),
      compactionRow(
        "m5",
        "Earlier: the release train was approved.",
        PACKED_SUMMARY,
      ),
      topicRow({
        id: "t2",
        title: "Wiki publishing",
        createdBy: "summarizer",
        anchorMessageId: "m5",
      }),
      assistantMessageRow("m6", {
        text: "Only if the release manager asks.",
        offsetMinutes: 5,
      }),
      userMessageRow("m7", "Noted — keep it in the repo for now.", 6),
      topicRow({
        id: "t3",
        title: "Keep it local",
        createdBy: "agent",
        anchorMessageId: "m7",
      }),
      topicRow({
        id: "t4",
        title: "Absorbed",
        createdBy: "user",
        anchorMessageId: "m7",
      }),
      assistantMessageRow("m8", { text: "Will do.", offsetMinutes: 7 }),
    ],
    // Only the tail is resident: t1's and t2's anchors were folded out.
    ["m6", "m7", "m8"],
  );
  return storageDir;
}

function readSpan(topicId: string, storageDir = seedFixture()) {
  return readTopicRecallSpan({
    storageDir,
    agentId: AGENT_ID,
    conversationId: CONVERSATION_ID,
    topicId,
  });
}

describe("cleanMessageTextForRecall", () => {
  type AssistantContent = Extract<
    LocalMessage,
    { role: "assistant" }
  >["content"];

  function assistant(content: AssistantContent, id = "a1"): LocalMessage {
    return {
      id,
      role: "assistant",
      content,
      api: "anthropic",
      provider: "anthropic",
      model: "fixture",
      usage: emptyLocalUsage(),
      stopReason: "stop",
      timestamp: 0,
    };
  }

  test("keeps user and assistant prose", () => {
    expect(
      cleanMessageTextForRecall({
        id: "u1",
        role: "user",
        content: [{ type: "text", text: "hello there" }],
        timestamp: 0,
      }),
    ).toBe("hello there");
    expect(
      cleanMessageTextForRecall(
        assistant([{ type: "text", text: "and back" }]),
      ),
    ).toBe("and back");
  });

  test("drops reasoning and tool calls, keeping only the text part", () => {
    const cleaned = cleanMessageTextForRecall(
      assistant([
        { type: "thinking", thinking: "SECRET-REASONING" },
        { type: "toolCall", id: "c1", name: "Write", arguments: {} },
        { type: "text", text: "The answer is 42." },
      ]),
    );
    expect(cleaned).toBe("The answer is 42.");
    expect(cleaned).not.toContain("SECRET-REASONING");
    expect(cleaned).not.toContain("Write");
  });

  test("drops a message that holds nothing but reasoning", () => {
    expect(
      cleanMessageTextForRecall(
        assistant([{ type: "thinking", thinking: "only thinking" }]),
      ),
    ).toBeNull();
  });

  test("drops a tool result whole", () => {
    expect(
      cleanMessageTextForRecall({
        id: "r1",
        role: "toolResult",
        toolCallId: "c1",
        toolName: "Write",
        content: [{ type: "text", text: "wrote 12 lines" }],
        isError: false,
        timestamp: 0,
      }),
    ).toBeNull();
  });

  test("strips reminder, alert and task-notification blocks and keeps the prose", () => {
    const cleaned = cleanMessageTextForRecall({
      id: "u2",
      role: "user",
      content: [
        {
          type: "text",
          text: [
            "<system-reminder>cleanup notice</system-reminder>",
            "<system-alert>legacy alert</system-alert>",
            "<task-notification><summary>bg task</summary></task-notification>",
            "Please rename the flag.",
          ].join("\n"),
        },
      ],
      timestamp: 0,
    });
    expect(cleaned).toBe("Please rename the flag.");
  });

  test("unpacks a compaction summary instead of printing its packed payload", () => {
    const cleaned = cleanMessageTextForRecall({
      id: "s1",
      role: "user",
      metadata: {
        compaction: {
          summary: "The release train was approved.",
          stats: { messages_count_before: 9, messages_count_after: 2 },
        },
      },
      content: [{ type: "text", text: PACKED_SUMMARY }],
      timestamp: 0,
    });
    expect(cleaned).toContain("The release train was approved.");
    expect(cleaned).toContain(
      "7 earlier messages are folded into this summary",
    );
    expect(cleaned).not.toContain("system_alert");
    expect(cleaned).not.toContain("packed summary payload");
  });

  test("replaces an image with a placeholder and never carries the payload", () => {
    const cleaned = cleanMessageTextForRecall({
      id: "u3",
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        { type: "image", data: "BASE64-IMAGE-DATA", mimeType: "image/png" },
      ],
      timestamp: 0,
    });
    expect(cleaned).toContain("[image]");
    expect(cleaned).not.toContain("BASE64-IMAGE-DATA");
  });

  test("returns null for a message that cleans to nothing", () => {
    expect(
      cleanMessageTextForRecall({
        id: "u4",
        role: "user",
        content: [
          {
            type: "text",
            text: "<system-reminder>only noise</system-reminder>",
          },
        ],
        timestamp: 0,
      }),
    ).toBeNull();
  });
});

describe("readTopicRecallSpan", () => {
  test("a user or agent marker owns its anchor message", () => {
    const span = readSpan("t1");
    expect(span?.messages.map((message) => message.position)).toEqual([1, 2]);
    expect(span?.messages.map((message) => message.text)).toEqual([
      "Where should the release notes live?",
      "In docs/releases.md.",
    ]);
  });

  test("a summarizer marker's anchor belongs to the next span", () => {
    const summarizer = readSpan("t2");
    expect(summarizer?.createdBy).toBe("summarizer");
    // Only m4: the anchor (m5) starts the next topic, so it is excluded.
    expect(summarizer?.messages).toHaveLength(1);
    expect(summarizer?.messages[0]?.text).toBe(
      "Should we also publish to the wiki?",
    );
    // …and the next span does own it.
    const next = readSpan("t3");
    expect(next?.messages[0]?.text).toContain("folded into this summary");
  });

  test("a marker sharing the previous marker's anchor has an empty span", () => {
    const span = readSpan("t4");
    expect(span?.messages).toEqual([]);
    const rendered = renderTopicRecall({
      span: span as NonNullable<typeof span>,
      tier: "full",
    });
    expect(rendered.messageCount).toBe(0);
    expect(rendered.text).toContain("no messages fall in this span");
  });

  test("an unknown marker id is null, not an empty span", () => {
    expect(readSpan("nope")).toBeNull();
  });

  test("an evicted anchor still reads in full and says so in the header", () => {
    const span = readSpan("t1");
    expect(span?.evicted).toBe(true);
    const rendered = recallTopicConversation({
      storageDir: seedFixture(),
      agentId: AGENT_ID,
      conversationId: CONVERSATION_ID,
      topicId: "t1",
      tier: "full",
    });
    expect(rendered?.evicted).toBe(true);
    expect(rendered?.text).toContain("no longer in the context");
    expect(rendered?.text).toContain("Where should the release notes live?");
    expect(rendered?.text).toContain("In docs/releases.md.");
  });

  test("a resident anchor is not reported as evicted", () => {
    const span = readSpan("t3");
    expect(span?.evicted).toBe(false);
  });

  test("nothing cleaned out of the span reaches the text", () => {
    const rendered = readSpan("t1");
    expect(rendered).not.toBeNull();
    const result = renderTopicRecall({
      span: rendered as NonNullable<typeof rendered>,
      tier: "full",
    });
    expect(result.text).not.toContain("PRIVATE-THINKING-TEXT");
    expect(result.text).not.toContain("wrote 12 lines");
    expect(result.text).not.toContain("call-m2");
  });

  test("a compaction summary is unpacked, never printed as its packed JSON", () => {
    const span = readSpan("t3");
    const result = renderTopicRecall({
      span: span as NonNullable<typeof span>,
      tier: "full",
    });
    expect(result.text).toContain("Earlier: the release train was approved.");
    expect(result.text).toContain("folded into this summary");
    expect(result.text).not.toContain("system_alert");
    expect(result.text).not.toContain("packed summary payload");
  });

  test("the text carries no message id and no path", () => {
    const storageDir = seedFixture();
    for (const topicId of ["t1", "t2", "t3"]) {
      const rendered = recallTopicConversation({
        storageDir,
        agentId: AGENT_ID,
        conversationId: CONVERSATION_ID,
        topicId,
        tier: "full",
      });
      const text = rendered?.text ?? "";
      for (const id of ["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8"]) {
        expect(text).not.toContain(` ${id} `);
        expect(text).not.toContain(`${id}:`);
      }
      expect(text).not.toContain(storageDir);
      expect(text).not.toContain("messages.jsonl");
      expect(text).not.toContain("conversations");
    }
  });

  test("a missing conversation reads as no span", () => {
    const storageDir = seedFixture();
    expect(
      readTopicRecallSpan({
        storageDir,
        agentId: AGENT_ID,
        conversationId: "conv-other",
        topicId: "t1",
      }),
    ).toBeNull();
  });
});

/** Twenty 200-character messages under one marker: enough to force a budget. */
function seedLongFixture(): string {
  const storageDir = createStorageDirectory();
  const rows: Record<string, unknown>[] = [];
  for (let index = 1; index <= 20; index += 1) {
    const body = `MESSAGE-${String(index).padStart(2, "0")}-${"x".repeat(180)}`;
    rows.push(
      index % 2 === 0
        ? assistantMessageRow(`m${index}`, { text: body, offsetMinutes: index })
        : userMessageRow(`m${index}`, body, index),
    );
  }
  rows.push(
    topicRow({
      id: "long",
      title: "A long topic",
      createdBy: "agent",
      anchorMessageId: "m20",
    }),
  );
  writeConversation(
    storageDir,
    rows,
    Array.from({ length: 20 }, (_unused, index) => `m${index + 1}`),
  );
  return storageDir;
}

describe("renderTopicRecall", () => {
  test("cuts a long full span to the ceiling and ends with the count", () => {
    const span = readSpan("long", seedLongFixture());
    const result = renderTopicRecall({
      span: span as NonNullable<typeof span>,
      tier: "full",
      maxChars: 800,
    });

    expect(result.chars).toBeLessThanOrEqual(800);
    expect(result.chars).toBe(result.text.length);
    expect(result.truncatedMessageCount).toBeGreaterThan(0);
    expect(result.text).toMatch(/\(and \d+ more messages not shown\)$/);
    expect(result.text.length).toBeLessThanOrEqual(800);
    // Whole messages only: the text never ends mid-word.
    expect(result.text).not.toMatch(/x+…$/);
  });

  test("the ceiling is a floor of 600 as well as the caller's number", () => {
    const span = readSpan("long", seedLongFixture());
    const result = renderTopicRecall({
      span: span as NonNullable<typeof span>,
      tier: "full",
      maxChars: 50,
    });
    expect(result.chars).toBeLessThanOrEqual(TOPIC_RECALL_MIN_MAX_CHARS);
    expect(result.text).toMatch(/\(and \d+ more messages not shown\)$/);
  });

  test("a span that fits carries no truncation notice", () => {
    const span = readSpan("t1");
    const result = renderTopicRecall({
      span: span as NonNullable<typeof span>,
      tier: "full",
    });
    expect(result.truncatedMessageCount).toBe(0);
    expect(result.text).not.toContain("not shown");
    expect(result.text).toBe(`${result.header}\n\n${result.body}`);
  });

  test("an excerpt keeps the head and the tail, not the middle", () => {
    const span = readSpan("long", seedLongFixture());
    const result = renderTopicRecall({
      span: span as NonNullable<typeof span>,
      tier: "excerpt",
    });

    expect(result.chars).toBeLessThanOrEqual(TOPIC_RECALL_EXCERPT_MAX_CHARS);
    expect(result.text).toContain("MESSAGE-01");
    expect(result.text).toContain("MESSAGE-20");
    // The numbering makes the gap visible instead of pretending it is contiguous.
    expect(result.text).toContain("18. assistant:");
    expect(result.text).not.toContain("MESSAGE-10");
    expect(result.truncatedMessageCount).toBeGreaterThan(0);
    expect(result.text).toMatch(/\(and \d+ more messages not shown\)$/);
  });

  test("a short span's excerpt is the whole span", () => {
    const span = readSpan("t1");
    const result = renderTopicRecall({
      span: span as NonNullable<typeof span>,
      tier: "excerpt",
    });
    expect(result.truncatedMessageCount).toBe(0);
    expect(result.text).toContain("Where should the release notes live?");
  });

  test("the default ceilings are the documented ones", () => {
    const span = readSpan("long", seedLongFixture());
    const full = renderTopicRecall({
      span: span as NonNullable<typeof span>,
      tier: "full",
    });
    expect(full.chars).toBeLessThanOrEqual(TOPIC_RECALL_FULL_MAX_CHARS);
  });

  test("one message longer than the whole budget is cut, not skipped", () => {
    const storageDir = createStorageDirectory();
    writeConversation(
      storageDir,
      [
        userMessageRow("m1", "y".repeat(4000), 0),
        topicRow({
          id: "huge",
          title: "One huge message",
          createdBy: "user",
          anchorMessageId: "m1",
        }),
      ],
      ["m1"],
    );
    const span = readSpan("huge", storageDir);
    const result = renderTopicRecall({
      span: span as NonNullable<typeof span>,
      tier: "full",
      maxChars: 800,
    });

    expect(result.chars).toBeLessThanOrEqual(800);
    expect(result.truncatedMessageCount).toBe(0);
    expect(result.text).toContain("…");
  });
});
