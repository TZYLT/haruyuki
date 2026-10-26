import type { ConversationContextMode } from "@/types/conversation-provenance";
import type { LocalAssistantMessage, LocalMessage } from "./local-message";
import { projectLocalMessageToStoredMessages } from "./local-message-projection";

const FORK_PROJECTION_FALLBACK_DATE = "1970-01-01T00:00:00.000Z";

/** The source a fork reads from, reduced to what message selection needs. */
export interface LocalForkSourceConversation {
  id: string;
  agent_id: string;
  in_context_message_ids?: readonly string[];
}

function projectMessage(
  message: LocalMessage,
  agentId: string,
  conversationId: string,
) {
  return projectLocalMessageToStoredMessages(
    message,
    agentId,
    conversationId,
    FORK_PROJECTION_FALLBACK_DATE,
  );
}

function truncateAssistantThroughProjectedMessage(
  message: LocalAssistantMessage,
  projectedMessageId: string,
  agentId: string,
  conversationId: string,
): LocalAssistantMessage {
  const selectedProjection = projectMessage(
    message,
    agentId,
    conversationId,
  ).find((projected) => projected.id === projectedMessageId);
  if (!selectedProjection) return message;
  const selectedJson = JSON.stringify(selectedProjection);

  for (let end = 1; end <= message.content.length; end += 1) {
    const candidate = { ...message, content: message.content.slice(0, end) };
    const candidateProjection = projectMessage(
      candidate,
      agentId,
      conversationId,
    );
    const selectedCandidate = candidateProjection.find(
      (projected) => projected.id === projectedMessageId,
    );
    if (
      candidateProjection.at(-1)?.id === projectedMessageId &&
      JSON.stringify(selectedCandidate) === selectedJson
    ) {
      return candidate;
    }
  }

  return message;
}

/**
 * The messages a fork copies for `inherited-context`: exactly the parent's
 * current context window, in the window's own order.
 *
 * The window is the authority — `in_context_message_ids` holds local message
 * ids, so this keeps whole messages (never a projected slice) and drops ids the
 * log no longer carries, which is what the parent's own next request would do.
 * An empty window copies nothing; the child still inherits the frozen prefix.
 */
function selectContextWindowMessages(
  messages: readonly LocalMessage[],
  inContextMessageIds: readonly string[],
): LocalMessage[] {
  if (inContextMessageIds.length === 0) return [];
  const byId = new Map(messages.map((message) => [message.id, message]));
  const selected: LocalMessage[] = [];
  for (const messageId of inContextMessageIds) {
    const message = byId.get(messageId);
    if (message) selected.push(message);
  }
  return selected;
}

/**
 * Pick the source messages to clone into a fork.
 *
 * `inherited-history` (the default, F-01) clones the transcript, optionally cut
 * at a projected message id. `inherited-context` (F-03) clones only the current
 * context window; the message-id cutoff belongs to the history mode alone and
 * the policy layer rejects the combination.
 *
 * Returns `undefined` only when a requested cutoff id does not exist.
 */
export function selectLocalMessagesForFork(
  messages: LocalMessage[],
  messageId: string | undefined,
  source: LocalForkSourceConversation,
  contextMode: ConversationContextMode,
): LocalMessage[] | undefined {
  if (contextMode === "inherited-context") {
    return selectContextWindowMessages(
      messages,
      source.in_context_message_ids ?? [],
    );
  }
  if (!messageId) return messages;

  for (let sourceIndex = 0; sourceIndex < messages.length; sourceIndex += 1) {
    const sourceMessage = messages[sourceIndex];
    if (!sourceMessage) continue;
    const projected = projectMessage(sourceMessage, source.agent_id, source.id);
    const projectedIndex = projected.findIndex(
      (message) => message.id === messageId,
    );
    if (projectedIndex < 0) continue;

    if (
      sourceMessage.role !== "assistant" ||
      projectedIndex === projected.length - 1
    ) {
      return messages.slice(0, sourceIndex + 1);
    }
    return [
      ...messages.slice(0, sourceIndex),
      truncateAssistantThroughProjectedMessage(
        sourceMessage,
        messageId,
        source.agent_id,
        source.id,
      ),
    ];
  }

  return undefined;
}
