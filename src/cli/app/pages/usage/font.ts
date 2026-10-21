/**
 * The 3×5 block font the Usage overview's hero numbers are drawn with
 * (docs/38 §14.6 fixes the table; this file is the implementation of it).
 *
 * Why a hand-written bitmap instead of a library: the glyphs are part of the
 * design contract, they are five rows tall by three columns wide, and every
 * candidate library brings a different grid. A table this small is also the one
 * thing that can be reviewed by eye against the spec.
 *
 * Glyph widths are **not** uniform: `M` is five columns because three columns
 * cannot distinguish it from `A`, and `.` is one column. `blockText` therefore
 * stacks each glyph at its own width and separates them with one space — the
 * spec's `339.4M` is 23 columns and `HARUYUKI` is 31, both of which the tests
 * pin.
 */

export const BLOCK_FONT_HEIGHT = 5;

/** Rows are top to bottom; every row of one glyph has the same width. */
export type BlockGlyph = readonly string[];

const DIGITS: Record<string, BlockGlyph> = {
  "0": ["███", "█ █", "█ █", "█ █", "███"],
  "1": [" █ ", "██ ", " █ ", " █ ", "███"],
  "2": ["███", "  █", "███", "█  ", "███"],
  "3": ["███", "  █", "███", "  █", "███"],
  "4": ["█ █", "█ █", "███", "  █", "  █"],
  "5": ["███", "█  ", "███", "  █", "███"],
  "6": ["███", "█  ", "███", "█ █", "███"],
  "7": ["███", "  █", "  █", "  █", "  █"],
  "8": ["███", "█ █", "███", "█ █", "███"],
  "9": ["███", "█ █", "███", "  █", "███"],
};

const LETTERS: Record<string, BlockGlyph> = {
  A: ["███", "█ █", "███", "█ █", "█ █"],
  H: ["█ █", "█ █", "███", "█ █", "█ █"],
  I: ["███", " █ ", " █ ", " █ ", "███"],
  K: ["█ █", "██ ", "█  ", "██ ", "█ █"],
  M: ["█   █", "██ ██", "█ █ █", "█   █", "█   █"],
  R: ["███", "█ █", "██ ", "█ █", "█ █"],
  U: ["█ █", "█ █", "█ █", "█ █", "███"],
  Y: ["█ █", "█ █", " █ ", " █ ", " █ "],
  // `formatCompact` writes thousands as a lowercase `k`.
  k: ["█  ", "█ █", "██ ", "█ █", "█ █"],
};

const PUNCTUATION: Record<string, BlockGlyph> = {
  ".": [" ", " ", " ", " ", "█"],
  " ": [" ", " ", " ", " ", " "],
  // Unknown characters must not shift the layout or throw: a box keeps the
  // hero's width predictable when a formatter starts emitting something new.
  "?": ["███", "  █", " █ ", "   ", " █ "],
};

/** Every glyph this font can draw, keyed by the character it represents. */
export function blockGlyph(character: string): BlockGlyph {
  return (
    DIGITS[character] ??
    LETTERS[character] ??
    PUNCTUATION[character] ??
    PUNCTUATION["?"]!
  );
}

export function blockGlyphWidth(character: string): number {
  return blockGlyph(character)[0]?.length ?? 0;
}

/**
 * Render `text` as block rows, one space between glyphs.
 *
 * Returns exactly five rows; an empty string returns five empty rows so callers
 * can keep a fixed line height without a special case.
 */
export function blockText(text: string, gap = 1): string[] {
  const separator = " ".repeat(gap);
  const characters = [...text];
  const rows: string[] = [];
  for (let row = 0; row < BLOCK_FONT_HEIGHT; row += 1) {
    const parts = characters.map(
      (character) => blockGlyph(character)[row] ?? "",
    );
    rows.push(parts.join(separator));
  }
  return rows;
}

/** Width of the rendered block text, in terminal columns. */
export function blockTextWidth(text: string, gap = 1): number {
  const characters = [...text];
  if (characters.length === 0) return 0;
  const glyphs = characters.reduce(
    (total, character) => total + blockGlyphWidth(character),
    0,
  );
  return glyphs + gap * (characters.length - 1);
}

/**
 * `HARUYUKI` in the same font — the overview's wordmark.
 *
 * Eight letters at three columns plus seven gaps = 31 columns, the width
 * docs/38 §14.6 specifies for the A tier.
 */
export function blockWordmark(): string[] {
  return blockText("HARUYUKI");
}
