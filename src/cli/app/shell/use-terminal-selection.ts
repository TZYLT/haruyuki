import { useEffect } from "react";
import { getViewportRows } from "@/cli/app/viewport-scroll";
import {
  beginSelection,
  clearSelection,
  extendSelection,
  getSelection,
  subscribeToSelection,
} from "@/cli/app/viewport-selection";
import { registerMouseHandler } from "@/cli/helpers/mouse-router";
import {
  getTerminalFrame,
  getTerminalFrameVersion,
  isCapturingTerminalFrame,
  subscribeToTerminalFrame,
  writeToTerminal,
} from "@/cli/helpers/terminal-frame";
import {
  highlightRow,
  orderSelection,
  rowSelectionSpan,
} from "@/cli/helpers/text-selection";

/**
 * Drag selection over the rendered transcript, and its highlight.
 *
 * The design decision this file carries out: the selection is judged against the
 * bytes Ink actually wrote (`terminal-frame.ts`) rather than against a second
 * renderer of the transcript. That is what makes what is selected exactly what
 * the user dragged over — diffs, boxes and highlighted code included — and it is
 * why the highlight can be painted by splicing two escape sequences into the
 * row's own bytes instead of re-rendering it.
 *
 * Four consequences worth knowing before changing anything here:
 *
 * 1. **The highlight is a terminal write, never React state.** A drag calls
 *    `writeToTerminal` directly; nothing re-renders, so a drag cannot cause the
 *    flicker the TUI guidance puts a red line around.
 * 2. **A frame erases the highlight.** Ink rewrites the frame (and on Windows in
 *    the alternate screen, clears it), so the painter repaints after every frame:
 *    it subscribes to the frame store, which is notified from inside the write
 *    that carried the frame.
 * 3. **An unanchored frame is refused.** When the capture cannot prove which
 *    screen rows a frame occupies, no highlight is painted and nothing is
 *    selectable — a wrong highlight over the wrong text is worse than none.
 * 4. **The capture is installed by the process entry**, not here
 *    (`full-screen-terminal.ts`): Ink writes its first frame inside `render()`,
 *    before any React effect runs, so a capture installed in an effect would miss
 *    the frame that is already on screen.
 *
 * Selection rows are clamped to the transcript band, whose rows are 1..n by
 * construction: the full-screen shell renders the transcript region first, so the
 * band is the top of the frame (`getViewportRows`).
 */

const CURSOR_TO_LINE_START = (row: number) => `\u001B[${row};1H`;
const ERASE_TO_END = "\u001B[K";

/**
 * Rows the painter has marked, and which frame that marking belongs to. Module
 * state, like the selection itself: one shell is mounted at a time.
 */
let painted = new Map<number, string>();
let paintedFrame = -1;

function paintSelection(): void {
  const frame = getTerminalFrame();
  if (!isCapturingTerminalFrame() || !frame || !frame.anchored) {
    // Nothing can be located (or nothing is being captured): leave the screen
    // alone rather than paint rows we cannot place.
    painted.clear();
    paintedFrame = -1;
    return;
  }

  const frameVersion = getTerminalFrameVersion();
  if (frameVersion !== paintedFrame) {
    // A new frame repainted every row, so the old marks are gone with it.
    painted.clear();
    paintedFrame = frameVersion;
  }

  const selection = getSelection();
  const target = new Map<number, string>();
  if (selection) {
    const { start, end } = orderSelection(selection);
    const lastRow = Math.min(end.row, frame.lines.length);
    for (let row = Math.max(1, start.row); row <= lastRow; row += 1) {
      const span = rowSelectionSpan(selection, row, frame.widths[row - 1] ?? 0);
      if (!span) continue;
      const marked = highlightRow(
        frame.lines[row - 1] ?? "",
        span.from,
        span.to,
      );
      if (marked.changed) target.set(row, marked.line);
    }
  }

  let out = "";
  // Rows that were marked and no longer are: put the row's own bytes back.
  for (const [row] of painted) {
    if (target.has(row)) continue;
    const plain = frame.lines[row - 1];
    if (plain === undefined) continue;
    out += CURSOR_TO_LINE_START(row) + plain + ERASE_TO_END;
  }
  for (const [row, bytes] of target) {
    if (painted.get(row) === bytes) continue;
    out += CURSOR_TO_LINE_START(row) + bytes + ERASE_TO_END;
  }

  painted = target;
  if (out.length > 0) writeToTerminal(out);
}

function isInsideBand(row: number): boolean {
  return row >= 1 && row <= getViewportRows();
}

function clampedToBand(
  row: number,
  column: number,
): {
  row: number;
  column: number;
} {
  const rows = Math.max(1, getViewportRows());
  return {
    row: Math.min(Math.max(1, row), rows),
    column: Math.max(1, column),
  };
}

export function useTerminalSelection(): void {
  useEffect(() => {
    const repaint = () => paintSelection();
    const unsubscribeFrame = subscribeToTerminalFrame(repaint);
    const unsubscribeSelection = subscribeToSelection(repaint);
    // A frame may already have been drawn before this effect ran.
    repaint();
    return () => {
      unsubscribeFrame();
      unsubscribeSelection();
      painted.clear();
      paintedFrame = -1;
    };
  }, []);

  useEffect(() => {
    return registerMouseHandler((report) => {
      // The wheel belongs to the scroll layer, which runs before this one.
      if (report.wheel) return false;
      if (report.kind === "press") {
        if (report.button !== "left") return false;
        if (!isInsideBand(report.row)) {
          // A click outside the transcript (the input, the status line) ends the
          // selection, the way clicking away from a selection does anywhere else.
          clearSelection();
          return true;
        }
        beginSelection({ row: report.row, column: Math.max(1, report.column) });
        return true;
      }
      if (report.kind === "move") {
        // `1002` reports motion only while a button is held, so a move is a drag.
        extendSelection(clampedToBand(report.row, report.column));
        return true;
      }
      // A release keeps what was dragged: copying is a key of its own, so a stray
      // drag never overwrites the clipboard on its own.
      return true;
    });
  }, []);
}
