import { describe, expect, test } from "bun:test";
import {
  fitWholeItemsFromEnd,
  layoutViewport,
  totalRows,
} from "@/cli/app/viewport-window";

/** The window for a materialised height array, written the way the tests read. */
function windowOf(
  heights: readonly number[],
  height: number,
  maxItems: number,
): { start: number; end: number } {
  return fitWholeItemsFromEnd(
    heights.length,
    height,
    maxItems,
    (index) => heights[index] ?? 0,
  );
}

describe("fitWholeItemsFromEnd", () => {
  test("keeps whole items that fit, anchored to the bottom", () => {
    expect(windowOf([10, 10, 10], 25, 100)).toEqual({ start: 1, end: 3 });
  });

  test("shows everything when it all fits", () => {
    expect(windowOf([3, 3], 10, 100)).toEqual({ start: 0, end: 2 });
  });

  test("caps the number of rendered items", () => {
    expect(windowOf([1, 1, 1, 1], 10, 2)).toEqual({ start: 2, end: 4 });
  });

  test("returns an empty window for no items", () => {
    expect(windowOf([], 10, 100)).toEqual({ start: 0, end: 0 });
  });

  test("bounded residency: a huge transcript still renders a capped window", () => {
    const heights = Array.from({ length: 5000 }, () => 3);
    const { start, end } = windowOf(heights, 24, 200);
    expect(end).toBe(5000);
    expect(end - start).toBeLessThanOrEqual(200);
    // Anchored to the bottom, not the top.
    expect(start).toBeGreaterThan(4000);
  });

  test("reads heights from the end backwards", () => {
    const heights = [0, 0, 1, 3, 12, 1, 7, 2];
    const read: number[] = [];
    const { start, end } = fitWholeItemsFromEnd(8, 20, 100, (index) => {
      read.push(index);
      return heights[index] ?? 0;
    });

    expect(read).toEqual([...read].sort((a, b) => b - a));
    expect(end - start).toBe(3);
    expect(read.length).toBe(4);
  });

  test("measures only the window plus the one item that did not fit", () => {
    const measured: number[] = [];
    const { start, end } = fitWholeItemsFromEnd(5_000, 24, 200, (index) => {
      measured.push(index);
      return 3;
    });

    // 24 rows of 3-row items: eight fit, the ninth is the probe that stops it.
    expect(end - start).toBe(8);
    expect(measured.length).toBe(9);
    expect(start).toBe(4_992);
  });

  test("the residency cap bounds the measuring, not just the rendering", () => {
    const measured: number[] = [];
    const { start, end } = fitWholeItemsFromEnd(10_000, 1_000, 200, (index) => {
      measured.push(index);
      return 1;
    });

    expect(end - start).toBe(200);
    expect(measured.length).toBe(200);
    expect(start).toBe(9_800);
  });

  test("stops measuring at zero-row items instead of walking the history", () => {
    // Zero-height items cost nothing to fit, so only the cap can stop the walk.
    const measured: number[] = [];
    const { start, end } = fitWholeItemsFromEnd(50_000, 10, 200, () => {
      measured.push(1);
      return 0;
    });

    expect(end - start).toBe(200);
    expect(measured.length).toBe(200);
    expect(start).toBe(49_800);
  });
});

describe("totalRows", () => {
  test("sums the heights", () => {
    expect(totalRows([3, 4, 5])).toBe(12);
  });
});

describe("layoutViewport", () => {
  test("collapses to nothing when there is no space", () => {
    expect(layoutViewport([10, 10], { height: 0 })).toMatchObject({
      start: 0,
      end: 0,
      totalRows: 20,
      clipped: true,
    });
  });

  test("collapses to nothing when there are no items", () => {
    expect(layoutViewport([], { height: 20 })).toMatchObject({
      start: 0,
      end: 0,
      totalRows: 0,
      clipped: false,
    });
  });

  test("shows everything when the transcript fits", () => {
    expect(layoutViewport([5, 5], { height: 20 })).toMatchObject({
      start: 0,
      end: 2,
      rowsAbove: 0,
      rowsBelow: 0,
      clipped: false,
    });
  });

  test("pins to the bottom by default", () => {
    expect(layoutViewport([10, 10, 10], { height: 15 })).toMatchObject({
      start: 1,
      end: 3,
      rowsAbove: 10,
      rowsBelow: 0,
    });
  });

  test("scrolls up by the requested rows", () => {
    expect(
      layoutViewport([10, 10, 10], { height: 15, scrollFromBottom: 5 }),
    ).toMatchObject({ start: 1, end: 3, rowsAbove: 10, rowsBelow: 0 });
  });

  test("clamps the scroll offset to the top of the transcript", () => {
    expect(
      layoutViewport([10, 10, 10], { height: 15, scrollFromBottom: 999 }),
    ).toMatchObject({ start: 0, end: 2, rowsAbove: 0, rowsBelow: 10 });
  });

  test("caps rendered items for bounded residency, keeping the bottom ones", () => {
    expect(
      layoutViewport([10, 10, 10], { height: 15, maxItems: 1 }),
    ).toMatchObject({ start: 2, end: 3, rowsAbove: 20 });
  });

  test("reports a single item taller than the viewport as clipped", () => {
    expect(layoutViewport([100], { height: 20 })).toMatchObject({
      start: 0,
      end: 1,
      clipped: true,
    });
  });
});
