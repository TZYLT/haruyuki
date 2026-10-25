/**
 * Pins for feature-③ (context management) state that must survive
 * `conversation.json` round-trips.
 *
 * The local conversation record is loaded with a spread
 * (`parsePersistedLocalConversation`) and persisted by serializing the whole
 * in-memory object, which is what lets a conversation-level field this build does
 * not know about — written by a newer build, or by a future feature — survive
 * load → mutate → persist, and survive an `updateConversation` that touches an
 * unrelated key. If that ever stops holding, the one-shot topic nudge would
 * re-fire after every restart.
 *
 * `context_management` (the nudge flag, D-114) started as exactly such an unknown
 * field and is now typed; the first two tests keep the forward-compatibility pins
 * and the third drives the field through the write path that owns it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationMessageCreateBody } from "@/backend";
import { parsePersistedLocalConversation } from "@/backend/local/local-conversation-record";
import { LocalStore } from "@/backend/local/local-store";
import type { StoredConversation } from "@/backend/local/local-types";

const temporaryDirectories: string[] = [];

async function createStorageDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "local-conversation-record-"));
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

const agentId = "agent-record-round-trip";

function recordPath(storageDir: string, conversationId = "default"): string {
  // Mirrors LocalStore#conversationKey: only the default conversation is keyed
  // by agent id.
  const key =
    conversationId === "default"
      ? `default:${agentId}`
      : `conversation:${conversationId}`;
  return join(
    storageDir,
    "conversations",
    Buffer.from(key).toString("base64url"),
    "conversation.json",
  );
}

function sendUserMessage(store: LocalStore, text: string): void {
  store.appendTurnInput("default", {
    agent_id: agentId,
    messages: [{ role: "user", content: text }],
  } as ConversationMessageCreateBody);
}

describe("parsePersistedLocalConversation", () => {
  test("keeps fields the store does not know about", () => {
    const parsed = parsePersistedLocalConversation(
      JSON.stringify({
        id: "conv-1",
        agent_id: "agent-1",
        in_context_message_ids: [],
        context_management: { nudge_sent_for_streak: true },
        future_field: { nested: [1, 2, 3] },
      }),
      () => "agent-1",
    );

    expect(parsed).toBeDefined();
    expect(
      (parsed as unknown as Record<string, unknown>).context_management,
    ).toEqual({ nudge_sent_for_streak: true });
    expect((parsed as unknown as Record<string, unknown>).future_field).toEqual(
      { nested: [1, 2, 3] },
    );
  });

  test("resolves an agent-free record's execution agent id", () => {
    const parsed = parsePersistedLocalConversation(
      JSON.stringify({
        id: "conv-free",
        agent_id: null,
        agent_free: true,
        in_context_message_ids: [],
      }),
      (conversationId) => `execution-${conversationId}`,
    );

    expect(parsed?.agent_id).toBe("execution-conv-free");
  });

  test("rejects a record with no usable owner", () => {
    expect(
      parsePersistedLocalConversation(
        JSON.stringify({ id: "conv-2", agent_id: null }),
        () => "agent-1",
      ),
    ).toBeUndefined();
  });
});

describe("conversation record round-trip", () => {
  test("an unknown conversation field survives load, mutation, and persist", async () => {
    const storageDir = await createStorageDirectory();
    const store = new LocalStore(agentId, { storageDir });
    sendUserMessage(store, "first");

    // Simulate a newer build (or a future feature) writing conversation-level
    // state this build has no field for.
    const before = JSON.parse(await readFile(recordPath(storageDir), "utf8"));
    before.context_management = { nudge_sent_for_streak: true };
    await writeFile(recordPath(storageDir), JSON.stringify(before, null, 2));

    // Reopen: the field must load, then survive a store-initiated persist.
    const reopened = new LocalStore(agentId, { storageDir });
    sendUserMessage(reopened, "second");

    const after = JSON.parse(await readFile(recordPath(storageDir), "utf8"));
    expect(after.context_management).toEqual({
      nudge_sent_for_streak: true,
    });
    expect(after.in_context_message_ids).toHaveLength(2);
  });

  test("an unknown conversation field survives an update through the store", async () => {
    const storageDir = await createStorageDirectory();
    const store = new LocalStore(agentId, { storageDir });
    const created = store.createConversation({ agent_id: agentId });
    const path = recordPath(storageDir, created.id);

    const before = JSON.parse(await readFile(path, "utf8"));
    before.context_management = { nudge_sent_for_streak: true };
    await writeFile(path, JSON.stringify(before, null, 2));

    const reopened = new LocalStore(agentId, { storageDir });
    reopened.updateConversation(created.id, { summary: "renamed" });

    const after = JSON.parse(await readFile(path, "utf8"));
    expect(after.summary).toBe("renamed");
    expect(after.context_management).toEqual({
      nudge_sent_for_streak: true,
    });
  });
});

describe("createLocalConversationRecord provenance (F-01 §5.5)", () => {
  test("writes origin and context mode from the create body", () => {
    const store = new LocalStore(agentId);
    const created = store.createConversation({
      agent_id: agentId,
      hidden: true,
      origin: "external",
      context_mode: "standalone",
    } as never) as StoredConversation;

    expect(created.origin).toBe("external");
    expect(created.context_mode).toBe("standalone");
    // A create copies nothing, so the inheritance fields stay absent.
    expect(created.inherited_message_count).toBeUndefined();
    expect(created.inherited_through_message_id).toBeUndefined();
    expect(created.parent_conversation_id).toBeUndefined();
  });

  test("an ordinary create stays legacy-shaped (no provenance keys)", () => {
    const store = new LocalStore(agentId);
    const created = store.createConversation({
      agent_id: agentId,
    } as never) as StoredConversation;

    expect(created.origin).toBeUndefined();
    expect(created.context_mode).toBeUndefined();
  });

  test("drops an unrecognized origin instead of persisting it", () => {
    const store = new LocalStore(agentId);
    const created = store.createConversation({
      agent_id: agentId,
      origin: "sleeptime",
      context_mode: "inherited-everything",
    } as never) as StoredConversation;

    expect(created.origin).toBeUndefined();
    expect(created.context_mode).toBeUndefined();
  });

  test("round-trips through conversation.json", async () => {
    const storageDir = await createStorageDirectory();
    const store = new LocalStore(agentId, { storageDir });
    const created = store.createConversation({
      agent_id: agentId,
      hidden: true,
      origin: "dream",
      context_mode: "standalone",
    } as never);

    const reopened = new LocalStore(agentId, { storageDir });
    const record = reopened.retrieveConversation(
      created.id,
    ) as StoredConversation;

    expect(record.hidden).toBe(true);
    expect(record.origin).toBe("dream");
    expect(record.context_mode).toBe("standalone");
  });
});

describe("the typed context_management field (D-114)", () => {
  test("round-trips through the write path that sets and clears it", async () => {
    const storageDir = await createStorageDirectory();
    const store = new LocalStore(agentId, { storageDir });
    sendUserMessage(store, "first");

    expect(
      store.contextRewrites.readContextManagement("default", agentId),
    ).toEqual({});

    store.contextRewrites.setTopicNudgeSent("default", agentId, true);
    const written = JSON.parse(await readFile(recordPath(storageDir), "utf8"));
    expect(written.context_management).toEqual({ nudge_sent_for_streak: true });

    // The flag is durable: a restart reads the same answer, which is what stops
    // the nudge from firing again after every reload.
    const reopened = new LocalStore(agentId, { storageDir });
    expect(
      reopened.contextRewrites.readContextManagement("default", agentId),
    ).toEqual({ nudge_sent_for_streak: true });
    // Writing the same value again is a no-op, so a per-turn reader is free.
    reopened.contextRewrites.setTopicNudgeSent("default", agentId, true);
    expect(
      JSON.parse(await readFile(recordPath(storageDir), "utf8"))
        .context_management,
    ).toEqual({ nudge_sent_for_streak: true });

    // A finished stretch clears it, leaving no empty object behind.
    reopened.contextRewrites.setTopicNudgeSent("default", agentId, false);
    expect(
      JSON.parse(await readFile(recordPath(storageDir), "utf8"))
        .context_management,
    ).toBeUndefined();
  });
});
