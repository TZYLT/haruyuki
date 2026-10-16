import { describe, expect, test } from "bun:test";
import { fitBlockedItemsFromEnd } from "./blocked-window";
import { type HistoryBlock, withHistoryBlockRows } from "./history-blocks";

/**
 * The payoff of walking pages at all: a page that has been measured is one step on
 * the next visit, so the cost of a deep position is paid once and not every frame.
 *
 * This is the seam that was missing (`34` §21.7.2): the fitter could always skip a
 * measured page, but nothing ever produced a height for one. Here the walk reports
 * what it measured, and the next walk over the same place is measurably cheaper while
 * selecting the same window.
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
});
