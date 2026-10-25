import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationMessageCreateBody } from "@/backend";
import { LocalBackend } from "@/backend/local/local-backend";
import { deleteLocalConversationSettings } from "@/backend/local/local-conversation-delete-settings";
import {
  LocalBackendNotFoundError,
  LocalStore,
} from "@/backend/local/local-store";
import type { StoredConversation } from "@/backend/local/local-types";
import {
  rebuildConversationIndex,
  recallIndexPath,
} from "@/backend/local/recall-index";
import type { LocalCompiledSystemPrompt } from "@/backend/local/system-prompt-compilation";
import { settingsManager } from "@/settings-manager";

const agentId = "agent-local-conversation-delete";

function compiledSnapshot(): LocalCompiledSystemPrompt {
  return {
    content: "compiled system",
    coreMemory: "core",
    compiledAt: "2026-01-01T00:00:00.000Z",
    systemTemplateHash: "hash",
    memfsRevision: "rev",
    freezeSchema: 1,
    frozenSkillsBlock: "<available_skills>A</available_skills>",
    frozenTools: '[{"name":"A"}]',
    frozenModel: "anthropic/x",
    frozenModelSettings: "{}",
    frozenReason: "conversation_created",
  };
}

/** Mirrors `LocalStore.conversationKey`: only "default" is keyed by agent. */
function conversationKeyFor(conversationId: string): string {
  return `conversation:${conversationId}`;
}

function conversationDirFor(
  storageDir: string,
  conversationId: string,
): string {
  return join(
    storageDir,
    "conversations",
    Buffer.from(conversationKeyFor(conversationId)).toString("base64url"),
  );
}

function appendUserMessages(
  store: LocalStore,
  conversationId: string,
  texts: string[],
): void {
  store.appendTurnInput(conversationId, {
    agent_id: agentId,
    messages: texts.map((text) => ({ role: "user", content: text })),
  } as unknown as ConversationMessageCreateBody);
}

function trashEntries(storageDir: string): string[] {
  const trashDir = join(storageDir, "trash");
  return existsSync(trashDir) ? readdirSync(trashDir) : [];
}

/**
 * The per-conversation caches are private; a deletion is only observably correct
 * if every one of them dropped the key, so the test reads them directly.
 */
interface StoreCaches {
  conversations: Map<string, StoredConversation>;
  localMessagesByConversationKey: Map<string, unknown[]>;
  loadedConversationKeys: Set<string>;
  tailResidentConversationKeys: Set<string>;
  residentTailStartIndexByConversationKey: Map<string, number>;
  loadRepairedConversationKeys: Set<string>;
  unreadTranscriptHeadBytesByKey: Map<string, number>;
  transcriptMetadataByConversationKey: Map<string, unknown>;
  conversationRecordJsonByKey: Map<string, string>;
  sessionEntryIdsByConversationKey: Map<string, Set<string>>;
  sessionEntryIdByMessageIdByConversationKey: Map<string, Map<string, string>>;
  persistedMessageByMessageIdByConversationKey: Map<
    string,
    Map<string, unknown>
  >;
  lastSessionEntryIdByConversationKey: Map<string, string | null>;
  compiledSystemPromptByConversationKey: Map<string, LocalCompiledSystemPrompt>;
  messagesById: Map<string, Array<{ conversation_id: string }>>;
  settledLocalMessageIds: Set<string>;
}

function caches(store: LocalStore): StoreCaches {
  return store as unknown as StoreCaches;
}

