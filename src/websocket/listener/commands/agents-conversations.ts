import type WebSocket from "ws";
import { formatCompactPlanningFailure } from "@/agent/compaction-execute";
import {
  type Backend,
  type ConversationMessageListBody,
  DEFAULT_CONVERSATION_MESSAGE_ORDER,
  getBackend,
} from "@/backend";
import { renderCompactionOverview } from "@/backend/local/compaction-preview";
import { LocalBackend } from "@/backend/local/local-backend";
import { toHiddenConversationSummary } from "@/types/conversation-provenance";
import type {
  AgentCreateCommand,
  AgentDeleteCommand,
  AgentListCommand,
  AgentRetrieveCommand,
  AgentUpdateCommand,
  ConversationCompactCommand,
  ConversationCreateCommand,
  ConversationDeleteCommand,
  ConversationForkCommand,
  ConversationListCommand,
  ConversationListEntry,
  ConversationMessagesListCommand,
  ConversationRecompileCommand,
  ConversationRetrieveCommand,
  ConversationUpdateCommand,
} from "@/types/protocol_v2";
import { runListenerLocalCompaction } from "@/websocket/listener/local-compaction";
import { isConversationForkCommand } from "@/websocket/listener/management-protocol-inbound";
import {
  isAgentCreateCommand,
  isAgentDeleteCommand,
  isAgentListCommand,
  isAgentRetrieveCommand,
  isAgentUpdateCommand,
  isConversationCompactCommand,
  isConversationCreateCommand,
  isConversationDeleteCommand,
  isConversationListCommand,
  isConversationMessagesListCommand,
  isConversationRecompileCommand,
  isConversationRetrieveCommand,
  isConversationUpdateCommand,
} from "@/websocket/listener/protocol-inbound";
import type { RunDetachedListenerTask, SafeSocketSend } from "./types";

export type AgentConversationManagementCommand =
  | AgentListCommand
  | AgentRetrieveCommand
  | AgentCreateCommand
  | AgentUpdateCommand
  | AgentDeleteCommand
  | ConversationListCommand
  | ConversationDeleteCommand
  | ConversationRetrieveCommand
  | ConversationCreateCommand
  | ConversationUpdateCommand
  | ConversationRecompileCommand
  | ConversationForkCommand
  | ConversationMessagesListCommand
  | ConversationCompactCommand;

type AgentConversationManagementCommandContext = {
  socket: WebSocket;
  safeSocketSend: SafeSocketSend;
  runDetachedListenerTask: RunDetachedListenerTask;
};

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function getPageItems<T>(page: unknown): T[] {
  if (Array.isArray(page)) return page as T[];
  if (page && typeof page === "object") {
    const candidate = page as {
      getPaginatedItems?: () => T[];
      items?: T[];
    };
    if (typeof candidate.getPaginatedItems === "function") {
      return candidate.getPaginatedItems();
    }
    if (Array.isArray(candidate.items)) {
      return candidate.items;
    }
  }
  return [];
}

/**
 * Find one conversation by exact id without `retrieveConversation`, which
 * resolves across agents on the local backend. `summary_search` narrows the
 * page; the id equality is what makes the answer exact.
 */
async function findConversationByExactId(
  backend: Pick<Backend, "listConversations">,
  conversationId: string,
  filter: { hidden_only?: boolean; include_hidden?: boolean },
): Promise<ConversationListEntry | undefined> {
  const page = await backend.listConversations({
    summary_search: conversationId,
    limit: 20,
    ...filter,
  });
  return getPageItems<ConversationListEntry>(page).find(
    (conversation) => conversation.id === conversationId,
  );
}

export type ConversationDeleteOutcome =
  | { ok: true }
  | {
      ok: false;
      error:
        | "default_not_deletable"
        | "not_supported"
        | "conversation_not_found"
        | "not_hidden";
    };

/**
 * Delete one hidden conversation.
 *
 * The protocol surface never deletes an ordinary conversation or `default`, so
 * both checks run before the backend is asked to do anything (§5.7.2). The
 * backend method stays generic; this is a policy guard, not a second storage
 * rule. Backend errors propagate so the caller can report them verbatim.
 */
