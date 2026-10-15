import { afterEach, describe, expect, test } from "bun:test";
import {
  getViewportScrollRequest,
  getViewportScrollVersion,
  jumpTranscriptToNewest,
  reportViewportPosition,
  resetViewportScroll,
  scrollTranscriptBy,
  scrollTranscriptPage,
  setViewportRows,
  subscribeToViewportScroll,
} from "@/cli/app/viewport-scroll";
import { fitScrolledItemsFromEnd } from "@/cli/app/viewport-window";

afterEach(() => {
  resetViewportScroll();
});

describe("viewport scroll store", () => {
  test("follows the newest row until something moves it", () => {
    expect(getViewportScrollRequest()).toEqual({ kind: "rows", rows: 0 });
    const seen: number[] = [];
    subscribeToViewportScroll(() => seen.push(getViewportScrollVersion()));
    scrollTranscriptBy(3);
    expect(seen.length).toBe(1);
    expect(getViewportScrollRequest()).toEqual({ kind: "rows", rows: 3 });
  });

  test("a page is a screen minus the line at the seam", () => {
    setViewportRows(20);
    // Nothing rendered yet, so the relative move starts from 0.
    scrollTranscriptPage("up");
    expect(getViewportScrollRequest()).toEqual({ kind: "rows", rows: 19 });
    // The viewport reports what it showed; the next page is relative to that.
    reportViewportPosition({ rows: 19, anchor: { end: 5, delta: 4 } });
    scrollTranscriptPage("up");
    expect(getViewportScrollRequest()).toEqual({ kind: "rows", rows: 38 });
  });

  test("scrolling down past the newest row resumes following", () => {
    setViewportRows(20);
    scrollTranscriptPage("up");
    scrollTranscriptPage("down");
    expect(getViewportScrollRequest()).toEqual({ kind: "rows", rows: 0 });
  });

  test("reporting a position parks the view on content", () => {
    scrollTranscriptBy(10);
    reportViewportPosition({ rows: 10, anchor: { end: 4, delta: 2 } });
    expect(getViewportScrollRequest()).toEqual({
      kind: "anchor",
      anchor: { end: 4, delta: 2 },
    });
  });

  test("reporting following stays a rows request, so appends do not churn it", () => {
    const version = getViewportScrollVersion();
    reportViewportPosition({ rows: 0, anchor: { end: 9, delta: 0 } });
    reportViewportPosition({ rows: 0, anchor: { end: 12, delta: 0 } });
    expect(getViewportScrollRequest()).toEqual({ kind: "rows", rows: 0 });
    expect(getViewportScrollVersion()).toBe(version);
  });

  test("jumpTranscriptToNewest returns to following", () => {
    scrollTranscriptBy(10);
    reportViewportPosition({ rows: 10, anchor: { end: 4, delta: 2 } });
    jumpTranscriptToNewest();
    expect(getViewportScrollRequest()).toEqual({ kind: "rows", rows: 0 });
    // Idempotent: a second jump publishes nothing.
    const version = getViewportScrollVersion();
    jumpTranscriptToNewest();
    expect(getViewportScrollVersion()).toBe(version);
  });

  test("the anchor holds the same content while the transcript grows below", () => {
    const before = [10, 10, 10, 10, 10];
    const scrolled = fitScrolledItemsFromEnd(
      5,
      20,
      200,
      25,
      (index) => before[index] ?? 0,
    );
    expect({ start: scrolled.start, end: scrolled.end }).toEqual({
      start: 0,
      end: 3,
    });

    // The newest item grows by a screen and a half, as a streaming answer does.
    const after = [10, 10, 10, 10, 40];
    const anchored = fitScrolledItemsFromEnd(
      5,
      20,
      200,
      0,
      (index) => after[index] ?? 0,
      scrolled.anchor,
    );
    expect({ start: anchored.start, end: anchored.end }).toEqual({
      start: scrolled.start,
      end: scrolled.end,
    });

    // Without the anchor, the same row offset now shows later content: this is
    // the drift the anchor exists to prevent.
    const drifted = fitScrolledItemsFromEnd(
      5,
      20,
      200,
      scrolled.scrollFromBottom,
      (index) => after[index] ?? 0,
    );
    expect(drifted.start).toBeGreaterThan(scrolled.start);
  });
});
