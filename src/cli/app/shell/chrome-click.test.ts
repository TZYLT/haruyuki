import { describe, expect, test } from "bun:test";
import type { MouseReport } from "@/cli/helpers/mouse-sequence";
import {
  CLICK_MAX_MS,
  CLICK_SLOP_COLUMNS,
  createClickTracker,
} from "./chrome-click";

/**
 * Telling a click from a drag, which is the whole reason the strip can be
 * operated with the mouse at all.
 *
 * The cases are the shapes the terminal actually sends — not the shapes a
 * hand-written pair of reports sends. A terminal under `1002` describes a click as
 * press → **motion** → release, and the motion arrives even when it stays inside
 * the cell; that difference is what the machine found (the tab row ignoring every
 * click) after a synthetic test had passed, so it is pinned here.
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

  test("motion in the middle of the gesture does not cancel the click", () => {
    // Exactly what `1002` sends for a still click: the terminal reports motion
    // while the button is held, sometimes at the same cell.
    const tracker = createClickTracker();
    tracker.press(report(), 1_000);
    tracker.move(report({ kind: "move", column: 4 }));
    tracker.move(report({ kind: "move", column: 5 }));
    expect(
      tracker.release(report({ kind: "release", column: 5 }), 1_100),
    ).toEqual({
      row: 1,
      column: 4,
    });
  });

  test("a release within the slop still resolves to the cell that was pressed", () => {
    const tracker = createClickTracker();
    tracker.press(report({ column: 10, row: 1 }), 1_000);
    tracker.move(report({ kind: "move", column: 10 + CLICK_SLOP_COLUMNS }));
    // The press cell, not the release cell: what the user aimed at is the tab.
    expect(
      tracker.release(
        report({ kind: "release", column: 10 + CLICK_SLOP_COLUMNS }),
        1_100,
      ),
    ).toEqual({ row: 1, column: 10 });
  });

  test("travel past the slop between press and release is a drag", () => {
    const tracker = createClickTracker();
    tracker.press(report(), 1_000);
    tracker.move(report({ kind: "move", column: 20 }));
    expect(
      tracker.release(report({ kind: "release", column: 20 }), 1_050),
    ).toBeNull();
  });

  test("a release whose button code was cleared is still the end of the click", () => {
    // X10 reports a release as button `none` (code 3); requiring `left` on the
    // release threw every such click away.
    const tracker = createClickTracker();
    tracker.press(report(), 1_000);
    expect(
      tracker.release(report({ kind: "release", button: "none" }), 1_100),
    ).toEqual({ row: 1, column: 4 });
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
