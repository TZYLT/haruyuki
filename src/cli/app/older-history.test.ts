import { afterEach, describe, expect, test } from "bun:test";
import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import { composeTranscriptItems } from "@/cli/app/composed-transcript";
import { HISTORY_PAGE_LIMIT } from "@/cli/app/history-window";
import {
  getOlderHistoryItems,
  getOlderHistoryState,
  HISTORY_CURSOR_NOTICE,
  HISTORY_START_NOTICE,
  historyItemsForMessages,
  logOrderedMessages,
  type OlderHistoryFetchRequest,
  olderHistoryCursor,
  requestOlderHistory,
  resetOlderHistoryForTests,
  setOlderHistoryFetcherForTests,
  setOlderHistoryLogReaderForTests,
  setOlderHistoryProvider,
} from "@/cli/app/older-history";
import {
  getViewportScrollRequest,
  getViewportScrollRows,
  reportViewportPosition,
  resetViewportScroll,
  setViewportRows,
} from "@/cli/app/viewport-scroll";
import type { Line } from "@/cli/helpers/accumulator";
import { getNotice, resetNoticeForTests } from "@/cli/helpers/notice";

/**
 * Paging older history, at the store.
 *
 * The failures this pins are the quiet ones: a page rendered twice, a cursor that
 * steps forward instead of back, a page that came back as the whole newest window
 * because the backend did not find the id, and a view that jumps by the rows that
 * were just loaded. Each of them reads on screen as "something above me is
 * wrong", which is exactly what nobody notices.
 */

function message(id: string, text: string): Message {
  return {
    id,
    message_type: "user_message",
    content: [{ type: "text", text }],
  } as unknown as Message;
}

function unknownMessage(id: string): Message {
  return { id, message_type: "not_a_rendered_type" } as unknown as Message;
}

function toolCallMessage(
  id: string,
  toolCallId: string,
  name: string,
): Message {
  return {
    id,
    message_type: "tool_call_message",
    tool_calls: [{ tool_call_id: toolCallId, name, arguments: "{}" }],
  } as unknown as Message;
}

function toolReturnMessage(
  id: string,
  toolCallId: string,
  output: string,
): Message {
  return {
    id,
    message_type: "tool_return_message",
    tool_returns: [
      { tool_call_id: toolCallId, status: "success", tool_return: output },
    ],
  } as unknown as Message;
}

/**
 * The local store's own paging semantics, faithfully: the messages older than the
 * cursor, the newest `limit` of them, oldest first. A cursor it cannot find returns
 * the newest window instead of slicing — the behaviour the cursor defence exists
 * for.
 */
function fakeBackend(all: readonly Message[]) {
  return async (request: OlderHistoryFetchRequest): Promise<Message[]> => {
    const index = all.findIndex((item) => item.id === request.before);
    const older = index < 0 ? all : all.slice(0, index);
    return older.slice(-request.limit);
  };
}

/** Core lines with stored message ids `m1000..`, as a resumed transcript has. */
function coreLines(count: number): Line[] {
  return Array.from({ length: count }, (_, index) => ({
    kind: "user" as const,
    id: `line-${index}`,
    text: `core ${index}`,
    messageId: `m${1000 + index}`,
  }));
}

function seedWith(lines: readonly Line[], conversationId = "conv-1"): void {
  setOlderHistoryProvider(() => ({
    conversationId,
    agentId: "agent-1",
    cursor: olderHistoryCursor(lines),
  }));
}

/**
 * A page of up to `count` messages older than the id in `before`, oldest first —
 * what a backend that slices at the cursor returns.
 */
function pageBefore(before: string, count: number): Message[] {
  const start = Number.parseInt(before.replace("m", ""), 10);
  if (!Number.isFinite(start)) return [];
  const ids: Message[] = [];
  for (let offset = count; offset >= 1; offset -= 1) {
    const id = start - offset;
    if (id < 0) continue;
    ids.push(message(`m${id}`, `older ${id}`));
  }
  return ids;
}

function pagingFetcher(
  requests: OlderHistoryFetchRequest[],
  count: number = HISTORY_PAGE_LIMIT,
) {
  return async (request: OlderHistoryFetchRequest): Promise<Message[]> => {
    requests.push(request);
    return pageBefore(request.before, count);
  };
}

