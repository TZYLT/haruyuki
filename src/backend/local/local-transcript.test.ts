import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type {
  ConversationMessageCreateBody,
  ConversationMessageListBody,
} from "@/backend";
import type { LocalMessage } from "@/backend/local/local-message";
import { LocalStore } from "@/backend/local/local-store";
import {
  LOCAL_TRANSCRIPT_MESSAGE_FORMAT,
  LocalTranscriptRepairRequiredError,
  type LocalTranscriptRowsResult,
  localTranscriptRowsResult,
  overlayResidentLocalMessageSuffix,
  readLocalTranscriptTailWindow,
  restrictLocalTranscriptToResidentMessages,
  spliceOutOfContextMessages,
} from "@/backend/local/local-transcript";

const temporaryDirectories: string[] = [];

async function createStorageDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "local-transcript-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

function userMessage(id: string, text: string): LocalMessage {
  return {
    id,
    role: "user",
    content: [{ type: "text", text }],
    timestamp: 0,
  } as LocalMessage;
}

describe("readLocalTranscriptTailWindow", () => {
  test("stops once the suffix covers every in-context id", async () => {
    const storageDir = await createStorageDirectory();
    const messagesPath = join(storageDir, "messages.jsonl");
    const messageCount = 200;
    const lines = [
      JSON.stringify({
        type: "session",
        version: 3,
        id: "conversation-compacted",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: storageDir,
      }),
    ];
    const messageIds: string[] = [];
    let parentId: string | null = null;
    for (let index = 0; index < messageCount; index += 1) {
      const messageId = `msg-${index}`;
      const entryId = `ent-${index}`;
      messageIds.push(messageId);
      lines.push(
        JSON.stringify({
          type: "message",
          id: entryId,
          parentId,
          timestamp: "2026-01-01T00:00:00.000Z",
          message: {
            id: messageId,
            role: index % 2 === 0 ? "user" : "assistant",
            content: [
              { type: "text", text: `payload-${index}-${"x".repeat(400)}` },
            ],
            timestamp: 0,
          },
        }),
      );
      parentId = entryId;
    }
    await writeFile(messagesPath, `${lines.join("\n")}\n`);

    const activeMessageIds = messageIds.slice(-5);
    const result = readLocalTranscriptTailWindow(
      messagesPath,
      LOCAL_TRANSCRIPT_MESSAGE_FORMAT,
      activeMessageIds,
      100,
      storageDir,
      storageDir,
    );

    expect(result.reachedStart).toBe(false);
    expect(result.messages.map((message) => message.id)).toEqual(
      activeMessageIds,
    );
    expect(result.transcript.messageById.size).toBeLessThan(messageCount);
  });
});

describe("restrictLocalTranscriptToResidentMessages", () => {
  test("drops historical suffix rows from persist maps", () => {
    const resident = [userMessage("keep-a", "a"), userMessage("keep-b", "b")];
    const historical = userMessage("old", "old");
    const transcript: LocalTranscriptRowsResult = {
      messages: resident,
      entryIds: new Set(["e-old", "e-a", "e-b", "e-last"]),
      entryIdByMessageId: new Map([
        ["old", "e-old"],
        ["keep-a", "e-a"],
        ["keep-b", "e-b"],
      ]),
      messageById: new Map([
        ["old", historical],
        ["keep-a", resident[0] as LocalMessage],
        ["keep-b", resident[1] as LocalMessage],
      ]),
      lastEntryId: "e-last",
      sourceStartIndex: 0,
    };

    const restricted = restrictLocalTranscriptToResidentMessages(
      transcript,
      resident,
    );
    expect([...restricted.messageById.keys()]).toEqual(["keep-a", "keep-b"]);
    expect([...restricted.entryIdByMessageId.keys()]).toEqual([
      "keep-a",
      "keep-b",
    ]);
    expect(restricted.entryIds.has("e-old")).toBe(false);
    expect(restricted.entryIds.has("e-last")).toBe(true);
    expect(restricted.lastEntryId).toBe("e-last");
  });
});