export async function deleteHiddenConversation(
  backend: Pick<Backend, "listConversations" | "deleteConversation">,
  conversationId: string,
): Promise<ConversationDeleteOutcome> {
  if (conversationId === "default") {
    return { ok: false, error: "default_not_deletable" };
  }
  if (typeof backend.deleteConversation !== "function") {
    return { ok: false, error: "not_supported" };
  }
  const hidden = await findConversationByExactId(backend, conversationId, {
    hidden_only: true,
  });
  if (!hidden) {
    // Distinguish "not hidden" from "does not exist" only when the backend can
    // answer for visible conversations too; a backend that ignores
    // `include_hidden` reports `conversation_not_found`, which is still safe.
    const visible = await findConversationByExactId(backend, conversationId, {
      include_hidden: true,
    });
    return {
      ok: false,
      error: visible ? "not_hidden" : "conversation_not_found",
    };
  }
  // Never trust the query flag alone: a backend that ignores `hidden_only`
  // returns visible rows too, and deleting one of those would be unrecoverable.
  if (hidden.hidden !== true) {
    return { ok: false, error: "not_hidden" };
  }
  await backend.deleteConversation(conversationId);
  return { ok: true };
}

type ConversationMessagePage = {
  messages: unknown[];
  nextBefore: string | null;
  hasMore: boolean;
};

