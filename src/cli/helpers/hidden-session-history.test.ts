/**
 * The detail view's read orchestration (F-01, 《45-1》§2.4).
 *
 * These are the branches a wrong answer would hide rows in. Each test drives the
 * reader through a fake backend that copies the two behaviours the real store
 * has and this module has to survive:
 *
 * 1. `after` / `before` are applied **only when the id is found**; an unknown
 *    cursor silently returns the whole list from the start (that is the bug
 *    `cursorRecovered` exists for).
 * 2. A page is capped at `limit` and `desc` is the reverse of `asc`.
 *
 * Nothing here touches a storage directory: the backend is an object literal, so
 * the tests also pin the exact query shape the reader sends (`agent_id`, `order`,
 * `include_out_of_context: true`).
 */
import { describe, expect, test } from "bun:test";
import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import type { Backend } from "@/backend";
import {
  extractHiddenSessionMessages,
  HIDDEN_SESSION_HISTORY_PAGE_SIZE,
  HIDDEN_SESSION_LEGACY_MAX_PAGES,
  HIDDEN_SESSION_LEGACY_MAX_ROWS,
  type HiddenSessionHistoryBackend,
  type HiddenSessionMessagePage,
  type HiddenSessionMessageQuery,
  inferLegacyBoundaryIndex,
  nextHiddenSessionAfter,
  readHiddenSessionHistory,
  readMoreHiddenSessionNewMessages,
  resolveHiddenSessionMode,
  sliceAfterBoundaryRow,
} from "@/cli/helpers/hidden-session-history";

/**
 * Compile-time contract for the caller: `getBackend()` must be passable as the
 * reader's backend without an adapter. If this stops compiling, the port drifted
 * from `Backend` and M4 has to wrap it rather than call it directly.
 */
const backendSatisfiesReadPort: Backend extends HiddenSessionHistoryBackend
  ? true
  : false = true;

const CONVERSATION_ID = "conv-hidden";
const AGENT_ID = "agent-1";

interface ListCall {
  conversationId: string;
  body: HiddenSessionMessageQuery;
}

interface FakeBackend extends HiddenSessionHistoryBackend {
  listCalls: ListCall[];
  retrieveCalls: string[];
}

interface FakeBackendOptions {
  messages?: Message[];
  /** Rows `retrieveMessage` can resolve but the language log does not hold. */
  retrieveRows?: Message[];
  /**
   * Reproduces "the cursor was not honoured": the store ignores an id it cannot
   * resolve instead of returning an empty page.
   */
  ignoreAfter?: boolean;
  ignoreBefore?: boolean;
  failList?: Error;
}

function createFakeBackend(options: FakeBackendOptions = {}): FakeBackend {
  const log = [...(options.messages ?? [])];
  const retrievable = [...(options.retrieveRows ?? []), ...log];
  const listCalls: ListCall[] = [];
  const retrieveCalls: string[] = [];

  return {
    listCalls,
    retrieveCalls,
    async retrieveMessage(messageId: string): Promise<Message> {
      retrieveCalls.push(messageId);
      const found = retrievable.find((message) => message.id === messageId);
      if (!found) throw new Error(`message not found: ${messageId}`);
      return found;
    },
    async listConversationMessages(
      conversationId: string,
      body?: HiddenSessionMessageQuery,
    ): Promise<HiddenSessionMessagePage> {
      if (options.failList) throw options.failList;
      if (!body) return [];
      listCalls.push({ conversationId, body });

      let items = [...log];
      if (body.after && !options.ignoreAfter) {
        const index = items.findIndex((message) => message.id === body.after);
        if (index >= 0) items = items.slice(index + 1);
      }
      if (body.before && !options.ignoreBefore) {
        const index = items.findIndex((message) => message.id === body.before);
        if (index >= 0) items = items.slice(0, index);
      }
      if (body.order === "desc") items = items.reverse();
      return items.slice(0, body.limit);
    },
  };
}

const DAY_START = Date.UTC(2026, 9, 25, 0, 0, 0);
const CONVERSATION_CREATED_AT = isoAt(12 * 3600);

function isoAt(offsetSeconds: number): string {
  return new Date(DAY_START + offsetSeconds * 1000).toISOString();
}

