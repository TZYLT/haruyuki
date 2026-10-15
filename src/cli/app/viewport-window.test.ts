import { describe, expect, test } from "bun:test";
import type { ViewportWindow } from "@/cli/app/viewport-window";
import { fitScrolledItemsFromEnd } from "@/cli/app/viewport-window";

/**
 * The window for a materialised history, written the long way: the full-pass
 * reference the lazy implementation is asserted against. It is the definition of
 * the row band (and the algorithm the module used before it had to measure
 * lazily), so the two must agree on every input.
 */
function referenceWindow(
  heights: readonly number[],
  height: number,
  maxItems: number,
  scrollFromBottom = 0,
): ViewportWindow {
  const count = heights.length;
  if (count === 0 || height < 1 || maxItems === 0) {
    return {
      start: 0,
      end: 0,
      scrollFromBottom: 0,
      anchor: { end: 0, delta: 0 },
    };
  }
  const total = heights.reduce((sum, rows) => sum + Math.max(0, rows), 0);
  if (total <= 0) {
    return {
      start: 0,
      end: 0,
      scrollFromBottom: 0,
      anchor: { end: 0, delta: 0 },
    };
  }
  const maxScroll = Math.max(0, total - height);
  const scroll = Math.min(Math.max(0, scrollFromBottom), maxScroll);

  const windowBottom = total - scroll;
  const windowTop = Math.max(0, windowBottom - height);

  let start = 0;
  let cumulative = 0;
  while (
    start < count &&
    cumulative + Math.max(0, heights[start] ?? 0) <= windowTop
  ) {
    cumulative += Math.max(0, heights[start] ?? 0);
    start += 1;
  }

  let end = start;
  let running = cumulative;
  while (end < count && running < windowBottom) {
    running += Math.max(0, heights[end] ?? 0);
    end += 1;
  }

  if (end - start > maxItems) start = end - maxItems;

  // Rows in the items at and after `end` are the ones the offset passes over.
  const belowWindow = Math.max(0, total - running);
  return {
    start,
    end,
    scrollFromBottom: scroll,
    anchor: { end, delta: scroll - belowWindow },
  };
}

/** The window the production path asks for: heights only exist via `measure`. */
function windowOf(
  heights: readonly number[],
  height: number,
  maxItems: number,
  scrollFromBottom = 0,
): ViewportWindow {
  return fitScrolledItemsFromEnd(
    heights.length,
    height,
    maxItems,
    scrollFromBottom,
    (index) => heights[index] ?? 0,
  );
}

