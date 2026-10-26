/**
 * Fork provenance for the local backend: which context mode a fork may claim,
 * and the record fields describing what it actually copied.
 *
 * Kept out of `local-store.ts` so the fork context policy has one home a later
 * feature extends, instead of a new branch inside an already pinned file.
 */
import {
  type ConversationContextMode,
  type ConversationForkProvenance,
  type ConversationProvenance,
  isConversationContextMode,
} from "@/types/conversation-provenance";
import type { StoredMessage } from "./local-types";

/** Options `LocalStore.forkConversation` accepts: clone controls plus provenance. */
export interface LocalForkConversationOptions
  extends ConversationForkProvenance {
  agentId?: string;
  hidden?: boolean;
  messageId?: string;
}

export const DEFAULT_FORK_CONTEXT_MODE: ConversationContextMode =
  "inherited-history";

/** The fork selection a caller asked for, reduced to what the policy reads. */
export interface ForkContextSelection {
  contextMode?: ConversationContextMode;
  messageId?: string;
}

/**
 * The context mode a fork will record.
 *
 * `inherited-context` (F-03) copies only the parent's current context window,
 * so a cutoff by projected message id would contradict what the fork claims to
 * hold: the two selections answer different questions and are rejected together
 * rather than letting one silently win.
 */
export function forkContextMode(
  selection: ForkContextSelection = {},
): ConversationContextMode {
  const mode = selection.contextMode ?? DEFAULT_FORK_CONTEXT_MODE;
  if (!isConversationContextMode(mode)) {
    throw new Error(`Unknown conversation context_mode: ${String(mode)}`);
  }
  if (mode === "inherited-context" && selection.messageId) {
    throw new Error(
      "invalid_argument: context_mode inherited-context selects the current context; messageId cannot be combined with it",
    );
  }
  return mode;
}

/**
 * The provenance fields written onto a fork.
 *
 * `inherited_message_count` / `inherited_through_message_id` describe the
 * **projected** messages the fork now holds, not the source's local messages:
 * the detail view pages a stored-message log, so the cursor has to be an id in
 * that projection. The parent is the direct source, never the source's own
 * parent — a fork of a fork points at the middle conversation (§5.5.3).
 */
export function forkedConversationProvenance(
  input: {
    projectedMessages: readonly StoredMessage[];
    sourceConversationId: string;
    contextMode: ConversationContextMode;
  } & ConversationForkProvenance,
): ConversationProvenance {
  return {
    origin: input.origin ?? "unknown",
    parent_conversation_id:
      input.parentConversationId ?? input.sourceConversationId,
    context_mode: input.contextMode,
    inherited_message_count: input.projectedMessages.length,
    inherited_through_message_id: input.projectedMessages.at(-1)?.id ?? null,
  };
}