describe("local transcript topic markers", () => {
  function topicRow(input: {
    id: string;
    parentId?: string | null;
    title: string;
    summary?: string;
    createdBy?: "agent" | "user";
    anchorMessageId?: string | null;
    turnsSincePrevious?: number;
  }): Record<string, unknown> {
    return {
      type: "topic",
      id: input.id,
      parentId: input.parentId ?? null,
      timestamp: "2026-01-01T00:00:00.000Z",
      title: input.title,
      ...(input.summary === undefined ? {} : { summary: input.summary }),
      createdBy: input.createdBy ?? "agent",
      anchorMessageId: input.anchorMessageId ?? "msg-2",
      turnsSincePrevious: input.turnsSincePrevious ?? 3,
    };
  }

  function messageRow(id: string, parentId: string | null, text: string) {
    return {
      type: "message",
      id: `entry-${id}`,
      parentId,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: {
        id,
        role: "user",
        content: [{ type: "text", text }],
        timestamp: 0,
      },
    };
  }

  test("rows keep markers out of the projection and out of the entry map", () => {
    const rows = [
      messageRow("msg-1", null, "one"),
      topicRow({ id: "topic-1", parentId: "entry-msg-1", title: "first" }),
      messageRow("msg-2", "topic-1", "two"),
    ];

    const result = localTranscriptRowsResult(
      rows,
      LOCAL_TRANSCRIPT_MESSAGE_FORMAT,
    );

    expect(result.messages.map((message) => message.id)).toEqual([
      "msg-1",
      "msg-2",
    ]);
    expect(result.entryIdByMessageId.size).toBe(2);
    expect(result.entryIds.has("topic-1")).toBe(false);
    expect(result.lastEntryId).toBe("entry-msg-2");
  });

  test("a trailing marker owns lastEntryId without entering context", () => {
    const rows = [
      messageRow("msg-1", null, "one"),
      topicRow({ id: "topic-9", parentId: "entry-msg-1", title: "done" }),
    ];
    const result = localTranscriptRowsResult(
      rows,
      LOCAL_TRANSCRIPT_MESSAGE_FORMAT,
    );

    expect(result.lastEntryId).toBe("topic-9");
    expect(result.messages).toHaveLength(1);
    expect(result.messageById.has("topic-9")).toBe(false);
  });

  test("tail reads ignore a marker sitting inside the window", async () => {
    const storageDir = await createStorageDirectory();
    const messagesPath = join(storageDir, "messages.jsonl");
    await writeFile(
      messagesPath,
      `${[
        JSON.stringify({
          type: "session",
          version: 3,
          id: "conversation-1",
          timestamp: "2026-01-01T00:00:00.000Z",
          cwd: storageDir,
        }),
        JSON.stringify(messageRow("msg-1", null, "one")),
        JSON.stringify(
          topicRow({ id: "topic-1", parentId: "entry-msg-1", title: "first" }),
        ),
        JSON.stringify(messageRow("msg-2", "topic-1", "two")),
      ].join("\n")}\n`,
    );

    const tail = readLocalTranscriptTailWindow(
      messagesPath,
      LOCAL_TRANSCRIPT_MESSAGE_FORMAT,
      [],
      10,
      storageDir,
      storageDir,
    );

    expect(tail.messages.map((message) => message.id)).toEqual([
      "msg-1",
      "msg-2",
    ]);
    expect(tail.transcript.lastEntryId).toBe("entry-msg-2");
  });
});

describe("overlayResidentLocalMessageSuffix", () => {
  test("appends the in-flight assistant and ignores older resident-only ids", () => {
    const disk = [userMessage("d1", "disk-1"), userMessage("d2", "disk-2")];
    const resident = [
      userMessage("older", "should-not-lead-or-trail"),
      userMessage("d1", "resident-d1"),
      userMessage("d2", "resident-d2"),
      userMessage("in-flight", "IN_FLIGHT_ASSISTANT"),
    ];
    const persisted = new Set(["older", "d1", "d2"]);
    const merged = overlayResidentLocalMessageSuffix(
      disk,
      resident,
      (messageId) => persisted.has(messageId),
    );
    expect(merged.map((message) => message.id)).toEqual([
      "d1",
      "d2",
      "in-flight",
    ]);
    expect(merged[0]).toEqual(resident[1]);
    expect(JSON.stringify(merged)).toContain("IN_FLIGHT_ASSISTANT");
    expect(JSON.stringify(merged)).not.toContain("should-not-lead-or-trail");
  });
});

