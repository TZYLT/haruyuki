import { describe, expect, test } from "bun:test";
import {
  clampCursor,
  edgeCursor,
  filterItems,
  itemAt,
  matchesQuery,
  moveCursor,
  type OverlayListItem,
  orderedKeys,
  swapWithin,
  toggleSelection,
  visibleWindow,
  windowStart,
} from "./list-model";

function items(count: number): OverlayListItem[] {
  return Array.from({ length: count }, (_, index) => ({
    key: `k${index}`,
    label: `Item ${index}`,
  }));
}

describe("clampCursor", () => {
  test("keeps the cursor inside the list", () => {
    expect(clampCursor(-3, 5)).toBe(0);
    expect(clampCursor(9, 5)).toBe(4);
    expect(clampCursor(2, 5)).toBe(2);
  });

  test("an empty list has one valid position, 0", () => {
    expect(clampCursor(4, 0)).toBe(0);
    expect(clampCursor(-1, 0)).toBe(0);
  });

  test("a non-finite cursor does not become NaN indexes", () => {
    expect(clampCursor(Number.NaN, 5)).toBe(0);
    expect(clampCursor(Number.POSITIVE_INFINITY, 5)).toBe(0);
  });
});

describe("windowStart", () => {
  test("a list that fits does not move", () => {
    expect(windowStart({ count: 3, cursor: 0, rows: 5 })).toBe(0);
    expect(windowStart({ count: 3, cursor: 2, rows: 5 })).toBe(0);
    expect(windowStart({ count: 5, cursor: 4, rows: 5 })).toBe(0);
  });

  test("the window follows the cursor once it reaches the edge", () => {
    // 10 items, 5 rows: the window stays put until the cursor passes its bottom.
    expect(windowStart({ count: 10, cursor: 4, rows: 5 })).toBe(0);
    expect(windowStart({ count: 10, cursor: 5, rows: 5 })).toBe(1);
    expect(windowStart({ count: 10, cursor: 9, rows: 5 })).toBe(5);
  });

  test("the window stops at the list's tail and keeps the cursor's row last", () => {
    // Cursor on the bottom row of a three-row window: the window is that row's
    // window, not the tail.
    expect(windowStart({ count: 10, cursor: 8, rows: 3 })).toBe(6);
    // Cursor on the last item: the window would run past the end, so it is the
    // tail instead of a short one.
    expect(windowStart({ count: 10, cursor: 9, rows: 3 })).toBe(7);
  });

  test("rows of zero or less means no windowing", () => {
    expect(windowStart({ count: 10, cursor: 7, rows: 0 })).toBe(0);
    expect(windowStart({ count: 10, cursor: 7, rows: -2 })).toBe(0);
  });

  test("the centered anchor holds the cursor in the middle of the window", () => {
    // `/resume` and `/search` both had `cursor - floor(rows / 2)`; the cursor
    // reaches the middle of the window and the window moves with it from there.
    expect(
      windowStart({ count: 20, cursor: 2, rows: 5, anchor: "center" }),
    ).toBe(0);
    expect(
      windowStart({ count: 20, cursor: 3, rows: 5, anchor: "center" }),
    ).toBe(1);
    // The last window is still the list's tail, so the tail is reachable.
    expect(
      windowStart({ count: 20, cursor: 19, rows: 5, anchor: "center" }),
    ).toBe(15);
    // A single-row window has no room to center, so both anchors agree.
    expect(
      windowStart({ count: 20, cursor: 9, rows: 1, anchor: "center" }),
    ).toBe(9);
    expect(windowStart({ count: 20, cursor: 9, rows: 1 })).toBe(9);
  });

  test("the page anchor does not move while the cursor stays in its page", () => {
    // `/help`'s shape: it moved a whole page at a time and put the cursor back
    // at the page's first row, which is what this window does.
    expect(
      windowStart({ count: 45, cursor: 0, rows: 10, anchor: "page" }),
    ).toBe(0);
    expect(
      windowStart({ count: 45, cursor: 9, rows: 10, anchor: "page" }),
    ).toBe(0);
    expect(
      windowStart({ count: 45, cursor: 10, rows: 10, anchor: "page" }),
    ).toBe(10);
    expect(
      windowStart({ count: 45, cursor: 19, rows: 10, anchor: "page" }),
    ).toBe(10);
  });

  test("the page anchor's last page is short instead of pulled to the tail", () => {
    // The one place the page anchor differs from `edge`: a tail window of the
    // full `rows` would push the page's own first row off the top.
    expect(
      windowStart({ count: 45, cursor: 40, rows: 10, anchor: "page" }),
    ).toBe(40);
    expect(windowStart({ count: 45, cursor: 44, rows: 10 })).toBe(35);
  });
});

