import stringWidth from "string-width";
import stripAnsi from "strip-ansi";

const OSC8 = "\x1b]8;;";
const ST = "\x1b\\";

export function truncateStatuslineText(
  value: string,
  maxChars: number,
): string {
  if (maxChars <= 0) return "";
  if (value.length <= maxChars) return value;
  if (maxChars <= 3) return value.slice(0, maxChars);
  return `${value.slice(0, maxChars - 3)}...`;
}

/**
 * The ellipsis this app truncates with, and the columns it needs.
 *
 * `string-width` calls U+2026 "ambiguous": one column on most terminals and **two**
 * on one that treats East Asian ambiguous characters as wide — which the machine
 * this is developed on does. Measured there on 2026-10-20: a tab title truncated
 * with `…` made the row one column wider than the terminal, the row wrapped, the
 * frame grew a line, and the alternate screen scrolled — taking the whole tab row
 * with it, with a lone `s` left at the top. Counting the ellipsis as wide costs
 * one column of padding on a terminal where it is narrow; counting it narrow costs
 * a whole row on a terminal where it is wide. The two directions are not
 * comparable, so this side wins.
 */
const ELLIPSIS = "…";
const ELLIPSIS_WIDTH = 2;

/**
 * Columns every exact-width row leaves empty, on purpose.
 *
 * The same lesson as the ellipsis, generalised: *the terminal decides how wide a
 * character is, and it does not always agree with the width table this app can
 * consult.* The machine draws `…` two columns wide while `string-width` says one,
 * so a row laid out to the column **exactly** is a row that wraps on it — and a
 * wrapped row costs a whole line, which (because the frame is pinned to the
 * screen's height) scrolls the alternate screen and takes the top row with it.
 * The 2026-10-20 reports were that twice over: the status line (`⚡︎` plus `·`)
 * and a markdown table row, both of which "fit" by the table and did not fit on
 * the screen.
 *
 * Ink cannot save us here: a fixed-width box with `overflow="hidden"` does **not**
 * clip an over-wide line — measured on Ink 7.1, both a composed row and a single
 * `Text` wrap inside such a box rather than being clipped. So the only defence is
 * never to hand a row the last two columns: a glyph drawn one or two columns wider
 * than our table believes lands in the margin instead of past the edge.
 */
export const ROW_SAFETY_COLUMNS = 2;

/** One glyph's width, with this app's ellipsis counted as the wide character it is. */
function glyphWidth(ch: string): number {
  return ch === ELLIPSIS ? ELLIPSIS_WIDTH : stringWidth(ch);
}

/**
 * Visible width of a string in terminal columns, ignoring ANSI escape codes
 * (colors, OSC 8 links) and accounting for wide characters (CJK, emoji) that
 * occupy two columns and zero-width/combining marks.
 *
 * The ellipsis is counted as two columns (`ELLIPSIS_WIDTH`) because a terminal
 * that renders ambiguous characters wide draws it that way; a row laid out with
 * the narrower number is one column too long there, and one column is the
 * difference between a row and a wrapped line.
 */
export function visibleWidth(value: string): number {
  const base = stringWidth(value);
  if (base === 0 || !value.includes(ELLIPSIS)) return base;
  let ellipses = 0;
  for (const ch of value) {
    if (ch === ELLIPSIS) ellipses += 1;
  }
  return base + ellipses * (ELLIPSIS_WIDTH - 1);
}

/**
 * Truncate to a visible column width, appending "…" when clipped. The ellipsis
 * path strips ANSI before slicing (truncated output is not color-preserved);
 * mods that need color-preserving truncation can pre-truncate to `width`
 * themselves. Slices by column width so wide characters are not split.
 *
 * This is a *segment* budget, so it spends the columns it is given exactly: the
 * safety margin belongs to the row that assembles segments (`ROW_SAFETY_COLUMNS`),
 * not to each segment, or three truncated titles would give up six columns
 * between them.
 */
export function truncateToWidth(value: string, width: number): string {
  if (width <= 0) return "";
  if (visibleWidth(value) <= width) return value;
  if (width < ELLIPSIS_WIDTH) return "";
  const budget = width - ELLIPSIS_WIDTH;
  let out = "";
  let used = 0;
  for (const ch of stripAnsi(value)) {
    const w = glyphWidth(ch);
    if (used + w > budget) break;
    out += ch;
    used += w;
  }
  return `${out}${ELLIPSIS}`;
}

/**
 * Lay out a left segment and a right segment across `width`, padding the middle
 * with spaces. ANSI-aware. If the two collide, the left side is truncated.
 *
 * The row ends `ROW_SAFETY_COLUMNS` short of `width` for the reason that constant
 * gives: a row that touches the right edge is a row the terminal may decide is one
 * column too long.
 */
export function row(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  const budget = width - ROW_SAFETY_COLUMNS;
  if (budget <= 0) return truncateToWidth(right, Math.max(0, width));
  const rightWidth = visibleWidth(right);
  if (rightWidth >= budget) return truncateToWidth(right, budget);
  const leftBudget = budget - rightWidth;
  const fittedLeft =
    visibleWidth(left) > leftBudget ? truncateToWidth(left, leftBudget) : left;
  const gap = Math.max(0, leftBudget - visibleWidth(fittedLeft));
  return `${fittedLeft}${" ".repeat(gap)}${right}`;
}

/**
 * Distribute parts across `width`: first left-aligned, last right-aligned,
 * middles spread evenly between. ANSI-aware.
 *
 * Three or more parts are spread over `width - ROW_SAFETY_COLUMNS` for the reason
 * that constant gives; two parts and one part already go through the helpers that
 * keep (or spend) the margin themselves.
 */
export function columns(parts: string[], width: number): string {
  const items = parts.filter((part) => part.length > 0);
  if (items.length === 0) return "";
  const first = items[0] ?? "";
  const second = items[1] ?? "";
  if (items.length === 1) return truncateToWidth(first, width);
  if (items.length === 2) return row(first, second, width);
  const budget = Math.max(0, width - ROW_SAFETY_COLUMNS);
  const totalContent = items.reduce((sum, part) => sum + visibleWidth(part), 0);
  const gaps = items.length - 1;
  const spare = Math.max(gaps, budget - totalContent);
  const base = Math.floor(spare / gaps);
  let extra = spare - base * gaps;
  let result = first;
  for (let i = 1; i < items.length; i += 1) {
    const pad = base + (extra > 0 ? 1 : 0);
    if (extra > 0) extra -= 1;
    result += " ".repeat(pad) + items[i];
  }
  return truncateToWidth(result, budget);
}

export function link(label: string, url: string): string {
  if (!url) return label;
  return `${OSC8}${url}${ST}${label}${OSC8}${ST}`;
}
