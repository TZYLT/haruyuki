// src/cli/app/pages/overview/overview-data.test.ts

/**
 * G-10: the overview data layer against a fake backend (《47-2》§1.8).
 *
 * The cases map one-to-one onto the gate's list — hidden excluded, `N+` on a
 * full aggregation pass, the per-agent `default` supplement, ordering, lazy
 * previews, generation cancellation, TTL/refresh — plus the retryable error the
 * page shell (W-15) renders. No real backend or harness state is touched: every
 * read goes through the injected fake.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { Backend } from "@/backend";
import type {
  OverviewAgentRecord,
  OverviewSnapshot,
} from "@/cli/app/pages/overview/overview-types";
import { OVERVIEW_CACHE_TTL_MS } from "./overview-cache";
import {
  applyOverviewPreview,
  isOverviewDataError,
  loadOverviewPreview,
  loadOverviewSnapshot,
  OVERVIEW_PREVIEW_ERROR_NOTE,
  OVERVIEW_SNAPSHOT_ERROR_NOTE,
  refreshOverviewSnapshot,
  resetOverviewData,
} from "./overview-data";
import {
  OVERVIEW_AGENT_CONVERSATION_LIMIT,
  OVERVIEW_CONVERSATION_LIST_LIMIT,
  OVERVIEW_DEFAULT_CONVERSATION_ID,
  OVERVIEW_DEFAULT_CONVERSATION_TITLE,
  OVERVIEW_SNIPPET_MAX_LENGTH,
} from "./overview-fetch";

const NOW_MS = Date.parse("2026-11-02T15:00:00.000Z");

interface FakeAgent {
  id: string;
  name?: string | null;
  description?: string | null;
}

interface FakeConversation {
  id: string;
  agent_id: string | null;
  summary?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  last_message_at?: string | null;
  hidden?: boolean;
}

interface FakeMessage {
  message_type?: string;
  content?: unknown;
  date?: string | null;
}

interface FakeBackendState {
  agentListCalls: number;
  conversationListBodies: Array<Record<string, unknown>>;
  defaultReads: string[];
  previewReads: string[];
  failAgentList: boolean;
  failDefaultReadsFor: string[];
}

interface FakeBackendOptions {
  agents?: FakeAgent[];
  conversations?: FakeConversation[];
  /** Newest-first message rows per agent for its `default` conversation. */
  defaults?: Record<string, FakeMessage[]>;
  /** Agents whose `default` supplement read throws (isolation case). */
  failDefaultReadsFor?: string[];
  /** Newest-first message rows per conversation id for a lazy preview. */
  messages?: Record<string, FakeMessage[]>;
  /** Override the preview read, e.g. to hold one open for the generation test. */
  previewLoader?: (
    conversationId: string,
  ) => FakeMessage[] | Promise<FakeMessage[]>;
}

function createFakeBackend(options: FakeBackendOptions = {}): {
  backend: Backend;
  state: FakeBackendState;
} {
  const state: FakeBackendState = {
    agentListCalls: 0,
    conversationListBodies: [],
    defaultReads: [],
    previewReads: [],
    failAgentList: false,
    failDefaultReadsFor: options.failDefaultReadsFor ?? [],
  };

  const backend = {
    async listAgents() {
      state.agentListCalls += 1;
      if (state.failAgentList) throw new Error("backend unavailable");
      return { items: options.agents ?? [] };
    },
    async listConversations(body?: Record<string, unknown>) {
      state.conversationListBodies.push(body ?? {});
      return options.conversations ?? [];
    },
    async listConversationMessages(
      conversationId: string,
      body?: Record<string, unknown>,
    ) {
      if (conversationId === OVERVIEW_DEFAULT_CONVERSATION_ID) {
        const agentId = typeof body?.agent_id === "string" ? body.agent_id : "";
        state.defaultReads.push(agentId);
        if (state.failDefaultReadsFor.includes(agentId)) {
          throw new Error("default read failed");
        }
        return options.defaults?.[agentId] ?? [];
      }
      state.previewReads.push(conversationId);
      if (options.previewLoader) {
        return await options.previewLoader(conversationId);
      }
      return options.messages?.[conversationId] ?? [];
    },
  } as unknown as Backend;

  return { backend, state };
}

function agent(
  id: string,
  fields: { name?: string | null; description?: string | null } = {},
): FakeAgent {
  return { id, ...fields };
}

