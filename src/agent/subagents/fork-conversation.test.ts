import { describe, expect, test } from "bun:test";
import type { SubagentConfig } from "@/agent/subagents";
import { forkParentConversation } from "@/agent/subagents/fork-conversation";
import type { Backend } from "@/backend";

const forkConfig: SubagentConfig = {
  name: "fork",
  description: "Fork the parent conversation",
  systemPrompt: "",
  allowedTools: "all",
  skills: [],
  fork: true,
  launchProfile: "default",
};

function backendFixture(events: string[]) {
  return {
    forkConversation: async (conversationId: string) => {
      events.push(`fork:${conversationId}`);
      return { id: "conv-fork" };
    },
    deleteConversation: async (conversationId: string) => {
      events.push(`delete:${conversationId}`);
    },
  } as unknown as Backend;
}

describe("forkParentConversation", () => {
  test("forks the parent conversation and copies the client toolset", async () => {
    const events: string[] = [];
    const result = await forkParentConversation(
      {
        backend: backendFixture(events),
        parentAgentId: "agent-parent",
        parentConversationId: "conv-parent",
        config: forkConfig,
      },
      {
        inheritToolset: async (agentId, parentId, forkId) => {
          events.push(`toolset:${agentId}:${parentId}:${forkId}`);
        },
      },
    );

    expect(result.id).toBe("conv-fork");
    expect(events).toEqual([
      "fork:conv-parent",
      "toolset:agent-parent:conv-parent:conv-fork",
    ]);
  });

  test("passes the parent agent for an agent-scoped default conversation", async () => {
    const forked = await forkParentConversation(
      {
        backend: {
          forkConversation: async (
            _conversationId: string,
            body: Record<string, unknown>,
          ) => {
            expect(body).toMatchObject({
              agentId: "agent-parent",
              hidden: true,
            });
            return { id: "conv-fork" };
          },
        } as unknown as Backend,
        parentAgentId: "agent-parent",
        parentConversationId: "default",
        config: forkConfig,
      },
      { inheritToolset: async () => undefined },
    );

    expect(forked.id).toBe("conv-fork");
  });

  test("forks without any model override in the fork body", async () => {
    let body: Record<string, unknown> | undefined;
    await forkParentConversation(
      {
        backend: {
          forkConversation: async (
            _conversationId: string,
            forkBody: Record<string, unknown>,
          ) => {
            body = forkBody;
            return { id: "conv-fork" };
          },
        } as unknown as Backend,
        parentAgentId: "agent-parent",
        parentConversationId: "conv-parent",
        config: forkConfig,
      },
      { inheritToolset: async () => undefined },
    );

    // A fork inherits the parent's model and applied prefix; it never re-pins
    // either, so the fork body carries no model/llm-config keys (D-C). It does
    // carry provenance — F-01 records background forks so the hidden-session
    // viewer can tell a task fork from an external one.
    expect(body?.hidden).toBe(true);
    expect(body?.origin).toBe("background");
    expect(Object.keys(body ?? {}).sort()).toEqual([
      "hidden",
      "origin",
      "signal",
    ]);
  });

  test("deletes the hidden fork when toolset inheritance fails", async () => {
    const events: string[] = [];
    await expect(
      forkParentConversation(
        {
          backend: backendFixture(events),
          parentAgentId: "agent-parent",
          parentConversationId: "conv-parent",
          config: forkConfig,
        },
        {
          inheritToolset: async () => {
            events.push("toolset-failed");
            throw new Error("toolset inheritance failed");
          },
        },
      ),
    ).rejects.toThrow("toolset inheritance failed");

    expect(events).toEqual([
      "fork:conv-parent",
      "toolset-failed",
      "delete:conv-fork",
    ]);
  });
});
