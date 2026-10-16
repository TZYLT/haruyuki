import { afterEach, expect, test } from "bun:test";
import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import { resetNoticeForTests } from "@/cli/helpers/notice";
import {
  evictOlderHistoryBlocksBefore,
  getOlderHistoryBlocks,
  getOlderHistoryItems,
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
 * A parked anchor names an item **index**, so dropping items from the front of the
 * rendered array moves it. Doing one without the other is exactly what a parked view
 * moving on its own looks like, and no single-file test can see it: the store and
 * the scroll position are two modules.
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

test("evicting a page drops its items and moves the parked anchor by them", async () => {
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
  expect(getOlderHistoryBlocks()).toHaveLength(2);
  expect(getOlderHistoryItems(CONVERSATION)).toHaveLength(2 * PAGE);
  expect(olderHistoryPrefixItems()).toBe(0);

  // A page has to be measured before it can be evicted: the walk can only skip a page
  // it has a height for, so the eviction rule clamps at the first unmeasured page.
  for (const block of getOlderHistoryBlocks()) {
    reportOlderHistoryBlockRows(block.key, 100);
  }

  // Parked above the newest rows (`rows: 0` would mean following the bottom).
  reportViewportPosition({ rows: 30, anchor: { end: 120, delta: 4 } });

  // The older page becomes a count: its items leave the rendered array, and the
  // index the anchor names moves down by exactly that many.
  evictOlderHistoryBlocksBefore(1);
  expect(getOlderHistoryItems(CONVERSATION)).toHaveLength(PAGE);
  expect(olderHistoryPrefixItems()).toBe(PAGE);
  const parked = getViewportScrollRequest();
  expect(parked.kind === "anchor" ? parked.anchor : null).toEqual({
    end: 120 - PAGE,
    delta: 4,
  });

  // Evicting what is already a count changes nothing, so a caller loop converges.
  const rendered = getOlderHistoryItems(CONVERSATION);
  evictOlderHistoryBlocksBefore(1);
  expect(getOlderHistoryItems(CONVERSATION)).toBe(rendered);
  expect(olderHistoryPrefixItems()).toBe(PAGE);
});
