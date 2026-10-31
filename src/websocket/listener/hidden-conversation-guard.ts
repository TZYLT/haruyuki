/**
 * Read-only guard for hidden conversations on the app-server protocol surface.
 *
 * F-01/D-9: a hidden conversation (reflection run, dream session, subagent fork,
 * agent-free ephemeral conversation) is viewable but not writable from the
 * app-server protocol. A client must not be able to start a turn on one, so
 * both `runtime_start` and `input` refuse them instead of inheriting the
 * ordinary conversation path.
 *
 * `hidden` is a runtime annotation the SDK's `Conversation` type does not carry
 * (`toHiddenConversationSummary` attaches it), so it is read through a guard
 * rather than a cast — the same rule `cron-host` and `agents-conversations`
 * follow.
 */
import { getBackend } from "@/backend";
import { debugLog } from "@/utils/debug";
import { isRecord } from "@/utils/type-guards";

/** Stable error text every protocol entry point that refuses a hidden write. */
export const HIDDEN_CONVERSATION_READ_ONLY =
  "Hidden conversations are read-only.";

/**
 * Read the runtime `hidden` annotation from a conversation-shaped value.
 *
 * Used where the conversation was already retrieved (`runtime_start`) so the
 * guard does not pay for a second lookup.
 */
export function isHiddenConversationAnnotation(value: unknown): boolean {
  return isRecord(value) && value.hidden === true;
}

/**
 * Is this conversation hidden?
 *
 * Deliberately a non-creating list rather than `retrieveConversation`: on the
 * local backend that call *creates* an unknown conversation, which would turn
 * the validation itself into a write (the reason `cron-host` resolves hidden
 * targets the same way). The implicit `default` conversation is never listed
 * and is never hidden.
 *
 * A lookup failure is logged and treated as "not hidden" — a backend hiccup
 * must not reject otherwise-valid input.
 */
export async function isHiddenConversation(
  conversationId: string,
): Promise<boolean> {
  if (conversationId === "default") return false;
  try {
    const rows = await getBackend().listConversations({
      summary_search: conversationId,
      include_hidden: true,
      limit: 100,
    });
    const row = rows.find((candidate) => candidate.id === conversationId);
    return isHiddenConversationAnnotation(row);
  } catch (error) {
    debugLog(
      "Listen",
      "hidden conversation lookup failed; treating it as not hidden",
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}