function row(id: string, date: string): Message {
  return {
    id,
    date,
    message_type: "assistant_message",
    content: `content:${id}`,
    conversation_id: CONVERSATION_ID,
  } as Message;
}

/** A cloned row: the fork keeps the parent's timestamp (before `created_at`). */
function inheritedRow(index: number): Message {
  return row(`i${index}`, isoAt(10 * 3600 + index));
}

/** A row the fork itself wrote, after `created_at`. */
function newRow(index: number): Message {
  return row(`n${index}`, isoAt(12 * 3600 + 60 + index));
}

function inheritedAndNew(newCount: number, inheritedCount = 3): Message[] {
  return [
    ...Array.from({ length: inheritedCount }, (_, index) =>
      inheritedRow(index + 1),
    ),
    ...Array.from({ length: newCount }, (_, index) => newRow(index + 1)),
  ];
}

function read(
  backend: FakeBackend,
  extra: Partial<Parameters<typeof readHiddenSessionHistory>[0]> = {},
) {
  return readHiddenSessionHistory({
    backend,
    conversationId: CONVERSATION_ID,
    agentId: AGENT_ID,
    conversationCreatedAt: CONVERSATION_CREATED_AT,
    ...extra,
  });
}

describe("readHiddenSessionHistory — boundary path", () => {
  test("reads the seam row, then one page after it", async () => {
    const backend = createFakeBackend({ messages: inheritedAndNew(2) });

    const history = await read(backend, {
      boundaryId: "i3",
      boundaryCount: 3,
    });

    expect(history.mode).toBe("boundary");
    expect(history.boundaryKnown).toBe(true);
    expect(history.lastInherited?.id).toBe("i3");
    expect(history.newMessages.map((message) => message.id)).toEqual([
      "n1",
      "n2",
    ]);
    expect(history.inheritedCount).toBe(3);
    expect(history.exhausted).toBe(true);
    expect(history.cursorRecovered).toBe(false);
    expect(history.truncatedByBudget).toBe(false);
    expect(history.pagesRead).toBe(1);
    expect(backend.retrieveCalls).toEqual(["i3"]);
    // The exact query the detail view needs: ordered, bounded, whole-log.
    expect(backend.listCalls).toHaveLength(1);
    expect(backend.listCalls[0]).toEqual({
      conversationId: CONVERSATION_ID,
      body: {
        agent_id: AGENT_ID,
        order: "asc",
        limit: HIDDEN_SESSION_HISTORY_PAGE_SIZE,
        after: "i3",
        include_out_of_context: true,
      },
    });
  });

  test("re-slices when the backend ignored the after cursor", async () => {
    const backend = createFakeBackend({
      messages: inheritedAndNew(2),
      ignoreAfter: true,
    });

    const history = await read(backend, { boundaryId: "i3" });

    // The unhonoured page starts at the conversation's first row, so the guard
    // is what keeps the inherited prefix out of the new segment.
    expect(history.lastInherited?.id).toBe("i3");
    expect(history.newMessages.map((message) => message.id)).toEqual([
      "n1",
      "n2",
    ]);
    expect(history.cursorRecovered).toBe(true);
    expect(history.boundaryKnown).toBe(true);
  });

  test("an empty new segment reports the seam and no new messages", async () => {
    const backend = createFakeBackend({
      messages: [inheritedRow(1), inheritedRow(2), inheritedRow(3)],
    });

    const history = await read(backend, { boundaryId: "i3", boundaryCount: 3 });

    expect(history.lastInherited?.id).toBe("i3");
    expect(history.newMessages).toEqual([]);
    expect(history.exhausted).toBe(true);
    expect(nextHiddenSessionAfter(history)).toBeNull();
  });

  test("a full first page leaves the new segment open and pages forward", async () => {
    const backend = createFakeBackend({ messages: inheritedAndNew(60) });
    const first = await read(backend, { boundaryId: "i3" });

    expect(first.newMessages).toHaveLength(HIDDEN_SESSION_HISTORY_PAGE_SIZE);
    expect(first.exhausted).toBe(false);
    expect(nextHiddenSessionAfter(first)).toBe("n50");

    const second = await readMoreHiddenSessionNewMessages(
      { backend, conversationId: CONVERSATION_ID, agentId: AGENT_ID },
      first,
    );

    expect(second.newMessages).toHaveLength(60);
    expect(second.newMessages[0]?.id).toBe("n1");
    expect(second.newMessages[59]?.id).toBe("n60");
    expect(second.exhausted).toBe(true);
    expect(second.pagesRead).toBe(2);
    expect(nextHiddenSessionAfter(second)).toBeNull();
    expect(backend.listCalls[1]?.body.after).toBe("n50");
  });

  test("keeps paging pages only for the boundary path", async () => {
    const backend = createFakeBackend({ messages: inheritedAndNew(60) });
    const standalone = await read(backend, { contextMode: "standalone" });

    const again = await readMoreHiddenSessionNewMessages(
      { backend, conversationId: CONVERSATION_ID, agentId: AGENT_ID },
      standalone,
    );

    expect(again).toBe(standalone);
  });

  test("a page that adds nothing ends the walk instead of looping", async () => {
    const backend = createFakeBackend({
      messages: inheritedAndNew(60),
      ignoreAfter: true,
    });
    const first = await read(backend, { boundaryId: "i3", pageSize: 10 });

    // The ignored cursor re-slices to the same rows every time, so "no progress"
    // has to be the terminal state or the view would re-ask forever.
    const again = await readMoreHiddenSessionNewMessages(
      {
        backend,
        conversationId: CONVERSATION_ID,
        agentId: AGENT_ID,
        pageSize: 10,
      },
      first,
    );

    expect(again.newMessages).toHaveLength(first.newMessages.length);
    expect(again.exhausted).toBe(true);
    expect(again.cursorRecovered).toBe(true);
  });
});

