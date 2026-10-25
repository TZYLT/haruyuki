import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __testSetBackend, type Backend } from "@/backend";
import { LocalBackend } from "@/backend/local/local-backend";
import { toHiddenConversationSummary } from "@/types/conversation-provenance";
import {
  deleteHiddenConversation,
  handleAgentConversationManagementProtocolCommand,
  listConversationMessagePage,
} from "@/websocket/listener/commands/agents-conversations";

type MessageBackend = Pick<Backend, "listConversationMessages">;

function page(messages: unknown[]) {
  return { getPaginatedItems: () => messages };
}

function backendWithPages(...pages: unknown[][]): {
  backend: MessageBackend;
  listMessages: ReturnType<typeof mock>;
} {
  const listMessages = mock(async () => page(pages.shift() ?? []));
  return {
    backend: {
      listConversationMessages:
        listMessages as unknown as MessageBackend["listConversationMessages"],
    },
    listMessages,
  };
}

describe("listConversationMessagePage", () => {
  test("returns a partial final page without probing", async () => {
    const { backend, listMessages } = backendWithPages([
      { id: "message-3" },
      { id: "message-2" },
    ]);

    const result = await listConversationMessagePage(backend, "conv-1", {
      order: "desc",
      limit: 3,
    });

    expect(result).toEqual({
      messages: [{ id: "message-3" }, { id: "message-2" }],
      nextBefore: "message-2",
      hasMore: false,
    });
    expect(listMessages).toHaveBeenCalledTimes(1);
  });

  test("trims an overfilled backend page and reports more history", async () => {
    const { backend, listMessages } = backendWithPages([
      { id: "message-4" },
      { id: "message-3" },
      { id: "message-2" },
    ]);

    const result = await listConversationMessagePage(backend, "conv-1", {
      order: "desc",
      limit: 2,
    });

    expect(result).toEqual({
      messages: [{ id: "message-4" }, { id: "message-3" }],
      nextBefore: "message-3",
      hasMore: true,
    });
    expect(listMessages).toHaveBeenCalledTimes(1);
  });

  test("probes an exactly full page with its oldest message id", async () => {
    const { backend, listMessages } = backendWithPages(
      [{ id: "message-4" }, { id: "message-3" }],
      [{ id: "message-2" }],
    );

    const result = await listConversationMessagePage(backend, "conv-1", {
      before: "message-5",
      order: "desc",
      limit: 2,
    });

    expect(result.hasMore).toBe(true);
    expect(result.nextBefore).toBe("message-3");
    expect(listMessages).toHaveBeenNthCalledWith(2, "conv-1", {
      before: "message-3",
      after: undefined,
      order: "desc",
      limit: 1,
    });
  });

  test("uses the first item as the oldest id for ascending pages", async () => {
    const { backend, listMessages } = backendWithPages(
      [{ id: "message-2" }, { id: "message-3" }],
      [],
    );

    const result = await listConversationMessagePage(backend, "conv-1", {
      order: "asc",
      limit: 2,
    });

    expect(result.nextBefore).toBe("message-2");
    expect(result.hasMore).toBe(false);
    expect(listMessages).toHaveBeenNthCalledWith(2, "conv-1", {
      before: "message-2",
      after: undefined,
      order: "desc",
      limit: 1,
    });
  });

  test("walks multiple descending pages without duplicates", async () => {
    const allMessages = Array.from({ length: 7 }, (_, index) => ({
      id: `message-${index + 1}`,
    }));
    const listMessages = mock(
      async (
        _conversationId: string,
        query: { before?: string; limit?: number },
      ) => {
        const end = query.before
          ? allMessages.findIndex((message) => message.id === query.before)
          : allMessages.length;
        const start = Math.max(0, end - (query.limit ?? 50));
        return page(allMessages.slice(start, end).reverse());
      },
    );
    const backend: MessageBackend = {
      listConversationMessages:
        listMessages as unknown as MessageBackend["listConversationMessages"],
    };
    const collected: string[] = [];
    let before: string | undefined;

    for (;;) {
      const result = await listConversationMessagePage(backend, "conv-1", {
        ...(before ? { before } : {}),
        limit: 3,
      });
      collected.push(
        ...result.messages.map((message) => (message as { id: string }).id),
      );
      if (!result.hasMore) break;
      expect(result.nextBefore).not.toBeNull();
      before = result.nextBefore ?? undefined;
    }

    expect(collected).toEqual([
      "message-7",
      "message-6",
      "message-5",
      "message-4",
      "message-3",
      "message-2",
      "message-1",
    ]);
    expect(new Set(collected).size).toBe(collected.length);
  });
});

