/**
 * Transcript width/row measurement primitives.
 *
 * These used to live privately inside the transcript renderers (for example
 * `wordWrap` in the user-message component). The full-screen shell needs to
 * know how many terminal rows a transcript item occupies *without* rendering it,
 * so the wrap math and the markdown block walker have to be shared rather than
 * duplicated: a renderer and the row model that disagree about a line's width
 * would disagree about where the transcript starts and stops.
 *
 * Everything here is pure and width-parameterised so it can run outside React.
 */

import wrapAnsi from "wrap-ansi";

/**
 * Match Ink's `@alcalzone/ansi-tokenize/is-fullwidth-code-point` width
 * semantics. In particular U+26A0 WARNING SIGN is narrow here even though
 * `string-width` reports it as wide, and Ink's output buffer follows that path.
 */
export function isInkFullWidthCodePoint(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (0x2e80 <= codePoint && codePoint <= 0x3247 && codePoint !== 0x303f) ||
      (0x3250 <= codePoint && codePoint <= 0x4dbf) ||
      (0x4e00 <= codePoint && codePoint <= 0xa4c6) ||
      (0xa960 <= codePoint && codePoint <= 0xa97c) ||
      (0xac00 <= codePoint && codePoint <= 0xd7a3) ||
      (0xf900 <= codePoint && codePoint <= 0xfaff) ||
      (0xfe10 <= codePoint && codePoint <= 0xfe19) ||
      (0xfe30 <= codePoint && codePoint <= 0xfe6b) ||
      (0xff01 <= codePoint && codePoint <= 0xff60) ||
      (0xffe0 <= codePoint && codePoint <= 0xffe6) ||
      (0x1b000 <= codePoint && codePoint <= 0x1b001) ||
      (0x1f200 <= codePoint && codePoint <= 0x1f251) ||
      (0x20000 <= codePoint && codePoint <= 0x3fffd))
  );
}

/** Visible width of `text`, using Ink's full-width code-point rules. */
export function inkStringWidth(text: string): number {
  let width = 0;
  for (let index = 0; index < text.length; ) {
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    width += isInkFullWidthCodePoint(codePoint) || character.length > 1 ? 2 : 1;
    index += character.length;
  }
  return width;
}

/**
 * Word-wrap plain text to a given visible width.
 *
 * This is the **app's own pre-wrap**, used by renderers that layout each row
 * themselves (`UserMessageRich.renderBlock`), so those rows never reach Ink's
 * wrapper. It is deliberately not Ink's algorithm: it keeps no leading space on a
 * continuation row, and it flushes a long word's tail before the words that
 * follow it. A pre-wrapping renderer and the row model that mirrors it must use
 * *this* function (`row-model.ts`'s `renderedBlockRows`), not `wrappedRowCount`.
 *
 * For a line Ink itself wraps (`<Text wrap="wrap">`), the exact row count comes
 * from `wrappedRowCount` instead — see its note.
 */
export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [text];

  const hardWrap = (value: string): string[] => {
    const chunks: string[] = [];
    let current = "";
    let currentWidth = 0;

    for (let index = 0; index < value.length; ) {
      const codePoint = value.codePointAt(index);
      if (codePoint === undefined) break;
      const character = String.fromCodePoint(codePoint);
      const characterWidth = inkStringWidth(character);

      if (current && currentWidth + characterWidth > width) {
        chunks.push(current);
        current = "";
        currentWidth = 0;
      }

      current += character;
      currentWidth += characterWidth;
      index += character.length;
    }

    if (current) {
      chunks.push(current);
    }
    return chunks.length > 0 ? chunks : [""];
  };

  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (inkStringWidth(word) > width) {
      if (current !== "") {
        lines.push(current);
        current = "";
      }
      lines.push(...hardWrap(word));
      continue;
    }

    if (current === "") {
      current = word;
    } else {
      const candidate = `${current} ${word}`;
      if (inkStringWidth(candidate) <= width) {
        current = candidate;
      } else {
        lines.push(current);
        current = word;
      }
    }
  }
  if (current !== "") {
    lines.push(current);
  }
  return lines.length > 0 ? lines : [""];
}

/**
 * Rows a single hard-break-free line occupies once **Ink** wraps it.
 *
 * This asks Ink's own wrapper (`wrap-ansi`, the module `ink` loads with
 * `trim: false, hard: true` for `<Text wrap="wrap">`) rather than re-deriving
 * its rules. Two of its behaviours are easy to get subtly wrong, and both were
 * measured against the real renderer on 2026-10-23:
 *
 * - **A long word is filled across rows, and the words after it continue on the
 *   last row** instead of starting a fresh one. The hand-rolled wrapper used to
 *   flush the tail and open a new line, so a 79-column path followed by
 *   `(585 KB)` in a 62-column band measured 3 rows where Ink drew 2 — a phantom
 *   row the viewport turns into blank space at the top.
 * - **A row break adds a leading space** (`trim: false`), which can cost one more
 *   column than this file's own `wrapText` assumes.
 *
 * A small cache keeps this affordable on the render path: one call per text line
 * per frame, and `wrap-ansi` segments the string for grapheme clusters. The cache
 * is bounded and dropped whole on overflow — the entries are cheap to rebuild and
 * a line's width is identical every frame until the text changes.
 */
const WRAP_ROW_CACHE_LIMIT = 4096;
const wrapRowCache = new Map<string, number>();