afterEach(() => {
  resetOlderHistoryForTests();
  resetViewportScroll();
  resetNoticeForTests();
});

describe("the paging cursor", () => {
  test("is the oldest row with a stored message id, and skips the rows before it", () => {
    const cursor = olderHistoryCursor([
      { kind: "separator", id: "row-before-cursor" },
      { kind: "user", id: "row-0", text: "core 0", messageId: "m0" },
      { kind: "user", id: "row-1", text: "core 1", messageId: "m1" },
    ]);
    expect(cursor?.before).toBe("m0");
    expect(cursor?.loadedIds.has("row-0")).toBe(true);
    expect(cursor?.loadedIds.has("m1")).toBe(true);
    // The row above the cursor has no message id to page by, so the next page
    // fetches it again and the core's copy wins — but it must not read as "already
    // loaded", or a correct page would be refused.
    expect(cursor?.loadedIds.has("row-before-cursor")).toBe(false);
    expect(cursor?.coreIds.has("row-before-cursor")).toBe(true);
  });

  test("is null while no row carries one", () => {
    expect(olderHistoryCursor([])).toBeNull();
    expect(
      olderHistoryCursor([{ kind: "separator", id: "separator-1" }]),
    ).toBeNull();
  });
});

describe("assembling a page", () => {
  test("draws the rows the resume path draws for the same messages", () => {
    const items = historyItemsForMessages([
      message("m1", "the first thing"),
      message("m2", "the second thing"),
    ]);
    expect(items.map((item) => item.kind)).toEqual(["user", "user"]);
    expect(
      items.map((item) => (item.kind === "user" ? item.text : "")),
    ).toEqual(["the first thing", "the second thing"]);
  });

  test("draws nothing for a message type the renderer does not know", () => {
    expect(historyItemsForMessages([unknownMessage("m1")])).toEqual([]);
  });
});

describe("the order a page says it is in", () => {
  test("a log-ordered page is used as it came", () => {
    const messages = [message("m1", "one"), message("m2", "two")];
    expect(logOrderedMessages({ order: "log", messages })).toEqual(messages);
    // The rows are handed on as a copy: a caller that re-orders its page must not be
    // able to reach back into the backend's answer.
    const copy = logOrderedMessages({ order: "log", messages });
    copy.reverse();
    expect(messages.map((item) => item.id)).toEqual(["m1", "m2"]);
  });

  test("a page in the in-context order is refused", () => {
    // The order that cannot be walked: its oldest row is a compaction's summary, so
    // treating it as the log would put that summary below the rows it replaced (and
    // its empty page would report the conversation's start while the rows the
    // compaction sent away are still unread).
    expect(() =>
      logOrderedMessages({
        order: "logical",
        messages: [message("m1", "one")],
      }),
    ).toThrow("logical-ordered page");
  });

  test("a page the backend says is not the log's is refused, not prepended", async () => {
    seedWith(coreLines(3));
    setOlderHistoryLogReaderForTests(async () => ({
      order: "logical",
      messages: [message("m1000", "the in-context list's oldest row")],
    }));

    // `failed`, not `loaded`: the walk is left where it is — and above all not told
    // it has reached the conversation's start.
    expect(await requestOlderHistory(0)).toBe("failed");
    expect(getOlderHistoryItems("conv-1")).toEqual([]);
    expect(getOlderHistoryState().stopped).toBeNull();
  });

  test("a backend that cannot read the log is refused the same way", async () => {
    seedWith(coreLines(3));
    setOlderHistoryLogReaderForTests(null);

    expect(await requestOlderHistory(0)).toBe("failed");
    expect(getOlderHistoryItems("conv-1")).toEqual([]);
    expect(getOlderHistoryState().stopped).toBeNull();
  });

  test("a log-ordered page is walked and drawn", async () => {
    seedWith(coreLines(3));
    const asked: string[] = [];
    setOlderHistoryLogReaderForTests(async (_conversationId, body) => {
      asked.push(body.before);
      // A full page, so the walk continues instead of reporting the log's start.
      return {
        order: "log",
        messages: Array.from({ length: HISTORY_PAGE_LIMIT }, (_, index) =>
          message(`m${900 + index}`, `older row ${index}`),
        ),
      };
    });

    expect(await requestOlderHistory(0)).toBe("loaded");
    expect(asked).toEqual(["m1000"]);
    const items = getOlderHistoryItems("conv-1");
    expect(items.length).toBe(HISTORY_PAGE_LIMIT);
    expect(items[0]?.id).toBe("m900");
    expect(items.at(-1)?.id).toBe(`m${900 + HISTORY_PAGE_LIMIT - 1}`);
  });
});