describe("visibleWindow", () => {
  test("no row budget means the whole list, which is what overlays did before", () => {
    expect(visibleWindow({ count: 4, cursor: 2 })).toEqual({
      start: 0,
      end: 4,
      above: 0,
      below: 0,
      total: 4,
    });
  });

  test("an empty list reports an empty window rather than a negative one", () => {
    expect(visibleWindow({ count: 0, cursor: 3, rows: 5 }).total).toBe(0);
    expect(visibleWindow({ count: -4, cursor: 0, rows: 5 }).end).toBe(0);
  });

  test("counts what is hidden on each side", () => {
    expect(visibleWindow({ count: 10, cursor: 5, rows: 4 })).toEqual({
      start: 2,
      end: 6,
      above: 2,
      below: 4,
      total: 10,
    });
  });

  test("a budget larger than the list hides nothing", () => {
    expect(visibleWindow({ count: 3, cursor: 1, rows: 8 })).toEqual({
      start: 0,
      end: 3,
      above: 0,
      below: 0,
      total: 3,
    });
  });

  test("the page anchor reports the short tail page as its own page", () => {
    expect(
      visibleWindow({ count: 45, cursor: 44, rows: 10, anchor: "page" }),
    ).toEqual({ start: 40, end: 45, above: 40, below: 0, total: 45 });
  });

  test("the window always contains the cursor", () => {
    for (let count = 1; count <= 12; count += 1) {
      for (let rows = 1; rows <= 12; rows += 1) {
        for (let cursor = 0; cursor < count; cursor += 1) {
          const window = visibleWindow({ count, cursor, rows });
          expect(window.start).toBeLessThanOrEqual(cursor);
          expect(window.end).toBeGreaterThan(cursor);
          expect(window.end - window.start).toBe(Math.min(rows, count));
          expect(
            window.above + (window.end - window.start) + window.below,
          ).toBe(count);
        }
      }
    }
  });
});

describe("moveCursor", () => {
  test("clamps by default, the way the pickers did", () => {
    expect(moveCursor({ cursor: 0, count: 5, delta: -1 })).toBe(0);
    expect(moveCursor({ cursor: 4, count: 5, delta: 1 })).toBe(4);
    expect(moveCursor({ cursor: 2, count: 5, delta: -1 })).toBe(1);
  });

  test("wraps on request, the way the autocomplete popup does", () => {
    expect(moveCursor({ cursor: 0, count: 5, delta: -1, wrap: true })).toBe(4);
    expect(moveCursor({ cursor: 4, count: 5, delta: 1, wrap: true })).toBe(0);
  });

  test("an empty list stays at 0 and a zero step changes nothing", () => {
    expect(moveCursor({ cursor: 0, count: 0, delta: 3 })).toBe(0);
    expect(moveCursor({ cursor: 3, count: 5, delta: 0 })).toBe(3);
  });

  test("a cursor that was out of range is clamped before the step", () => {
    expect(moveCursor({ cursor: 99, count: 5, delta: -1 })).toBe(3);
  });
});

describe("edgeCursor", () => {
  test("names the first and last item", () => {
    expect(edgeCursor(6, "start")).toBe(0);
    expect(edgeCursor(6, "end")).toBe(5);
  });

  test("an empty list has no edges to fall off", () => {
    expect(edgeCursor(0, "start")).toBe(0);
    expect(edgeCursor(0, "end")).toBe(0);
  });
});

describe("itemAt", () => {
  test("reads by clamped index", () => {
    const list = items(3);
    expect(itemAt(list, 1)?.key).toBe("k1");
    expect(itemAt(list, 42)?.key).toBe("k2");
    expect(itemAt(list, -1)?.key).toBe("k0");
  });

  test("an empty list has no item", () => {
    expect(itemAt([], 0)).toBeUndefined();
  });
});

describe("filterItems", () => {
  const list: OverlayListItem[] = [
    { key: "a", label: "Alpha" },
    { key: "b", label: "Beta", description: "the second one" },
    { key: "c", label: "Gamma" },
  ];

  test("matches the label case-insensitively and trims the query", () => {
    expect(filterItems(list, "  ALP ").map((item) => item.key)).toEqual(["a"]);
  });

  test("matches the description too, which is what the user can see", () => {
    expect(filterItems(list, "second").map((item) => item.key)).toEqual(["b"]);
  });

  test("an empty query keeps everything, as a copy", () => {
    const kept = filterItems(list, "   ");
    expect(kept).toEqual(list);
    expect(kept).not.toBe(list);
  });

  test("no match is an empty list, not the unfiltered one", () => {
    expect(filterItems(list, "zzz")).toEqual([]);
  });

  test("matchesQuery answers for one item", () => {
    const beta = list.find((item) => item.key === "b");
    if (!beta) throw new Error("fixture is missing the beta item");
    expect(matchesQuery(beta, "beta")).toBe(true);
    expect(matchesQuery(beta, "gamma")).toBe(false);
  });
});

describe("selection", () => {
  test("toggling adds and removes without mutating the input", () => {
    const selected = new Set(["a"]);
    const added = toggleSelection(selected, "b");
    expect([...added].sort()).toEqual(["a", "b"]);
    expect([...selected]).toEqual(["a"]);

    const removed = toggleSelection(added, "a");
    expect([...removed]).toEqual(["b"]);
  });

  test("the answer is in list order, so a reorder reorders it", () => {
    const list: OverlayListItem[] = [
      { key: "third", label: "3" },
      { key: "first", label: "1" },
      { key: "second", label: "2" },
    ];
    const selected = new Set(["first", "second", "third"]);
    expect(orderedKeys(list, selected)).toEqual(["third", "first", "second"]);
  });
});

describe("swapWithin", () => {
  test("swaps two positions", () => {
    expect(swapWithin(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
  });

  test("does not mutate its input", () => {
    const list = ["a", "b"];
    swapWithin(list, 0, 1);
    expect(list).toEqual(["a", "b"]);
  });

  test("out-of-range and no-op swaps return an equal list rather than throwing", () => {
    expect(swapWithin(["a", "b"], -1, 1)).toEqual(["a", "b"]);
    expect(swapWithin(["a", "b"], 0, 5)).toEqual(["a", "b"]);
    expect(swapWithin(["a", "b"], 1, 1)).toEqual(["a", "b"]);
    expect(swapWithin([], 0, 0)).toEqual([]);
  });
});