function conversation(input: {
  id: string;
  agentId: string | null;
  at: string;
  summary?: string | null;
  hidden?: boolean;
}): FakeConversation {
  return {
    id: input.id,
    agent_id: input.agentId,
    summary: input.summary,
    created_at: input.at,
    updated_at: input.at,
    last_message_at: input.at,
    hidden: input.hidden,
  };
}

function message(
  messageType: "user_message" | "assistant_message",
  content: unknown,
  date: string,
): FakeMessage {
  return { message_type: messageType, content, date };
}

function agentRecord(
  snapshot: OverviewSnapshot,
  agentId: string,
): OverviewAgentRecord {
  const record = snapshot.agents.find(
    (candidate) => candidate.agentId === agentId,
  );
  if (!record) throw new Error(`missing agent record for ${agentId}`);
  return record;
}

function conversationIds(
  snapshot: OverviewSnapshot,
  agentId: string,
): string[] {
  return (snapshot.conversations[agentId] ?? []).map(
    (conversationRecord) => conversationRecord.conversationId,
  );
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  resetOverviewData();
});

describe("fetchOverviewSnapshot (through loadOverviewSnapshot)", () => {
  test("orders agents and each conversation group by last activity", async () => {
    const { backend } = createFakeBackend({
      agents: [
        agent("a1", { name: "Agent One", description: "  first agent  " }),
        agent("a2", { name: "Agent Two", description: "   " }),
        agent("a3", { name: "" }),
      ],
      conversations: [
        conversation({
          id: "c1",
          agentId: "a1",
          at: "2026-11-02T10:00:00.000Z",
          summary: "  First chat  ",
        }),
        conversation({
          id: "c2",
          agentId: "a1",
          at: "2026-11-02T12:00:00.000Z",
        }),
        conversation({
          id: "c3",
          agentId: "a2",
          at: "2026-11-02T11:00:00.000Z",
        }),
      ],
      defaults: {
        a2: [message("user_message", "hello", "2026-11-02T14:00:00.000Z")],
      },
    });

    const snapshot = await loadOverviewSnapshot({ backend, nowMs: NOW_MS });

    expect(snapshot.generatedAtMs).toBe(NOW_MS);
    expect(snapshot.agents.map((record) => record.agentId)).toEqual([
      "a2",
      "a1",
      "a3",
    ]);

    const a1 = agentRecord(snapshot, "a1");
    expect(a1.name).toBe("Agent One");
    expect(a1.description).toBe("first agent");
    expect(a1.conversationCount).toBe(2);
    expect(a1.totalConversationCount).toBe(2);
    expect(a1.conversationCountTruncated).toBe(false);
    expect(a1.lastActivityAtMs).toBe(Date.parse("2026-11-02T12:00:00.000Z"));
    expect(conversationIds(snapshot, "a1")).toEqual(["c2", "c1"]);
    expect((snapshot.conversations.a1 ?? [])[1]?.title).toBe("First chat");

    const a2 = agentRecord(snapshot, "a2");
    expect(a2.description).toBeNull();
    expect(a2.conversationCount).toBe(2);
    expect(conversationIds(snapshot, "a2")).toEqual([
      OVERVIEW_DEFAULT_CONVERSATION_ID,
      "c3",
    ]);
    expect((snapshot.conversations.a2 ?? [])[0]?.title).toBe(
      OVERVIEW_DEFAULT_CONVERSATION_TITLE,
    );
    expect(a2.lastActivityAtMs).toBe(Date.parse("2026-11-02T14:00:00.000Z"));

    const a3 = agentRecord(snapshot, "a3");
    expect(a3.name).toBe("a3");
    expect(a3.description).toBeNull();
    expect(a3.conversationCount).toBe(0);
    expect(a3.totalConversationCount).toBe(0);
    expect(a3.lastActivityAtMs).toBeNull();
    expect(conversationIds(snapshot, "a3")).toEqual([]);
  });

  test("excludes hidden conversations and agent-free conversations (Q-35)", async () => {
    const { backend } = createFakeBackend({
      agents: [agent("a1")],
      conversations: [
        conversation({ id: "visible", agentId: "a1", at: NOW_MS_ISO(1) }),
        conversation({
          id: "hidden",
          agentId: "a1",
          at: NOW_MS_ISO(9),
          hidden: true,
        }),
        conversation({ id: "orphan", agentId: null, at: NOW_MS_ISO(8) }),
        conversation({ id: "elsewhere", agentId: "a9", at: NOW_MS_ISO(7) }),
      ],
    });

    const snapshot = await loadOverviewSnapshot({ backend, nowMs: NOW_MS });

    expect(snapshot.agents.map((record) => record.agentId)).toEqual(["a1"]);
    expect(conversationIds(snapshot, "a1")).toEqual(["visible"]);
    const record = agentRecord(snapshot, "a1");
    expect(record.totalConversationCount).toBe(1);
    // The hidden row is newer than the visible one; it must not leak into the
    // agent's last activity either.
    expect(record.lastActivityAtMs).toBe(Date.parse(NOW_MS_ISO(1)));
  });

  test("marks every count truncated when the single pass hits its limit (N+)", async () => {
    const agentIds = ["a1", "a2"];
    const rows: FakeConversation[] = [];
    for (let index = 0; index < OVERVIEW_CONVERSATION_LIST_LIMIT; index += 1) {
      rows.push({
        id: `c${index}`,
        agent_id: agentIds[index % agentIds.length] as string,
        created_at: NOW_MS_ISO(index),
        updated_at: NOW_MS_ISO(index),
        last_message_at: NOW_MS_ISO(index),
      });
    }
    const { backend, state } = createFakeBackend({
      agents: [agent("a1"), agent("a2")],
      conversations: rows,
    });

    const snapshot = await loadOverviewSnapshot({ backend, nowMs: NOW_MS });

    expect(state.conversationListBodies).toHaveLength(1);
    expect(state.conversationListBodies[0]?.limit).toBe(
      OVERVIEW_CONVERSATION_LIST_LIMIT,
    );
    expect(state.conversationListBodies[0]?.order).toBe("desc");
    for (const record of snapshot.agents) {
      expect(record.conversationCountTruncated).toBe(true);
      // The second level carries the first screen only, while the aggregate
      // reports what the pass saw (a lower bound under the flag).
      expect(record.conversationCount).toBe(OVERVIEW_AGENT_CONVERSATION_LIMIT);
      expect(record.totalConversationCount).toBe(
        OVERVIEW_CONVERSATION_LIST_LIMIT / 2,
      );
    }
    expect(conversationIds(snapshot, "a1")).toHaveLength(
      OVERVIEW_AGENT_CONVERSATION_LIMIT,
    );
  });

  test("does not flag counts when the pass is below its limit", async () => {
    const rows: FakeConversation[] = [];
    const count = OVERVIEW_CONVERSATION_LIST_LIMIT - 1;
    for (let index = 0; index < count; index += 1) {
      rows.push({
        id: `c${index}`,
        agent_id: "a1",
        created_at: NOW_MS_ISO(index),
        updated_at: NOW_MS_ISO(index),
        last_message_at: NOW_MS_ISO(index),
      });
    }
    const { backend } = createFakeBackend({
      agents: [agent("a1")],
      conversations: rows,
    });

    const snapshot = await loadOverviewSnapshot({ backend, nowMs: NOW_MS });

    const record = agentRecord(snapshot, "a1");
    expect(record.conversationCountTruncated).toBe(false);
    expect(record.totalConversationCount).toBe(count);
    expect(record.conversationCount).toBe(OVERVIEW_AGENT_CONVERSATION_LIMIT);
  });

  test("supplements the agent's default conversation (Q-53)", async () => {
    const { backend, state } = createFakeBackend({
      agents: [agent("a1"), agent("a2")],
      conversations: [
        conversation({
          id: "c10",
          agentId: "a1",
          at: "2026-11-02T10:00:00.000Z",
        }),
        conversation({
          id: "c12",
          agentId: "a1",
          at: "2026-11-02T12:00:00.000Z",
        }),
      ],
      defaults: {
        a1: [
          message("user_message", "default newest", "2026-11-02T11:00:00.000Z"),
        ],
      },
    });

    const snapshot = await loadOverviewSnapshot({ backend, nowMs: NOW_MS });

    expect(state.defaultReads.sort()).toEqual(["a1", "a2"]);
    // Default sits by activity between the two listed conversations, not at the
    // top as a fixed prefix (R-10.3 orders by last message time).
    expect(conversationIds(snapshot, "a1")).toEqual([
      "c12",
      OVERVIEW_DEFAULT_CONVERSATION_ID,
      "c10",
    ]);
    const record = agentRecord(snapshot, "a1");
    expect(record.conversationCount).toBe(3);
    expect(record.totalConversationCount).toBe(3);
    expect(record.lastActivityAtMs).toBe(
      Date.parse("2026-11-02T12:00:00.000Z"),
    );
    expect(agentRecord(snapshot, "a2").conversationCount).toBe(0);
  });

  test("keeps the snapshot when one agent's default read fails", async () => {
    const { backend } = createFakeBackend({
      agents: [agent("a1"), agent("a2")],
      conversations: [
        conversation({ id: "c1", agentId: "a1", at: NOW_MS_ISO(1) }),
      ],
      defaults: {
        a1: [message("user_message", "unreadable", NOW_MS_ISO(2))],
        a2: [message("user_message", "still here", NOW_MS_ISO(3))],
      },
      failDefaultReadsFor: ["a1"],
    });

    const snapshot = await loadOverviewSnapshot({ backend, nowMs: NOW_MS });

    expect(conversationIds(snapshot, "a1")).toEqual(["c1"]);
    expect(conversationIds(snapshot, "a2")).toEqual([
      OVERVIEW_DEFAULT_CONVERSATION_ID,
    ]);
    expect(agentRecord(snapshot, "a2").totalConversationCount).toBe(1);
  });

  test("returns an empty snapshot, not an error, when there are no agents", async () => {
    const { backend } = createFakeBackend();

    const snapshot = await loadOverviewSnapshot({ backend, nowMs: NOW_MS });

    expect(snapshot.agents).toEqual([]);
    expect(snapshot.conversations).toEqual({});
    expect(snapshot.generatedAtMs).toBe(NOW_MS);
  });

  test("wraps a failed read in a retryable error and succeeds on retry", async () => {
    const { backend, state } = createFakeBackend({ agents: [agent("a1")] });
    state.failAgentList = true;

    try {
      await loadOverviewSnapshot({ backend, nowMs: NOW_MS });
      throw new Error("expected the read to fail");
    } catch (error) {
      expect(isOverviewDataError(error)).toBe(true);
      if (isOverviewDataError(error)) {
        expect(error.retryable).toBe(true);
        expect(error.message).toBe(OVERVIEW_SNAPSHOT_ERROR_NOTE);
      }
    }

    state.failAgentList = false;
    const snapshot = await loadOverviewSnapshot({ backend, nowMs: NOW_MS });
    expect(snapshot.agents.map((record) => record.agentId)).toEqual(["a1"]);
  });
});

