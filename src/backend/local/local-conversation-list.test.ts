import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Conversation } from "@letta-ai/letta-client/resources/conversations/conversations";
import { LocalBackend } from "@/backend/local/local-backend";
import { listLocalConversations } from "@/backend/local/local-conversation-list";
import type { HiddenConversationSummary } from "@/types/conversation-provenance";

type ListableConversation = Conversation & {
  hidden?: boolean;
  origin?: string;
  context_mode?: string;
  parent_conversation_id?: string | null;
  inherited_message_count?: number | null;
  inherited_through_message_id?: string | null;
};

function conversation(input: {
  id: string;
  agentId?: string;
  summary?: string;
  updatedAt: string;
  hidden?: boolean;
  origin?: string;
  contextMode?: string;
  parentConversationId?: string | null;
  inheritedMessageCount?: number | null;
  inheritedThroughMessageId?: string | null;
  inContextCount?: number;
}): ListableConversation {
  return {
    id: input.id,
    agent_id: input.agentId ?? "agent-1",
    summary: input.summary ?? null,
    created_at: input.updatedAt,
    updated_at: input.updatedAt,
    last_message_at: input.updatedAt,
    in_context_message_ids: Array.from(
      { length: input.inContextCount ?? 0 },
      (_, index) => `${input.id}:msg-${index}`,
    ),
    ...(input.hidden ? { hidden: true } : {}),
    ...(input.origin ? { origin: input.origin } : {}),
    ...(input.contextMode ? { context_mode: input.contextMode } : {}),
    ...(input.parentConversationId !== undefined
      ? { parent_conversation_id: input.parentConversationId }
      : {}),
    ...(input.inheritedMessageCount !== undefined
      ? { inherited_message_count: input.inheritedMessageCount }
      : {}),
    ...(input.inheritedThroughMessageId !== undefined
      ? { inherited_through_message_id: input.inheritedThroughMessageId }
      : {}),
  } as ListableConversation;
}

function ids(rows: Array<{ id: string }>): string[] {
  return rows.map((row) => row.id);
}

describe("listLocalConversations", () => {
  test("filters titles and IDs case-insensitively before applying the limit", () => {
    const result = listLocalConversations(
      [
        conversation({
          id: "local-conv-newest",
          summary: "Release Planning",
          updatedAt: "2026-07-18T12:00:00.000Z",
        }),
        conversation({
          id: "local-conv-flaky",
          summary: "Flaky Integration Tests",
          updatedAt: "2026-07-17T12:00:00.000Z",
        }),
      ],
      { agent_id: "agent-1", summary_search: "  FLAKY ", limit: 1 },
    );

    expect(ids(result)).toEqual(["local-conv-flaky"]);
  });

  test("keeps completed local resume searches filtered", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "resume-search-"));

    try {
      const backend = new LocalBackend({ storageDir, memfsEnabled: false });
      const agent = await backend.createAgent({ name: "Local" } as never);
      await backend.createConversation({
        agent_id: agent.id,
        summary: "Release Planning",
      } as never);
      const flaky = await backend.createConversation({
        agent_id: agent.id,
        summary: "Flaky Integration Tests",
      } as never);

      const results = (await backend.listConversations({
        agent_id: agent.id,
        summary_search: "flaky",
      } as never)) as Conversation[];

      expect(ids(results)).toEqual([flaky.id]);
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("preserves agent, hidden, ordering, and cursor filters", () => {
    const result = listLocalConversations(
      [
        conversation({
          id: "local-conv-3",
          summary: "Third",
          updatedAt: "2026-07-18T12:00:00.000Z",
        }),
        conversation({
          id: "local-conv-hidden",
          summary: "Hidden",
          updatedAt: "2026-07-18T13:00:00.000Z",
          hidden: true,
        }),
        conversation({
          id: "local-conv-2",
          summary: "Second",
          updatedAt: "2026-07-17T12:00:00.000Z",
        }),
        conversation({
          id: "local-conv-other-agent",
          agentId: "agent-2",
          summary: "Other",
          updatedAt: "2026-07-19T12:00:00.000Z",
        }),
      ],
      { agent_id: "agent-1", after: "local-conv-3" },
    );

    expect(ids(result)).toEqual(["local-conv-2"]);
  });
});

