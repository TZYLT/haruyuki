// src/cli/helpers/mouse-click.ts

import type { MouseReport } from "@/cli/helpers/mouse-sequence";

/**
 * What counts as a click, told apart from a drag.
 *
 * The mouse reports this app receives describe a *stream*: a press, then motion
 * while the button is held, then a release. A terminal has no click event, and the
 * selection layer already reads the same stream as a drag — so the rule that
 * separates them has to be one place. It lives here rather than next to the tab
 * strip because two surfaces now aim with it: the shell's chrome rows and a
 * surface's own rows (the slash popup, a page, a face — 《38》§19.2), and both must
 * answer "was this a click?" the same way.
 *
 * - **The release lands on the same target, give or take a cell.** `CLICK_SLOP_*`
 *   is the tolerance: a hand click is not a coordinate, and the terminal reports
 *   the pointer in cells while the user aims with pixels.
 * - **Within `CLICK_MAX_MS`.** A slow press-and-release is a press the user
 *   changed their mind about; firing a tab switch on it would make the strip feel
 *   haunted.
 *
 * **Motion does not cancel a click.** The first version of this rule threw the
 * candidate away on any motion report, and that is a defect no synthetic test can
 * see: under `1002` a terminal reports motion *while the button is held*,
 * including motion that stays inside one cell, so a real click arrives as
 * press → move → release and was discarded every time. The reported machine
 * behaviour (2026-10-20 实机: the tab row ignoring every click while the wheel and
 * the drag both worked) is exactly this; motion is now a fact to remember, and the
 * release decides.
 *
 * **The release may arrive without a button.** SGR releases normally repeat the
 * button code, but a terminal that reports the release with the button cleared (the
 * X10 convention, code `3`) is still saying "the button came up": requiring
 * `left` on the release threw those clicks away. Only the press starts a
 * candidate, and that one must be the left button.
 *
 * A drag that *ends* away from where it started is not a click — that is what
 * keeps a drag beginning on the strip from switching anything, and the answer is
 * the press cell, not the release cell: what the user aimed at is the tab they
 * pressed.
 *
 * The clock is a parameter rather than `Date.now()` inside, so the window is
 * testable without sleeping.
 */

/** How long a press may last and still count as a click. */
export const CLICK_MAX_MS = 300;

/** Columns the pointer may move between press and release and still be a click. */
export const CLICK_SLOP_COLUMNS = 2;

/** Rows the pointer may move between press and release and still be a click. */
export const CLICK_SLOP_ROWS = 1;

export type ClickPoint = {
  /** 1-based screen row. */
  row: number;
  /** 1-based screen column. */
  column: number;
};

export type ClickTracker = {
  /** Remember a press. A press while one is pending replaces it. */
  press(report: MouseReport, at: number): void;
  /** Motion while a candidate is pending: remembered, never fatal. */
  move(report: MouseReport): void;
  /**
   * Resolve a release. Returns the cell the user pressed when this was a click,
   * and `null` otherwise — including for a release with no press, which is what a
   * drag that began before this layer was listening looks like.
   */
  release(report: MouseReport, at: number): ClickPoint | null;
  /** Whether a press is waiting for its release. */
  isPending(): boolean;
};

/** Whether a release point is close enough to the press to be one gesture. */
function withinSlop(press: ClickPoint, release: MouseReport): boolean {
  return (
    Math.abs(press.row - release.row) <= CLICK_SLOP_ROWS &&
    Math.abs(press.column - release.column) <= CLICK_SLOP_COLUMNS
  );
}

export function createClickTracker(): ClickTracker {
  let pending: (ClickPoint & { at: number }) | null = null;

  return {
    press(report, at) {
      if (report.button !== "left") {
        pending = null;
        return;
      }
      pending = { row: report.row, column: report.column, at };
    },
    move() {
      // Deliberately nothing: the press cell is what a click resolves to, and the
      // release is compared against it. Recording the motion would only tempt the
      // next reader into using it.
    },
    release(report, at) {
      const candidate = pending;
      pending = null;
      if (!candidate) return null;
      // `none` is the release that arrived with its button code cleared; the `m`
      // final already told us this is a release.
      if (report.button !== "left" && report.button !== "none") return null;
      if (!withinSlop(candidate, report)) return null;
      if (at - candidate.at > CLICK_MAX_MS) return null;
      return { row: candidate.row, column: candidate.column };
    },
    isPending() {
      return pending !== null;
    },
  };
}
