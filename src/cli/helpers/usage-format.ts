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