type DeleteBackend = Pick<Backend, "listConversations" | "deleteConversation">;

function deleteBackend(
  conversations: Array<{
    id: string;
    hidden?: boolean;
    summary?: string | null;
    origin?: string;
    context_mode?: string;
    in_context_message_ids?: string[];
  }>,
  options: { supportsDelete?: boolean } = {},
): {
  backend: DeleteBackend;
  list: ReturnType<typeof mock>;
  remove: ReturnType<typeof mock>;
} {
  const list = mock(async (query?: Record<string, unknown>) => {
    const search =
      typeof query?.summary_search === "string"
        ? query.summary_search.toLowerCase()
        : undefined;
    const hiddenOnly = query?.hidden_only === true;
    const includeHidden = query?.include_hidden === true;
    const matches = conversations.filter((conversation) => {
      if (hiddenOnly && conversation.hidden !== true) return false;
      if (!hiddenOnly && !includeHidden && conversation.hidden === true) {
        return false;
      }
      if (!search) return true;
      return (
        conversation.id.toLowerCase().includes(search) ||
        (conversation.summary?.toLowerCase().includes(search) ?? false)
      );
    });
    return page(matches);
  });
  const remove = mock(async () => ({}));
  return {
    backend: {
      listConversations: list as unknown as DeleteBackend["listConversations"],
      ...(options.supportsDelete === false
        ? {}
        : { deleteConversation: remove }),
    },
    list,
    remove,
  };
}