describe("readHiddenSessionHistory — boundary fallback", () => {
  test("an unresolvable seam falls back to the timestamp walk", async () => {
    const backend = createFakeBackend({
      messages: [newRow(1), newRow(2)],
    });

    const history = await read(backend, { boundaryId: "gone-forever" });

    expect(history.mode).toBe("legacy");
    expect(history.boundaryKnown).toBe(false);
    expect(history.lastInherited).toBeNull();
    expect(history.newMessages.map((message) => message.id)).toEqual([
      "n1",
      "n2",
    ]);
    expect(history.exhausted).toBe(true);
    expect(backend.retrieveCalls).toEqual(["gone-forever"]);
  });

  test("a seam from another conversation is not used as a cursor", async () => {
    const foreign = row("i3", isoAt(10 * 3600)) as Message & {
      conversation_id: string;
    };
    foreign.conversation_id = "conv-other";
    const backend = createFakeBackend({
      messages: [newRow(1), newRow(2)],
      retrieveRows: [foreign],
    });

    const history = await read(backend, { boundaryId: "i3" });

    expect(history.mode).toBe("legacy");
    expect(history.boundaryKnown).toBe(false);
    // The foreign row never entered the window, and its id never became a cursor.
    expect(history.newMessages.map((message) => message.id)).toEqual([
      "n1",
      "n2",
    ]);
    expect(backend.retrieveCalls).toEqual(["i3"]);
    expect(backend.listCalls.some((call) => call.body.after === "i3")).toBe(
      false,
    );
  });

  test("an empty fork reads as legacy with nothing to show", async () => {
    const backend = createFakeBackend({ messages: [] });

    const history = await read(backend, { boundaryId: "never-there" });

    expect(history.mode).toBe("legacy");
    expect(history.boundaryKnown).toBe(false);
    expect(history.lastInherited).toBeNull();
    expect(history.newMessages).toEqual([]);
    expect(history.exhausted).toBe(true);
    expect(history.pagesRead).toBe(1);
  });
});

