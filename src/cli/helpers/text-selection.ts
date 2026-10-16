import { scanAnsi } from "./ansi-scan";
import type { TerminalFrame } from "./terminal-frame";
import { inkStringWidth } from "./text-metrics";

/**
 * What a drag selects, and how it is read back.
 *
 * The contract (from the interaction design) is that the selection unit is a
 * **rendered text line**, not a transcript item: what the user drags over is what
 * gets copied. That makes the whole model screen coordinates — a row and a
 * column — which is also what a mouse report carries.
 *
 * Three decisions worth stating, because each is visible in the result:
 *
 * 1. **Flow, not rectangle.** A selection from the middle of one row to the
 *    middle of another copies the whole of every row between them, like every
 *    terminal's own selection. A rectangular selection is only useful for
 *    spreadsheets.
 * 2. **Wide characters snap outward.** A drag that ends inside a two-column
 *    character takes the whole character: half a character cannot be copied, and
 *    counting it as half a column is how a selection drifts out of line with what
 *    was dragged over.
 * 3. **Trailing blanks are dropped per row.** Rows are padded or simply not
 *    written, so keeping the padding would paste a ragged block of spaces.
 */

/** A point in screen coordinates, both 1-based. */
export interface FramePoint {
  row: number;
  column: number;
}

export interface FrameSelection {
  /** Where the drag started. */
  anchor: FramePoint;
  /** Where the pointer is now. */
  head: FramePoint;
}

/** The selection ordered so `start` is above-left of `end`. */
export function orderSelection(selection: FrameSelection): {
  start: FramePoint;
  end: FramePoint;
} {
  const { anchor, head } = selection;
  const before =
    anchor.row < head.row ||
    (anchor.row === head.row && anchor.column <= head.column);
  return before ? { start: anchor, end: head } : { start: head, end: anchor };
}

/**
 * The columns a row contributes to the selection, or `null` when the row is not
 * part of it.
 *
 * `width` is the row's display width, not its string length: a row the selection
 * runs through contributes all of it.
 */
export function rowSelectionSpan(
  selection: FrameSelection,
  row: number,
  width: number,
): { from: number; to: number } | null {
  const { start, end } = orderSelection(selection);
  if (row < start.row || row > end.row) return null;
  if (width <= 0) return null;

  const from = Math.max(1, row === start.row ? start.column : 1);
  const to = Math.min(width, row === end.row ? end.column : width);
  if (to < from) return null;
  return { from, to };
}

/**
 * The characters of `text` whose columns intersect `[from, to]`, inclusive.
 *
 * A zero-width character (a combining mark) rides with the character it belongs
 * to, which is why it inherits the previous decision instead of being measured.
 */
export function sliceByColumns(text: string, from: number, to: number): string {
  let column = 1;
  let inside = false;
  let slice = "";

  for (const char of text) {
    const width = inkStringWidth(char);
    const included: boolean =
      width === 0 ? inside : column + width - 1 >= from && column <= to;
    if (included) slice += char;
    inside = included;
    if (width > 0) column += width;
    if (column > to) break;
  }

  return slice;
}

/**
 * The text the selection covers, one line per row.
 *
 * Rows past the end of the frame are dropped rather than filled with blanks: a
 * selection that outlives a shrinking transcript should copy what is there.
 */
export function selectionText(
  frame: TerminalFrame | null,
  selection: FrameSelection | null,
): string {
  if (!frame || !selection) return "";
  const { start, end } = orderSelection(selection);
  const lines: string[] = [];

  for (
    let row = Math.max(1, start.row);
    row <= Math.min(end.row, frame.text.length);
    row += 1
  ) {
    const text = frame.text[row - 1] ?? "";
    const span = rowSelectionSpan(selection, row, inkStringWidth(text));
    if (!span) {
      lines.push("");
      continue;
    }
    lines.push(sliceByColumns(text, span.from, span.to).trimEnd());
  }

  return lines.join("\n");
}

const INVERSE_ON = "\u001B[7m";
const INVERSE_OFF = "\u001B[27m";

/**
 * The row's bytes with `[from, to]` wrapped in inverse video.
 *
 * The bytes are spliced rather than re-rendered: writing a plain copy of the row
 * would drop the colours its text carries, which is most of what makes a diff or
 * a highlighted code block readable. Escape sequences take no columns, so the
 * counter only advances on characters — and they are copied whole, through the
 * same scanner the frame was read with.
 *
 * `changed` is false when the span lies past the row's content: there is nothing
 * to mark, and the caller can skip the repaint entirely.
 */
export function highlightRow(
  line: string,
  from: number,
  to: number,
): { line: string; changed: boolean } {
  if (to < from || from < 1) return { line, changed: false };

  let spliced = "";
  let column = 1;
  let open = false;
  let changed = false;

  const close = () => {
    if (!open) return;
    spliced += INVERSE_OFF;
    open = false;
  };

  for (const token of scanAnsi(line)) {
    if (token.kind === "escape") {
      // Close before the row's own styling continues, so the highlight ends at
      // the boundary the user dragged over and never bleeds into a style change.
      if (column > to) close();
      spliced += token.value;
      continue;
    }
    if (token.kind === "control") continue;

    for (const char of token.value) {
      const width = inkStringWidth(char);
      if (width === 0) {
        // A combining mark belongs to the character before it.
        spliced += char;
        continue;
      }
      if (column > to) {
        close();
        spliced += char;
        column += width;
        continue;
      }
      if (!open && column >= from) {
        spliced += INVERSE_ON;
        open = true;
        changed = true;
      }
      spliced += char;
      column += width;
    }
  }

  close();
  return { line: spliced, changed };
}