function keyedCaches(
  store: LocalStore,
): Map<string, { has(key: string): boolean }> {
  const internals = caches(store);
  return new Map<string, { has(key: string): boolean }>([
    ["conversations", internals.conversations],
    [
      "localMessagesByConversationKey",
      internals.localMessagesByConversationKey,
    ],
    ["loadedConversationKeys", internals.loadedConversationKeys],
    ["tailResidentConversationKeys", internals.tailResidentConversationKeys],
    [
      "residentTailStartIndexByConversationKey",
      internals.residentTailStartIndexByConversationKey,
    ],
    ["loadRepairedConversationKeys", internals.loadRepairedConversationKeys],
    [
      "unreadTranscriptHeadBytesByKey",
      internals.unreadTranscriptHeadBytesByKey,
    ],
    [
      "transcriptMetadataByConversationKey",
      internals.transcriptMetadataByConversationKey,
    ],
    ["conversationRecordJsonByKey", internals.conversationRecordJsonByKey],
    [
      "sessionEntryIdsByConversationKey",
      internals.sessionEntryIdsByConversationKey,
    ],
    [
      "sessionEntryIdByMessageIdByConversationKey",
      internals.sessionEntryIdByMessageIdByConversationKey,
    ],
    [
      "persistedMessageByMessageIdByConversationKey",
      internals.persistedMessageByMessageIdByConversationKey,
    ],
    [
      "lastSessionEntryIdByConversationKey",
      internals.lastSessionEntryIdByConversationKey,
    ],
    [
      "compiledSystemPromptByConversationKey",
      internals.compiledSystemPromptByConversationKey,
    ],
  ]);
}

function indexedConversationIds(store: LocalStore): Set<string> {
  const ids = new Set<string>();
  for (const messages of caches(store).messagesById.values()) {
    for (const message of messages) ids.add(message.conversation_id);
  }
  return ids;
}