export function wrappedRowCount(text: string, width: number): number {
  if (!text) return 1;
  const usable = Math.max(1, width);
  const key = `${usable}\u0000${text}`;
  const cached = wrapRowCache.get(key);
  if (cached !== undefined) return cached;
  const rows = wrapAnsi(text, usable, { trim: false, hard: true }).split(
    "\n",
  ).length;
  if (wrapRowCache.size >= WRAP_ROW_CACHE_LIMIT) wrapRowCache.clear();
  wrapRowCache.set(key, rows);
  return rows;
}

/**
 * Rows `text` occupies when wrapped at `width`, counting each `\n`-separated
 * segment separately (a blank segment still occupies one row).
 */
export function countTextRows(text: string, width: number): number {
  return text
    .split("\n")
    .reduce((rows, segment) => rows + wrappedRowCount(segment, width), 0);
}

/** A styled text chunk with optional color/dim for row-splitting. */
export type StyledChunk = { text: string; color?: string; dimColor?: boolean };

/**
 * Longest prefix of `text` whose visible width is at most `maxWidth`, split by
 * code point so a surrogate pair is never cut in half.
 */
function takePrefixByDisplayWidth(
  text: string,
  maxWidth: number,
): { prefix: string; rest: string; width: number } {
  if (maxWidth <= 0) {
    return { prefix: "", rest: text, width: 0 };
  }

  let prefix = "";
  let width = 0;

  for (const character of text) {
    const characterWidth = inkStringWidth(character);
    if (width + characterWidth > maxWidth) {
      break;
    }
    prefix += character;
    width += characterWidth;
  }

  return { prefix, rest: text.slice(prefix.length), width };
}

/** First code point of `text`, even when it is wider than the available width. */
function takeFirstCharacter(text: string): {
  prefix: string;
  rest: string;
  width: number;
} {
  const prefix = Array.from(text)[0] ?? "";
  return {
    prefix,
    rest: text.slice(prefix.length),
    width: inkStringWidth(prefix),
  };
}

/**
 * Split styled chunks into rows of exactly `cols` *display columns*, padding the
 * last row. Continuation rows start with a blank indent of `contIndent` columns
 * (matching Codex's empty-gutter + 2-space continuation, diff_render.rs:922-929).
 *
 * Rows are split by `inkStringWidth` — the same width rules Ink's own output
 * buffer uses — not by `String.length`. Splitting a CJK or emoji line by code
 * units would emit a row that is twice the requested width, and Ink would then
 * wrap it again: the rendered row count would exceed the count this function
 * reports, which is exactly what the transcript row model relies on.
 *
 * **Every returned row is at most `cols` display columns wide** (the only
 * exception is a terminal so narrow that one character alone overflows it).
 * That invariant is the contract: `diff-rows` counts these rows without
 * rendering them, so a row Ink has to wrap a second time would make the model
 * report one row fewer than the screen shows.
 */
export function paddedRows(
  chunks: StyledChunk[],
  cols: number,
  contIndent: number,
): StyledChunk[][] {
  if (cols <= 0) return [chunks];
  const rows: StyledChunk[][] = [];
  const continueRow = (): StyledChunk[] => [{ text: " ".repeat(contIndent) }];
  let row: StyledChunk[] = [];
  let width = 0;
  // Whether `row` holds anything besides its continuation indent. A row that
  // holds nothing else can always take the next code point, which is what keeps
  // this loop terminating on a terminal too narrow to hold one character.
  let rowHasContent = false;
  for (const chunk of chunks) {
    let rem = chunk.text;
    while (rem.length > 0) {
      if (width >= cols) {
        rows.push(row);
        row = continueRow();
        width = contIndent;
        rowHasContent = false;
      }

      const space = Math.max(1, cols - width);
      if (inkStringWidth(rem) <= space) {
        row.push({ text: rem, color: chunk.color, dimColor: chunk.dimColor });
        width += inkStringWidth(rem);
        rowHasContent = true;
        rem = "";
        continue;
      }

      const next = takePrefixByDisplayWidth(rem, space);
      if (!next.prefix) {
        // The next code point is wider than the space left on this row — a
        // double-width character beside a one-column gap. Emitting it here would
        // produce a row wider than `cols`, which Ink wraps again: the rendered
        // row count would exceed the count this function's rows report, which is
        // exactly what the transcript row model relies on. Close the row and let
        // the character start the continuation row instead.
        const characterWidth = inkStringWidth(Array.from(rem)[0] ?? "");
        if (
          rowHasContent &&
          contIndent < cols &&
          characterWidth <= cols - contIndent
        ) {
          rows.push(row);
          row = continueRow();
          width = contIndent;
          rowHasContent = false;
          continue;
        }
        // Nowhere to move it to (the continuation indent itself leaves no room):
        // take the character anyway so the loop always makes progress.
        const forced = takeFirstCharacter(rem);
        row.push({
          text: forced.prefix,
          color: chunk.color,
          dimColor: chunk.dimColor,
        });
        width += forced.width;
        rem = forced.rest;
        rows.push(row);
        // Start continuation row with blank gutter indent
        row = continueRow();
        width = contIndent;
        rowHasContent = false;
        continue;
      }

      row.push({
        text: next.prefix,
        color: chunk.color,
        dimColor: chunk.dimColor,
      });
      width += next.width;
      rowHasContent = true;
      rem = next.rest;
      rows.push(row);
      // Start continuation row with blank gutter indent
      row = continueRow();
      width = contIndent;
      rowHasContent = false;
    }
  }
  if (width < cols) row.push({ text: " ".repeat(cols - width) });
  if (row.length > 0) rows.push(row);
  return rows;
}
