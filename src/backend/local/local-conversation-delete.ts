/**
 * Physical deletion of one local conversation (F-01 M2).
 *
 * It lives beside `local-store.ts` rather than inside it for two reasons: the
 * store is pinned at its size ceiling, and this is a second behaviour (the store
 * is pinned for *wiring* growth only). The store still owns its state — it hands
 * its own collections in through {@link LocalConversationDeleteState}, the same
 * ports pattern `LocalContextRewrites` already uses — so the order below is the
 * one thing this module decides.
 *
 * Order (requirement §5.4.5):
 * 1. the conversation directory leaves the live tree (`trash/` sits outside
 *    `conversations/`, so the record scan cannot see it);
 * 2. only then is memory and the derived index cleared;
 * 3. finally the trashed copy is removed.
 *
 * A rename failure throws before step 2, so a deletion that cannot reach disk
 * leaves the conversation readable instead of half-deleted.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { debugWarn } from "@/utils/debug";
import type { LocalMessage } from "./local-message";
import type { StoredConversation, StoredMessage } from "./local-types";
import type { LocalCompiledSystemPrompt } from "./system-prompt-compilation";

/**
 * A collection this module may only drop a key from.
 *
 * `LocalStore`'s transcript metadata record is private to the store, and a
 * deletion never reads any of these caches — it only forgets them. Both `Map`
 * and `Set` satisfy this shape.
 */
type ForgetKeyed = { delete(key: string): boolean };

/**
 * The store-owned state one deletion touches.
 *
 * Every collection here is keyed by, or derived from, a single conversation.
 * **A new per-conversation cache in `LocalStore` must be added here too**, or a
 * deletion will leave it behind and a later read can serve the deleted row.
 */
export interface LocalConversationDeleteState {
  storageDir?: string;
  conversations: Map<string, StoredConversation>;
  localMessagesByConversationKey: Map<string, LocalMessage[]>;
  loadedConversationKeys: Set<string>;
  tailResidentConversationKeys: Set<string>;
  residentTailStartIndexByConversationKey: Map<string, number>;
  loadRepairedConversationKeys: Set<string>;
  unreadTranscriptHeadBytesByKey: Map<string, number>;
  transcriptMetadataByConversationKey: ForgetKeyed;
  conversationRecordJsonByKey: Map<string, string>;
  sessionEntryIdsByConversationKey: Map<string, Set<string>>;
  sessionEntryIdByMessageIdByConversationKey: Map<string, Map<string, string>>;
  persistedMessageByMessageIdByConversationKey: Map<
    string,
    Map<string, LocalMessage>
  >;
  lastSessionEntryIdByConversationKey: Map<string, string | null>;
  compiledSystemPromptByConversationKey: Map<string, LocalCompiledSystemPrompt>;
  /** Projected-message lookup: the source local id plus each `<id>:<variant>`. */
  messagesById: Map<string, StoredMessage[]>;
  /** Assistant ids whose turn settled; the rollback path reads it. */
  settledLocalMessageIds: Set<string>;
  conversationKey(conversationId: string, agentId: string): string;
  conversationDir(key: string): string | undefined;
  encodeKey(key: string): string;
  refreshConversationRecord(key: string): StoredConversation | undefined;
  scanConversationRecords(): void;
}

/**
 * Find the record a deletion targets, or `undefined` when it does not exist.
 *
 * `agentId` only saves the record scan: every non-default conversation key is
 * `conversation:<id>` no matter which agent owns it, so the id alone is enough
 * (requirement §5.5.5 — deletion looks at the id, never at provenance).
 * `"default"` is never deletable: it is the agent's own conversation, and
 * removing it would take the agent's whole transcript with it.
 */
export function resolveConversationForDeletion(
  state: LocalConversationDeleteState,
  conversationId: string,
  agentId?: string,
): StoredConversation | undefined {
  if (conversationId === "default") {
    throw new Error("Default conversation cannot be deleted");
  }
  if (agentId) {
    const direct = state.refreshConversationRecord(
      state.conversationKey(conversationId, agentId),
    );
    if (direct) return direct;
  }
  const cached = conversationWithId(state, conversationId);
  if (cached) return cached;
  // Only pay for the directory scan when the record has not been cached yet.
  state.scanConversationRecords();
  return conversationWithId(state, conversationId);
}

