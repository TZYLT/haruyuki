// Text layout helpers for the composer input: visual-line wrapping, the caret's
// cell inside those lines, and display-string truncation. A visual line ends at a
// newline character (hard break) or when it reaches the layout width (soft wrap).

import { terminalTextWidth } from "@/cli/helpers/char-width";

/**
 * Represents a visual line segment in the text.
 * A visual line ends at either a newline character or when it reaches lineWidth.
 *
 * `start`/`end` are **string indexes** (UTF-16 code units), because they are used
 * to slice the draft. The *width* a line occupies is a different number: see
 * `getCaretCell` and `terminalTextWidth`.
 */
export interface VisualLine {
  start: number; // Start index in text
  end: number; // End index (exclusive, not including \n)
}

/**
 * Computes visual lines from text, accounting for both hard breaks (\n)
 * and soft wrapping at lineWidth.
 *
 * **The wrap is measured in display columns, not characters** (`terminalTextWidth`).
 * The composer renders its rows itself (`TextInput`) so that the inverse-video caret
 * and the terminal's real cursor can be placed on the same cell; a row counted in
 * characters would hold twice as much CJK as the terminal can draw, Ink would wrap
 * each of those rows again, and every row after the first wide character would be in
 * the wrong place. Measuring with `terminalTextWidth` is also what makes the number
 * agree with what the *terminal* draws, which `stringWidth` does not promise for the
 * ambiguous-width characters (`char-width.ts`).
 */
export function getVisualLines(text: string, lineWidth: number): VisualLine[] {
  const lines: VisualLine[] = [];
  let start = 0;
  let columns = 0;

  for (let index = 0; index < text.length; ) {
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    const next = index + character.length;

    if (character === "\n") {
      lines.push({ start, end: index });
      start = next;
      columns = 0;
      index = next;
      continue;
    }

    const width = terminalTextWidth(character);
    // Wrap *before* the character that would overflow the row, and never before the
    // first one: a character wider than the whole line still has to occupy a row,
    // or this loop would stop making progress.
    if (lineWidth > 0 && columns + width > lineWidth && index > start) {
      lines.push({ start, end: index });
      start = index;
      columns = 0;
    }
    columns += width;
    index = next;
  }

  lines.push({ start, end: text.length });
  return lines;
}

/** The display rows `text` occupies at `lineWidth`, as strings. */
export function wrapDisplayRows(text: string, lineWidth: number): string[] {
  return getVisualLines(text, lineWidth).map((line) =>
    text.slice(line.start, line.end),
  );
}

/**
 * Finds which visual line the cursor is on and the column within that line.
 *
 * `column` is a **character** offset inside the line, not a display column: callers
 * move the caret by adding it to `line.start` (up/down through a wrapped draft), and
 * a character offset is what that arithmetic needs. For the cell the terminal sees,
 * use `getCaretCell`.
 */
export function findCursorLine(
  cursorPos: number,
  visualLines: VisualLine[],
): { lineIndex: number; column: number } {
  for (let i = 0; i < visualLines.length; i++) {
    const line = visualLines[i];
    if (line && cursorPos >= line.start && cursorPos <= line.end) {
      return { lineIndex: i, column: cursorPos - line.start };
    }
  }
  // Fallback to last line
  const lastLine = visualLines[visualLines.length - 1];
  return {
    lineIndex: visualLines.length - 1,
    column: Math.max(0, cursorPos - (lastLine?.start ?? 0)),
  };
}

/** A zero-based cell: row within the wrapped text, display column within the row. */
export interface CaretCell {
  lineIndex: number;
  column: number;
}

/**
 * The cell the caret occupies once `text` is wrapped at `lineWidth`.
 *
 * This is the number the terminal cursor has to be placed at, so it is measured in
 * display columns and it accounts for the two boundary cases a naive "position minus
 * line start" gets wrong:
 *
 * - **A soft wrap puts two lines at the same index.** The caret at that index draws
 *   the *next* row's first character, so it belongs to the later line.
 * - **A caret at the end of a row that is exactly full has nowhere to sit.** Ink
 *   wraps the cell that follows it, so the caret is on the row below, in column 0 —
 *   which is also where `renderCaretRows` paints its trailing space.
 */
export function getCaretCell(
  text: string,
  caretOffset: number,
  lineWidth: number,
): CaretCell {
  const lines = getVisualLines(text, lineWidth);
  const offset = Math.max(0, Math.min(caretOffset, text.length));

  // The *last* line starting at or before the caret: on a soft wrap that is the row
  // whose first character is at the caret, and on a hard break the later line starts
  // after the newline, so the caret stays on the row it is drawn at.
  let lineIndex = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line && line.start <= offset) lineIndex = i;
  }

  const line = lines[lineIndex] ?? { start: 0, end: 0 };
  const column = terminalTextWidth(text.slice(line.start, offset));
  if (lineWidth > 0 && column >= lineWidth) {
    return { lineIndex: lineIndex + 1, column: 0 };
  }
  return { lineIndex, column };
}

/**
 * Paint an inverse-video caret into wrapped rows.
 *
 * The caret goes on the character occupying its cell — or on a space when the cell is
 * past the row's last character, which is an empty draft and the end of a row. The
 * trailing cell gets its own row for the case `getCaretCell` returns one past the last
 * row (a full last row), so a caret at the end of the text never wraps a character.
 *
 * `inverse` is caller-supplied so this stays free of the colour layer (chalk decides
 * its level at import time, and the renderer owns that decision).
 */
export function renderCaretRows(
  rows: string[],
  caret: CaretCell,
  inverse: (text: string) => string,
): string {
  const painted: string[] = [];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index] ?? "";
    if (index !== caret.lineIndex) {
      painted.push(row);
      continue;
    }

    let width = 0;
    let injected = false;
    let out = "";
    for (const character of row) {
      const atCaret = !injected && width >= caret.column;
      out += atCaret ? inverse(character) : character;
      if (atCaret) injected = true;
      width += terminalTextWidth(character);
    }
    if (!injected) out += inverse(" ");
    painted.push(out);
  }

  // A caret past the last row (the end of a row that is exactly full) needs a row of
  // its own; otherwise the row it painted is the last one already.
  if (caret.lineIndex >= rows.length) {
    painted.push(inverse(" "));
  }

  return painted.join("\n");
}

/** Truncate a display string to maxChars, appending "..." when truncated. */
export function truncateEnd(value: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (value.length <= maxChars) return value;
  if (maxChars <= 3) return value.slice(0, maxChars);
  return `${value.slice(0, maxChars - 3)}...`;
}