describe("requesting a page", () => {
  test("is unavailable without a cursor to page from", async () => {
    const requests: OlderHistoryFetchRequest[] = [];
    setOlderHistoryFetcherForTests(pagingFetcher(requests));
    expect(await requestOlderHistory(3)).toBe("unavailable");

    setOlderHistoryProvider(() => ({
      conversationId: "conv-1",
      agentId: "agent-1",
      cursor: null,
    }));
    expect(await requestOlderHistory(3)).toBe("unavailable");
    expect(requests).toEqual([]);
  });

  test("prepends the page, oldest first, and advances the cursor", async () => {
    seedWith(coreLines(3));
    const requests: OlderHistoryFetchRequest[] = [];
    setOlderHistoryFetcherForTests(pagingFetcher(requests));

    expect(await requestOlderHistory(0)).toBe("loaded");

    expect(requests[0]).toEqual({
      conversationId: "conv-1",
      agentId: "agent-1",
      before: "m1000",
      limit: HISTORY_PAGE_LIMIT,
    });
    const items = getOlderHistoryItems("conv-1");
    expect(items.length).toBe(HISTORY_PAGE_LIMIT);
    expect(items[0]?.id).toBe("m950");
    expect(items.at(-1)?.id).toBe("m999");
    // The cursor advances to the page's *second* oldest message, so the oldest is
    // fetched again with its partner: a tool call and its return can straddle the
    // boundary. The duplicate that overlap creates is dropped at composition.
    expect(getOlderHistoryState().cursor).toBe("m951");
    expect(getOlderHistoryItems("another-conversation")).toEqual([]);
  });

  test("a second request pages further back", async () => {
    seedWith(coreLines(3));
    setOlderHistoryFetcherForTests(pagingFetcher([]));

    await requestOlderHistory(0);
    const firstPage = getOlderHistoryItems("conv-1").map((item) => item.id);
    await requestOlderHistory(0);
    const both = getOlderHistoryItems("conv-1").map((item) => item.id);

    expect(firstPage.length).toBe(HISTORY_PAGE_LIMIT);
    // The next page starts one message back, so the oldest message of the previous
    // page comes back with it — and is prefixed once.
    expect(both.length).toBe(2 * HISTORY_PAGE_LIMIT - 1);
    expect(both[0]).toBe("m901");
    expect(both.at(-1)).toBe("m999");
    expect(new Set(both).size).toBe(both.length);
    // A row the core list already draws is never prefixed, whichever page brings it.
    const composed = composeTranscriptItems(getOlderHistoryItems("conv-1"), [
      { kind: "user", id: "m1000", text: "core" },
    ]);
    expect(new Set(composed.map((item) => item.id)).size).toBe(composed.length);
  });

  test("refuses a page that reaches into the loaded rows, and stops asking", async () => {
    seedWith(coreLines(3));
    const requests: OlderHistoryFetchRequest[] = [];
    // What a backend does with a cursor it cannot find: it returns the newest
    // window instead of slicing at the cursor. Here that window is the core's own
    // newest rows — a page that would duplicate the view and walk the cursor
    // forward.
    setOlderHistoryFetcherForTests(async (request) => {
      requests.push(request);
      return [message("m1001", "core 1"), message("m1002", "core 2")];
    });

    expect(await requestOlderHistory(0)).toBe("refused");
    expect(getOlderHistoryItems("conv-1")).toEqual([]);
    expect(getNotice()).toBe(HISTORY_CURSOR_NOTICE);

    // Once refused it stays refused: every further up-move would ask for the same
    // page and read the same window.
    expect(await requestOlderHistory(3)).toBe("refused");
    expect(requests.length).toBe(1);
  });

  test("a tool call and its return that straddle a boundary arrive together", async () => {
    seedWith(coreLines(3));
    // Chronological: the call and its return sit just below the core's oldest row,
    // and the page is exactly long enough to cut between them.
    const all: Message[] = [
      toolCallMessage("m949", "t1", "Read"),
      toolReturnMessage("m950", "t1", "the output"),
      ...Array.from({ length: 49 }, (_, index) =>
        message(`m${951 + index}`, `older ${951 + index}`),
      ),
      message("m1000", "core 0"),
      message("m1001", "core 1"),
      message("m1002", "core 2"),
    ];
    setOlderHistoryFetcherForTests(fakeBackend(all));

    // First page: 50 messages, whose oldest is the return — its call is one
    // message older, outside the page, so the return has nothing to merge into.
    expect(await requestOlderHistory(0)).toBe("loaded");
    const afterFirstPage = getOlderHistoryState().cursor;
    expect(
      getOlderHistoryItems("conv-1").some((item) => item.kind === "tool_call"),
    ).toBe(false);

    expect(await requestOlderHistory(0)).toBe("start");
    const toolCall = getOlderHistoryItems("conv-1").find(
      (item) => item.kind === "tool_call" && item.toolCallId === "t1",
    );
    // The second page starts one message back, so it carries the return with the
    // call: the row renders as finished history rather than as a pending tool call.
    // Paging from the page's *oldest* message instead leaves it "ready" forever,
    // which is why this assertion comes before the cursor one.
    expect(toolCall?.kind === "tool_call" ? toolCall.phase : null).toBe(
      "finished",
    );
    expect(toolCall?.kind === "tool_call" ? toolCall.resultText : null).toBe(
      "the output",
    );
    expect(afterFirstPage).toBe("m951");
  });

  test("stops at the conversation's first message", async () => {
    seedWith(coreLines(3));
    const requests: OlderHistoryFetchRequest[] = [];
    setOlderHistoryFetcherForTests(pagingFetcher(requests, 2));

    expect(await requestOlderHistory(0)).toBe("start");
    expect(getNotice()).toBe(HISTORY_START_NOTICE);
    expect(await requestOlderHistory(0)).toBe("start");
    expect(requests.length).toBe(1);
  });

  test("a page that draws nothing still advances the cursor", async () => {
    seedWith(coreLines(3));
    const requests: OlderHistoryFetchRequest[] = [];
    let call = 0;
    setOlderHistoryFetcherForTests(async (request) => {
      requests.push(request);
      call += 1;
      return Array.from({ length: HISTORY_PAGE_LIMIT }, (_, index) =>
        unknownMessage(`u${call}-${index}`),
      );
    });

    expect(await requestOlderHistory(0)).toBe("loaded");
    expect(getOlderHistoryItems("conv-1")).toEqual([]);
    // The page is consumed rather than re-asked for, even though it drew nothing:
    // otherwise a page the renderer has no rows for would be fetched forever.
    expect(getOlderHistoryState().cursor).toBe("u1-1");
    expect(await requestOlderHistory(0)).toBe("loaded");
    expect(requests[1]?.before).toBe("u1-1");
  });

  test("drops the paged rows when the core's oldest row moves under them", async () => {
    const requests: OlderHistoryFetchRequest[] = [];
    seedWith(coreLines(3));
    setOlderHistoryFetcherForTests(pagingFetcher(requests));
    await requestOlderHistory(0);
    expect(getOlderHistoryItems("conv-1")[0]?.id).toBe("m950");

    // A compaction re-projects the history: the rows it replaced are gone from what
    // the backend lists, and a summary row with a *new* id (here `m2000`) sits at
    // the position they occupied, so the core no longer starts where it did. Rows
    // paged against the old projection would leave a hole above the new core.
    seedWith([
      { kind: "user", id: "summary-row", text: "summary", messageId: "m2000" },
      { kind: "user", id: "kept-row", text: "kept", messageId: "m2001" },
    ]);
    expect(await requestOlderHistory(0)).toBe("loaded");

    expect(requests.at(-1)?.before).toBe("m2000");
    const items = getOlderHistoryItems("conv-1");
    expect(items[0]?.id).toBe("m1950");
    expect(items.some((item) => item.id === "m950")).toBe(false);
  });

  test("does not stop at a resident bound, because eviction bounds it instead", async () => {
    seedWith(coreLines(3));
    const requests: OlderHistoryFetchRequest[] = [];
    let page = 0;
    setOlderHistoryFetcherForTests(async (request) => {
      requests.push(request);
      page += 1;
      return Array.from({ length: HISTORY_PAGE_LIMIT }, (_, index) =>
        message(`page-${page}-${index}`, `older ${page}.${index}`),
      );
    });

    // Well past the two thousand items a flat bound used to stop the walk at: what
    // is resident is bounded by the window now, so the walk itself has no ceiling.
    const rounds = Math.ceil(2_000 / HISTORY_PAGE_LIMIT) + 5;
    for (let round = 0; round < rounds; round += 1) {
      expect(await requestOlderHistory(0)).toBe("loaded");
    }
    expect(requests.length).toBe(rounds);
    expect(getOlderHistoryState().itemCount).toBe(rounds * HISTORY_PAGE_LIMIT);
    expect(getOlderHistoryState().stopped).toBeNull();
  });

  test("drops a page that arrives after the conversation changed", async () => {
    seedWith(coreLines(3), "conv-1");
    let release = () => {};
    setOlderHistoryFetcherForTests(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return [message("m999", "older")];
    });

    const pending = requestOlderHistory(0);
    seedWith(coreLines(3), "conv-2");
    release();
    expect(await pending).toBe("unavailable");
    expect(getOlderHistoryItems("conv-2")).toEqual([]);
  });

  test("answers busy instead of double-fetching, then gives the rows a frame", async () => {
    seedWith(coreLines(3));
    let release = () => {};
    const requests: OlderHistoryFetchRequest[] = [];
    setOlderHistoryFetcherForTests((request) => {
      requests.push(request);
      return new Promise<Message[]>((resolve) => {
        release = () => resolve(pageBefore(request.before, HISTORY_PAGE_LIMIT));
      });
    });

    const pending = requestOlderHistory(0);
    expect(await requestOlderHistory(0)).toBe("busy");
    release();
    expect(await pending).toBe("loaded");
    expect(requests.length).toBe(1);
    expect(getOlderHistoryItems("conv-1").length).toBe(HISTORY_PAGE_LIMIT);
  });

  test("reports a failed fetch without stopping the next attempt", async () => {
    seedWith(coreLines(3));
    setOlderHistoryFetcherForTests(async () => {
      throw new Error("the store is gone");
    });
    expect(await requestOlderHistory(0)).toBe("failed");
    expect(getOlderHistoryState().stopped).toBeNull();
  });
});

