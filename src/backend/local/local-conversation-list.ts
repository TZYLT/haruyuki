import type { Conversation } from "@letta-ai/letta-client/resources/conversations/conversations";
import type { ConversationListBody } from "@/backend/backend";
import {
  type HiddenConversationSummary,
  toHiddenConversationSummary,
} from "@/types/conversation-provenance";

type ListableLocalConversation = Conversation & {
  hidden?: boolean;
};

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function matchesSummarySearch(
  conversation: ListableLocalConversation,
  normalizedSearch: string | undefined,
): boolean {
  if (!normalizedSearch) return true;

  return (
    conversation.id.toLowerCase().includes(normalizedSearch) ||
    (conversation.summary?.toLowerCase().includes(normalizedSearch) ?? false)
  );
}

export function listLocalConversations(
  source: Iterable<ListableLocalConversation>,
  body?: ConversationListBody,
): HiddenConversationSummary[] {
  const bodyRecord = (body ?? {}) as Record<string, unknown>;
  const agentId = optionalString(bodyRecord.agent_id);
  const after = optionalString(bodyRecord.after);
  const normalizedSearch = optionalString(bodyRecord.summary_search)
    ?.trim()
    .toLowerCase();
  const limit = typeof bodyRecord.limit === "number" ? bodyRecord.limit : 20;
  // `hidden_only` is the viewer's filter; `include_hidden` is the older
  // "show everything" escape hatch. When both are set, `hidden_only` wins
  // (§5.7.1) — otherwise a delegated caller could silently get ordinary
  // conversations in a hidden-session response.
  const hiddenOnly = bodyRecord.hidden_only === true;
  const includeHidden = bodyRecord.include_hidden === true;
  let conversations = [...source].filter(
    (conversation) =>
      conversation.id !== "default" &&
      (hiddenOnly
        ? conversation.hidden === true
        : includeHidden || !conversation.hidden) &&
      (!agentId || conversation.agent_id === agentId) &&
      matchesSummarySearch(conversation, normalizedSearch),
  );

  conversations.sort((a, b) => {
    const aDate = a.last_message_at ?? a.updated_at ?? a.created_at ?? "";
    const bDate = b.last_message_at ?? b.updated_at ?? b.created_at ?? "";

    return bDate.localeCompare(aDate);
  });

  if (after) {
    const afterIndex = conversations.findIndex(
      (conversation) => conversation.id === after,
    );
    if (afterIndex >= 0) conversations = conversations.slice(afterIndex + 1);
  }

  return conversations.slice(0, limit).map(toHiddenConversationSummary);
}