describe("LocalStore.deleteConversation", () => {
  let storageDir: string;

  beforeEach(async () => {
    storageDir = await mkdtemp(join(tmpdir(), "local-conversation-delete-"));
  });

  afterEach(async () => {
    await rm(storageDir, { recursive: true, force: true });
  });

  test("removes the directory, record, transcript, snapshot and recall sidecar", () => {
    const store = new LocalStore(agentId, {
      storageDir,
      strictConversationAccess: true,
    });
    const conversation = store.createConversation({
      agent_id: agentId,
    } as never);
    appendUserMessages(store, conversation.id, ["first turn", "second turn"]);
    store.setCompiledSystemPrompt(conversation.id, agentId, compiledSnapshot());

    const conversationDir = conversationDirFor(storageDir, conversation.id);
    const index = rebuildConversationIndex({
      conversationDir,
      identity: {
        conversationKey: conversationKeyFor(conversation.id),
        conversationId: conversation.id,
        agentId,
      },
    });
    expect("sidecar" in index).toBe(true);
    expect(existsSync(recallIndexPath(conversationDir))).toBe(true);
    expect(existsSync(join(conversationDir, "conversation.json"))).toBe(true);
    const storedMessages = store.listConversationMessages(conversation.id, {
      agent_id: agentId,
      order: "asc",
      limit: 50,
    });
    const storedMessageId = storedMessages[0]?.id;
    if (!storedMessageId) throw new Error("expected a stored message");
    expect(store.retrieveMessage(storedMessageId)).not.toHaveLength(0);

    store.deleteConversation(conversation.id, agentId);

    expect(existsSync(conversationDir)).toBe(false);
    expect(trashEntries(storageDir)).toEqual([]);
    expect(store.listConversations({ agent_id: agentId })).toEqual([]);
    expect(
      store.getCompiledSystemPrompt(conversation.id, agentId),
    ).toBeUndefined();
    expect(() => store.retrieveConversation(conversation.id)).toThrow(
      LocalBackendNotFoundError,
    );
    // A strict read is what makes "physically gone" observable: a non-strict
    // store would re-create the conversation instead (requirement §2.5 note).
    expect(() =>
      store.listConversationMessages(conversation.id, { agent_id: agentId }),
    ).toThrow(LocalBackendNotFoundError);
    // The lookup index no longer serves the deleted projection.
    expect(() => store.retrieveMessage(storedMessageId)).toThrow(
      LocalBackendNotFoundError,
    );
  });

  test("forgets every per-conversation cache and index entry", () => {
    const first = new LocalStore(agentId, {
      storageDir,
      strictConversationAccess: true,
      residentMessageTailLimit: 1,
    });
    const conversation = first.createConversation({
      agent_id: agentId,
    } as never);
    appendUserMessages(first, conversation.id, ["one", "two"]);

    // A second store loads the record and the transcript tail from disk, which
    // is what fills the transcript metadata, session entry and resident-window
    // caches in a running process.
    const store = new LocalStore(agentId, {
      storageDir,
      strictConversationAccess: true,
      residentMessageTailLimit: 1,
    });
    store.setCompiledSystemPrompt(conversation.id, agentId, compiledSnapshot());
    appendUserMessages(store, conversation.id, ["three"]);

    const key = conversationKeyFor(conversation.id);
    const internals = caches(store);
    const localMessageIds = store
      .listLocalMessages(conversation.id, agentId)
      .map((message) => message.id);
    expect(localMessageIds.length).toBeGreaterThan(0);
    // These two caches only fill from a >64KB transcript tail read or a legacy
    // repair; seed them so the assertions below cannot pass by accident.
    internals.loadedConversationKeys.add(key);
    internals.loadRepairedConversationKeys.add(key);
    internals.unreadTranscriptHeadBytesByKey.set(key, 128);
    // The settled-turn set is keyed by local message id, same as the index.
    const settledId = localMessageIds[0];
    if (!settledId) throw new Error("expected a local message id");
    internals.settledLocalMessageIds.add(settledId);

    for (const [name, cache] of keyedCaches(store)) {
      expect({ name, holds: cache.has(key) }).toEqual({ name, holds: true });
    }
    expect(indexedConversationIds(store)).toContain(conversation.id);

    store.deleteConversation(conversation.id, agentId);

    for (const [name, cache] of keyedCaches(store)) {
      expect({ name, holds: cache.has(key) }).toEqual({
        name,
        holds: false,
      });
    }
    expect(indexedConversationIds(store)).not.toContain(conversation.id);
    expect(caches(store).settledLocalMessageIds.has(settledId)).toBe(false);
  });

  test("does not resurrect the conversation after a same-process reload", () => {
    const store = new LocalStore(agentId, {
      storageDir,
      strictConversationAccess: true,
    });
    const conversation = store.createConversation({
      agent_id: agentId,
    } as never);
    appendUserMessages(store, conversation.id, ["only turn"]);
    store.deleteConversation(conversation.id, agentId);

    const reloaded = new LocalStore(agentId, {
      storageDir,
      strictConversationAccess: true,
    });

    expect(reloaded.listConversations({ agent_id: agentId })).toEqual([]);
    expect(() => reloaded.retrieveConversation(conversation.id)).toThrow(
      LocalBackendNotFoundError,
    );
    expect(existsSync(conversationDirFor(storageDir, conversation.id))).toBe(
      false,
    );
  });

  test("rejects the agent's default conversation", () => {
    const store = new LocalStore(agentId, { storageDir });

    expect(() => store.deleteConversation("default")).toThrow(
      "Default conversation cannot be deleted",
    );
    expect(() => store.deleteConversation("default", agentId)).toThrow(
      "Default conversation cannot be deleted",
    );
  });

  test("throws not found for an unknown conversation id", () => {
    const store = new LocalStore(agentId, {
      storageDir,
      strictConversationAccess: true,
    });

    expect(() => store.deleteConversation("conv-local-missing")).toThrow(
      LocalBackendNotFoundError,
    );
    expect(() =>
      store.deleteConversation("conv-local-missing", agentId),
    ).toThrow(/Conversation conv-local-missing not found/);
  });

  test("leaves the conversation readable when it cannot leave the live tree", () => {
    const store = new LocalStore(agentId, {
      storageDir,
      strictConversationAccess: true,
    });
    const conversation = store.createConversation({
      agent_id: agentId,
    } as never);
    appendUserMessages(store, conversation.id, ["kept turn"]);
    // A plain file where the trash directory has to be makes the move fail
    // before any memory state changes.
    const blocker = join(storageDir, "trash");
    writeFileSync(blocker, "not a directory");

    expect(() => store.deleteConversation(conversation.id, agentId)).toThrow();
    expect(
      existsSync(
        join(
          conversationDirFor(storageDir, conversation.id),
          "conversation.json",
        ),
      ),
    ).toBe(true);
    expect(
      store.listConversations({ agent_id: agentId }).map((row) => row.id),
    ).toContain(conversation.id);
    expect(store.listLocalMessages(conversation.id, agentId)).toHaveLength(1);

    // Once the obstruction is gone the same call succeeds.
    rmSync(blocker, { force: true });
    store.deleteConversation(conversation.id, agentId);
    expect(existsSync(conversationDirFor(storageDir, conversation.id))).toBe(
      false,
    );
  });

  test("deletes an agent-free conversation", () => {
    const store = new LocalStore(agentId, {
      storageDir,
      strictConversationAccess: true,
    });
    const conversation = store.createEphemeralConversation({
      model: "anthropic/x",
      system: "worker system",
    });

    store.deleteConversation(conversation.id);

    expect(existsSync(conversationDirFor(storageDir, conversation.id))).toBe(
      false,
    );
    expect(() => store.retrieveConversation(conversation.id)).toThrow(
      LocalBackendNotFoundError,
    );
  });
});