/**
 * Delete `conversation` from disk and memory.
 *
 * `loadConversationRecordsFromStorage()` must not run afterwards: it would cache
 * whatever directory is still on disk, which is exactly the half-resurrection
 * the rename is there to prevent.
 */
export function deleteLocalConversation(
  state: LocalConversationDeleteState,
  conversation: StoredConversation,
): void {
  const key = state.conversationKey(conversation.id, conversation.agent_id);
  // Collected before the resident window is dropped: the settled-turn set and
  // the lookup index are keyed by these same local message ids.
  const localMessageIds = localMessageIdsForDeletion(state, key, conversation);
  const trashedDir = moveConversationDirToTrash(state, key);
  forgetConversationState(state, key);
  forgetMessageIndex(state, conversation.id, localMessageIds);
  removeTrashedDir(trashedDir);
}

function conversationWithId(
  state: LocalConversationDeleteState,
  conversationId: string,
): StoredConversation | undefined {
  for (const conversation of state.conversations.values()) {
    if (conversation.id === conversationId) return conversation;
  }
  return undefined;
}

function localMessageIdsForDeletion(
  state: LocalConversationDeleteState,
  key: string,
  conversation: StoredConversation,
): string[] {
  const ids = new Set<string>(conversation.in_context_message_ids ?? []);
  for (const message of state.localMessagesByConversationKey.get(key) ?? []) {
    ids.add(message.id);
  }
  return [...ids];
}

/** Rename the conversation directory out of `conversations/`, or skip. */
function moveConversationDirToTrash(
  state: LocalConversationDeleteState,
  key: string,
): string | undefined {
  if (!state.storageDir) return undefined;
  const conversationDir = state.conversationDir(key);
  if (!conversationDir || !existsSync(conversationDir)) return undefined;
  const trashDir = join(state.storageDir, "trash");
  mkdirSync(trashDir, { recursive: true });
  const trashedDir = join(trashDir, `${state.encodeKey(key)}-${randomUUID()}`);
  renameSync(conversationDir, trashedDir);
  return trashedDir;
}

function forgetConversationState(
  state: LocalConversationDeleteState,
  key: string,
): void {
  state.conversations.delete(key);
  state.localMessagesByConversationKey.delete(key);
  state.loadedConversationKeys.delete(key);
  state.tailResidentConversationKeys.delete(key);
  state.residentTailStartIndexByConversationKey.delete(key);
  state.loadRepairedConversationKeys.delete(key);
  state.unreadTranscriptHeadBytesByKey.delete(key);
  state.transcriptMetadataByConversationKey.delete(key);
  state.conversationRecordJsonByKey.delete(key);
  state.sessionEntryIdsByConversationKey.delete(key);
  state.sessionEntryIdByMessageIdByConversationKey.delete(key);
  state.persistedMessageByMessageIdByConversationKey.delete(key);
  state.lastSessionEntryIdByConversationKey.delete(key);
  state.compiledSystemPromptByConversationKey.delete(key);
}

function forgetMessageIndex(
  state: LocalConversationDeleteState,
  conversationId: string,
  localMessageIds: readonly string[],
): void {
  for (const messageId of localMessageIds) {
    state.messagesById.delete(messageId);
    state.settledLocalMessageIds.delete(messageId);
  }
  // One local message also indexes each projected variant (`<id>:assistant`,
  // `<id>:reasoning`, `<id>:tool`) and a paged read can index a projection with
  // nothing resident in memory. Sweep by owner rather than rebuild the whole
  // index: the values carry their conversation id, and no projection of another
  // conversation can share this id.
  for (const [lookupKey, messages] of state.messagesById) {
    if (
      messages.every((message) => message.conversation_id === conversationId)
    ) {
      state.messagesById.delete(lookupKey);
    }
  }
}

function removeTrashedDir(trashedDir: string | undefined): void {
  if (!trashedDir) return;
  try {
    rmSync(trashedDir, { recursive: true, force: true });
  } catch (error) {
    // The live tree no longer has the conversation, which is what "deleted"
    // means to every reader. A leftover trash copy is garbage, not a failure.
    debugWarn(
      "local-store",
      "conversation trash cleanup failed for %s: %o",
      trashedDir,
      error,
    );
  }
}
