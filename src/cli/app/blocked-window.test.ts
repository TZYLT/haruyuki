import { describe, expect, test } from "bun:test";
import { fitBlockedItemsFromEnd } from "./blocked-window";
import type { HistoryBlock } from "./history-blocks";
import { fitScrolledItemsFromEnd } from "./viewport-window";

/**
 * The blocked walk has to select exactly what the item walk selects, or a paged
 * history scrolls to a different place than a compacted one and it only shows on a
 * real screen, deep in a conversation. The item walk is the oracle; both are given
 * the same rows, so a differing field is the page step being wrong.
 *
 * Checked from the simplest corner outwards, and a mismatch reports the inputs and
 * both outputs — a bare "these differ" costs a whole round.
 */

function heightsFor(count: number): number[] {
  let seed = 12_345;
  const heights: number[] = [];
  for (let index = 0; index < count; index += 1) {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    heights.push(1 + (seed % 9));
  }
  return heights;
}

const ITEM_COUNT = 240;
const PAGE_ITEMS = 40;
const heights = heightsFor(ITEM_COUNT);
const CORE_ITEMS = ITEM_COUNT - 5 * PAGE_ITEMS;

const PAGES: HistoryBlock[] = Array.from({ length: 5 }, (_, page) => {
  const slice = heights.slice(page * PAGE_ITEMS, (page + 1) * PAGE_ITEMS);
  return {
    key: `page-${page}`,
    itemCount: PAGE_ITEMS,
    rows: slice.reduce((sum, rows) => sum + rows, 0),
  };
});

const MEASURING = (index: number) => heights[index] ?? 0;

function fieldsOf(window: {
  start: number;
  end: number;
  scrollFromBottom: number;
  contentOffset: number;
  anchor: unknown;
}) {
  return {
    start: window.start,
    end: window.end,
    scrollFromBottom: window.scrollFromBottom,
    contentOffset: window.contentOffset,
    anchor: window.anchor,
  };
}

function compare(input: {
  height: number;
  maxItems: number;
  scroll: number;
  anchor?: { end: number; delta: number };
  blocks?: readonly HistoryBlock[];
}): void {
  const blocks = input.blocks ?? PAGES;
  const oracle = fieldsOf(
    fitScrolledItemsFromEnd(
      ITEM_COUNT,
      input.height,
      input.maxItems,
      input.scroll,
      MEASURING,
      input.anchor,
    ),
  );
  const blocked = fieldsOf(
    fitBlockedItemsFromEnd({
      blocks,
      coreItemCount: CORE_ITEMS,
      height: input.height,
      maxItems: input.maxItems,
      scrollFromBottom: input.scroll,
      anchor: input.anchor,
      measure: MEASURING,
    }),
  );
  try {
    expect(blocked).toEqual(oracle);
  } catch {
    throw new Error(
      `window mismatch: height=${input.height} maxItems=${input.maxItems} scroll=${input.scroll} anchor=${JSON.stringify(input.anchor ?? null)}\n  oracle=${JSON.stringify(oracle)}\n  blocked=${JSON.stringify(blocked)}`,
    );
  }
}

describe("the blocked window walk", () => {
  // No item-bound pressure and no anchor: only "a page is one step" is weighed.
  test("matches with no item bound and no anchor", () => {
    for (const height of [5, 12, 30]) {
      for (const scroll of [0, 3, 40, 300, 1000]) {
        compare({ height, maxItems: 1000, scroll });
      }
    }
  });

  test("matches when the item bound is what stops the walk", () => {
    for (const height of [5, 12, 30]) {
      for (const maxItems of [4, 50]) {
        for (const scroll of [0, 63, 300, 3000, 12_000]) {
          compare({ height, maxItems, scroll });
        }
      }
    }
  });

  test("matches under an anchor", () => {
    for (const height of [5, 12]) {
      for (const end of [40, 120, 200, 240]) {
        for (const delta of [0, 3, 9]) {
          compare({ height, maxItems: 50, scroll: 0, anchor: { end, delta } });
        }
      }
    }
  });

  test("matches when a page was never measured", () => {
    const unmeasured = PAGES.map((page, index) =>
      index === 2 ? { ...page, rows: null } : page,
    );
    for (const scroll of [0, 300, 3000]) {
      compare({ height: 12, maxItems: 50, scroll, blocks: unmeasured });
    }
  });

  test("measures far fewer items than the item walk when deep", () => {
    let oracleCalls = 0;
    fitScrolledItemsFromEnd(ITEM_COUNT, 12, 50, 9000, (index) => {
      oracleCalls += 1;
      return heights[index] ?? 0;
    });
    let blockedCalls = 0;
    fitBlockedItemsFromEnd({
      blocks: PAGES,
      coreItemCount: CORE_ITEMS,
      height: 12,
      maxItems: 50,
      scrollFromBottom: 9000,
      measure: (index) => {
        blockedCalls += 1;
        return heights[index] ?? 0;
      },
    });
    expect(oracleCalls).toBeGreaterThan(ITEM_COUNT / 2);
    expect(blockedCalls).toBeLessThan(oracleCalls * 0.75);
  });

  test("asks for the pages the window touches", () => {
    const deep = fitBlockedItemsFromEnd({
      blocks: PAGES,
      coreItemCount: CORE_ITEMS,
      height: 12,
      maxItems: 50,
      scrollFromBottom: 3000,
      measure: MEASURING,
    });
    expect(deep.resident).not.toBeNull();
    const following = fitBlockedItemsFromEnd({
      blocks: PAGES,
      coreItemCount: CORE_ITEMS,
      height: 12,
      maxItems: 50,
      scrollFromBottom: 0,
      measure: MEASURING,
    });
    expect(following.resident).toBeNull();
  });
});
