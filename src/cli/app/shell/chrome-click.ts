// src/cli/app/shell/chrome-click.ts

import type { MouseReport } from "@/cli/helpers/mouse-sequence";

/**
 * What counts as a click, told apart from a drag.
 *
 * The mouse reports this app receives describe a *stream*: a press, then motion
 * while the button is held, then a release. A terminal has no click event, and the
 * selection layer already reads the same stream as a drag — so the rule that
 * separates them has to be one place, and it is here:
 *
 * - **The press and the release are on the same cell.** One column or one row of
 *   travel means the user was dragging, not clicking.
 * - **Within `CLICK_MAX_MS`.** A slow press-and-release is a press the user
 *   changed their mind about; firing a tab switch on it would make the strip feel
 *   haunted.
 *
 * Any motion between the two cancels the candidate outright, which is also what
 * keeps the two layers from fighting: a drag that started on the tab row belongs
 * to nobody (the strip is not selectable), and a drag that started in the band is
 * the selection's.
 *
 * The clock is a parameter rather than `Date.now()` inside, so the window is
 * testable without sleeping.
 */

/** How long a press may last and still count as a click. */
export const CLICK_MAX_MS = 300;

export type ClickPoint = {
  /** 1-based screen row. */
  row: number;
  /** 1-based screen column. */
  column: number;
};

export type ClickTracker = {
  /** Remember a press. A press while one is pending replaces it. */
  press(report: MouseReport, at: number): void;
  /** Motion: a candidate press is no longer a click. */
  cancel(): void;
  /**
   * Resolve a release. Returns the cell when this was a click, and `null`
   * otherwise — including for a release with no press, which is what a drag that
   * began before this layer was listening looks like.
   */
  release(report: MouseReport, at: number): ClickPoint | null;
  /** Whether a press is waiting for its release. */
  isPending(): boolean;
};

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
    cancel() {
      pending = null;
    },
    release(report, at) {
      const candidate = pending;
      pending = null;
      if (!candidate) return null;
      if (report.button !== "left") return null;
      if (candidate.row !== report.row || candidate.column !== report.column) {
        return null;
      }
      if (at - candidate.at > CLICK_MAX_MS) return null;
      return { row: candidate.row, column: candidate.column };
    },
    isPending() {
      return pending !== null;
    },
  };
}
