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
 * Everything here is pure and width-parameterised so the detail view, and its
 * tests, can lay out lines without rendering them.
 */

import { terminalTextWidth } from "./char-width";
import { inkStringWidth } from "./text-metrics";

/**
 * Columns a string occupies for wrapping: the larger of the terminal's answer
 * and Ink's (C-32). Never negative.
 */
export function wrappedCellWidth(text: string): number {
  return Math.max(terminalTextWidth(text), inkStringWidth(text));
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

/** Hard-split one word that has no space to break on (CJK, URLs, hashes). */
function splitLongWord(word: string, width: number): string[] {
  const parts: string[] = [];
  let current = "";
  let currentWidth = 0;
  for (const cluster of graphemes(word)) {
    const clusterWidth = wrappedCellWidth(cluster);
    if (current !== "" && currentWidth + clusterWidth > width) {
      parts.push(current);
      current = "";
      currentWidth = 0;
    }
    current += cluster;
    currentWidth += clusterWidth;
  }
  if (current !== "") parts.push(current);
  return parts.length > 0 ? parts : [""];
}

/**
 * Greedy word wrap of one hard-break-free segment.
 *
 * Spaces stay inside a row (a sentence keeps its spaces) but are dropped at a
 * break, the way the transcript's own pre-wrap does; a word longer than the
 * width is hard-split by grapheme cluster, which is also how CJK breaks — it
 * has no spaces to wrap on.
 */
function wrapSegment(segment: string, width: number): string[] {
  if (segment === "") return [""];
  const words = segment.split(" ");
  const rows: string[] = [];
  let current = "";

  for (const word of words) {
    if (wrappedCellWidth(word) > width) {
      if (current !== "") {
        rows.push(current);
        current = "";
      }
      const parts = splitLongWord(word, width);
      rows.push(...parts.slice(0, -1));
      current = parts.at(-1) ?? "";
      continue;
    }

    if (current === "") {
      current = word;
    } else if (wrappedCellWidth(`${current} ${word}`) <= width) {
      current = `${current} ${word}`;
    } else {
      rows.push(current);
      current = word;
    }
  }
  if (current !== "") rows.push(current);
  return rows.length > 0 ? rows : [""];
}

/**
 * Wrap `text` to `width` columns.
 *
 * `\n` is a hard break (a detail's code block keeps its own shape); every
 * returned row is at most `width` columns under both width systems. Empty input
 * is one empty row, not zero: a blank line still occupies a frame row.
 */
export function wrapRows(text: string, width: number): string[] {
  const usable = Math.max(1, Math.trunc(width));
  const rows: string[] = [];
  for (const segment of text.split("\n")) {
    rows.push(...wrapSegment(segment, usable));
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
