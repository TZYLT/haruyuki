import { describe, expect, test } from "bun:test";
import {
  fitWholeItems,
  layoutViewport,
  totalRows,
} from "@/cli/app/viewport-window";

describe("fitWholeItems", () => {
  test("keeps whole items that fit, anchored to the bottom", () => {
    expect(fitWholeItems([10, 10, 10], 25, 100)).toEqual({ start: 1, end: 3 });
  });

  test("shows everything when it all fits", () => {
    expect(fitWholeItems([3, 3], 10, 100)).toEqual({ start: 0, end: 2 });
  });

  test("caps the number of rendered items", () => {
    expect(fitWholeItems([1, 1, 1, 1], 10, 2)).toEqual({ start: 2, end: 4 });
  });

  test("returns an empty window for no items", () => {
    expect(fitWholeItems([], 10, 100)).toEqual({ start: 0, end: 0 });
  });

  test("bounded residency: a huge transcript still renders a capped window", () => {
    const heights = Array.from({ length: 5000 }, () => 3);
    const { start, end } = fitWholeItems(heights, 24, 200);
    expect(end).toBe(5000);
    expect(end - start).toBeLessThanOrEqual(200);
    // Anchored to the bottom, not the top.
    expect(start).toBeGreaterThan(4000);
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
