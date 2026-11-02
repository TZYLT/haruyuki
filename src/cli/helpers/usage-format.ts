/**
 * Number formatting for everything that shows usage: the page's two screens and
 * the rail's badges (docs/38 §14.7–§14.8).
 *
 * It lives in `helpers/` rather than under `pages/usage/` because the rail needs
 * it too, and the rail is drawn by the shell — a shell module importing a page's
 * private helper is the kind of edge that later becomes a cycle.
 *
 * Two rules matter here:
 *
 * 1. **An unknown price is `—`, never `0` and never an invented number**
 *    (§14.7 #1). A local model is genuinely free and a model the provider did
 *    not price is unknown; both must be distinguishable on screen, so the
 *    ledger omits `cost` for the free case and these formatters print `—` when
 *    there was no cost at all.
 * 2. **A real but sub-digit amount never rounds to `0.00`.** Most turns cost a
 *    fraction of a cent, so `toFixed(2)` turned a whole page into "free"; an
 *    amount below the smallest digit shown reads `$ <0.01` instead.
 *
 * Money is **dollars**: the ledger stores the provider's own `cost` split, and
 * pi-ai reports it in USD (`usage_statistics.cost_usd`). There is no exchange
 * rate anywhere in this tree, so a localised symbol would be a claim the data
 * cannot back.
 */

import { terminalTextWidth } from "./char-width";
import { formatCompact } from "./format";

/** What a screen prints when a number does not exist. */
export const UNKNOWN_VALUE = "—";

/** The currency mark. See the note above: the numbers are USD. */
export const CURRENCY = "$";

/** Decimals the overview and the rail show — a magnitude, read at a glance. */
export const COST_DECIMALS = 2;

/**
 * Decimals the detail screen shows.
 *
 * Five, because that screen exists to answer "which bucket is costing me": at
 * two decimals every bucket of a normal turn is `0.00` and the split says
 * nothing (docs/38 §14.8, amended 2026-10-22).
 */
export const DETAIL_COST_DECIMALS = 5;

/** `12.40`, or `—` — the amount alone, for table cells. */
export function formatCostAmount(
  value: number | undefined,
  decimals: number = COST_DECIMALS,
): string {
  if (value === undefined || !Number.isFinite(value)) return UNKNOWN_VALUE;
  return value.toFixed(decimals);
}

/** `$ 12.40`, or `$ <0.01` when the amount is smaller than the last digit. */
export function formatCost(
  value: number | undefined,
  decimals: number = COST_DECIMALS,
): string {
  if (value === undefined || !Number.isFinite(value)) return UNKNOWN_VALUE;
  const step = 10 ** -decimals;
  if (value > 0 && value < step / 2) {
    return `${CURRENCY} <${step.toFixed(decimals)}`;
  }
  return `${CURRENCY} ${value.toFixed(decimals)}`;
}

/**
 * Two-decimal percentage, the detail screen's contract (§14.8, amended).
 *
 * A zero denominator is `—`: "0 of 0" is not 0%, it is a question the data
 * cannot answer.
 */
export function formatPercent(part: number, whole: number): string {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) {
    return UNKNOWN_VALUE;
  }
  return `${((part / whole) * 100).toFixed(2)}%`;
}

/** Two-decimal percentage from a 0..1 rate (the cache hit rate). */
export function formatRate(rate: number | undefined): string {
  if (rate === undefined || !Number.isFinite(rate)) return UNKNOWN_VALUE;
  return `${(rate * 100).toFixed(2)}%`;
}

/**
 * An **estimated** token count, marked with `~`: `~20k` (T-05 / T-06).
 *
 * The `~` is the contract, not the number of significant figures: every value
 * this formats was derived from a heuristic (4 bytes per token), never measured.
 * The magnitude uses the same `formatCompact` the measured columns use, so a
 * component and a total that read the same way also *compare* the same way; a
 * negative or non-finite count cannot be one, so it is clamped to zero / shown
 * as unknown instead of printing `~-3k` or `~NaN`.
 */
export function formatEstimatedCompact(n: number): string {
  if (!Number.isFinite(n)) return UNKNOWN_VALUE;
  return `~${formatCompact(Math.max(0, Math.round(n)))}`;
}

/**
 * An **estimated** percentage from a 0..1 ratio, marked with `~`: `~43%`.
 *
 * Whole percent, because only the `~` is meaningful here: the numerator was
 * estimated from bytes, and the denominator can be a provider-reported total
 * that the estimate is not guaranteed to reach (an old ledger row can therefore
 * read `~103%`; that history is deliberately not rewritten — R-05.7). Two
 * decimals would claim a precision the estimate does not have. Neither the
 * ratio nor the rounding is clamped at 100%: the screens report what the stored
 * numbers say (Q-30), and a value above 100% is honest evidence that the two
 * sides of the division came from different eras of the estimator.
 */
export function formatEstimatedPercent(ratio: number): string {
  if (!Number.isFinite(ratio)) return UNKNOWN_VALUE;
  return `~${Math.round(Math.max(0, ratio) * 100)}%`;
}

/**
 * The narrowest the detail screen's cost column may be drawn (T-05 / R-05.9).
 *
 * Eleven columns is what `$ 0.00000` needs — the five-decimal detail cost. It is
 * a floor rather than a constant: a table whose priced rows are wider (a bigger
 * total, or a `$ <0.00001` marker) asks for its own width through
 * {@link costColumnWidth}, instead of being cut off at eleven, which is what the
 * old hard-coded `padStart(11)` did.
 */
export const DETAIL_COST_MIN_WIDTH = 11;

/**
 * The width a table's cost column needs for the cells it will draw.
 *
 * Terminal columns, not string length: the unknown marker is `—`, an ambiguous
 * character, and under a CJK console it is two cells wide while `string.length`
 * says one — padding on the latter would misalign every row after it. The result
 * is never below {@link DETAIL_COST_MIN_WIDTH}, and every cell in the returned
 * width is right-aligned by the caller so the `$`/digit columns line up.
 */
export function costColumnWidth(
  cells: readonly string[],
  minWidth: number = DETAIL_COST_MIN_WIDTH,
): number {
  let width = minWidth;
  for (const cell of cells) {
    width = Math.max(width, terminalTextWidth(cell));
  }
  return width;
}