describe("what a page does to the parked position", () => {
  test("re-bases the anchor by the rows that were inserted, and spends the move", async () => {
    setViewportRows(12);
    reportViewportPosition({ rows: 6, anchor: { end: 5, delta: 2 } });
    seedWith(coreLines(3));
    setOlderHistoryFetcherForTests(pagingFetcher([]));

    expect(await requestOlderHistory(3)).toBe("loaded");

    expect(getOlderHistoryItems("conv-1").length).toBe(HISTORY_PAGE_LIMIT);
    // The rows below the anchor did not move, and the refused notch is spent:
    // 6 reported + 3 asked for.
    expect(getViewportScrollRows()).toBe(6);
    expect(getViewportScrollRequest()).toEqual({ kind: "rows", rows: 9 });
  });

  test("leaves the position alone when the load asked for no move", async () => {
    setViewportRows(12);
    reportViewportPosition({ rows: 6, anchor: { end: 5, delta: 2 } });
    seedWith(coreLines(3));
    setOlderHistoryFetcherForTests(pagingFetcher([]));

    expect(await requestOlderHistory(0)).toBe("loaded");

    // Every item paged in above the anchor shifts its index, and nothing else:
    // the frame would otherwise jump by exactly the rows that just arrived.
    expect(getViewportScrollRequest()).toEqual({
      kind: "anchor",
      anchor: { end: 5 + HISTORY_PAGE_LIMIT, delta: 2 },
    });
    expect(getViewportScrollRows()).toBe(6);
  });
});
