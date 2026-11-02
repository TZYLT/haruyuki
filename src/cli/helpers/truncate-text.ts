import { terminalTextWidth } from "./char-width";

/**
 * Truncate text to fit within maxWidth terminal columns, appending "..." when
 * truncation occurs.
 *
 * The width question is the *terminal's*, not `string-width`'s: Unicode's ambiguous
 * characters (`— … · ≥ →`) are one column under a Western console face and two under
 * a CJK one, and a row laid out with the wrong answer is either short by a column or
 * — worse — wraps, which costs a physical line. `terminalTextWidth`
 * (`./char-width.ts`) is the one place that answer is resolved, so every row that
 * pre-computes its own line has to ask it rather than assume.
 *
 * That mismatch is exactly what the user saw: the UI's rows (page labels, status
 * line, selectors) were clipped with `stringWidth` while the terminal drew wide, so
 * the row was a column or two narrower than the frame it sat in, and a right-hand
 * column landed one cell off. The mouse hit-testing was fine because it reads frame
 * coordinates, not this arithmetic.
 */
export function truncateText(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (terminalTextWidth(text) <= maxWidth) return text;
  if (maxWidth <= 3) return ".".repeat(maxWidth);

  const suffix = "...";
  const budget = Math.max(0, maxWidth - terminalTextWidth(suffix));
  let out = "";
  for (const char of text) {
    const next = out + char;
    if (terminalTextWidth(next) > budget) break;
    out = next;
  }
  return out + suffix;
}

/**
 * Pad text with spaces to `width` terminal columns.
 *
 * `String.prototype.padEnd` counts UTF-16 code units, so a wide label is padded
 * as if each CJK character were one column: a 12-character title occupies 24
 * columns but `padEnd(26)` adds 14 spaces instead of 2, every column to its
 * right shifts, and a hover background filled to the nominal width pushes the
 * row past the band — an over-wide first line wraps, costing a physical row the
 * window arithmetic never budgeted. The cell width is the terminal's, the same
 * answer [truncateText] uses, so the two cannot disagree.
 *
 * Text already at or past `width` is returned unchanged: this pads, it does not
 * clip (truncate first when both are wanted).
 */
export function padToWidth(text: string, width: number): string {
  const missing = width - terminalTextWidth(text);
  return missing > 0 ? text + " ".repeat(missing) : text;
}
