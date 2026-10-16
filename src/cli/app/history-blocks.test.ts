import { describe, expect, test } from "bun:test";
import {
  type HistoryBlock,
  historyBlockAt,
  historyBlockItems,
  historyBlocksForWindow,
  withHistoryBlockRows,
} from "./history-blocks";

function block(
  key: string,
  itemCount: number,
  rows: number | null = null,
): HistoryBlock {
  return { key, itemCount, rows };
}

/** Three pages of ten items each, oldest first, then a core of four items. */
const THREE = [block("b0", 10, 30), block("b1", 10, 40), block("b2", 10, 50)];

describe("the paged history as blocks", () => {
  test("counts the items the blocks hold", () => {
    expect(historyBlockItems(THREE)).toBe(30);
    expect(historyBlockItems([])).toBe(0);
    expect(historyBlockItems([block("odd", -5)])).toBe(0);
  });

  test("maps a global index to its block, and the core to null", () => {
    expect(historyBlockAt(THREE, 0)).toBe(0);
    expect(historyBlockAt(THREE, 9)).toBe(0);
    expect(historyBlockAt(THREE, 10)).toBe(1);
    expect(historyBlockAt(THREE, 29)).toBe(2);
    // Past the blocks is the core, which is not a block.
    expect(historyBlockAt(THREE, 30)).toBeNull();
    expect(historyBlockAt(THREE, -1)).toBeNull();
  });

  test("asks for the blocks a window touches, with slack either side", () => {
    // A window inside block 1 pulls block 0 and block 2 in with it.
    expect(historyBlocksForWindow(THREE, 12, 18)).toEqual({ from: 0, to: 2 });
    // Slack is clamped at the ends.
    expect(historyBlocksForWindow(THREE, 0, 3, 2)).toEqual({ from: 0, to: 2 });
    expect(historyBlocksForWindow(THREE, 27, 30, 4)).toEqual({
      from: 0,
      to: 2,
    });
    // No slack: exactly the blocks the rows fall in.
    expect(historyBlocksForWindow(THREE, 10, 20, 0)).toEqual({
      from: 1,
      to: 1,
    });
  });

  test("asks for nothing while the window is in the core", () => {
    // The steady state: following the newest row, no block needs to be resident.
    expect(historyBlocksForWindow(THREE, 30, 34)).toBeNull();
    expect(historyBlocksForWindow([], 0, 5)).toBeNull();
    expect(historyBlocksForWindow(THREE, 7, 7)).toBeNull();
  });

  test("records a measured height only when it moved", () => {
    const measured = withHistoryBlockRows(THREE, "b1", 41);
    expect(measured[1]?.rows).toBe(41);
    // Identity is the signal that nothing has to re-render.
    expect(withHistoryBlockRows(measured, "b1", 41)).toBe(measured);
    expect(withHistoryBlockRows(measured, "unknown", 7)).toBe(measured);
    expect(withHistoryBlockRows(measured, "b2", 50)).toBe(measured);
  });
});
