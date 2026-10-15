import { describe, expect, test } from "bun:test";
import { layoutViewport, totalRows } from "@/cli/app/viewport-window";

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
