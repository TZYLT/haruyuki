/**
 * Wrapping for the surfaces that must keep a fixed frame height (F-06 §5.7.4).
 *
 * Two width systems disagree in this tree (`char-width.ts`): `terminalTextWidth`
 * asks what the terminal *draws* (ambiguous characters may be one or two
 * columns), `inkStringWidth` asks what Ink *thinks* it drew. A wrapper that
 * trusts only one of them is wrong on the other: measure by Ink and a wide
 * ambiguous terminal wraps the line again at paint time (the frame grows by a
 * row the layout never reserved); measure by the terminal and Ink's own word
 * wrap can disagree about a continuation row. C-32's ruling is to take the
 * **larger** of the two per string, which is what `wrappedCellWidth` does — the
 * row then fits whichever renderer is right.
 *
 * **ANSI is an atom, not text.** A stored message can carry colour sequences
 * (pasted output, a tool return that printed escapes). Escape bytes draw no
 * columns, so measuring them as text makes every coloured word look wider than
 * it is, and splitting a word by grapheme can land in the middle of
 * `ESC[31m` — half a sequence printed to the terminal leaks colour or eats the
 * bytes after it. So the wrapper tokenizes with `ansi-scan`: every escape
 * sequence is a zero-width unit that is never split, and widths are measured on
 * the visible bytes only.
 *
 * Everything here is pure and width-parameterised so the detail view, and its
 * tests, can lay out lines without rendering them.
 */

import stripAnsi from "strip-ansi";
import { scanAnsi } from "./ansi-scan";
import { terminalTextWidth } from "./char-width";
import { inkStringWidth } from "./text-metrics";

/**
 * Columns a string occupies for wrapping: the larger of the terminal's answer
 * and Ink's (C-32). Never negative. ANSI is stripped first: it occupies no
 * column on either side, and counting its bytes is how a coloured word used to
 * be wrapped early.
 */
export function wrappedCellWidth(text: string): number {
  return Math.max(terminalTextWidth(text), inkStringWidth(stripAnsi(text)));
}

/**
 * Split into grapheme clusters, so a wrap never severs an emoji sequence
 * (`👨‍👩‍👧` is one glyph across several code points) or a combining mark from
 * the character it modifies. A code-point split would lay out half an emoji on
 * one row and half on the next; the terminal then draws a broken cluster whose
 * width guesses disagree with both width systems.
 */
const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (part) => part.segment);
}

/** One indivisible piece of a row: a cluster, one column of space, or an escape. */
interface WrapUnit {
  text: string;
  width: number;
}

/**
 * Tokenize one hard-break-free segment into wrap units.
 *
 * Escape sequences stay whole and weigh zero; text becomes grapheme clusters;
 * control characters are kept (they still affect what the terminal does) and
 * measured the same way the old wrapper did.
 */
function unitsOf(segment: string): WrapUnit[] {
  const units: WrapUnit[] = [];
  for (const token of scanAnsi(segment)) {
    if (token.kind === "escape") {
      units.push({ text: token.value, width: 0 });
      continue;
    }
    if (token.kind === "control") {
      units.push({ text: token.value, width: wrappedCellWidth(token.value) });
      continue;
    }
    for (const cluster of graphemes(token.value)) {
      units.push({ text: cluster, width: wrappedCellWidth(cluster) });
    }
  }
  return units;
}

/** A row's text; trailing spaces paint nothing, so they are not kept. */
function rowText(units: readonly WrapUnit[]): string {
  let end = units.length;
  while (end > 0 && units[end - 1]?.text === " ") end -= 1;
  return units
    .slice(0, end)
    .map((unit) => unit.text)
    .join("");
}

function widthOf(units: readonly WrapUnit[]): number {
  let width = 0;
  for (const unit of units) width += unit.width;
  return width;
}

/** Greedy wrap of one segment's units, breaking on spaces where possible. */
function wrapUnits(units: readonly WrapUnit[], width: number): string[] {
  const rows: string[] = [];
  let row: WrapUnit[] = [];
  let rowWidth = 0;
  // Index in `row` of the last space: the preferred break point.
  let spaceAt = -1;

  const startRow = (next: readonly WrapUnit[]): void => {
    row = [...next];
    rowWidth = widthOf(next);
    spaceAt = -1;
    for (let index = 0; index < row.length; index += 1) {
      if (row[index]?.text === " ") spaceAt = index;
    }
  };

  const flush = (cut: number | null): void => {
    const emitted = cut === null ? row : row.slice(0, cut);
    // A leading space is dropped rather than emitting a blank row.
    if (emitted.length > 0) rows.push(rowText(emitted));
    startRow(cut === null ? [] : row.slice(cut + 1));
  };

  for (const unit of units) {
    const isSpace = unit.text === " " && unit.width === 1;
    const hasVisible = row.some((entry) => entry.width > 0);
    if (hasVisible && unit.width > 0 && rowWidth + unit.width > width) {
      if (isSpace) {
        // The space itself is the break: it is dropped, not wrapped.
        flush(null);
        continue;
      }
      if (spaceAt > 0) flush(spaceAt);
      else flush(null);
    }
    row.push(unit);
    rowWidth += unit.width;
    if (isSpace) spaceAt = row.length - 1;
  }

  if (row.length > 0) rows.push(rowText(row));
  return rows.length > 0 ? rows : [""];
}

/**
 * Wrap `text` to `width` columns.
 *
 * `\n` is a hard break (a detail's code block keeps its own shape); every
 * returned row is at most `width` columns under both width systems, and an
 * escape sequence is never split across rows. Empty input is one empty row,
 * not zero: a blank line still occupies a frame row.
 */
export function wrapRows(text: string, width: number): string[] {
  const usable = Math.max(1, Math.trunc(width));
  const rows: string[] = [];
  for (const segment of text.split("\n")) {
    rows.push(...wrapUnits(unitsOf(segment), usable));
  }
  return rows;
}

/**
 * Wrap `text` and paint `prefix` on every physical row.
 *
 * Used for an indented detail body: the prefix costs columns on the *first*
 * row too, so the content budget is what is left after it. The prefix itself is
 * never wrapped; a caller whose prefix is wider than the row gets a degenerate
 * one-column budget rather than an unbounded line.
 */
export function wrapRowsWithPrefix(
  prefix: string,
  text: string,
  width: number,
): string[] {
  const usable = Math.max(1, Math.trunc(width));
  const budget = Math.max(1, usable - wrappedCellWidth(prefix));
  return wrapRows(text, budget).map((row) => `${prefix}${row}`);
}