function messageId(message: unknown): string | null {
  if (!message || typeof message !== "object") return null;
  const id = (message as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export async function listConversationMessagePage(
  backend: Pick<Backend, "listConversationMessages">,
  conversationId: string,
  query: ConversationMessageListBody = {},
): Promise<ConversationMessagePage> {
  const normalizedQuery = query ?? {};
  const limit = normalizedQuery.limit ?? 50;
  const order = normalizedQuery.order ?? DEFAULT_CONVERSATION_MESSAGE_ORDER;
  const page = await backend.listConversationMessages(
    conversationId,
    normalizedQuery,
  );
  const untrimmedMessages = getPageItems(page);
  const messages = untrimmedMessages.slice(0, limit);
  const oldestMessage =
    order === "asc" ? messages[0] : messages[messages.length - 1];
  const nextBefore = messageId(oldestMessage);

  if (!nextBefore || messages.length < limit) {
    return { messages, nextBefore, hasMore: false };
  }
  if (untrimmedMessages.length > limit) {
    return { messages, nextBefore, hasMore: true };
  }

  const probe = await backend.listConversationMessages(conversationId, {
    ...normalizedQuery,
    after: undefined,
    before: nextBefore,
    order: "desc",
    limit: 1,
  });
  return {
    messages,
    nextBefore,
    hasMore: getPageItems(probe).length > 0,
  };
}

export async function handleAgentConversationManagementCommand(
  parsed: AgentConversationManagementCommand,
  socket: WebSocket,
  safeSocketSend: SafeSocketSend,
): Promise<boolean> {
  const backend = getBackend();

  if (parsed.type === "agent_list") {
    try {
      const page = await backend.listAgents(parsed.query);
      safeSocketSend(
        socket,
        {
          type: "agent_list_response",
          request_id: parsed.request_id,
          success: true,
          agents: getPageItems(page),
        },
        "listener_agent_management_send_failed",
        "listener_agent_management",
      );
    } catch (error) {
      safeSocketSend(
        socket,
        {
          type: "agent_list_response",
          request_id: parsed.request_id,
          success: false,
          agents: [],
          error: getErrorMessage(error, "Failed to list agents"),
        },
        "listener_agent_management_send_failed",
        "listener_agent_management",
      );
    }
    return true;
  }

  if (parsed.type === "agent_retrieve") {
    try {
      const agent = await backend.retrieveAgent(parsed.agent_id);
      safeSocketSend(
        socket,
        {
          type: "agent_retrieve_response",
          request_id: parsed.request_id,
          success: true,
          agent,
        },
        "listener_agent_management_send_failed",
        "listener_agent_management",
      );
    } catch (error) {
      safeSocketSend(
        socket,
        {
          type: "agent_retrieve_response",
          request_id: parsed.request_id,
          success: false,
          agent: null,
          error: getErrorMessage(error, "Failed to retrieve agent"),
        },
        "listener_agent_management_send_failed",
        "listener_agent_management",
      );
    }
    return true;
  }

  if (parsed.type === "agent_create") {
    try {
      const { prepareRawCreateAgentBodyForMemfs, enableMemfsIfCloud } =
        await import("@/agent/memory-filesystem");
      const body = await prepareRawCreateAgentBodyForMemfs(parsed.body);
      const agent = await backend.createAgent(body);
      // Finish memfs setup (settings, repo clone, legacy tool detach) without
      // blocking the response. The tag is already stamped at creation, so
      // lazy sync paths can complete this even if the process dies here.
      void enableMemfsIfCloud(agent.id);
      safeSocketSend(
        socket,
        {
          type: "agent_create_response",
          request_id: parsed.request_id,
          success: true,
          agent,
        },
        "listener_agent_management_send_failed",
        "listener_agent_management",
      );
    } catch (error) {
      safeSocketSend(
        socket,
        {
          type: "agent_create_response",
          request_id: parsed.request_id,
          success: false,
          agent: null,
          error: getErrorMessage(error, "Failed to create agent"),
        },
        "listener_agent_management_send_failed",
        "listener_agent_management",
      );
    }
    return true;
  }

  if (parsed.type === "agent_update") {
    try {
      const agent = await backend.updateAgent(parsed.agent_id, parsed.body);
      safeSocketSend(
        socket,
        {
          type: "agent_update_response",
          request_id: parsed.request_id,
          success: true,
          agent,
        },
        "listener_agent_management_send_failed",
        "listener_agent_management",
      );
    } catch (error) {
      safeSocketSend(
        socket,
        {
          type: "agent_update_response",
          request_id: parsed.request_id,
          success: false,
          agent: null,
          error: getErrorMessage(error, "Failed to update agent"),
        },
        "listener_agent_management_send_failed",
        "listener_agent_management",
      );
    }
    return true;
  }

  if (parsed.type === "agent_delete") {
    try {
      await backend.deleteAgent(parsed.agent_id);
      safeSocketSend(
        socket,
        {
          type: "agent_delete_response",
          request_id: parsed.request_id,
          success: true,
          agent_id: parsed.agent_id,
        },
        "listener_agent_management_send_failed",
        "listener_agent_management",
      );
    } catch (error) {
      safeSocketSend(
        socket,
        {
          type: "agent_delete_response",
          request_id: parsed.request_id,
          success: false,
          agent_id: parsed.agent_id,
          error: getErrorMessage(error, "Failed to delete agent"),
        },
        "listener_agent_management_send_failed",
        "listener_agent_management",
      );
    }
    return true;
  }

  if (parsed.type === "conversation_list") {
    try {
      const page = await backend.listConversations(parsed.query);
      safeSocketSend(
        socket,
        {
          type: "conversation_list_response",
          request_id: parsed.request_id,
          success: true,
          conversations: getPageItems<ConversationListEntry>(page).map(
            toHiddenConversationSummary,
          ),
        },
        "listener_conversation_management_send_failed",
        "listener_conversation_management",
      );
    } catch (error) {
      safeSocketSend(
        socket,
        {
          type: "conversation_list_response",
          request_id: parsed.request_id,
          success: false,
          conversations: [],
          error: getErrorMessage(error, "Failed to list conversations"),
        },
        "listener_conversation_management_send_failed",
        "listener_conversation_management",
      );
    }
    return true;
  }

  if (parsed.type === "conversation_delete") {
    const conversationId = parsed.conversation_id;
    const respond = (success: boolean, error?: string) =>
      safeSocketSend(
        socket,
        {
          type: "conversation_delete_response",
          request_id: parsed.request_id,
          success,
          conversation_id: conversationId,
          ...(error ? { error } : {}),
        },
        "listener_conversation_management_send_failed",
        "listener_conversation_management",
      );

    try {
      const outcome = await deleteHiddenConversation(backend, conversationId);
      respond(outcome.ok, outcome.ok ? undefined : outcome.error);
    } catch (error) {
      respond(false, getErrorMessage(error, "Failed to delete conversation"));
    }
    return true;
  }

  if (parsed.type === "conversation_retrieve") {
    try {
      const conversation = await backend.retrieveConversation(
        parsed.conversation_id,
      );
      safeSocketSend(
        socket,
        {
          type: "conversation_retrieve_response",
          request_id: parsed.request_id,
          success: true,
          conversation,
        },
        "listener_conversation_management_send_failed",
        "listener_conversation_management",
      );
    } catch (error) {
      safeSocketSend(
        socket,
        {
          type: "conversation_retrieve_response",
          request_id: parsed.request_id,
          success: false,
          conversation: null,
          error: getErrorMessage(error, "Failed to retrieve conversation"),
        },
        "listener_conversation_management_send_failed",
        "listener_conversation_management",
      );
    }
    return true;
  }

  if (parsed.type === "conversation_create") {
    try {
      const conversation = await backend.createConversation(parsed.body);
      safeSocketSend(
        socket,
        {
          type: "conversation_create_response",
          request_id: parsed.request_id,
          success: true,
          conversation,
        },
        "listener_conversation_management_send_failed",
        "listener_conversation_management",
      );
    } catch (error) {
      safeSocketSend(
        socket,
        {
          type: "conversation_create_response",
          request_id: parsed.request_id,
          success: false,
          conversation: null,
          error: getErrorMessage(error, "Failed to create conversation"),
        },
        "listener_conversation_management_send_failed",
        "listener_conversation_management",
      );
    }
    return true;
  }

  if (parsed.type === "conversation_update") {
    try {
      const conversation = await backend.updateConversation(
        parsed.conversation_id,
        parsed.body,
      );
      safeSocketSend(
        socket,
        {
          type: "conversation_update_response",
          request_id: parsed.request_id,
          success: true,
          conversation,
        },
        "listener_conversation_management_send_failed",
        "listener_conversation_management",
      );
    } catch (error) {
      safeSocketSend(
        socket,
        {
          type: "conversation_update_response",
          request_id: parsed.request_id,
          success: false,
          conversation: null,
          error: getErrorMessage(error, "Failed to update conversation"),
        },
        "listener_conversation_management_send_failed",
        "listener_conversation_management",
      );
    }
    return true;
  }

  if (parsed.type === "conversation_recompile") {
    try {
      const result = await backend.recompileConversation(
        parsed.conversation_id,
        parsed.body,
      );
      safeSocketSend(
        socket,
        {
          type: "conversation_recompile_response",
          request_id: parsed.request_id,
          success: true,
          result,
        },
        "listener_conversation_management_send_failed",
        "listener_conversation_management",
      );
    } catch (error) {
      safeSocketSend(
        socket,
        {
          type: "conversation_recompile_response",
          request_id: parsed.request_id,
          success: false,
          result: null,
          error: getErrorMessage(error, "Failed to recompile conversation"),
        },
        "listener_conversation_management_send_failed",
        "listener_conversation_management",
      );
    }
    return true;
  }

  if (parsed.type === "conversation_fork") {
    try {
      const conversation = await backend.forkConversation(
        parsed.conversation_id,
        {
          ...(typeof parsed.body?.agent_id === "string"
            ? { agentId: parsed.body.agent_id }
            : {}),
          ...(typeof parsed.body?.hidden === "boolean"
            ? { hidden: parsed.body.hidden }
            : {}),
          ...(typeof parsed.body?.message_id === "string"
            ? { messageId: parsed.body.message_id }
            : {}),
          // A fork requested over the protocol comes from an external client,
          // not from a console or background producer (§5.5.2).
          origin: "external",
        },
      );
      safeSocketSend(
        socket,
        {
          type: "conversation_fork_response",
          request_id: parsed.request_id,
          success: true,
          conversation,
        },
        "listener_conversation_management_send_failed",
        "listener_conversation_management",
      );
    } catch (error) {
      safeSocketSend(
        socket,
        {
          type: "conversation_fork_response",
          request_id: parsed.request_id,
          success: false,
          conversation: null,
          error: getErrorMessage(error, "Failed to fork conversation"),
        },
        "listener_conversation_management_send_failed",
        "listener_conversation_management",
      );
    }
    return true;
  }

  if (parsed.type === "conversation_messages_list") {
    try {
      const page = await listConversationMessagePage(
        backend,
        parsed.conversation_id,
        parsed.query,
      );
      safeSocketSend(
        socket,
        {
          type: "conversation_messages_list_response",
          request_id: parsed.request_id,
          success: true,
          messages: page.messages,
          next_before: page.nextBefore,
          has_more: page.hasMore,
        },
        "listener_conversation_management_send_failed",
        "listener_conversation_management",
      );
    } catch (error) {
      safeSocketSend(
        socket,
        {
          type: "conversation_messages_list_response",
          request_id: parsed.request_id,
          success: false,
          messages: [],
          next_before: null,
          has_more: false,
          error: getErrorMessage(error, "Failed to list conversation messages"),
        },
        "listener_conversation_management_send_failed",
        "listener_conversation_management",
      );
    }
    return true;
  }

  if (parsed.type === "conversation_compact") {
    try {
      const local = backend instanceof LocalBackend ? backend : null;
      if (local) {
        // F-04 §5.12.2: the desktop's compaction is the same
        // `prepare → pick → apply` as `/compact`. This path has no picker, so
        // the compression rate takes the default cut; a client that wants a
        // different one calls the terminal's `/compact <n>`, whose number is
        // resolved against the pre-summarizer table (§5.6.3).
        const bodyRecord = (parsed.body ?? {}) as Record<string, unknown>;
        const requestedAgentId =
          typeof bodyRecord.agent_id === "string" &&
          bodyRecord.agent_id.length > 0
            ? bodyRecord.agent_id
            : undefined;
        try {
          // The listener's run guard: refuses a second run on the same
          // conversation, and writes exactly one ledger row per attempt (§5.14).
          const outcome = await runListenerLocalCompaction({
            backend: local,
            conversationId: parsed.conversation_id,
            ...(requestedAgentId === undefined
              ? {}
              : { agentId: requestedAgentId }),
          });
          if (outcome.kind === "cancelled") {
            safeSocketSend(
              socket,
              {
                type: "conversation_compact_response",
                request_id: parsed.request_id,
                success: false,
                compaction: null,
                error: outcome.receipt,
              },
              "listener_conversation_management_send_failed",
              "listener_conversation_management",
            );
            return true;
          }
          safeSocketSend(
            socket,
            {
              type: "conversation_compact_response",
              request_id: parsed.request_id,
              success: true,
              // The legacy shape, so a client that has not learned
              // `topic_report` still renders the two counts and a summary.
              compaction: {
                num_messages_before: outcome.result.numMessagesBefore,
                num_messages_after: outcome.result.numMessagesAfter,
                summary: renderCompactionOverview(outcome.preview.overview),
              },
              topic_report: outcome.report,
            },
            "listener_conversation_management_send_failed",
            "listener_conversation_management",
          );
          return true;
        } catch (error) {
          // The planner's own two cases, not the cloud taxonomy: this branch
          // only ever sees local failures (M-2).
          safeSocketSend(
            socket,
            {
              type: "conversation_compact_response",
              request_id: parsed.request_id,
              success: false,
              compaction: null,
              error: formatCompactPlanningFailure(error),
            },
            "listener_conversation_management_send_failed",
            "listener_conversation_management",
          );
          return true;
        }
      }
      const compaction = await backend.compactConversationMessages(
        parsed.conversation_id,
        parsed.body,
      );
      safeSocketSend(
        socket,
        {
          type: "conversation_compact_response",
          request_id: parsed.request_id,
          success: true,
          compaction,
        },
        "listener_conversation_management_send_failed",
        "listener_conversation_management",
      );
    } catch (error) {
      safeSocketSend(
        socket,
        {
          type: "conversation_compact_response",
          request_id: parsed.request_id,
          success: false,
          compaction: null,
          error: formatCompactPlanningFailure(error),
        },
        "listener_conversation_management_send_failed",
        "listener_conversation_management",
      );
    }
    return true;
  }

  return false;
}

export function handleAgentConversationManagementProtocolCommand(
  parsed: unknown,
  context: AgentConversationManagementCommandContext,
): boolean {
  const { socket, safeSocketSend, runDetachedListenerTask } = context;

  if (
    isAgentListCommand(parsed) ||
    isAgentRetrieveCommand(parsed) ||
    isAgentCreateCommand(parsed) ||
    isAgentUpdateCommand(parsed) ||
    isAgentDeleteCommand(parsed) ||
    isConversationListCommand(parsed) ||
    isConversationDeleteCommand(parsed) ||
    isConversationRetrieveCommand(parsed) ||
    isConversationCreateCommand(parsed) ||
    isConversationUpdateCommand(parsed) ||
    isConversationRecompileCommand(parsed) ||
    isConversationForkCommand(parsed) ||
    isConversationMessagesListCommand(parsed) ||
    isConversationCompactCommand(parsed)
  ) {
    runDetachedListenerTask(
      "agent_conversation_management_command",
      async () => {
        await handleAgentConversationManagementCommand(
          parsed,
          socket,
          safeSocketSend,
        );
      },
    );
    return true;
  }

  return false;
}