describe("readHiddenSessionHistory — legacy timestamp inference", () => {
  test("finds the seam across pages and stops there", async () => {
    const backend = createFakeBackend({ messages: inheritedAndNew(60) });

    const history = await read(backend);

    expect(history.mode).toBe("legacy");
    expect(history.boundaryKnown).toBe(true);
    expect(history.lastInherited?.id).toBe("i3");
    expect(history.newMessages).toHaveLength(60);
    expect(history.newMessages[0]?.id).toBe("n1");
    expect(history.newMessages[59]?.id).toBe("n60");
    // The inherited prefix is never read: the walk stopped at the seam.
    expect(history.pagesRead).toBe(2);
    expect(history.exhausted).toBe(true);
    expect(history.truncatedByBudget).toBe(false);
  });

  test("all rows newer than the conversation reports an unknown boundary", async () => {
    const backend = createFakeBackend({ messages: [newRow(1), newRow(2)] });

    const history = await read(backend);

    expect(history.boundaryKnown).toBe(false);
    expect(history.lastInherited).toBeNull();
    expect(history.newMessages.map((message) => message.id)).toEqual([
      "n1",
      "n2",
    ]);
    expect(history.exhausted).toBe(true);
  });

  test("all rows older than the conversation is not a seam at index zero", async () => {
    const backend = createFakeBackend({ messages: inheritedAndNew(0) });

    const history = await read(backend);

    // A conversation whose rows all predate it looks exactly like an imported
    // transcript: showing every row is the only answer that hides nothing.
    expect(history.boundaryKnown).toBe(false);
    expect(history.lastInherited).toBeNull();
    expect(history.newMessages).toHaveLength(3);
    expect(history.exhausted).toBe(true);
  });

  test("a same-millisecond clone is ambiguous, not new", async () => {
    const backend = createFakeBackend({
      messages: [
        row("old", isoAt(10 * 3600)),
        row("edge", CONVERSATION_CREATED_AT),
        row("later", isoAt(13 * 3600)),
      ],
    });

    const history = await read(backend);

    expect(history.boundaryKnown).toBe(false);
    expect(history.lastInherited).toBeNull();
    // Everything loaded is shown, newest last.
    expect(history.newMessages.map((message) => message.id)).toEqual([
      "old",
      "edge",
      "later",
    ]);
  });

  test("a missing timestamp is ambiguous, not a seam", async () => {
    const backend = createFakeBackend({
      messages: [inheritedRow(1), row("no-date", ""), newRow(1)],
    });

    const history = await read(backend);

    expect(history.boundaryKnown).toBe(false);
    expect(history.newMessages).toHaveLength(3);
  });

  test("a missing conversation timestamp falls back to showing everything", async () => {
    const backend = createFakeBackend({ messages: inheritedAndNew(2) });

    const history = await read(backend, { conversationCreatedAt: null });

    expect(history.boundaryKnown).toBe(false);
    expect(history.lastInherited).toBeNull();
    expect(history.newMessages).toHaveLength(5);
  });

  test("stops at the page/row budget and says so", async () => {
    const backend = createFakeBackend({
      // 600 rows, all newer than the conversation: the walk never finds a seam.
      messages: Array.from({ length: 600 }, (_, index) => newRow(index + 1)),
    });

    const history = await read(backend);

    expect(history.pagesRead).toBe(HIDDEN_SESSION_LEGACY_MAX_PAGES);
    expect(history.newMessages).toHaveLength(HIDDEN_SESSION_LEGACY_MAX_ROWS);
    expect(history.boundaryKnown).toBe(false);
    expect(history.truncatedByBudget).toBe(true);
    expect(history.exhausted).toBe(false);
    // The window still ends at the newest row, so the tail of the session shows.
    expect(history.newMessages[history.newMessages.length - 1]?.id).toBe(
      "n600",
    );
    expect(history.newMessages[0]?.id).toBe("n101");
  });
});

describe("readHiddenSessionHistory — standalone", () => {
  test("shows every row in order without asking for a seam", async () => {
    const backend = createFakeBackend({ messages: inheritedAndNew(120) });

    const history = await read(backend, {
      contextMode: "standalone",
      boundaryId: "i3",
      boundaryCount: 3,
    });

    expect(history.mode).toBe("standalone");
    expect(history.boundaryKnown).toBe(false);
    expect(history.lastInherited).toBeNull();
    expect(history.newMessages).toHaveLength(123);
    expect(history.newMessages[0]?.id).toBe("i1");
    expect(history.newMessages[122]?.id).toBe("n120");
    // A standalone conversation no longer trusts a stale inherited count.
    expect(history.inheritedCount).toBeNull();
    expect(backend.retrieveCalls).toEqual([]);
    expect(backend.listCalls.every((call) => call.body.order === "desc")).toBe(
      true,
    );
    expect(history.exhausted).toBe(true);
    expect(history.truncatedByBudget).toBe(false);
  });

  test("a standalone session larger than the budget says it is truncated", async () => {
    const backend = createFakeBackend({
      messages: Array.from({ length: 600 }, (_, index) => newRow(index + 1)),
    });

    const history = await read(backend, { contextMode: "standalone" });

    expect(history.newMessages).toHaveLength(HIDDEN_SESSION_LEGACY_MAX_ROWS);
    expect(history.truncatedByBudget).toBe(true);
    expect(history.exhausted).toBe(false);
    expect(history.boundaryKnown).toBe(false);
  });
});

