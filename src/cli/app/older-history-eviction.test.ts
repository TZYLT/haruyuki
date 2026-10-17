import { afterEach, expect, test } from "bun:test";
import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import { resetNoticeForTests } from "@/cli/helpers/notice";
import {
  evictOlderHistoryBlocksBefore,
  getOlderHistoryBlocks,
  getOlderHistoryItems,
  materializeOlderHistoryBlocks,
  olderHistoryCursor,
  olderHistoryPrefixItems,
  reportOlderHistoryBlockRows,
  requestOlderHistory,
  resetOlderHistoryForTests,
  setOlderHistoryFetcherForTests,
  setOlderHistoryProvider,
} from "./older-history";
import {
  getViewportScrollRequest,
  reportViewportPosition,
  resetViewportScroll,
} from "./viewport-scroll";

/**
 * Eviction is where the paging store and the parked position have to agree.
 *
 * The walk numbers items over **every** page — an evicted one still contributes its
 * count — while the rendered array only holds the materialized ones. Two things can
 * go wrong where those two spaces meet, and neither is visible in a single module:
 * compensating the parked anchor for items that were dropped (the walk never
 * renumbered, so the view jumps), and walking into a page that is only a count (its
 * rows cannot be measured, and its items cannot be drawn).
 */

const CONVERSATION = "conv-eviction";
/** A full page, so the walk is not at the conversation's start yet. */
const PAGE = 50;

function message(id: string): Message {
  return {
    id,
    message_type: "user_message",
    content: [{ type: "text", text: id }],
  } as unknown as Message;
}

function seed(): void {
  setOlderHistoryProvider(() => ({
    conversationId: CONVERSATION,
    agentId: "agent-1",
    cursor: olderHistoryCursor([
      { kind: "user", id: "core", text: "core", messageId: "core" },
    ]),
  }));
}

afterEach(() => {
  resetOlderHistoryForTests();
  resetViewportScroll();
  resetNoticeForTests();
});

test("evicting a page drops its items and leaves the parked anchor alone", async () => {
  seed();
  let page = 0;
  setOlderHistoryFetcherForTests(async () => {
    page += 1;
    return Array.from({ length: PAGE }, (_, index) =>
      message(`p${page}-${index}`),
    );
  });

  expect(await requestOlderHistory(0)).toBe("loaded");
  expect(await requestOlderHistory(0)).toBe("loaded");
  expect(getOlderHistoryBlocks(CONVERSATION)).toHaveLength(2);
  expect(getOlderHistoryItems(CONVERSATION)).toHaveLength(2 * PAGE);
  expect(olderHistoryPrefixItems(CONVERSATION)).toBe(0);

  // A page has to be measured before it can be evicted: the walk can only skip a page
  // it has a height for, so the eviction rule clamps at the first unmeasured page.
  for (const block of getOlderHistoryBlocks(CONVERSATION)) {
    reportOlderHistoryBlockRows(block.key, 100);
  }

  // Parked above the newest rows (`rows: 0` would mean following the bottom).
  reportViewportPosition({ rows: 30, anchor: { end: 120, delta: 4 } });

  // The older page becomes a count: its items leave the rendered array. The anchor
  // does **not** move — it names a position in the walk's item space, which counts
  // every page whether it is materialized or only a count, so eviction does not
  // renumber anything. Moving it here is what made a dropped page take the parked
  // view with it.
  evictOlderHistoryBlocksBefore(1);
  expect(getOlderHistoryItems(CONVERSATION)).toHaveLength(PAGE);
  expect(olderHistoryPrefixItems(CONVERSATION)).toBe(PAGE);
  const parked = getViewportScrollRequest();
  expect(parked.kind === "anchor" ? parked.anchor : null).toEqual({
    end: 120,
    delta: 4,
  });

  // Evicting what is already a count changes nothing, so a caller loop converges.
  const rendered = getOlderHistoryItems(CONVERSATION);
  evictOlderHistoryBlocksBefore(1);
  expect(getOlderHistoryItems(CONVERSATION)).toBe(rendered);
  expect(olderHistoryPrefixItems(CONVERSATION)).toBe(PAGE);
});

test("a page the window comes back to is materialized from what is held", async () => {
  seed();
  let page = 0;
  let fetches = 0;
  setOlderHistoryFetcherForTests(async () => {
    page += 1;
    fetches += 1;
    return Array.from({ length: PAGE }, (_, index) =>
      message(`p${page}-${index}`),
    );
  });

  expect(await requestOlderHistory(0)).toBe("loaded");
  expect(await requestOlderHistory(0)).toBe("loaded");
  for (const block of getOlderHistoryBlocks(CONVERSATION)) {
    reportOlderHistoryBlockRows(block.key, 100);
  }
  const whole = getOlderHistoryItems(CONVERSATION).map((item) => item.id);

  evictOlderHistoryBlocksBefore(1);
  expect(getOlderHistoryItems(CONVERSATION)).toHaveLength(PAGE);
  expect(olderHistoryPrefixItems(CONVERSATION)).toBe(PAGE);

  // The walk counts both pages, so a window can land in the evicted one: those items
  // have to come back, in front of the rendered array and in the same order.
  expect(materializeOlderHistoryBlocks(0, 1)).toBe(true);
  expect(getOlderHistoryItems(CONVERSATION).map((item) => item.id)).toEqual(
    whole,
  );
  expect(olderHistoryPrefixItems(CONVERSATION)).toBe(0);
  // Nothing was re-fetched: the page's own messages were still held.
  expect(fetches).toBe(2);
  // Already materialized: no change, so a caller loop converges.
  expect(materializeOlderHistoryBlocks(0, 1)).toBe(false);
});
