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
 * Returns an array of lines, each at most `width` visible characters wide.
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

/** Rows a single hard-break-free line occupies once word-wrapped. */
export function wrappedRowCount(text: string, width: number): number {
  return wrapText(text, width).length;
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
 */
export function paddedRows(
  chunks: StyledChunk[],
  cols: number,
  contIndent: number,
): StyledChunk[][] {
  if (cols <= 0) return [chunks];
  const rows: StyledChunk[][] = [];
  let row: StyledChunk[] = [];
  let width = 0;
  for (const chunk of chunks) {
    let rem = chunk.text;
    while (rem.length > 0) {
      if (width >= cols) {
        rows.push(row);
        row = [{ text: " ".repeat(contIndent) }];
        width = contIndent;
      }

      const space = Math.max(1, cols - width);
      if (inkStringWidth(rem) <= space) {
        row.push({ text: rem, color: chunk.color, dimColor: chunk.dimColor });
        width += inkStringWidth(rem);
        rem = "";
      } else {
        let next = takePrefixByDisplayWidth(rem, space);
        if (!next.prefix) {
          next = takeFirstCharacter(rem);
        }
        row.push({
          text: next.prefix,
          color: chunk.color,
          dimColor: chunk.dimColor,
        });
        width += next.width;
        rem = next.rest;
        rows.push(row);
        // Start continuation row with blank gutter indent
        row = [{ text: " ".repeat(contIndent) }];
        width = contIndent;
      }
    }
  }
  if (width < cols) row.push({ text: " ".repeat(cols - width) });
  if (row.length > 0) rows.push(row);
  return rows;
}
