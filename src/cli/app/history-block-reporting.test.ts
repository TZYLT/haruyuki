import { describe, expect, test } from "bun:test";
import { fitBlockedItemsFromEnd } from "./blocked-window";
import { type HistoryBlock, withHistoryBlockRows } from "./history-blocks";
import { fitScrolledItemsFromEnd } from "./viewport-window";

/**
 * The payoff of walking pages at all: a page that has been measured is one step on
 * the next visit, so the cost of a deep position is paid once and not every frame.
 *
 * This is the seam that was missing: the fitter could always skip a measured page,
 * but nothing ever produced a height for one. Here the walk reports what it measured,
 * and the next walk over the same place is measurably cheaper while selecting the
 * same window.
 */

/** Five pages of ten items, none of them measured yet: no page can be skipped. */
const PAGES: HistoryBlock[] = Array.from({ length: 5 }, (_, page) => ({
  key: `p${page}`,
  itemCount: 10,
  rows: null,
}));

/** Deterministic heights, so the two walks see the same transcript. */
const heights = (index: number) => 1 + (index % 3);

function walk(blocks: readonly HistoryBlock[], counter: { calls: number }) {
  return fitBlockedItemsFromEnd({
    blocks,
    coreItemCount: 0,
    height: 12,
    maxItems: 50,
    scrollFromBottom: 30,
    measure: (index) => {
      counter.calls += 1;
      return heights(index);
    },
  });
}

function windowOf(fitted: {
  start: number;
  end: number;
  contentOffset: number;
}) {
  return {
    start: fitted.start,
    end: fitted.end,
    contentOffset: fitted.contentOffset,
  };
}

describe("reporting what the walk measured", () => {
  test("a page measured once is skipped on the next walk, same window", () => {
    const first = { calls: 0 };
    const before = walk(PAGES, first);
    expect(before.measuredBlocks.length).toBeGreaterThan(0);

    let ledger: readonly HistoryBlock[] = PAGES;
    for (const block of before.measuredBlocks) {
      ledger = withHistoryBlockRows(ledger, block.key, block.rows);
    }

    const second = { calls: 0 };
    const after = walk(ledger, second);
    // Cheaper, not different: the window a user sees is the same one.
    expect(windowOf(after)).toEqual(windowOf(before));
    expect(second.calls).toBeLessThan(first.calls);
  });

  test("a page seen only in part is not reported", () => {
    // A single-row window over the newest page: the walk touches that page's last
    // item and nothing else, so it has no total to report.
    const counter = { calls: 0 };
    const fitted = fitBlockedItemsFromEnd({
      blocks: PAGES.map((page, index) =>
        index === 4 ? { ...page, rows: 12 } : page,
      ),
      coreItemCount: 0,
      height: 2,
      maxItems: 4,
      scrollFromBottom: 0,
      measure: (index) => {
        counter.calls += 1;
        return heights(index);
      },
    });
    expect(fitted.measuredBlocks).toEqual([]);
  });

  test("a reported height is the page's own rows, not its measurement calls", () => {
    // The walk asks the step provider more than once at the same boundary (the first
    // pass breaks on a step that does not fit and the second restarts there, the
    // anchor translation walks the same ground, and reaching the oldest re-walks the
    // whole thing folded back). A height accumulated per *call* comes out at roughly
    // twice the page, and a page skipped by a height that is too large puts the
    // window somewhere the rows on screen are not.
    const first = walk(PAGES, { calls: 0 });
    expect(first.measuredBlocks.length).toBeGreaterThan(0);

    for (const block of first.measuredBlocks) {
      const page = Number(block.key.slice(1));
      const rows = Array.from({ length: 10 }, (_, index) =>
        heights(page * 10 + index),
      ).reduce((sum, value) => sum + value, 0);
      expect(block.rows).toBe(rows);
    }
  });

  test("the heights it reports keep the next walk on the oracle's window", () => {
    // The whole payoff, weighed against the item walk: once a page's height is in the
    // ledger, a blocked walk that skips it has to select exactly the window the item
    // walk selects -- otherwise the ledger is a second, quietly different answer.
    const first = walk(PAGES, { calls: 0 });
    let ledger: readonly HistoryBlock[] = PAGES;
    for (const block of first.measuredBlocks) {
      ledger = withHistoryBlockRows(ledger, block.key, block.rows);
    }

    const second = walk(ledger, { calls: 0 });
    const oracle = fitScrolledItemsFromEnd(
      PAGES.length * 10,
      12,
      50,
      30,
      heights,
    );
    expect(windowOf(second)).toEqual({
      start: oracle.start,
      end: oracle.end,
      contentOffset: oracle.contentOffset,
    });
  });
});