describe("LocalBackend.deleteConversation", () => {
  let homeDir: string;
  let previousHome: string | undefined;
  let storageDir: string;

  beforeEach(async () => {
    previousHome = process.env.HOME;
    homeDir = await mkdtemp(join(tmpdir(), "local-conversation-delete-home-"));
    process.env.HOME = homeDir;
    await settingsManager.reset();
    await settingsManager.initialize();
    storageDir = join(homeDir, "backend");
  });

  afterEach(async () => {
    await settingsManager.reset();
    process.env.HOME = previousHome;
    await rm(homeDir, { recursive: true, force: true });
  });

  test("clears the conversation's toolset, client preferences and session pointer", async () => {
    const backend = new LocalBackend({ storageDir, memfsEnabled: false });
    const agent = await backend.createAgent({
      name: "Delete fixture",
      model: "anthropic/claude-sonnet-4-6",
    });
    const conversation = await backend.createConversation({
      agent_id: agent.id,
      hidden: true,
    } as never);
    const other = await backend.createConversation({
      agent_id: agent.id,
    } as never);
    settingsManager.setToolsetPreference(agent.id, "codex", conversation.id);
    settingsManager.setClientPreferences(agent.id, conversation.id, {
      toolset: { include: ["AskUserQuestion"] },
    });
    settingsManager.setToolsetPreference(agent.id, "codex", other.id);
    settingsManager.updateSettings({
      sessionsByServer: {
        "delete.test": { agentId: agent.id, conversationId: conversation.id },
        "keep.test": { agentId: agent.id, conversationId: other.id },
      },
      lastSession: { agentId: agent.id, conversationId: conversation.id },
    });

    await backend.deleteConversation(conversation.id);

    const settings = settingsManager.getSettings();
    expect(settings.sessionsByServer?.["delete.test"]).toBeUndefined();
    expect(settings.sessionsByServer?.["keep.test"]).toEqual({
      agentId: agent.id,
      conversationId: other.id,
    });
    expect(settings.lastSession).toBeUndefined();
    expect(
      settingsManager.getToolsetPreference(agent.id, conversation.id),
    ).toBe("auto");
    expect(
      settingsManager.getClientPreferences(agent.id, conversation.id),
    ).toEqual({});
    const stored = settings.agents?.find((row) => row.agentId === agent.id);
    expect(stored?.toolsetsByConversation?.[conversation.id]).toBeUndefined();
    expect(
      stored?.clientPreferencesByConversation?.[conversation.id],
    ).toBeUndefined();
    // A sibling conversation's override is not collateral damage.
    expect(settingsManager.getToolsetPreference(agent.id, other.id)).toBe(
      "codex",
    );
    await expect(backend.retrieveConversation(conversation.id)).rejects.toThrow(
      LocalBackendNotFoundError,
    );
  });

  test("rejects the default conversation and unknown ids", async () => {
    const backend = new LocalBackend({ storageDir, memfsEnabled: false });
    await backend.createAgent({
      name: "Delete guard fixture",
      model: "anthropic/claude-sonnet-4-6",
    });

    await expect(backend.deleteConversation("default")).rejects.toThrow(
      "Default conversation cannot be deleted",
    );
    await expect(
      backend.deleteConversation("conv-local-missing"),
    ).rejects.toThrow(LocalBackendNotFoundError);
  });

  test("deletes an agent-free conversation without a settings failure", async () => {
    const backend = new LocalBackend({ storageDir, memfsEnabled: false });
    const conversation = await backend.createEphemeralConversation({
      model: "anthropic/x",
      system: "worker system",
    });

    await backend.deleteConversation(conversation.id);

    await expect(backend.retrieveConversation(conversation.id)).rejects.toThrow(
      LocalBackendNotFoundError,
    );
  });

  test("keeps the conversation deleted when the settings surface is unavailable", async () => {
    const backend = new LocalBackend({ storageDir, memfsEnabled: false });
    const agent = await backend.createAgent({
      name: "No settings fixture",
      model: "anthropic/claude-sonnet-4-6",
    });
    const conversation = await backend.createConversation({
      agent_id: agent.id,
    } as never);
    // From here every settings read throws; the delete must log and finish
    // instead of rolling the conversation back (requirement §5.4.7).
    await settingsManager.reset();

    await expect(
      backend.deleteConversation(conversation.id),
    ).resolves.toBeUndefined();

    await expect(backend.retrieveConversation(conversation.id)).rejects.toThrow(
      LocalBackendNotFoundError,
    );
    expect(existsSync(conversationDirFor(storageDir, conversation.id))).toBe(
      false,
    );
  });
});