describe("fitScrolledItemsFromEnd", () => {
  test("pins to the newest item by default", () => {
    expect(windowOf([10, 10, 10], 15, 100)).toMatchObject({
      start: 1,
      end: 3,
      scrollFromBottom: 0,
    });
  });

  test("shows everything when the transcript fits", () => {
    expect(windowOf([3, 3], 10, 100)).toMatchObject({
      start: 0,
      end: 2,
      scrollFromBottom: 0,
    });
  });

  test("returns an empty window for no items", () => {
    expect(windowOf([], 10, 100)).toMatchObject({
      start: 0,
      end: 0,
      scrollFromBottom: 0,
    });
  });

  test("renders an item taller than the viewport instead of nothing", () => {
    // The window used to require whole items to fit, so a single tall item —
    // the newest one, usually the streaming answer — produced an EMPTY window
    // and the full-screen shell went blank. Ink clips it instead.
    expect(windowOf([100], 20, 200)).toMatchObject({
      start: 0,
      end: 1,
      scrollFromBottom: 0,
    });
    expect(windowOf([3, 3, 100], 20, 200)).toMatchObject({
      start: 2,
      end: 3,
      scrollFromBottom: 0,
    });
  });

  test("caps the number of rendered items", () => {
    expect(windowOf([1, 1, 1, 1], 10, 2)).toMatchObject({
      start: 2,
      end: 4,
      scrollFromBottom: 0,
    });
  });

  test("bounded residency: a huge transcript still renders a capped window", () => {
    const heights = Array.from({ length: 5000 }, () => 3);
    const { start, end } = windowOf(heights, 24, 200);
    expect(end).toBe(5000);
    expect(end - start).toBeLessThanOrEqual(200);
    // Anchored to the bottom, not the top.
    expect(start).toBeGreaterThan(4000);
  });

  test("scrolls up by rows, keeping the band's items", () => {
    expect(windowOf([10, 10, 10], 15, 100, 5)).toMatchObject({
      start: 1,
      end: 3,
      scrollFromBottom: 5,
    });
    // Far enough up that the oldest item is in the band.
    expect(windowOf([10, 10, 10], 15, 100, 12)).toMatchObject({
      start: 0,
      end: 2,
    });
  });

  test("clamps an offset past the top and reports the offset shown", () => {
    // The history is 30 rows; the largest offset that shows anything new is 15.
    expect(windowOf([10, 10, 10], 15, 100, 999)).toMatchObject({
      start: 0,
      end: 2,
      scrollFromBottom: 15,
    });
  });

  test("reading heights from the end backwards", () => {
    const heights = [0, 0, 1, 3, 12, 1, 7, 2];
    const read: number[] = [];
    fitScrolledItemsFromEnd(8, 20, 100, 0, (index) => {
      read.push(index);
      return heights[index] ?? 0;
    });

    expect(read).toEqual([...read].sort((a, b) => b - a));
  });

  test("measures the window's items and the rows the offset passes over", () => {
    const measured: number[] = [];
    const pinned = fitScrolledItemsFromEnd(5_000, 24, 200, 0, (index) => {
      measured.push(index);
      return 3;
    });
    // 24 rows of 3-row items: seven fill the band, and the eighth is the probe
    // that shows the band's top edge falls inside it.
    expect(pinned.end - pinned.start).toBe(8);
    expect(measured.length).toBe(8);

    const scrolled: number[] = [];
    const scrolledWindow = fitScrolledItemsFromEnd(
      5_000,
      24,
      200,
      6,
      (index) => {
        scrolled.push(index);
        return 3;
      },
    );
    // Six rows of scroll pass two items, then the same window.
    expect(scrolledWindow.end - scrolledWindow.start).toBe(8);
    expect(scrolled.length).toBe(10);
  });

  test("the residency cap bounds the measuring, not just the rendering", () => {
    const measured: number[] = [];
    const window = fitScrolledItemsFromEnd(10_000, 1_000, 200, 0, (index) => {
      measured.push(index);
      return 1;
    });

    expect(window.end - window.start).toBe(200);
    expect(measured.length).toBe(200);
    expect(window.start).toBe(9_800);
  });

  test("stays bounded when items have no rows at all", () => {
    // Zero-row items consume no offset, so the walk is bounded by the offset plus
    // the cap rather than by the history length. The row model gives every real
    // item at least its header row; this synthetic case is here to pin that no
    // input can make one frame walk the whole history.
    const measured: number[] = [];
    const window = fitScrolledItemsFromEnd(50_000, 10, 200, 0, (index) => {
      measured.push(index);
      return 0;
    });

    expect(measured.length).toBeLessThanOrEqual(2 * 200 + 1);
    expect(window.end - window.start).toBeLessThanOrEqual(201);
  });

  test("agrees with the full-pass reference over many histories", () => {
    // Deterministic pseudo-random histories across offsets, viewport heights and
    // caps. Every item has at least one row: that is what real items look like
    // (the row model counts a header row), and it is the domain where the skip
    // bound cannot fire, so the lazy walk must match the definition exactly.
    let seed = 20261015;
    const nextRandom = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };

    const mismatches: string[] = [];
    for (let round = 0; round < 400; round += 1) {
      const count = 1 + Math.trunc(nextRandom() * 40);
      const heights = Array.from(
        { length: count },
        () => 1 + Math.trunc(nextRandom() * 30),
      );
      const height = 1 + Math.trunc(nextRandom() * 30);
      const maxItems = 1 + Math.trunc(nextRandom() * 12);
      const scroll = Math.trunc(nextRandom() * 60);

      const expected = referenceWindow(heights, height, maxItems, scroll);
      const actual = windowOf(heights, height, maxItems, scroll);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        mismatches.push(
          `heights=${JSON.stringify(heights)} height=${height} maxItems=${maxItems} scroll=${scroll}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`,
        );
      }
    }

    expect(mismatches).toEqual([]);
  });
});
