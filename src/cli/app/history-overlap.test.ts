/**
 * A page that reaches into the rows the core already holds is not a dishonest
 * cursor.
 *
 * The defence exists for one shape: a cursor the store cannot find, answered with
 * the newest window instead of a slice. Once the read is compaction-transparent
 * that shape is narrower, because the raw log legitimately returns the messages a
 * compaction kept (they sit before the summary in the log) together with the older
 * rows the walk is for. Judging on the newest row alone refused those pages and
 * stopped the walk at the summary — which is the bug this pins, with the refusing
 * direction pinned next to it so the defence cannot be dropped by accident.
 */

import { afterEach, expect, test } from "bun:test";
import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import { resetNoticeForTests } from "@/cli/helpers/notice";
import {
  getOlderHistoryBlocks,
  getOlderHistoryItems,
  olderHistoryCursor,
  reportOlderHistoryBlockRows,
  requestOlderHistory,
  resetOlderHistoryForTests,
  setOlderHistoryFetcherForTests,
  setOlderHistoryProvider,
} from "./older-history";
import { resetViewportScroll } from "./viewport-scroll";

const CONVERSATION = "conv-overlap";

function message(id: string, text: string): Message {
  return {
    id,
    message_type: "user_message",
    content: [{ type: "text", text }],
  } as unknown as Message;
}

/** The core the page is fetched against: its oldest row is the cursor. */
// Row ids are the stored ids, as `backfillBuffers` keys a plain user message, so
// the page copies below really do land on rows the core already draws.
const CORE_CURSOR = olderHistoryCursor([
  { kind: "user", id: "m0", text: "core 0", messageId: "m0" },
  { kind: "user", id: "m1", text: "core 1", messageId: "m1" },
]);

function seed(): void {
  setOlderHistoryProvider(() => ({
    conversationId: CONVERSATION,
    agentId: "agent-1",
    cursor: CORE_CURSOR,
  }));
}

afterEach(() => {
  resetOlderHistoryForTests();
  resetViewportScroll();
  resetNoticeForTests();
});

test("a page that overlaps the loaded rows still lands", async () => {
  seed();
  setOlderHistoryFetcherForTests(async () => [
    // Newest first: one row older than the core, then two the core holds.
    message("m100", "older than the core"),
    message("m1", "kept by the core"),
    message("m0", "the cursor itself"),
  ]);

  // Short page, so this is also the end of the walk; the point is that it landed
  // instead of being read as a cursor the backend did not honour.
  expect(await requestOlderHistory(0)).toBe("start");
  expect(getOlderHistoryItems(CONVERSATION).map((item) => item.id)).toEqual([
    "m100",
  ]);
});

test("a page that is entirely loaded is refused, once", async () => {
  seed();
  let fetches = 0;
  setOlderHistoryFetcherForTests(async () => {
    fetches += 1;
    return [
      message("m1", "kept by the core"),
      message("m0", "the cursor itself"),
    ];
  });

  expect(await requestOlderHistory(0)).toBe("refused");
  expect(fetches).toBe(1);
  expect(getOlderHistoryItems(CONVERSATION)).toHaveLength(0);
});

test("a landed page is one ledger entry, in step with the rows it inserted", async () => {
  seed();
  setOlderHistoryFetcherForTests(async () => [
    message("m100", "older than the core"),
    message("m101", "older still"),
    message("m1", "kept by the core"),
    message("m0", "the cursor itself"),
  ]);
  expect(await requestOlderHistory(0)).toBe("start");

  // Two rows were inserted (the core's two were dropped by composition), and the
  // ledger says exactly that: the count is what the window fitter skips the page by.
  const inserted = getOlderHistoryItems(CONVERSATION).map((item) => item.id);
  expect(inserted).toEqual(["m100", "m101"]);
  expect(
    getOlderHistoryBlocks(CONVERSATION).map((block) => block.itemCount),
  ).toEqual([2]);
  expect(getOlderHistoryBlocks(CONVERSATION)[0]?.rows).toBeNull();

  // A reported height sticks, and reporting the same one again changes nothing.
  reportOlderHistoryBlockRows("m0", 7);
  expect(getOlderHistoryBlocks(CONVERSATION)[0]?.rows).toBe(7);
  const before = getOlderHistoryBlocks(CONVERSATION);
  reportOlderHistoryBlockRows("m0", 7);
  expect(getOlderHistoryBlocks(CONVERSATION)).toBe(before);
});