describe("listLocalConversations hidden-only filter (F-01 §5.2.1)", () => {
  const fixtures = () => [
    conversation({
      id: "default",
      updatedAt: "2026-07-18T12:00:00.000Z",
      hidden: true,
    }),
    conversation({
      id: "local-conv-visible",
      updatedAt: "2026-07-18T12:00:00.000Z",
    }),
    conversation({
      id: "local-conv-hidden-new",
      updatedAt: "2026-07-18T13:00:00.000Z",
      hidden: true,
    }),
    conversation({
      id: "local-conv-hidden-old",
      updatedAt: "2026-07-17T12:00:00.000Z",
      hidden: true,
    }),
  ];

  test("returns only hidden conversations and still excludes default", () => {
    const result = listLocalConversations(fixtures(), { hidden_only: true });

    expect(ids(result)).toEqual([
      "local-conv-hidden-new",
      "local-conv-hidden-old",
    ]);
    expect(result.every((row) => row.hidden === true)).toBe(true);
  });

  test("include_hidden without hidden_only stays the older superset", () => {
    expect(
      ids(listLocalConversations(fixtures(), { include_hidden: true })),
    ).toEqual([
      "local-conv-hidden-new",
      "local-conv-visible",
      "local-conv-hidden-old",
    ]);
    // The default (neither flag) is unchanged: hidden stays out.
    expect(ids(listLocalConversations(fixtures(), {}))).toEqual([
      "local-conv-visible",
    ]);
  });

  test("hidden_only wins when both flags are set", () => {
    const result = listLocalConversations(fixtures(), {
      include_hidden: true,
      hidden_only: true,
    });

    expect(ids(result)).toEqual([
      "local-conv-hidden-new",
      "local-conv-hidden-old",
    ]);
  });

  test("hidden_only keeps agent, search, limit, and cursor filters", () => {
    const rows = [
      conversation({
        id: "local-conv-reflect-a",
        agentId: "agent-1",
        summary: "Nightly reflection",
        updatedAt: "2026-07-18T12:00:00.000Z",
        hidden: true,
      }),
      conversation({
        id: "local-conv-reflect-b",
        agentId: "agent-1",
        summary: "Nightly dream",
        updatedAt: "2026-07-17T12:00:00.000Z",
        hidden: true,
      }),
      conversation({
        id: "local-conv-reflect-c",
        agentId: "agent-2",
        summary: "Other agent reflection",
        updatedAt: "2026-07-19T12:00:00.000Z",
        hidden: true,
      }),
    ];

    expect(
      ids(
        listLocalConversations(rows, {
          agent_id: "agent-1",
          hidden_only: true,
          summary_search: "reflection",
        }),
      ),
    ).toEqual(["local-conv-reflect-a"]);

    // Cursor paging happens after the hidden filter, so page two of the
    // current agent's list is the older row — not the other agent's.
    expect(
      ids(
        listLocalConversations(rows, {
          agent_id: "agent-1",
          hidden_only: true,
          after: "local-conv-reflect-a",
          limit: 1,
        }),
      ),
    ).toEqual(["local-conv-reflect-b"]);
  });
});

describe("listLocalConversations provenance annotations (F-01 §5.2.4)", () => {
  test("carries origin, parent, mode, and the in-context size", () => {
    const [row] = listLocalConversations(
      [
        conversation({
          id: "local-conv-annotated",
          updatedAt: "2026-07-18T12:00:00.000Z",
          hidden: true,
          origin: "reflection",
          contextMode: "inherited-history",
          parentConversationId: "local-conv-parent",
          inheritedMessageCount: 9,
          inheritedThroughMessageId: "local-msg-9:assistant:0",
          inContextCount: 4,
        }),
      ],
      { hidden_only: true },
    );

    expect(row).toMatchObject({
      id: "local-conv-annotated",
      hidden: true,
      origin: "reflection",
      context_mode: "inherited-history",
      parent_conversation_id: "local-conv-parent",
      inherited_message_count: 9,
      inherited_through_message_id: "local-msg-9:assistant:0",
      context_message_count: 4,
    });
  });

  test("reads a legacy row as unknown with no context size", () => {
    const [row] = listLocalConversations(
      [
        conversation({
          id: "local-conv-legacy",
          updatedAt: "2026-07-18T12:00:00.000Z",
          hidden: true,
        }),
      ],
      { hidden_only: true },
    );

    expect(row?.origin).toBe("unknown");
    expect(row?.context_message_count).toBe(0);
    expect(row?.context_mode).toBeUndefined();
    expect(row?.parent_conversation_id).toBeUndefined();
  });
});

describe("hidden conversations through the local backend (F-01 §5.2)", () => {
  test("hidden_only lists only hidden records; the default list excludes them", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "hidden-list-"));
    try {
      const backend = new LocalBackend({ storageDir, memfsEnabled: false });
      const agent = await backend.createAgent({ name: "Local" } as never);
      const source = await backend.createConversation({
        agent_id: agent.id,
        summary: "Console conversation",
      } as never);
      const backgroundFork = await backend.forkConversation(source.id, {
        hidden: true,
        origin: "background",
      });
      const externalFork = await backend.forkConversation(source.id, {
        hidden: true,
        origin: "external",
      });

      const visible = (await backend.listConversations({
        agent_id: agent.id,
      })) as Conversation[];
      expect(ids(visible)).toEqual([source.id]);

      const hidden = (await backend.listConversations({
        agent_id: agent.id,
        hidden_only: true,
      } as never)) as unknown as HiddenConversationSummary[];
      expect(ids(hidden).sort()).toEqual(
        [backgroundFork.id, externalFork.id].sort(),
      );
      expect(hidden.map((row) => row.origin).sort()).toEqual([
        "background",
        "external",
      ]);
      expect(hidden.map((row) => row.context_message_count)).toEqual([0, 0]);
      expect(hidden.every((row) => row.hidden === true)).toBe(true);

      const all = (await backend.listConversations({
        agent_id: agent.id,
        include_hidden: true,
      } as never)) as unknown as HiddenConversationSummary[];
      expect(ids(all).sort()).toEqual(
        [source.id, backgroundFork.id, externalFork.id].sort(),
      );
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });
});