describe("overview snapshot cache (TTL and refresh)", () => {
  test("serves the cached snapshot for 30 s, then refetches", async () => {
    const { backend, state } = createFakeBackend({ agents: [agent("a1")] });

    await loadOverviewSnapshot({ backend, nowMs: NOW_MS });
    expect(state.agentListCalls).toBe(1);

    await loadOverviewSnapshot({
      backend,
      nowMs: NOW_MS + OVERVIEW_CACHE_TTL_MS - 1,
    });
    expect(state.agentListCalls).toBe(1);

    const refetched = await loadOverviewSnapshot({
      backend,
      nowMs: NOW_MS + OVERVIEW_CACHE_TTL_MS,
    });
    expect(state.agentListCalls).toBe(2);
    // The TTL anchor is the snapshot's own timestamp, not the read clock.
    expect(refetched.generatedAtMs).toBe(NOW_MS + OVERVIEW_CACHE_TTL_MS);
  });

  test("refresh ignores the cache and takes a new generation", async () => {
    const { backend, state } = createFakeBackend({ agents: [agent("a1")] });

    const first = await loadOverviewSnapshot({ backend, nowMs: NOW_MS });
    const refreshed = await refreshOverviewSnapshot({
      backend,
      nowMs: NOW_MS + 1_000,
    });

    expect(state.agentListCalls).toBe(2);
    expect(refreshed.generatedAtMs).toBe(NOW_MS + 1_000);
    expect(refreshed).not.toBe(first);
  });

  test("concurrent reads share one backend pass", async () => {
    const { backend, state } = createFakeBackend({ agents: [agent("a1")] });

    const [first, second] = await Promise.all([
      loadOverviewSnapshot({ backend, nowMs: NOW_MS }),
      loadOverviewSnapshot({ backend, nowMs: NOW_MS }),
    ]);

    expect(state.agentListCalls).toBe(1);
    expect(first).toBe(second);
  });
});