describe("in-context tail window and unread head validation", () => {
  const agentId = "agent-head-validation";

  function appendTurn(store: LocalStore, text: string): void {
    store.appendTurnInput("default", {
      agent_id: agentId,
      messages: [{ role: "user", content: text }],
    } as ConversationMessageCreateBody);
    store.appendStreamChunk("default", agentId, {
      message_type: "assistant_message",
      content: [{ type: "text", text: `reply: ${text}` }],
    } as LettaStreamingResponse);
    store.appendStreamChunk("default", agentId, {
      message_type: "stop_reason",
      stop_reason: "end_turn",
    });
  }

  function conversationPath(storageDir: string, file: string): string {
    const key = Buffer.from(`default:${agentId}`).toString("base64url");
    return join(storageDir, "conversations", key, file);
  }

  // 80 messages of ~2 KB. The tail load parses every in-context row, so an
  // unparsed head only remains for compacted history (`compactKeep`) or for
  // a record without an in-context list (`clearInContext`, where the 4-message
  // floor bounds the window and every message counts as in context).
  async function seedTranscript(
    options: { compactKeep?: number; clearInContext?: boolean } = {},
  ): Promise<string> {
    const storageDir = await createStorageDirectory();
    const store = freshStore(storageDir);
    for (let turn = 0; turn < 40; turn += 1) {
      appendTurn(store, `turn-${turn}-${"y".repeat(2000)}`);
    }
    if (options.compactKeep !== undefined) {
      const messages = store.listLocalMessages("default", agentId);
      store.contextRewrites.rewriteInContext({
        conversationId: "default",
        agentId,
        summary: "summary",
        packedSummary: "packed summary",
        remainingMessages: messages.slice(-options.compactKeep),
      });
    }
    if (options.clearInContext) {
      const recordPath = conversationPath(storageDir, "conversation.json");
      const record = JSON.parse(await readFile(recordPath, "utf8"));
      record.in_context_message_ids = [];
      await writeFile(recordPath, JSON.stringify(record));
    }
    return storageDir;
  }

  function freshStore(storageDir: string): LocalStore {
    return new LocalStore(agentId, { storageDir, residentMessageTailLimit: 4 });
  }

  function sendUserMessage(store: LocalStore, text: string): void {
    store.appendTurnInput("default", {
      agent_id: agentId,
      messages: [{ role: "user", content: text }],
    } as ConversationMessageCreateBody);
  }

  async function wrapLegacyUiMessage(messagesPath: string): Promise<string> {
    const lines = (await readFile(messagesPath, "utf8")).split("\n");
    const entry = JSON.parse(lines[1] ?? "{}");
    entry.message = { id: entry.message.id, role: "user", parts: [] };
    lines[1] = JSON.stringify(entry);
    await writeFile(messagesPath, lines.join("\n"));
    return lines.join("\n");
  }

  async function corruptFirstLine(messagesPath: string): Promise<string> {
    const original = await readFile(messagesPath, "utf8");
    const corrupted = `{corrupt\n${original.slice(original.indexOf("\n") + 1)}`;
    await writeFile(messagesPath, corrupted);
    return corrupted;
  }

  test("rejects a corrupt line straddling the tail-window boundary", async () => {
    const storageDir = await seedTranscript({ compactKeep: 2 });
    const messagesPath = conversationPath(storageDir, "messages.jsonl");
    const original = await readFile(messagesPath, "utf8");
    // The 64 KB suffix drops its partial first line; that line must still be
    // validated as part of the head. Corrupt it in place (same length).
    const boundary = Buffer.byteLength(original) - 64 * 1024;
    const lineStart = original.lastIndexOf("\n", boundary - 1) + 1;
    const corrupted = `${original.slice(0, lineStart)}X${original.slice(lineStart + 1)}`;
    await writeFile(messagesPath, corrupted);

    const store = freshStore(storageDir);
    expect(() => sendUserMessage(store, "after corruption")).toThrow();
    expect(() => sendUserMessage(store, "retry")).toThrow();
    expect(await readFile(messagesPath, "utf8")).toBe(corrupted);
  });

  test("rejects a legacy UI message in the unread head of an all-messages record", async () => {
    const storageDir = await seedTranscript({ clearInContext: true });
    const messagesPath = conversationPath(storageDir, "messages.jsonl");
    const legacy = await wrapLegacyUiMessage(messagesPath);

    const store = freshStore(storageDir);
    expect(() => sendUserMessage(store, "after legacy row")).toThrow(
      LocalTranscriptRepairRequiredError,
    );
    expect(() => sendUserMessage(store, "retry")).toThrow(
      LocalTranscriptRepairRequiredError,
    );
    expect(await readFile(messagesPath, "utf8")).toBe(legacy);
  });

  test("ignores legacy UI rows that compaction dropped from context", async () => {
    const storageDir = await seedTranscript({ compactKeep: 2 });
    await wrapLegacyUiMessage(conversationPath(storageDir, "messages.jsonl"));

    const reopened = freshStore(storageDir);
    sendUserMessage(reopened, "after compaction");
    expect(reopened.listLocalMessages("default", agentId)).toHaveLength(4);
  });

  test("keeps the head check pending after a failed full read", async () => {
    const storageDir = await seedTranscript({ clearInContext: true });
    const messagesPath = conversationPath(storageDir, "messages.jsonl");
    const corrupted = await corruptFirstLine(messagesPath);

    const store = freshStore(storageDir);
    expect(() => sendUserMessage(store, "first")).toThrow();
    // A full-history read (e.g. /compact or an asc listing) fails too; it must
    // not clear the pending head check for the next send.
    expect(() => store.listLocalMessages("default", agentId)).toThrow();
    expect(() => sendUserMessage(store, "retry")).toThrow();
    expect(await readFile(messagesPath, "utf8")).toBe(corrupted);
  });

  test("compaction validates the head before rewriting the conversation record", async () => {
    const storageDir = await seedTranscript({ compactKeep: 2 });
    const messagesPath = conversationPath(storageDir, "messages.jsonl");
    const recordPath = conversationPath(storageDir, "conversation.json");
    await corruptFirstLine(messagesPath);
    const record = await readFile(recordPath, "utf8");

    // Tail loaded by a non-writing path; the compacted in-context set is
    // resident, so reads never touch the corrupt head.
    const reopened = freshStore(storageDir);
    reopened.settleInterruptedToolCalls("default", { agentId });
    const current = reopened.listLocalMessages("default", agentId);
    expect(() =>
      reopened.contextRewrites.rewriteInContext({
        conversationId: "default",
        agentId,
        summary: "summary 2",
        packedSummary: "packed summary 2",
        remainingMessages: current.slice(-1),
      }),
    ).toThrow();
    expect(await readFile(recordPath, "utf8")).toBe(record);
  });

  test("serves a long uncompacted history from memory after the tail load", async () => {
    const storageDir = await seedTranscript();
    const store = freshStore(storageDir);
    appendTurn(store, "after reload");
    // Every in-context message is resident despite the 4-message floor, so
    // full-history reads never go back to disk.
    await writeFile(conversationPath(storageDir, "messages.jsonl"), "{gone\n");
    const messages = store.listLocalMessages("default", agentId);
    expect(messages).toHaveLength(82);
    expect(JSON.stringify(messages[0])).toContain("turn-0-");
    expect(JSON.stringify(messages.at(-1))).toContain("reply: after reload");
    const ascending = store.listConversationMessages("default", {
      agent_id: agentId,
      order: "asc",
    } as ConversationMessageListBody);
    expect(ascending.length).toBeGreaterThanOrEqual(82);
    expect(inspectResidency(store).residentMessages).toBe(82);
    expect(inspectResidency(store).persistedSnapshots).toBe(82);
  });

  test("compaction drops replaced messages from the window and snapshot index", async () => {
    const storageDir = await seedTranscript();
    const store = freshStore(storageDir);
    const messages = store.listLocalMessages("default", agentId);
    store.settleInterruptedToolCalls("default", { agentId });
    expect(inspectResidency(store).persistedSnapshots).toBe(80);
    store.contextRewrites.rewriteInContext({
      conversationId: "default",
      agentId,
      summary: "summary",
      packedSummary: "packed summary",
      remainingMessages: messages.slice(-6),
    });
    // Summary + 6 kept exceeds the 4-message floor; none of it is evicted.
    expect(inspectResidency(store)).toEqual({
      residentMessages: 7,
      persistedSnapshots: 7,
    });
  });

  test("drops an in-context id a killed stream left without a row", async () => {
    const storageDir = await seedTranscript({ compactKeep: 2 });
    const recordPath = conversationPath(storageDir, "conversation.json");
    const killed = freshStore(storageDir);
    sendUserMessage(killed, "question");
    killed.appendStreamChunk("default", agentId, {
      message_type: "assistant_message",
      content: [{ type: "text", text: "partial answ" }],
    } as LettaStreamingResponse);
    const danglingId = JSON.parse(
      await readFile(recordPath, "utf8"),
    ).in_context_message_ids.at(-1);

    const restarted = freshStore(storageDir);
    sendUserMessage(restarted, "after restart");
    const inContext = JSON.parse(await readFile(recordPath, "utf8"))
      .in_context_message_ids as string[];
    expect(inContext).toHaveLength(5);
    expect(inContext).not.toContain(danglingId);
    // The window covers the pruned context: reads stay off disk.
    await writeFile(conversationPath(storageDir, "messages.jsonl"), "{gone\n");
    expect(restarted.listLocalMessages("default", agentId)).toHaveLength(5);
  });

  test("a raw page reaches the messages compaction dropped from context", async () => {
    const storageDir = await seedTranscript({ compactKeep: 2 });
    const store = freshStore(storageDir);

    // The projection is the compacted window: the summary plus what was kept.
    const projected = store.listConversationMessages("default", {
      agent_id: agentId,
      order: "asc",
    } as ConversationMessageListBody);
    expect(projected.length).toBeLessThanOrEqual(3);

    // A raw page is the conversation as the user saw it. `include_out_of_context`
    // is what makes that possible: the in-context filter is dropped, so every row
    // the compaction removed is readable again, in log order.
    const raw = store.listConversationMessages("default", {
      agent_id: agentId,
      order: "desc",
      limit: 500,
      include_out_of_context: true,
    } as ConversationMessageListBody);
    expect(raw.length).toBeGreaterThan(projected.length);
    const projectedIds = new Set(projected.map((message) => message.id));
    expect(raw.some((message) => !projectedIds.has(message.id))).toBe(true);

    // Oldest first, the first row is the first turn: the page walked past the
    // compaction, which is exactly what the in-context projection cannot do.
    const oldestFirst = [...raw].reverse();
    expect(JSON.stringify(oldestFirst[0])).toContain("turn-0-");
    // And paging before that row finds nothing: that is the true start.
    const older = store.listConversationMessages("default", {
      agent_id: agentId,
      order: "desc",
      limit: 10,
      before: oldestFirst[0]?.id ?? "",
      include_out_of_context: true,
    } as ConversationMessageListBody);
    expect(older).toHaveLength(0);
  });
});

