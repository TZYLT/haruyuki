import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationMessageCreateBody } from "@/backend";
import { LocalBackend } from "@/backend/local/local-backend";
import { LocalStore } from "@/backend/local/local-store";
import type { StoredConversation } from "@/backend/local/local-types";
import type { LocalCompiledSystemPrompt } from "@/backend/local/system-prompt-compilation";

describe("LocalBackend conversation forks", () => {
  test("copies the parent frozen snapshot to the fork (V13)", () => {
    const agentId = "agent-local-fork-freeze";
    const store = new LocalStore(agentId);
    const source = store.createConversation({ agent_id: agentId } as never);
    const snapshot: LocalCompiledSystemPrompt = {
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
    store.setCompiledSystemPrompt(source.id, agentId, snapshot);

    const forked = store.forkConversation(source.id);
    const inherited = store.getCompiledSystemPrompt(forked.id, agentId);

    // The child starts byte-identical and is marked as inherited, not freshly
    // compiled.
    expect(inherited?.content).toBe(snapshot.content);
    expect(inherited?.frozenTools).toBe(snapshot.frozenTools);
    expect(inherited?.frozenSkillsBlock).toBe(snapshot.frozenSkillsBlock);
    expect(inherited?.frozenModel).toBe(snapshot.frozenModel);
    expect(inherited?.frozenReason).toBe("fork_inherited");

    // A parent change after the fork must not flow into the child.
    store.setCompiledSystemPrompt(source.id, agentId, {
      ...snapshot,
      content: "parent changed",
    });
    expect(store.getCompiledSystemPrompt(forked.id, agentId)?.content).toBe(
      "compiled system",
    );
  });

  test("inherits the parent's topic markers and keeps writing its own (G12)", async () => {
    // Markers are transcript rows, so this needs a real storage directory and the
    // backend seam that remaps their anchors onto the fork's cloned messages.
    const storageDir = await mkdtemp(join(tmpdir(), "local-fork-topics-"));
    try {
      const agentId = "agent-local-fork-topics";
      const store = new LocalStore(agentId, { storageDir });
      const source = store.createConversation({ agent_id: agentId } as never);
      store.appendTurnInput(source.id, {
        agent_id: agentId,
        messages: [
          { role: "user", content: "first topic" },
          { role: "user", content: "second topic" },
        ],
      } as unknown as ConversationMessageCreateBody);
      const sourceMessages = store.listLocalMessages(source.id, agentId);
      const firstAnchor = sourceMessages[0]?.id;
      if (!firstAnchor) throw new Error("Expected a source message id");
      store.contextRewrites.appendTopicMarker({
        conversationId: source.id,
        agentId,
        title: "Parent topic",
        summary: "what the parent discussed",
        createdBy: "agent",
      });

      // Fork through the backend, which is the only seam that remaps anchors.
      const backend = new LocalBackend({
        storageDir,
        memfsEnabled: false,
      });
      const forked = await backend.forkConversation(source.id, {});

      const inherited = backend.listTopicMarkers(forked.id, agentId);
      expect(inherited.map((marker) => marker.title)).toEqual(["Parent topic"]);
      // The anchor points at the fork's own copy, not the parent's message.
      const forkedMessages = (
        backend as unknown as { store: LocalStore }
      ).store.listLocalMessages(forked.id, agentId);
      expect(forkedMessages.map((message) => message.id)).not.toContain(
        firstAnchor,
      );
      expect(inherited[0]?.anchorMessageId).toBe(forkedMessages.at(-1)?.id);
      expect(inherited[0]?.anchorMessageId).not.toBe(sourceMessages.at(-1)?.id);

      // Later marking is independent in each conversation.
      backend.markTopic({
        conversationId: forked.id,
        agentId,
        title: "Child topic",
        createdBy: "user",
      });

      expect(
        backend.listTopicMarkers(forked.id, agentId).map((m) => m.title),
      ).toEqual(["Parent topic", "Child topic"]);
      expect(
        backend.listTopicMarkers(source.id, agentId).map((m) => m.title),
      ).toEqual(["Parent topic"]);
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("does not copy topic markers into an inherited-context fork (F-03)", async () => {
    // A context-only fork holds the parent's current window, not a positional
    // prefix, so the anchor remap cannot be trusted; the markers stay behind.
    const storageDir = await mkdtemp(join(tmpdir(), "local-fork-topics-ctx-"));
    try {
      const agentId = "agent-local-fork-topics-context";
      const store = new LocalStore(agentId, { storageDir });
      const source = store.createConversation({ agent_id: agentId } as never);
      store.appendTurnInput(source.id, {
        agent_id: agentId,
        messages: [
          { role: "user", content: "first topic" },
          { role: "user", content: "second topic" },
        ],
      } as unknown as ConversationMessageCreateBody);
      store.contextRewrites.appendTopicMarker({
        conversationId: source.id,
        agentId,
        title: "Parent topic",
        createdBy: "agent",
      });

      const backend = new LocalBackend({ storageDir, memfsEnabled: false });
      const forked = await backend.forkConversation(source.id, {
        contextMode: "inherited-context",
      });

      expect(backend.listTopicMarkers(forked.id, agentId)).toEqual([]);
      expect(
        backend.listTopicMarkers(source.id, agentId).map((m) => m.title),
      ).toEqual(["Parent topic"]);
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("does not inherit the source snapshot into a different agent (R-06)", () => {
    const agentId = "agent-local-fork-owner";
    const otherAgentId = "agent-local-fork-other";
    const store = new LocalStore(agentId);
    const source = store.createConversation({ agent_id: agentId } as never);
    store.setCompiledSystemPrompt(source.id, agentId, {
      content: "compiled system",
      coreMemory: "core",
      compiledAt: "2026-01-01T00:00:00.000Z",
      systemTemplateHash: "hash",
      memfsRevision: "rev",
      frozenReason: "conversation_created",
    });

    // The snapshot describes the source agent's system prompt, model, and memory
    // revision — none of which apply to another agent.
    const forked = store.forkConversation(source.id, { agentId: otherAgentId });

    expect(
      store.getCompiledSystemPrompt(forked.id, otherAgentId),
    ).toBeUndefined();
  });

  test("forks through a projected message ID inclusively", () => {
    const agentId = "agent-local-fork-cutoff";
    const store = new LocalStore(agentId);
    const source = store.createConversation({ agent_id: agentId } as never);
    store.appendTurnInput(source.id, {
      agent_id: agentId,
      messages: [
        { role: "user", content: "first" },
        { role: "user", content: "second" },
      ],
    } as unknown as ConversationMessageCreateBody);
    const sourceMessages = store.listLocalMessages(source.id, agentId);
    const projectedMessages = store.listConversationMessages(source.id, {
      agent_id: agentId,
    } as never);
    const cutoffMessageId = projectedMessages.find(
      (message) => message.id === sourceMessages[0]?.id,
    )?.id;
    if (!cutoffMessageId) throw new Error("Expected a projected message ID");

    const forked = store.forkConversation(source.id, {
      messageId: cutoffMessageId,
    });

    expect(store.listLocalMessages(forked.id, agentId)).toHaveLength(1);
  });

  test("rejects an unknown fork cutoff without creating a conversation", () => {
    const agentId = "agent-local-fork-missing-cutoff";
    const store = new LocalStore(agentId);
    const source = store.createConversation({ agent_id: agentId } as never);

    expect(() =>
      store.forkConversation(source.id, { messageId: "missing:assistant:0" }),
    ).toThrow("Message missing:assistant:0 not found");
    expect(store.listConversations({ agent_id: agentId })).toHaveLength(1);
  });

  test("trims a source assistant message at the projected cutoff", () => {
    const agentId = "agent-local-fork-projected-cutoff";
    const store = new LocalStore(agentId);
    const source = store.createConversation({ agent_id: agentId } as never);
    store.appendStreamChunk(source.id, agentId, {
      message_type: "reasoning_message",
      reasoning: "thinking before the answer",
    } as never);
    store.appendStreamChunk(source.id, agentId, {
      message_type: "assistant_message",
      content: [{ type: "text", text: "answer after the cutoff" }],
    } as never);
    const sourceProjected = store.listConversationMessages(source.id, {
      agent_id: agentId,
      order: "asc",
    } as never);
    const cutoffMessageId = sourceProjected.find(
      (message) => message.message_type === "reasoning_message",
    )?.id;
    if (!cutoffMessageId) throw new Error("Expected a reasoning message");

    const forked = store.forkConversation(source.id, {
      messageId: cutoffMessageId,
    });
    const forkedProjected = store.listConversationMessages(forked.id, {
      agent_id: agentId,
      order: "asc",
    } as never);

    expect(forkedProjected.map((message) => message.message_type)).toEqual([
      "reasoning_message",
    ]);
    expect(store.listLocalMessages(forked.id, agentId)[0]?.content).toEqual([
      expect.objectContaining({ thinking: "thinking before the answer" }),
    ]);
  });

  test("rejects a fabricated projected ID for an existing source message", () => {
    const agentId = "agent-local-fork-invalid-projection";
    const store = new LocalStore(agentId);
    const source = store.createConversation({ agent_id: agentId } as never);
    store.appendTurnInput(source.id, {
      agent_id: agentId,
      messages: [{ role: "user", content: "hello" }],
    } as unknown as ConversationMessageCreateBody);
    const sourceMessageId = store.listLocalMessages(source.id, agentId)[0]?.id;
    if (!sourceMessageId) throw new Error("Expected a source message");

    expect(() =>
      store.forkConversation(source.id, {
        messageId: `${sourceMessageId}:assistant:999`,
      }),
    ).toThrow(`Message ${sourceMessageId}:assistant:999 not found`);
    expect(store.listConversations({ agent_id: agentId })).toHaveLength(1);
  });
});

function storedConversation(
  store: LocalStore,
  conversationId: string,
): StoredConversation {
  return store.retrieveConversation(conversationId) as StoredConversation;
}

function projectedIds(store: LocalStore, conversationId: string): string[] {
  return store
    .listConversationMessages(conversationId, { order: "asc" } as never)
    .map((message) => message.id);
}

describe("LocalStore fork provenance (F-01 §5.5)", () => {
  test("records inherited-history, the source as parent, and the cloned size", () => {
    const agentId = "agent-fork-provenance-default";
    const store = new LocalStore(agentId);
    const source = store.createConversation({ agent_id: agentId } as never);
    store.appendTurnInput(source.id, {
      agent_id: agentId,
      messages: [
        { role: "user", content: "first" },
        { role: "user", content: "second" },
      ],
    } as unknown as ConversationMessageCreateBody);

    const forked = store.forkConversation(source.id);
    const record = storedConversation(store, forked.id);

    expect(record.origin).toBe("unknown");
    expect(record.context_mode).toBe("inherited-history");
    expect(record.parent_conversation_id).toBe(source.id);
    expect(record.inherited_message_count).toBe(2);
    // The cursor is a stored (projected) message id, so the detail view can
    // page the log from it directly.
    expect(record.inherited_through_message_id).toBe(
      projectedIds(store, forked.id).at(-1) ?? null,
    );
  });

  test("an empty fork inherits zero messages and no cursor", () => {
    const agentId = "agent-fork-provenance-empty";
    const store = new LocalStore(agentId);
    const source = store.createConversation({ agent_id: agentId } as never);

    const forked = store.forkConversation(source.id);
    const record = storedConversation(store, forked.id);

    expect(record.inherited_message_count).toBe(0);
    expect(record.inherited_through_message_id).toBeNull();
    expect(record.parent_conversation_id).toBe(source.id);
  });

  test("counts projected rows, not local messages", () => {
    const agentId = "agent-fork-provenance-projected";
    const store = new LocalStore(agentId);
    const source = store.createConversation({ agent_id: agentId } as never);
    store.appendStreamChunk(source.id, agentId, {
      message_type: "reasoning_message",
      reasoning: "thinking before the answer",
    } as never);
    store.appendStreamChunk(source.id, agentId, {
      message_type: "assistant_message",
      content: [{ type: "text", text: "answer" }],
    } as never);
    expect(store.listLocalMessages(source.id, agentId)).toHaveLength(1);
    const expectedProjected = projectedIds(store, source.id);

    const forked = store.forkConversation(source.id);
    const record = storedConversation(store, forked.id);

    // One local assistant message projects to reasoning + text rows, so a count
    // of local messages would understate what the viewer has to slice.
    expect(record.inherited_message_count).toBe(expectedProjected.length);
    expect(record.inherited_message_count).toBeGreaterThan(1);
    expect(record.inherited_through_message_id).toBe(
      projectedIds(store, forked.id).at(-1) ?? null,
    );
  });

  test("passes origin and context mode through", () => {
    const agentId = "agent-fork-provenance-origin";
    const store = new LocalStore(agentId);
    const source = store.createConversation({ agent_id: agentId } as never);

    const forked = store.forkConversation(source.id, {
      origin: "reflection",
      contextMode: "inherited-history",
    });

    expect(storedConversation(store, forked.id).origin).toBe("reflection");
  });

  test("points at the direct source, not the original ancestor", () => {
    const agentId = "agent-fork-provenance-chain";
    const store = new LocalStore(agentId);
    const source = store.createConversation({ agent_id: agentId } as never);
    store.appendTurnInput(source.id, {
      agent_id: agentId,
      messages: [{ role: "user", content: "hello" }],
    } as unknown as ConversationMessageCreateBody);

    const middle = store.forkConversation(source.id, { hidden: true });
    const grandchild = store.forkConversation(middle.id, { hidden: true });
    const record = storedConversation(store, grandchild.id);

    expect(record.parent_conversation_id).toBe(middle.id);
    expect(record.parent_conversation_id).not.toBe(source.id);
    // Re-derived from the middle conversation, not copied from its record.
    expect(record.inherited_message_count).toBe(1);
  });

  test("inherited-context copies only the compaction window, summary included", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-fork-context-"));
    try {
      const agentId = "agent-fork-context-window";
      const store = new LocalStore(agentId, { storageDir });
      const source = store.createConversation({ agent_id: agentId } as never);
      store.appendTurnInput(source.id, {
        agent_id: agentId,
        messages: [
          { role: "user", content: "first" },
          { role: "user", content: "second" },
          { role: "user", content: "third" },
        ],
      } as unknown as ConversationMessageCreateBody);
      const kept = store.listLocalMessages(source.id, agentId).at(-1);
      if (!kept) throw new Error("Expected a source message");
      store.contextRewrites.rewriteInContext({
        conversationId: source.id,
        agentId,
        summary: "earlier turns",
        packedSummary: "[compaction] earlier turns",
        remainingMessages: [kept],
      });
      // The window is the summary row plus the message it kept; the other two
      // user messages are out of context.
      expect(store.getInContextMessageIds(source.id, agentId)).toHaveLength(2);

      const forked = store.forkConversation(source.id, {
        origin: "reflection",
        contextMode: "inherited-context",
        parentConversationId: source.id,
        hidden: true,
      });

      const forkedMessages = store.listLocalMessages(forked.id, agentId);
      expect(forkedMessages).toHaveLength(2);
      expect(forkedMessages[0]?.role).toBe("user");
      expect(forkedMessages[0]?.metadata?.compaction?.summary).toBe(
        "earlier turns",
      );
      expect(forkedMessages[1]?.content).toEqual(kept.content);
      expect(forkedMessages.map((message) => message.id)).not.toContain(
        kept.id,
      );

      const record = storedConversation(store, forked.id);
      expect(record.context_mode).toBe("inherited-context");
      expect(record.origin).toBe("reflection");
      expect(record.parent_conversation_id).toBe(source.id);
      expect(record.hidden).toBe(true);
      expect(record.inherited_message_count).toBeGreaterThan(0);
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("an empty context copies no messages but keeps the frozen prefix", () => {
    const agentId = "agent-fork-context-empty";
    const store = new LocalStore(agentId);
    const source = store.createConversation({ agent_id: agentId } as never);
    store.appendTurnInput(source.id, {
      agent_id: agentId,
      messages: [{ role: "user", content: "hello" }],
    } as unknown as ConversationMessageCreateBody);
    store.setCompiledSystemPrompt(source.id, agentId, {
      content: "compiled system",
      coreMemory: "core",
      compiledAt: "2026-01-01T00:00:00.000Z",
      systemTemplateHash: "hash",
      memfsRevision: "rev",
      frozenReason: "conversation_created",
    });
    const record = storedConversation(store, source.id);
    record.in_context_message_ids = [];

    const forked = store.forkConversation(source.id, {
      contextMode: "inherited-context",
    });

    // No message is copied (§5.2.6); the fork still exists and inherits the
    // parent's applied system prompt snapshot.
    expect(store.listLocalMessages(forked.id, agentId)).toHaveLength(0);
    const forkRecord = storedConversation(store, forked.id);
    expect(forkRecord.inherited_message_count).toBe(0);
    expect(forkRecord.inherited_through_message_id).toBeNull();
    expect(store.getCompiledSystemPrompt(forked.id, agentId)?.content).toBe(
      "compiled system",
    );
    expect(
      store.getCompiledSystemPrompt(forked.id, agentId)?.frozenReason,
    ).toBe("fork_inherited");
  });

  test("rejects a message cutoff combined with inherited-context", () => {
    const agentId = "agent-fork-context-message-id";
    const store = new LocalStore(agentId);
    const source = store.createConversation({ agent_id: agentId } as never);
    store.appendTurnInput(source.id, {
      agent_id: agentId,
      messages: [{ role: "user", content: "hello" }],
    } as unknown as ConversationMessageCreateBody);
    const messageId = projectedIds(store, source.id)[0];
    if (!messageId) throw new Error("Expected a projected message id");

    expect(() =>
      store.forkConversation(source.id, {
        contextMode: "inherited-context",
        messageId,
      }),
    ).toThrow("invalid_argument");
    expect(store.listConversations({ agent_id: agentId })).toHaveLength(1);
  });

  test("survives a conversation.json round-trip", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-fork-provenance-"));
    try {
      const agentId = "agent-fork-provenance-round-trip";
      const store = new LocalStore(agentId, { storageDir });
      const source = store.createConversation({ agent_id: agentId } as never);
      store.appendTurnInput(source.id, {
        agent_id: agentId,
        messages: [{ role: "user", content: "hello" }],
      } as unknown as ConversationMessageCreateBody);
      const forked = store.forkConversation(source.id, {
        hidden: true,
        origin: "background",
      });
      const cursor = storedConversation(
        store,
        forked.id,
      ).inherited_through_message_id;

      const reopened = new LocalStore(agentId, { storageDir });
      const record = reopened.retrieveConversation(
        forked.id,
      ) as StoredConversation;

      expect(record.hidden).toBe(true);
      expect(record.origin).toBe("background");
      expect(record.context_mode).toBe("inherited-history");
      expect(record.parent_conversation_id).toBe(source.id);
      expect(record.inherited_message_count).toBe(1);
      expect(record.inherited_through_message_id).toBe(cursor ?? null);
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });
});