describe("deleteHiddenConversation", () => {
  test("deletes the hidden conversation with the exact id", async () => {
    const { backend, remove } = deleteBackend([
      { id: "local-conv-hidden-1", hidden: true },
    ]);

    expect(
      await deleteHiddenConversation(backend, "local-conv-hidden-1"),
    ).toEqual({ ok: true });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith("local-conv-hidden-1");
  });

  test("refuses the default conversation and never asks the backend", async () => {
    const { backend, list, remove } = deleteBackend([]);

    expect(await deleteHiddenConversation(backend, "default")).toEqual({
      ok: false,
      error: "default_not_deletable",
    });
    expect(list).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  test("reports not_supported when the backend cannot delete", async () => {
    const { backend, list, remove } = deleteBackend(
      [{ id: "local-conv-hidden-1", hidden: true }],
      { supportsDelete: false },
    );

    expect(
      await deleteHiddenConversation(backend, "local-conv-hidden-1"),
    ).toEqual({ ok: false, error: "not_supported" });
    expect(list).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  test("refuses a visible conversation", async () => {
    const { backend, remove } = deleteBackend([
      { id: "local-conv-visible", hidden: false },
    ]);

    expect(
      await deleteHiddenConversation(backend, "local-conv-visible"),
    ).toEqual({ ok: false, error: "not_hidden" });
    expect(remove).not.toHaveBeenCalled();
  });

  test("reports a conversation that does not exist", async () => {
    const { backend, remove } = deleteBackend([]);

    expect(await deleteHiddenConversation(backend, "local-conv-gone")).toEqual({
      ok: false,
      error: "conversation_not_found",
    });
    expect(remove).not.toHaveBeenCalled();
  });

  test("never matches a longer id by substring", async () => {
    // A summary search for "local-conv-1" also returns "local-conv-12"; only
    // exact equality may authorize a delete.
    const { backend, remove } = deleteBackend([
      { id: "local-conv-12", hidden: true },
    ]);

    expect(await deleteHiddenConversation(backend, "local-conv-1")).toEqual({
      ok: false,
      error: "conversation_not_found",
    });
    expect(remove).not.toHaveBeenCalled();
  });

  test("refuses a visible row even when the backend ignores hidden_only", async () => {
    // A backend that does not implement the flag answers with visible rows; the
    // returned row's own `hidden` is the authority, not the query we sent.
    const remove = mock(async () => ({}));
    const backend = {
      listConversations: mock(async () =>
        page([{ id: "local-conv-visible", agent_id: "agent-1" }]),
      ),
      deleteConversation: remove,
    } as unknown as DeleteBackend;

    expect(
      await deleteHiddenConversation(backend, "local-conv-visible"),
    ).toEqual({ ok: false, error: "not_hidden" });
    expect(remove).not.toHaveBeenCalled();
  });
});

describe("toHiddenConversationSummary", () => {
  test("attaches provenance, hidden, and the in-context size", () => {
    expect(
      toHiddenConversationSummary({
        id: "local-conv-hidden-1",
        agent_id: "agent-1",
        hidden: true,
        origin: "reflection",
        parent_conversation_id: "local-conv-parent",
        context_mode: "inherited-history",
        inherited_message_count: 4,
        inherited_through_message_id: "msg-4",
        in_context_message_ids: ["msg-3", "msg-4", "msg-5"],
      } as never),
    ).toMatchObject({
      id: "local-conv-hidden-1",
      hidden: true,
      origin: "reflection",
      parent_conversation_id: "local-conv-parent",
      context_mode: "inherited-history",
      inherited_message_count: 4,
      inherited_through_message_id: "msg-4",
      context_message_count: 3,
    });
  });

  test("reads a legacy row as unknown with a zero context size", () => {
    expect(
      toHiddenConversationSummary({
        id: "local-conv-1",
        agent_id: "agent-1",
      } as never),
    ).toMatchObject({
      id: "local-conv-1",
      origin: "unknown",
      context_message_count: 0,
    });
  });
});

describe("deleteHiddenConversation against the local backend", () => {
  test("deletes a real hidden fork and leaves nothing listable", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "hidden-delete-"));
    try {
      const backend = new LocalBackend({ storageDir, memfsEnabled: false });
      const agent = await backend.createAgent({ name: "Local" } as never);
      const source = await backend.createConversation({
        agent_id: agent.id,
      } as never);
      const hidden = await backend.forkConversation(source.id, {
        hidden: true,
        origin: "background",
      });

      expect(await deleteHiddenConversation(backend, hidden.id)).toEqual({
        ok: true,
      });

      const remaining = (await backend.listConversations({
        agent_id: agent.id,
        hidden_only: true,
      } as never)) as unknown as Array<{ id: string }>;
      expect(remaining.map((conversation) => conversation.id)).toEqual([]);

      // A second delete is a plain not-found, not a silent success.
      expect(await deleteHiddenConversation(backend, hidden.id)).toEqual({
        ok: false,
        error: "conversation_not_found",
      });
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("refuses a real visible conversation", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "hidden-delete-visible-"));
    try {
      const backend = new LocalBackend({ storageDir, memfsEnabled: false });
      const agent = await backend.createAgent({ name: "Local" } as never);
      const visible = await backend.createConversation({
        agent_id: agent.id,
      } as never);

      expect(await deleteHiddenConversation(backend, visible.id)).toEqual({
        ok: false,
        error: "not_hidden",
      });
      const remaining = (await backend.listConversations({
        agent_id: agent.id,
      })) as unknown as Array<{ id: string }>;
      expect(remaining.map((conversation) => conversation.id)).toEqual([
        visible.id,
      ]);
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });
});

describe("protocol dispatch", () => {
  afterEach(() => {
    __testSetBackend(null);
  });

  test("routes conversation_delete to the handler instead of dropping it", async () => {
    const { backend, remove } = deleteBackend([
      { id: "local-conv-hidden-1", hidden: true },
    ]);
    __testSetBackend(backend as never);
    const sent: Array<Record<string, unknown>> = [];
    const handled = handleAgentConversationManagementProtocolCommand(
      {
        type: "conversation_delete",
        request_id: "del-1",
        conversation_id: "local-conv-hidden-1",
      },
      {
        socket: {} as never,
        safeSocketSend: ((
          _socket: unknown,
          payload: Record<string, unknown>,
        ) => {
          sent.push(payload);
        }) as never,
        runDetachedListenerTask: ((
          _name: string,
          task: () => Promise<void>,
        ) => {
          void task();
        }) as never,
      },
    );

    expect(handled).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(remove).toHaveBeenCalledWith("local-conv-hidden-1");
    expect(sent).toContainEqual(
      expect.objectContaining({
        type: "conversation_delete_response",
        request_id: "del-1",
        success: true,
        conversation_id: "local-conv-hidden-1",
      }),
    );
  });
});
