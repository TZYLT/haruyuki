import { describe, expect, test } from "bun:test";
import {
  findCursorLine,
  getCaretCell,
  getVisualLines,
  renderCaretRows,
  wrapDisplayRows,
} from "@/cli/helpers/text-layout";

/**
 * The composer's layout math, pinned as numbers.
 *
 * Two things are load-bearing here and both are invisible in a rendered frame:
 *
 * - **Rows are measured in display columns.** A row that holds two CJK characters
 *   holds four columns; counting *characters* made the composer believe a long
 *   Chinese draft fit in half the rows the terminal drew, so its height reservation
 *   and its caret were both off. The emoji cases cover the other family of
 *   double-width code points, including one that arrives as a surrogate pair (an
 *   index into JS strings that a per-code-unit walk would cut in half).
 * - **The caret's cell is a boundary case machine.** A caret sits at an index, and
 *   the same index is the end of one row and the start of the next at a soft wrap;
 *   the visible result differs, so which row it belongs to has to be decided rather
 *   than left to whichever comparison runs first.
 */

const CJK = "\u4e2d"; // 中 — two columns
const EMOJI = "\u{1f600}"; // 😀 — two columns, two code units

describe("getVisualLines", () => {
  test("soft-wraps ASCII at the width", () => {
    const lines = getVisualLines("abcdef", 4);
    expect(lines).toEqual([
      { start: 0, end: 4 },
      { start: 4, end: 6 },
    ]);
  });

  test("counts CJK as two columns", () => {
    // Four characters, four columns of budget: two per row, not four.
    const lines = getVisualLines(CJK.repeat(4), 4);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({ start: 0, end: 2 });
    expect(lines[1]).toEqual({ start: 2, end: 4 });
  });

  test("counts an emoji as one glyph of two columns", () => {
    const text = EMOJI.repeat(3);
    const lines = getVisualLines(text, 4);
    expect(lines.map((line) => text.slice(line.start, line.end))).toEqual([
      EMOJI.repeat(2),
      EMOJI,
    ]);
    // A surrogate pair is never split across rows: two emoji are four code units.
    expect(lines[0]?.end).toBe(4);
  });

  test("mixes widths inside one row", () => {
    // "中a中" is 2 + 1 + 2 columns; at width 5 it is one row, at 4 it is two.
    expect(getVisualLines("中a中", 5)).toEqual([{ start: 0, end: 3 }]);
    expect(getVisualLines("中a中", 4)).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 3 },
    ]);
  });

  test("hard breaks keep their own rows, blank ones included", () => {
    const text = "ab\n\ncd";
    expect(getVisualLines(text, 80)).toEqual([
      { start: 0, end: 2 },
      { start: 3, end: 3 },
      { start: 4, end: 6 },
    ]);
    expect(wrapDisplayRows(text, 80)).toEqual(["ab", "", "cd"]);
  });

  test("an empty draft still has one row to put a caret on", () => {
    expect(getVisualLines("", 80)).toEqual([{ start: 0, end: 0 }]);
    expect(getVisualLines("ab\n", 80)).toEqual([
      { start: 0, end: 2 },
      { start: 3, end: 3 },
    ]);
  });

  test("a character wider than the width still gets a row of its own", () => {
    // Width 1 cannot hold a two-column character. It takes the row anyway: the
    // alternative is a loop that never advances.
    const lines = getVisualLines(CJK.repeat(3), 1);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toEqual({ start: 1, end: 2 });
  });

  test("no width means no soft wrapping", () => {
    expect(getVisualLines("abcdef", 0)).toEqual([{ start: 0, end: 6 }]);
  });
});

describe("getCaretCell", () => {
  test("starts at the first cell of the first row", () => {
    expect(getCaretCell("abc", 0, 10)).toEqual({ lineIndex: 0, column: 0 });
  });

  test("counts CJK columns, not characters", () => {
    // Two characters before the caret, four columns.
    expect(getCaretCell("中文abc", 2, 20)).toEqual({
      lineIndex: 0,
      column: 4,
    });
    // And the cell right after a wide character is two columns past it.
    expect(getCaretCell("a中", 2, 20)).toEqual({ lineIndex: 0, column: 3 });
  });

  test("a soft wrap puts the caret on the next row's first column", () => {
    // Offset 2 is `lines[0].end` *and* `lines[1].start`; the character drawn there
    // is the second row's first one.
    expect(getCaretCell("abcd", 2, 2)).toEqual({ lineIndex: 1, column: 0 });
  });

  test("a hard break keeps the caret at the end of its own row", () => {
    expect(getCaretCell("ab\ncd", 2, 80)).toEqual({ lineIndex: 0, column: 2 });
    // …and just past the newline it is the next row's first cell.
    expect(getCaretCell("ab\ncd", 3, 80)).toEqual({ lineIndex: 1, column: 0 });
  });

  test("the end of a full row moves to the row below", () => {
    // Nothing can be drawn at column `width`; the caret (an inverse space) wraps.
    expect(getCaretCell("abcd", 4, 4)).toEqual({ lineIndex: 1, column: 0 });
    // At the end of a row that is not full it stays put.
    expect(getCaretCell("abc", 3, 4)).toEqual({ lineIndex: 0, column: 3 });
  });

  test("an empty draft puts the caret on the origin", () => {
    expect(getCaretCell("", 0, 10)).toEqual({ lineIndex: 0, column: 0 });
  });

  test("clamps a caret past the end of the draft", () => {
    expect(getCaretCell("ab", 99, 10)).toEqual({ lineIndex: 0, column: 2 });
  });
});

describe("renderCaretRows", () => {
  const paint = (text: string, caretOffset: number, width: number) => {
    const rows = wrapDisplayRows(text, width);
    return renderCaretRows(
      rows,
      getCaretCell(text, caretOffset, width),
      (value) => `[${value}]`,
    );
  };

  test("paints the character under the caret", () => {
    expect(paint("abc", 1, 10)).toBe("a[b]c");
  });

  test("paints a space when the caret is past the last character", () => {
    expect(paint("abc", 3, 10)).toBe("abc[ ]");
  });

  test("paints on the wrapped row the caret belongs to", () => {
    expect(paint("abcd", 2, 2)).toBe("ab\n[c]d");
    // The row is full, so the trailing caret gets a row of its own.
    expect(paint("abcd", 4, 2)).toBe("ab\ncd\n[ ]");
  });

  test("paints a wide character as a whole cell", () => {
    const rows = wrapDisplayRows("中文中", 4);
    const painted = renderCaretRows(
      rows,
      getCaretCell("中文中", 2, 4),
      (value) => `[${value}]`,
    );
    expect(painted).toBe("中文\n[中]");
  });

  test("paints the caret on a blank row of its own", () => {
    expect(paint("ab\n\ncd", 3, 80)).toBe("ab\n[ ]\ncd");
  });
});

describe("findCursorLine", () => {
  test("reports a character column, which is what up/down arithmetic needs", () => {
    const lines = getVisualLines("abcd", 2);
    // Offset 2 is on the *first* line by that rule (upper bound inclusive) — the
    // up/down navigation adds the column to `line.start`, so this is the number it
    // needs, and it is not the display cell `getCaretCell` reports for the same
    // index. Keeping the two functions distinct is deliberate.
    expect(findCursorLine(2, lines)).toEqual({ lineIndex: 0, column: 2 });
    expect(findCursorLine(3, lines)).toEqual({ lineIndex: 1, column: 1 });
  });
});