describe("lazy conversation previews", () => {
  const messageDate = "2026-11-02T13:00:00.000Z";

  test("reads each conversation once and returns both snippets", async () => {
    const { backend, state } = createFakeBackend({
      agents: [agent("a1")],
      conversations: [
        conversation({ id: "c1", agentId: "a1", at: NOW_MS_ISO(1) }),
      ],
      messages: {
        c1: [
          message("assistant_message", "the answer", messageDate),
          message("user_message", "the question", "2026-11-02T12:59:00.000Z"),
        ],
      },
    });

    const snapshot = await loadOverviewSnapshot({ backend, nowMs: NOW_MS });
    expect(state.previewReads).toEqual([]);
    expect((snapshot.conversations.a1 ?? [])[0]?.lastUserMessage).toBeNull();

    const first = await loadOverviewPreview("a1", "c1", { backend });
    expect(first.status).toBe("loaded");
    if (first.status === "loaded") {
      expect(first.preview).toEqual({
        lastUserMessage: "the question",
        lastAgentMessage: "the answer",
      });
    }
    const second = await loadOverviewPreview("a1", "c1", { backend });
    expect(second.status).toBe("loaded");
    expect(state.previewReads).toEqual(["c1"]);
  });

  test("deduplicates a read that is already in flight", async () => {
    const deferred = createDeferred<FakeMessage[]>();
    const { backend, state } = createFakeBackend({
      agents: [agent("a1")],
      conversations: [
        conversation({ id: "c1", agentId: "a1", at: NOW_MS_ISO(1) }),
      ],
      previewLoader: () => deferred.promise,
    });

    await loadOverviewSnapshot({ backend, nowMs: NOW_MS });
    const first = loadOverviewPreview("a1", "c1", { backend });
    const second = loadOverviewPreview("a1", "c1", { backend });
    deferred.resolve([message("user_message", "hi", messageDate)]);

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.status).toBe("loaded");
    expect(secondResult.status).toBe("loaded");
    expect(state.previewReads).toEqual(["c1"]);
  });

  test("drops a preview whose generation was replaced by a refresh", async () => {
    const deferred = createDeferred<FakeMessage[]>();
    let previewReads = 0;
    const { backend } = createFakeBackend({
      agents: [agent("a1")],
      conversations: [
        conversation({ id: "c1", agentId: "a1", at: NOW_MS_ISO(1) }),
      ],
      previewLoader: () => {
        previewReads += 1;
        if (previewReads === 1) return deferred.promise;
        return [message("user_message", "after refresh", messageDate)];
      },
    });

    await loadOverviewSnapshot({ backend, nowMs: NOW_MS });
    const pendingPreview = loadOverviewPreview("a1", "c1", { backend });
    await refreshOverviewSnapshot({ backend, nowMs: NOW_MS + 1_000 });

    deferred.resolve([message("user_message", "before refresh", messageDate)]);
    const result = await pendingPreview;
    expect(result.status).toBe("stale");

    // The stale answer was never cached, so the next ask reads again.
    const retried = await loadOverviewPreview("a1", "c1", { backend });
    expect(retried.status).toBe("loaded");
    if (retried.status === "loaded") {
      expect(retried.preview.lastUserMessage).toBe("after refresh");
    }
    expect(previewReads).toBe(2);
  });

  test("returns a retryable error, then succeeds", async () => {
    let shouldFail = true;
    const { backend } = createFakeBackend({
      agents: [agent("a1")],
      conversations: [
        conversation({ id: "c1", agentId: "a1", at: NOW_MS_ISO(1) }),
      ],
      previewLoader: () => {
        if (shouldFail) throw new Error("read failed");
        return [message("user_message", "recovered", messageDate)];
      },
    });

    await loadOverviewSnapshot({ backend, nowMs: NOW_MS });
    const failed = await loadOverviewPreview("a1", "c1", { backend });
    expect(failed.status).toBe("error");
    if (failed.status === "error") {
      expect(failed.error.retryable).toBe(true);
      expect(failed.error.message).toBe(OVERVIEW_PREVIEW_ERROR_NOTE);
    }

    shouldFail = false;
    const retried = await loadOverviewPreview("a1", "c1", { backend });
    expect(retried.status).toBe("loaded");
  });

  test("skips system reminders and clips long snippets", async () => {
    const longText = "x".repeat(OVERVIEW_SNIPPET_MAX_LENGTH + 40);
    const { backend } = createFakeBackend({
      agents: [agent("a1")],
      conversations: [
        conversation({ id: "c1", agentId: "a1", at: NOW_MS_ISO(1) }),
      ],
      messages: {
        c1: [
          message("user_message", longText, messageDate),
          message(
            "user_message",
            [
              {
                type: "text",
                text: "<system-reminder>auto context</system-reminder>",
              },
              { type: "text", text: "the real question" },
            ],
            "2026-11-02T12:58:00.000Z",
          ),
          message("user_message", ["oldest"], "2026-11-02T12:57:00.000Z"),
        ],
      },
    });

    await loadOverviewSnapshot({ backend, nowMs: NOW_MS });
    const result = await loadOverviewPreview("a1", "c1", { backend });
    expect(result.status).toBe("loaded");
    if (result.status === "loaded") {
      // Newest user message is the long one and wins; the system-reminder part
      // in it would have been skipped, but here the newest text is real content.
      expect(result.preview.lastUserMessage).toBe(
        `${longText.slice(0, OVERVIEW_SNIPPET_MAX_LENGTH - 3)}...`,
      );
      expect(result.preview.lastAgentMessage).toBeNull();
    }
  });

  test("prefers the user text after a system reminder inside one message", async () => {
    const { backend } = createFakeBackend({
      agents: [agent("a1")],
      conversations: [
        conversation({ id: "c1", agentId: "a1", at: NOW_MS_ISO(1) }),
      ],
      messages: {
        c1: [
          message("assistant_message", "answer", messageDate),
          message(
            "user_message",
            [
              {
                type: "text",
                text: "<system-reminder>auto context</system-reminder>",
              },
              { type: "text", text: "  the   real question  " },
            ],
            "2026-11-02T12:58:00.000Z",
          ),
        ],
      },
    });

    await loadOverviewSnapshot({ backend, nowMs: NOW_MS });
    const result = await loadOverviewPreview("a1", "c1", { backend });
    if (result.status === "loaded") {
      expect(result.preview.lastUserMessage).toBe("the real question");
    } else {
      throw new Error("expected a loaded preview");
    }
  });
});

