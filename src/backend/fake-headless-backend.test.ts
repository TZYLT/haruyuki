import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentCreateBody,
  ConversationCreateBody,
  ConversationMessageCreateBody,
  ConversationMessageListBody,
  ConversationUpdateBody,
} from "@/backend";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import { DeterministicToolCallExecutor } from "@/backend/dev/headless-turn-executor";
import {
  type ProviderStreamAdapter,
  ProviderTurnExecutor,
  type ProviderTurnInput,
  providerLettaChunk,
} from "@/backend/dev/provider-turn-executor";
import { TURN_DID_NOT_COMPLETE } from "@/constants";

async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const chunks: unknown[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

class RecordingProviderAdapter implements ProviderStreamAdapter {
  input: ProviderTurnInput | undefined;

  async *stream(input: ProviderTurnInput) {
    this.input = input;
    yield providerLettaChunk({
      message_type: "stop_reason",
      stop_reason: "end_turn",
    } as never);
  }
}

/** Throws on the first turn, succeeds afterwards. */
class FlakyProviderAdapter implements ProviderStreamAdapter {
  calls = 0;
  lastInput: ProviderTurnInput | undefined;

  async *stream(input: ProviderTurnInput) {
    this.calls += 1;
    this.lastInput = input;
    if (this.calls === 1) throw new Error("provider exploded");
    yield providerLettaChunk({
      message_type: "stop_reason",
      stop_reason: "end_turn",
    } as never);
  }
}

async function findConversationDir(
  storageDir: string,
  conversationId: string,
): Promise<string> {
  const conversationsDir = join(storageDir, "conversations");
  for (const dir of await readdir(conversationsDir)) {
    const candidateDir = join(conversationsDir, dir);
    const candidate = JSON.parse(
      await readFile(join(candidateDir, "conversation.json"), "utf8"),
    ) as { id?: unknown };
    if (candidate.id === conversationId) return candidateDir;
  }
  throw new Error("Expected the persisted test conversation directory");
}

describe("FakeHeadlessBackend", () => {
  test("streams deterministic assistant responses", async () => {
    const backend = new FakeHeadlessBackend("agent-fake-headless");
    const conversation = await backend.createConversation({
      agent_id: "agent-fake-headless",
    });

    const chunks = await collect(
      await backend.createConversationMessageStream(conversation.id, {
        agent_id: "agent-fake-headless",
        messages: [{ role: "user", content: "ping" }],
      } as ConversationMessageCreateBody),
    );

    expect(
      chunks.map((chunk) => (chunk as { message_type?: string }).message_type),
    ).toEqual(["assistant_message", "stop_reason"]);
    expect(JSON.stringify(chunks)).toContain("pong");
  });

  test("persists pi-style local transcripts when storage is enabled", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "fake-headless-pi-"));
    const backend = new FakeHeadlessBackend("agent-fake-headless", undefined, {
      storageDir,
      strictAgentAccess: false,
      strictConversationAccess: false,
    });
    const conversation = await backend.createConversation({
      agent_id: "agent-fake-headless",
    });
    await collect(
      await backend.createConversationMessageStream(conversation.id, {
        agent_id: "agent-fake-headless",
        messages: [{ role: "user", content: "persist" }],
      } as ConversationMessageCreateBody),
    );

    const conversationsDir = join(storageDir, "conversations");
    const dirs = await readdir(conversationsDir);
    let conversationDir: string | undefined;
    for (const dir of dirs) {
      const candidateDir = join(conversationsDir, dir);
      const candidate = JSON.parse(
        await readFile(join(candidateDir, "conversation.json"), "utf8"),
      ) as { id?: unknown };
      if (candidate.id === conversation.id) {
        conversationDir = candidateDir;
        break;
      }
    }
    if (!conversationDir)
      throw new Error("Expected the persisted test conversation directory");
    const manifest = JSON.parse(
      await readFile(join(conversationDir, "manifest.json"), "utf8"),
    );
    expect(manifest.provider_stack).toBe("pi-ai");
    const jsonl = await readFile(
      join(conversationDir, "messages.jsonl"),
      "utf8",
    );
    expect(jsonl).toContain('"content"');
    expect(jsonl).not.toContain('"parts"');
  });

  test("passes conversation model settings to local provider turns", async () => {
    const adapter = new RecordingProviderAdapter();
    const backend = new FakeHeadlessBackend(
      "agent-fake-headless",
      new ProviderTurnExecutor(adapter),
      {
        strictAgentAccess: false,
        strictConversationAccess: false,
      },
    );
    const agent = await backend.createAgent({
      name: "Conversation Override Agent",
      model: "openai/gpt-5",
      model_settings: {
        provider_type: "openai",
        reasoning: { reasoning_effort: "minimal" },
        parallel_tool_calls: true,
      },
    } as AgentCreateBody);
    const conversation = await backend.createConversation({
      agent_id: agent.id,
    } as ConversationCreateBody);
    await backend.updateConversation(conversation.id, {
      model: "openai/gpt-5.5",
      model_settings: {
        provider_type: "openai",
        reasoning: { reasoning_effort: "medium" },
      },
      context_window_limit: 500000,
    } as ConversationUpdateBody);

    await collect(
      await backend.createConversationMessageStream(conversation.id, {
        agent_id: agent.id,
        messages: [{ role: "user", content: "use the override" }],
      } as ConversationMessageCreateBody),
    );

    expect(adapter.input?.agent.model).toBe("openai/gpt-5.5");
    expect(adapter.input?.agent.model_settings).toMatchObject({
      provider_type: "openai",
      reasoning: { reasoning_effort: "medium" },
      parallel_tool_calls: true,
      context_window_limit: 500000,
    });

    const storedAgent = await backend.retrieveAgent(agent.id);
    expect(storedAgent.model).toBe("openai/gpt-5");
    expect(storedAgent.model_settings).toMatchObject({
      reasoning: { reasoning_effort: "minimal" },
    });
  });

  test("settles orphaned tool calls from an interrupted turn before the next turn", async () => {
    // Simulate what happens when a turn is interrupted (crash / unhandled error)
    // before cancelConversation is called: a tool_use block is stored in the
    // conversation history but its tool_result never arrives. The next turn must
    // add a synthetic error result so the provider doesn't reject the context.
    const backend = new FakeHeadlessBackend(
      "agent-fake-headless",
      new DeterministicToolCallExecutor(),
      { strictAgentAccess: false, strictConversationAccess: false },
    );
    const conversation = await backend.createConversation({
      agent_id: "agent-fake-headless",
    });

    // Run a turn that ends with a tool call (requires_approval), then do NOT
    // send a tool result — leave the tool call orphaned.
    await collect(
      await backend.createConversationMessageStream(conversation.id, {
        agent_id: "agent-fake-headless",
        messages: [{ role: "user", content: "use a tool" }],
      } as ConversationMessageCreateBody),
    );

    // Inspect the raw local messages before the next turn: there should be one
    // tool call with no corresponding result.
    const storeBefore = (
      backend as unknown as {
        store: { listLocalMessages: (id: string) => unknown[] };
      }
    ).store.listLocalMessages(conversation.id);
    const messagesBefore = storeBefore as Array<{
      role: string;
      content?: Array<{ type: string; id?: string }>;
      toolCallId?: string;
    }>;
    const orphanedCallIds = messagesBefore
      .filter((m) => m.role === "assistant")
      .flatMap((m) => m.content ?? [])
      .filter((c) => c.type === "toolCall")
      .map((c) => c.id ?? "");
    const existingResultIds = messagesBefore
      .filter((m) => m.role === "toolResult")
      .map((m) => m.toolCallId ?? "");
    const unsettled = orphanedCallIds.filter(
      (id) => !existingResultIds.includes(id),
    );
    expect(unsettled.length).toBe(1); // one orphaned tool call before the next turn

    // Start the next turn — executeConversationTurn should settle the orphan first.
    await collect(
      await backend.createConversationMessageStream(conversation.id, {
        agent_id: "agent-fake-headless",
        messages: [{ role: "user", content: "second turn" }],
      } as ConversationMessageCreateBody),
    );

    // Now the orphaned tool call should have a synthetic error result.
    const storeAfter = (
      backend as unknown as {
        store: { listLocalMessages: (id: string) => unknown[] };
      }
    ).store.listLocalMessages(conversation.id);
    const messagesAfter = storeAfter as Array<{
      role: string;
      content?: Array<{ type: string; text?: string }>;
      toolCallId?: string;
    }>;
    const settledResult = messagesAfter.find(
      (m) =>
        m.role === "toolResult" &&
        unsettled.includes(m.toolCallId ?? "") &&
        m.content?.some((c) => c.text === TURN_DID_NOT_COMPLETE),
    );
    expect(settledResult).toBeDefined();
  });

  test("keeps approval turns open when a tool call is emitted", async () => {
    const backend = new FakeHeadlessBackend(
      "agent-fake-headless",
      new DeterministicToolCallExecutor(),
    );
    const conversation = await backend.createConversation({
      agent_id: "agent-fake-headless",
    });
    const chunks = await collect(
      await backend.createConversationMessageStream(conversation.id, {
        agent_id: "agent-fake-headless",
        messages: [{ role: "user", content: "use a tool" }],
      } as ConversationMessageCreateBody),
    );
    expect(
      chunks.map((chunk) => (chunk as { message_type?: string }).message_type),
    ).toEqual(["approval_request_message", "stop_reason"]);
    expect(
      (chunks.at(-1) as { stop_reason?: string } | undefined)?.stop_reason,
    ).toBe("requires_approval");
  });

  // Feature-③ pre-flight pin: the user message is appended to the transcript
  // *before* the provider runs (`executeConversationTurn` calls
  // `store.appendTurnInput` first). Any error path that aborts the turn — the
  // coming hard-context-limit refusal, a provider overflow, a crash — therefore
  // leaves this turn's user message in context. The error copy must say "resend
  // after trimming" rather than auto-retrying, or the model would see it twice.
  //
  // A provider-level throw is *not* a rejection: `ProviderTurnExecutor` wraps
  // the adapter stream and turns a throw into `error_message` + `stop_reason`
  // chunks, so the turn visibly fails and ends. The coming refusal path inherits
  // that shape rather than inventing a new one.
  test("persists the user message before the provider runs, even when it throws", async () => {
    const adapter = new FlakyProviderAdapter();
    const storageDir = await mkdtemp(join(tmpdir(), "fake-headless-order-"));
    const backend = new FakeHeadlessBackend(
      "agent-fake-headless",
      new ProviderTurnExecutor(adapter),
      {
        storageDir,
        strictAgentAccess: false,
        strictConversationAccess: false,
      },
    );
    const conversation = await backend.createConversation({
      agent_id: "agent-fake-headless",
    });

    const chunks = await collect(
      await backend.createConversationMessageStream(conversation.id, {
        agent_id: "agent-fake-headless",
        messages: [{ role: "user", content: "survives the failure" }],
      } as ConversationMessageCreateBody),
    );
    expect(
      chunks.map((chunk) => (chunk as { message_type?: string }).message_type),
    ).toEqual(["error_message", "stop_reason"]);
    expect(
      (chunks.at(-1) as { stop_reason?: string } | undefined)?.stop_reason,
    ).toBe("error");

    const conversationDir = await findConversationDir(
      storageDir,
      conversation.id,
    );
    const record = JSON.parse(
      await readFile(join(conversationDir, "conversation.json"), "utf8"),
    ) as { in_context_message_ids?: string[] };
    expect(record.in_context_message_ids).toHaveLength(1);
    expect(
      await readFile(join(conversationDir, "messages.jsonl"), "utf8"),
    ).toContain("survives the failure");

    // The next turn sees it too: an automatic re-send would duplicate content.
    await collect(
      await backend.createConversationMessageStream(conversation.id, {
        agent_id: "agent-fake-headless",
        messages: [{ role: "user", content: "second" }],
      } as ConversationMessageCreateBody),
    );
    expect(JSON.stringify(adapter.lastInput?.uiMessages)).toContain(
      "survives the failure",
    );
  });

  /**
   * The paging read (`Backend.listConversationHistoryPage`), which is what lets the
   * TUI scroll past a compaction and what tells it which order it is walking.
   */
  describe("paging the transcript log", () => {
    /** The rows of a list result, whichever shape the backend returned. */
    function pageItems(page: unknown): Array<{ id: string }> {
      return (
        page as { getPaginatedItems(): Array<{ id: string }> }
      ).getPaginatedItems();
    }

    test("states its order, oldest first, and stops at the log's own start", async () => {
      const storageDir = await mkdtemp(
        join(tmpdir(), "fake-headless-history-"),
      );
      const backend = new FakeHeadlessBackend("agent-history", undefined, {
        storageDir,
        strictAgentAccess: false,
        strictConversationAccess: false,
      });
      const conversation = await backend.createConversation({
        agent_id: "agent-history",
      });
      for (const text of ["one", "two", "three"]) {
        await collect(
          await backend.createConversationMessageStream(conversation.id, {
            agent_id: "agent-history",
            messages: [{ role: "user", content: text }],
          } as ConversationMessageCreateBody),
        );
      }

      // Nothing has been compacted here, so the in-context list *is* the log; the
      // newest-first read is the same rows the page has to reverse.
      const newestFirst = pageItems(
        await backend.listConversationMessages(conversation.id, {
          agent_id: "agent-history",
          order: "desc",
          limit: 50,
        } as ConversationMessageListBody),
      );
      expect(newestFirst.length).toBeGreaterThan(2);

      // `before` is exclusive: a page holds the rows the log keeps *before* the
      // cursor, oldest first — and it says so, rather than leaving the caller to
      // remember which order it is in.
      const page = await backend.listConversationHistoryPage(conversation.id, {
        agent_id: "agent-history",
        before: newestFirst[0]?.id ?? "",
        limit: 50,
      });
      expect(page.order).toBe("log");
      expect(page.messages.map((message) => message.id)).toEqual(
        newestFirst
          .slice(1)
          .map((message) => message.id)
          .reverse(),
      );

      // The log's own first row is where the walk stops: an empty page. A page of
      // the in-context list would stop at a compaction's summary instead, which is
      // the "已到这次会话的开头" lie this method exists to make impossible.
      const older = await backend.listConversationHistoryPage(conversation.id, {
        agent_id: "agent-history",
        before: page.messages[0]?.id ?? "",
        limit: 50,
      });
      expect(older.order).toBe("log");
      expect(older.messages).toEqual([]);
    });
  });
});