describe("readHiddenSessionHistory — errors and query shape", () => {
  test("a failing read is surfaced, not swallowed", async () => {
    const backend = createFakeBackend({
      messages: [newRow(1)],
      failList: new Error("backend unavailable"),
    });

    await expect(read(backend, { boundaryId: "i3" })).rejects.toThrow(
      "backend unavailable",
    );
  });

  test("every read asks for the whole transcript log", async () => {
    const backend = createFakeBackend({ messages: inheritedAndNew(60) });

    await read(backend, { pageSize: 20 });

    expect(backend.listCalls.length).toBeGreaterThan(0);
    for (const call of backend.listCalls) {
      expect(call.body.agent_id).toBe(AGENT_ID);
      expect(call.body.limit).toBe(20);
      expect(call.body.include_out_of_context).toBe(true);
    }
  });
});

describe("pure helpers", () => {
  test("the real backend fits the read port", () => {
    expect(backendSatisfiesReadPort).toBe(true);
  });

  test("sliceAfterBoundaryRow keeps rows after the boundary", () => {
    const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];

    expect(sliceAfterBoundaryRow(rows, "b")).toEqual({
      rows: [{ id: "c" }],
      boundaryIndex: 1,
    });
    expect(sliceAfterBoundaryRow(rows, "missing")).toEqual({
      rows,
      boundaryIndex: -1,
    });
    expect(sliceAfterBoundaryRow(rows, null)).toEqual({
      rows,
      boundaryIndex: -1,
    });
  });

  test("resolveHiddenSessionMode prefers standalone over a boundary id", () => {
    expect(
      resolveHiddenSessionMode({
        contextMode: "standalone",
        boundaryId: "i3",
      }),
    ).toBe("standalone");
    expect(resolveHiddenSessionMode({ boundaryId: "i3" })).toBe("boundary");
    expect(resolveHiddenSessionMode({ contextMode: "inherited-history" })).toBe(
      "legacy",
    );
    expect(resolveHiddenSessionMode({ boundaryId: "   " })).toBe("legacy");
  });

  test("inferLegacyBoundaryIndex reports the transition, not just an old row", () => {
    const rows = [newRow(1), inheritedRow(1), inheritedRow(2)];

    expect(inferLegacyBoundaryIndex(rows, CONVERSATION_CREATED_AT)).toEqual({
      kind: "found",
      index: 1,
    });
    expect(
      inferLegacyBoundaryIndex([inheritedRow(1)], CONVERSATION_CREATED_AT),
    ).toEqual({ kind: "all-inherited" });
    expect(
      inferLegacyBoundaryIndex([newRow(1)], CONVERSATION_CREATED_AT),
    ).toEqual({ kind: "continue" });
    expect(inferLegacyBoundaryIndex(rows, null)).toEqual({
      kind: "ambiguous",
      reason: "missing-conversation-created-at",
    });
  });

  test("extractHiddenSessionMessages accepts arrays and page objects", () => {
    const messages = [newRow(1), newRow(2)];

    expect(extractHiddenSessionMessages(messages)).toEqual(messages);
    expect(
      extractHiddenSessionMessages({ getPaginatedItems: () => messages }),
    ).toEqual(messages);
    expect(extractHiddenSessionMessages({ items: messages })).toEqual(messages);
    expect(extractHiddenSessionMessages({ items: [{ id: 5 }] })).toEqual([]);
    expect(extractHiddenSessionMessages(null)).toEqual([]);
    expect(extractHiddenSessionMessages("nope")).toEqual([]);
  });
});
