import { describe, expect, test } from "bun:test";
import type { MouseReport } from "@/cli/helpers/mouse-sequence";
import { CLICK_MAX_MS, createClickTracker } from "./chrome-click";

/**
 * Telling a click from a drag, which is the whole reason the strip can be
 * operated with the mouse at all.
 *
 * The cases are the shapes the terminal actually sends: a press and a release on
 * one cell, the same two with a column of travel between them (a drag), a slow
 * pair, a release with no press, and a drag that starts on a tab and ends in the
 * transcript.
 */

function report(overrides: Partial<MouseReport> = {}): MouseReport {
  return {
    kind: "press",
    button: "left",
    column: 4,
    row: 1,
    modifiers: { shift: false, alt: false, ctrl: false },
    ...overrides,
  };
}

describe("a chrome click", () => {
  test("a press and release on the same cell is a click", () => {
    const tracker = createClickTracker();
    tracker.press(report(), 1_000);
    expect(tracker.release(report({ kind: "release" }), 1_120)).toEqual({
      row: 1,
      column: 4,
    });
    expect(tracker.isPending()).toBe(false);
  });

  test("travel between press and release is a drag", () => {
    const tracker = createClickTracker();
    tracker.press(report(), 1_000);
    expect(
      tracker.release(report({ kind: "release", column: 9 }), 1_050),
    ).toBeNull();
  });

  test("motion cancels the candidate outright", () => {
    const tracker = createClickTracker();
    tracker.press(report(), 1_000);
    tracker.cancel();
    expect(tracker.release(report({ kind: "release" }), 1_050)).toBeNull();
    expect(tracker.isPending()).toBe(false);
  });

  test("a press held longer than the window is not a click", () => {
    const tracker = createClickTracker();
    tracker.press(report(), 1_000);
    expect(
      tracker.release(report({ kind: "release" }), 1_000 + CLICK_MAX_MS + 1),
    ).toBeNull();
    // Exactly at the boundary still counts.
    const atBoundary = createClickTracker();
    atBoundary.press(report(), 0);
    expect(
      atBoundary.release(report({ kind: "release" }), CLICK_MAX_MS),
    ).toEqual({ row: 1, column: 4 });
  });

  test("a release with no press resolves to nothing, and clears the candidate", () => {
    const tracker = createClickTracker();
    expect(tracker.release(report({ kind: "release" }), 5)).toBeNull();

    tracker.press(report(), 1_000);
    // A double click is two clicks, not one click carrying over.
    expect(tracker.release(report({ kind: "release" }), 1_010)).not.toBeNull();
    expect(tracker.release(report({ kind: "release" }), 1_020)).toBeNull();
  });

  test("only the left button starts a candidate", () => {
    const tracker = createClickTracker();
    tracker.press(report({ button: "right" }), 1_000);
    expect(tracker.isPending()).toBe(false);
    expect(tracker.release(report({ kind: "release" }), 1_020)).toBeNull();
  });
});