describe("deleteLocalConversationSettings", () => {
  let homeDir: string;
  let previousHome: string | undefined;

  beforeEach(async () => {
    previousHome = process.env.HOME;
    homeDir = await mkdtemp(join(tmpdir(), "local-delete-settings-home-"));
    process.env.HOME = homeDir;
    await settingsManager.reset();
    await settingsManager.initialize();
  });

  afterEach(async () => {
    await settingsManager.reset();
    process.env.HOME = previousHome;
    await rm(homeDir, { recursive: true, force: true });
  });

  test("clears the local project's session pointer for the deleted conversation", async () => {
    const projectDir = join(homeDir, "project");
    await settingsManager.loadLocalProjectSettings(projectDir);
    settingsManager.updateLocalProjectSettings(
      {
        sessionsByServer: {
          "delete.test": { agentId, conversationId: "conv-local-gone" },
          "keep.test": { agentId, conversationId: "conv-local-kept" },
        },
        lastSession: { agentId, conversationId: "conv-local-gone" },
      },
      projectDir,
    );

    await deleteLocalConversationSettings({
      agentId,
      agentFree: false,
      conversationId: "conv-local-gone",
      workingDirectory: projectDir,
    });

    const local = settingsManager.getLocalProjectSettings(projectDir);
    expect(local.sessionsByServer?.["delete.test"]).toBeUndefined();
    expect(local.sessionsByServer?.["keep.test"]).toEqual({
      agentId,
      conversationId: "conv-local-kept",
    });
    expect(local.lastSession).toBeUndefined();
    expect(settingsManager.getLocalLastSession(projectDir)).toBeNull();
  });

  test("leaves another agent's session that reuses the id alone", async () => {
    settingsManager.updateSettings({
      sessionsByServer: {
        "delete.test": {
          agentId: "agent-someone-else",
          conversationId: "conv-local-shared",
        },
      },
    });

    await deleteLocalConversationSettings({
      agentId,
      agentFree: false,
      conversationId: "conv-local-shared",
    });

    expect(
      settingsManager.getSettings().sessionsByServer?.["delete.test"],
    ).toEqual({
      agentId: "agent-someone-else",
      conversationId: "conv-local-shared",
    });
  });

  test("does nothing for an agent-free conversation", async () => {
    const executionAgentId = "agent-free:conv-local-worker";
    settingsManager.setToolsetPreference(
      executionAgentId,
      "codex",
      "conv-local-worker",
    );

    await deleteLocalConversationSettings({
      agentId: executionAgentId,
      agentFree: true,
      conversationId: "conv-local-worker",
    });

    // An agent-free conversation has no settings row to clean; nothing was
    // touched (the fixture write survives).
    expect(
      settingsManager.getToolsetPreference(
        executionAgentId,
        "conv-local-worker",
      ),
    ).toBe("codex");
  });
});
