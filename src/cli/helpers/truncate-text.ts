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
