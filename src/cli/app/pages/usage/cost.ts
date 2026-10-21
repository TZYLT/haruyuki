/**
 * Number formatting for the Usage screens.
 *
 * One rule matters here: **an unknown price is `—`, never `0` and never an
 * invented number** (docs/38 §14.7 #1). A local model is genuinely free and a
 * model the provider did not price is unknown; both must be distinguishable on
 * screen, so the ledger omits `cost` for the free case and the formatter prints
 * `—` when there was no cost at all.
 */

/** What a screen prints when a number does not exist. */
export const UNKNOWN_VALUE = "—";

/** `¥ 12.40`, or `—` when nothing was priced. */
export function formatCost(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return UNKNOWN_VALUE;
  return `¥ ${formatCostAmount(value)}`;
}

/** `12.40`, or `—` — the amount alone, for table cells. */
export function formatCostAmount(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return UNKNOWN_VALUE;
  return value.toFixed(2);
}

/**
 * One-decimal percentage, the detail screen's contract (§14.8).
 *
 * A zero denominator is `—`: "0 of 0" is not 0%, it is a question the data
 * cannot answer.
 */
export function formatPercent(part: number, whole: number): string {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) {
    return UNKNOWN_VALUE;
  }
  return `${((part / whole) * 100).toFixed(1)}%`;
}

/** Whole-number percentage, for the overview's cache-rate line. */
export function formatRate(rate: number | undefined): string {
  if (rate === undefined || !Number.isFinite(rate)) return UNKNOWN_VALUE;
  return `${Math.round(rate * 100)}%`;
}

/** `1,258,291` — byte and token counts that are read, not scanned. */
export function formatGrouped(value: number): string {
  if (!Number.isFinite(value)) return UNKNOWN_VALUE;
  return Math.round(value).toLocaleString("en-US");
}
