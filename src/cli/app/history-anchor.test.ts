import { describe, expect, test } from "bun:test";
import {
  globalItemForHistoryAnchor,
  type HistoryAnchor,
  historyAnchorForGlobalItem,
  historyAnchorIsLive,
} from "./history-anchor";
import type { HistoryBlock } from "./history-blocks";

/** Three pages of ten items: the core would start at item 30. */
const PAGES: HistoryBlock[] = [
  { key: "p0", itemCount: 10, rows: 30 },
  { key: "p1", itemCount: 10, rows: 40 },
  { key: "p2", itemCount: 10, rows: 50 },
];

describe("a position that survives materialization", () => {
  test("round-trips every item index through an anchor", () => {
    for (const index of [0, 5, 10, 12, 19, 20, 29]) {
      const anchor = historyAnchorForGlobalItem(PAGES, index, 3);
      expect(anchor).not.toBeNull();
      expect(globalItemForHistoryAnchor(PAGES, anchor as HistoryAnchor)).toBe(
        index,
      );
    }
  });

  test("an index in the core is not a page", () => {
    expect(historyAnchorForGlobalItem(PAGES, 30, 0)).toBeNull();
    expect(historyAnchorForGlobalItem(PAGES, 400, 0)).toBeNull();
  });

  test("evicting another page moves the index, never the anchor", () => {
    // Item 12 is the third item of `p1`.
    const anchor = historyAnchorForGlobalItem(PAGES, 12, 3);
    expect(anchor).toEqual({ blockKey: "p1", offsetInBlock: 2, delta: 3 });

    // The oldest page goes: the same content now sits two items lower, and the
    // triple is untouched — which is the property the parked view depends on.
    const withoutOldest = PAGES.slice(1);
    expect(globalItemForHistoryAnchor(PAGES, anchor as HistoryAnchor)).toBe(12);
    expect(
      globalItemForHistoryAnchor(withoutOldest, anchor as HistoryAnchor),
    ).toBe(2);
    expect(anchor).toEqual({ blockKey: "p1", offsetInBlock: 2, delta: 3 });
    expect(historyAnchorIsLive(withoutOldest, anchor as HistoryAnchor)).toBe(
      true,
    );
  });

  test("a page that is gone reads as not live", () => {
    const anchor = historyAnchorForGlobalItem(PAGES, 12, 3) as HistoryAnchor;
    const withoutMiddle = PAGES.filter((page) => page.key !== "p1");
    expect(historyAnchorIsLive(withoutMiddle, anchor)).toBe(false);
    // Null rather than a plausible-looking index: a caller can fall back to the
    // newest rows instead of parking on content that is no longer loaded.
    expect(globalItemForHistoryAnchor(withoutMiddle, anchor)).toBeNull();
  });
});