describe("spliceOutOfContextMessages", () => {
  const messages = () =>
    ["a", "b", "c", "d", "e"].map((id) => userMessage(id, id));

  test("evicts out-of-context messages oldest first down to the floor", () => {
    const window = messages();
    const evicted = spliceOutOfContextMessages(window, ["b", "d"], 2);
    expect(evicted.map((message) => message.id)).toEqual(["a", "c"]);
    // The newest message stays even though it is not yet in context.
    expect(window.map((message) => message.id)).toEqual(["b", "d", "e"]);
  });

  test("keeps the window at the floor", () => {
    const window = messages();
    expect(spliceOutOfContextMessages(window, ["e"], 4)).toHaveLength(1);
    expect(window.map((message) => message.id)).toEqual(["b", "c", "d", "e"]);
  });
});

type ResidencyInternals = {
  localMessagesByConversationKey: Map<string, unknown[]>;
  persistedMessageByMessageIdByConversationKey: Map<
    string,
    Map<string, unknown>
  >;
};

function inspectResidency(store: LocalStore) {
  const internals = store as unknown as ResidencyInternals;
  const key = "default:agent-head-validation";
  return {
    residentMessages:
      internals.localMessagesByConversationKey.get(key)?.length ?? 0,
    persistedSnapshots:
      internals.persistedMessageByMessageIdByConversationKey.get(key)?.size ??
      0,
  };
}