/** An ISO instant `minutes` after the fixed test anchor. */
function NOW_MS_ISO(minutes: number): string {
  return new Date(NOW_MS + minutes * 60_000).toISOString();
}

describe("applyOverviewPreview", () => {
  test("replaces only the matching conversation in a new snapshot", async () => {
    const { backend } = createFakeBackend({
      agents: [agent("a1")],
      conversations: [
        conversation({ id: "c1", agentId: "a1", at: NOW_MS_ISO(1) }),
        conversation({ id: "c2", agentId: "a1", at: NOW_MS_ISO(2) }),
      ],
    });
    const snapshot = await loadOverviewSnapshot({ backend, nowMs: NOW_MS });

    const next = applyOverviewPreview(snapshot, "a1", "c1", {
      lastUserMessage: "question",
      lastAgentMessage: "answer",
    });

    expect(next).not.toBe(snapshot);
    expect(next.agents).toBe(snapshot.agents);
    const c1 = (next.conversations.a1 ?? []).find(
      (record) => record.conversationId === "c1",
    );
    expect(c1?.lastUserMessage).toBe("question");
    expect(c1?.lastAgentMessage).toBe("answer");
    // The sibling record is the same object: nothing else is rebuilt.
    expect((next.conversations.a1 ?? [])[0]).toBe(
      (snapshot.conversations.a1 ?? [])[0],
    );
    // The input snapshot is untouched.
    expect((snapshot.conversations.a1 ?? [])[1]?.lastUserMessage).toBeNull();
  });

  test("returns the same snapshot for an unknown agent or conversation", async () => {
    const { backend } = createFakeBackend({
      agents: [agent("a1")],
      conversations: [
        conversation({ id: "c1", agentId: "a1", at: NOW_MS_ISO(1) }),
      ],
    });
    const snapshot = await loadOverviewSnapshot({ backend, nowMs: NOW_MS });
    const preview = { lastUserMessage: "q", lastAgentMessage: null };

    expect(applyOverviewPreview(snapshot, "missing", "c1", preview)).toBe(
      snapshot,
    );
    expect(applyOverviewPreview(snapshot, "a1", "missing", preview)).toBe(
      snapshot,
    );
  });
});
