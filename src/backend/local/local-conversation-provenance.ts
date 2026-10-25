/**
 * Fork provenance for the local backend: which context mode a fork may claim,
 * and the record fields describing what it actually copied.
 *
 * Kept out of `local-store.ts` so the F-01 policy (reject `inherited-context`
 * until F-03 can select context) has one home a later feature extends, instead
 * of a new branch inside an already pinned file.
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

/**
 * The context mode a fork will record.
 *
 * `inherited-context` is rejected until F-03 can actually select context: the
 * current fork clones the whole transcript, so that label would promise a
 * smaller child than the one written (user decision A, 2026-10-25).
 */
export function forkContextMode(
  requested: ConversationContextMode | undefined,
): ConversationContextMode {
  const mode = requested ?? DEFAULT_FORK_CONTEXT_MODE;
  if (!isConversationContextMode(mode)) {
    throw new Error(`Unknown conversation context_mode: ${String(mode)}`);
  }
  if (mode === "inherited-context") {
    throw new Error("not_supported: inherited-context requires F-03");
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
