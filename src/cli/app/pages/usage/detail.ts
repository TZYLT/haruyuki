/**
 * The Usage detail screen (P5), docs/38 §14.8.
 *
 * Plain text only: the overview owns the bars, the grid and the block art, and
 * this screen is what a person reads when they want the four cost buckets, the
 * context number, the per-model split and the last fourteen days.
 *
 * The percentage column means **share of all tokens** in the same scope, on
 * every row. §14.8 fixes that convention for the history table; using one
 * meaning everywhere is what keeps the sections comparable, and it makes the
 * four buckets add up to 100%.
 *
 * Two formatting decisions from the 2026-10-22 pass:
 *
 * - **cost is five decimals here** (`usage-format.ts`): at two, every bucket of
 *   a normal turn is `$ 0.00` and the screen's whole job — which bucket costs
 *   what — is invisible.
 * - **the history row drops the per-bucket percentages** that §14.8's sketch
 *   had. They cannot be shown at two decimals alongside the counts and the day's
 *   cost inside the content width: the row came to ~75 columns against the ~65
 *   the band gives. The counts and the cost survive, and the shares are one
 *   screen up, aggregated over the same buckets. Recorded in §14.8.
 *
 * **The third visual pass (2026-10-23).** Four section titles and a table used to
 * sit on five consecutive lines, so the screen read as one long list with dim
 * captions in it rather than as four blocks. Every section now opens after one
 * blank row — including `Cost`, whose title otherwise touched the page header.
 * The blank is the frame's empty `text` row, which `page-frame.tsx` paints as one
 * space (Ink collapses an empty `<Text>` to zero height, so asking for the row is
 * not the same as getting it). It costs four rows: the detail screen does not
 * have a tier rule — it scrolls — so nothing is pushed off screen by them.
 *
 * **T-05 (2026-11-02).** The two tables are laid out by `detail-tables.ts`: the
 * Automated tasks row is `source/runs/in/hit/out/cost/hit%` (the `in`/`hit` split,
 * full columns only when the band is at least the O-05 58 columns or the user
 * pressed `f`), the By model row is the fixed `model/in/hit/out/cost`, and the
 * cost column is as wide as its own cells instead of a hard-coded eleven. The
 * context section marks its estimated components and derived shares with `~`,
 * labels `system` as `sys+mem` (memory is compiled in before the request exists)
 * and no longer prints a separate "memory is folded" line; the provider-reported
 * total stays unmarked. Old ledger rows are shown as stored, so their shares can
 * exceed 100% — deliberate (R-05.7).
 */

import type { PageRow } from "@/cli/app/pages/page-model";
import { formatCompact } from "@/cli/helpers/format";
import { truncateText } from "@/cli/helpers/truncate-text";
import {
  costColumnWidth,
  DETAIL_COST_DECIMALS,
  formatCost,
  formatEstimatedCompact,
  formatEstimatedPercent,
  formatPercent,
  formatRate,
} from "@/cli/helpers/usage-format";
import {
  aggregateUsageByDay,
  aggregateUsageByModel,
  aggregateUsageBySource,
  DEFAULT_USAGE_SOURCE,
  type UsageRecord,
  type UsageSource,
  type UsageTotals,
  usageDayKey,
} from "@/usage/ledger";
import type { UsageSummary } from "@/usage/summary";
import {
  contextBreakdownTotal,
  contextComponents,
  contextShareDenominator,
  type UsageContextBreakdown,
} from "@/utils/usage-context";
import { addUsageCost } from "@/utils/usage-cost";
import {
  automatedTableColumns,
  automatedTableNaturalWidth,
  modelTableColumns,
  renderDetailTable,
} from "./detail-tables";

/** Days of history the screen shows (docs/38 §14.8). */
export const DETAIL_HISTORY_DAYS = 14;

function textRow(text: string, width: number): PageRow {
  return { kind: "text", text: truncateText(text, width) };
}

function headerRow(text: string): PageRow {
  return { kind: "header", text };
}

/**
 * A row of air between two sections.
 *
 * `text: ""` and not a space: the frame owns the painting rule (`page-frame.tsx`
 * draws an empty text row as one space, because Ink would otherwise collapse it
 * to zero height and the section would touch the one above it again).
 */
function blankRow(): PageRow {
  return { kind: "text", text: "" };
}

/** Open a section: one blank row, then its dim title. */
function openSection(rows: PageRow[], title: string): void {
  rows.push(blankRow());
  rows.push(headerRow(title));
}

interface BucketRow {
  label: string;
  tokens: number;
  cost: number | undefined;
}

/** Token counts per billed bucket, summed over the same records. */
export function bucketTokens(records: readonly UsageRecord[]): {
  miss: number;
  hit: number;
  write: number;
  output: number;
  total: number;
} {
  let miss = 0;
  let hit = 0;
  let write = 0;
  let output = 0;
  for (const record of records) {
    miss += record.prompt;
    hit += record.cachedInput;
    write += record.cacheWrite;
    output += record.completion;
  }
  return { miss, hit, write, output, total: miss + hit + write + output };
}

/** The latest request composition the ledger has, or `undefined`. */
export function latestContextBreakdown(
  records: readonly UsageRecord[],
): UsageContextBreakdown | undefined {
  let best: { hour: string; breakdown: UsageContextBreakdown } | undefined;
  for (const record of records) {
    if (!record.contextBreakdown) continue;
    if (!best || record.tsHour >= best.hour) {
      best = { hour: record.tsHour, breakdown: record.contextBreakdown };
    }
  }
  return best?.breakdown;
}

/** The latest context occupancy the ledger has, or `undefined`. */
export function latestContextTokens(
  records: readonly UsageRecord[],
): number | undefined {
  let best: { hour: string; tokens: number } | undefined;
  for (const record of records) {
    if (record.contextTokens === undefined) continue;
    if (!best || record.tsHour >= best.hour) {
      best = { hour: record.tsHour, tokens: record.contextTokens };
    }
  }
  return best?.tokens;
}

/** The most recent `days` calendar days that have records, newest first. */
export function recentDays(
  records: readonly UsageRecord[],
  now: Date,
  days: number = DETAIL_HISTORY_DAYS,
): string[] {
  const byDay = aggregateUsageByDay(records);
  const keys: string[] = [];
  const cursor = new Date(now.getTime());
  cursor.setHours(0, 0, 0, 0);
  for (let index = 0; index < days; index += 1) {
    keys.push(usageDayKey(cursor));
    cursor.setDate(cursor.getDate() - 1);
  }
  return keys.filter((key) => byDay.has(key));
}

/** `$ 0.10000` right-aligned in the money column, `—` when unpriced. */
function money(value: number | undefined): string {
  return formatCost(value, DETAIL_COST_DECIMALS);
}

/**
 * A bucket's total cost, or `undefined` when nothing in it carried a price.
 *
 * A zero total is treated as unpriced because that is what the ledger means by
 * it: the price buckets are omitted for a model with no price, and `—` says
 * "unknown" where `$ 0.00000` would claim the spend was free (§14.7 #1).
 */
function modelCost(totals: UsageTotals): number | undefined {
  return totals.cost.total > 0 ? totals.cost.total : undefined;
}

/**
 * One row of the Automated tasks table (F-03 §5.16.5, T-05).
 *
 * The old row had a single `tokens` cell (all four billed buckets). `in` is now
 * the non-cached input (`prompt + cacheWrite`), `hit` the cached input
 * (`cachedInput`) and `out` the completion, so the three cells still add up to
 * that same `tokens` total (R-05.1 / Q-10) — the split costs no spend, it only
 * separates what was cached from what was not.
 *
 * `hitRate` stays the ledger's own input-only rate
 * (`cachedInput / (prompt + cachedInput)`, docs/38 §14.7 #3): it is the number
 * written into the ledger per turn and the same one the rail shows (T-06), so it
 * is not recomputed as `hit / (in + hit)`.
 */
export interface AutomatedUsageRow {
  source: UsageSource;
  runs: number;
  /** prompt + cacheWrite (R-05.1). */
  in: number;
  /** cachedInput (R-05.1). */
  hit: number;
  /** completion (R-05.1). */
  out: number;
  cost: number | undefined;
  hitRate: number | undefined;
}

function automatedRow(
  source: UsageSource,
  totals: UsageTotals,
): AutomatedUsageRow {
  const billedInput = totals.prompt + totals.cachedInput;
  return {
    source,
    runs: totals.turns,
    in: totals.prompt + totals.cacheWrite,
    hit: totals.cachedInput,
    out: totals.completion,
    // Absent, not zero: a record with no price is unknown, not free.
    cost: totals.cost.total > 0 ? totals.cost.total : undefined,
    hitRate: billedInput > 0 ? totals.cachedInput / billedInput : undefined,
  };
}

/** Fold `from` into `into` (the section's own total row). */
function addTotals(into: UsageTotals, from: UsageTotals): void {
  into.turns += from.turns;
  into.prompt += from.prompt;
  into.cachedInput += from.cachedInput;
  into.cacheWrite += from.cacheWrite;
  into.completion += from.completion;
  into.reasoning += from.reasoning;
  into.steps += from.steps;
  into.wallMs += from.wallMs;
  into.apiMs += from.apiMs;
  addUsageCost(into.cost, from.cost);
}

/** The automated sources' totals, keyed by source (`interactive` dropped). */
function automatedTotals(records: readonly UsageRecord[]): {
  rows: Array<{ source: UsageSource; totals: UsageTotals }>;
  total: UsageTotals | undefined;
} {
  const rows: Array<{ source: UsageSource; totals: UsageTotals }> = [];
  let total: UsageTotals | undefined;
  for (const [source, totals] of aggregateUsageBySource(records)) {
    if (source === DEFAULT_USAGE_SOURCE) continue;
    rows.push({ source, totals });
    if (!total) {
      // Copy: the map's totals object belongs to the ledger, and the section's
      // total must not mutate it.
      total = { ...totals, cost: { ...totals.cost } };
    } else {
      addTotals(total, totals);
    }
  }
  rows.sort((left, right) => left.source.localeCompare(right.source));
  return { rows, total };
}

/**
 * The automated runs, one row per source, `interactive` excluded.
 *
 * The overview's total already folds these records in (they are ordinary
 * records); this section only splits them out, which is exactly what §5.16.5
 * asks for — automated spend visible, and separable from the interactive bill.
 */
export function automatedUsageRows(
  records: readonly UsageRecord[],
): AutomatedUsageRow[] {
  return automatedTotals(records).rows.map(({ source, totals }) =>
    automatedRow(source, totals),
  );
}

/** The automated records' own total (the section's last row). */
export function automatedUsageTotal(
  records: readonly UsageRecord[],
): AutomatedUsageRow | undefined {
  const { total } = automatedTotals(records);
  return total ? automatedRow("other", total) : undefined;
}

/** One Automated tasks cell, selected by the column's stable key. */
function automatedCell(
  key: string,
  label: string,
  row: AutomatedUsageRow,
): string {
  switch (key) {
    case "source":
      return label;
    case "runs":
      return `${row.runs}`;
    case "in":
      return formatCompact(row.in);
    case "hit":
      return formatCompact(row.hit);
    case "out":
      return formatCompact(row.out);
    case "cost":
      return money(row.cost);
    case "hit%":
      return formatRate(row.hitRate);
    default:
      return "";
  }
}

/**
 * The Automated tasks section: one row per source, then its total.
 *
 * Layout lives in `detail-tables.ts`: the cost column is as wide as the table's
 * own formatted costs (R-05.9), and the full set (`source/runs/in/hit/out/cost/hit%`)
 * is drawn by default only when the band can hold its natural width — the 58
 * columns of O-05. Under that, `runs` and `hit%` are hidden (R-05.8) unless the
 * user presses `f`, which `usage-page.tsx` passes in as `fullTable`.
 */
function automatedSectionRows(
  records: readonly UsageRecord[],
  width: number,
  fullTable: boolean,
): PageRow[] {
  const rows: PageRow[] = [];
  const automated = automatedUsageRows(records);
  if (automated.length === 0) {
    rows.push(textRow("  no automated runs recorded", width));
    return rows;
  }
  const total = automatedUsageTotal(records);
  const table: Array<{ label: string; row: AutomatedUsageRow }> = [
    ...automated.map((row) => ({ label: row.source, row })),
    ...(total ? [{ label: "total", row: total }] : []),
  ];
  const costWidth = costColumnWidth(table.map(({ row }) => money(row.cost)));
  const full = fullTable || width >= automatedTableNaturalWidth(costWidth);
  const columns = automatedTableColumns({ full, costWidth });
  const lines = renderDetailTable(
    columns,
    table.map(({ label, row }) =>
      columns.map((column) => automatedCell(column.key, label, row)),
    ),
  );
  for (const line of lines) rows.push(textRow(line, width));
  return rows;
}

/** Build the detail screen's rows. */
export function buildDetailRows(input: {
  summary: UsageSummary;
  records: readonly UsageRecord[];
  now: Date;
  width: number;
  /** The conversation's context window, for the occupancy line. */
  contextWindow?: number | null;
  /**
   * The user asked for the complete Automated tasks table with `f`.
   *
   * Only widens the table: a band already wide enough for the full columns draws
   * them anyway (the default), so the flag matters on the narrow side only.
   */
  fullTable?: boolean;
}): PageRow[] {
  const { summary, records, now, width, contextWindow } = input;
  const fullTable = input.fullTable === true;
  const rows: PageRow[] = [];
  if (summary.recordCount === 0) {
    rows.push(textRow("No usage recorded yet.", width));
    rows.push(textRow("A finished turn writes one line to the ledger.", width));
    return rows;
  }

  const tokens = bucketTokens(records);
  const breakdown = summary.totals.costBreakdown;
  // No record in scope carried a price: the buckets are unknown, not zero.
  const priced = summary.totals.cost !== undefined;
  openSection(rows, `Cost (est. ${money(summary.totals.cost)})`);
  const bucketRows: BucketRow[] = [
    {
      label: "Input miss",
      tokens: tokens.miss,
      cost: priced ? breakdown.input : undefined,
    },
    {
      label: "Input hit",
      tokens: tokens.hit,
      cost: priced ? breakdown.cacheRead : undefined,
    },
    {
      label: "Cache write",
      tokens: tokens.write,
      cost: priced ? breakdown.cacheWrite : undefined,
    },
    {
      label: "Output",
      tokens: tokens.output,
      cost: priced ? breakdown.output : undefined,
    },
  ];
  for (const bucket of bucketRows) {
    // One row of columns: label, count, money, share. Every field is padded so
    // the four rows read as a table rather than as four sentences.
    const label = bucket.label.padEnd(12);
    const count = formatCompact(bucket.tokens).padStart(7);
    const amount = money(bucket.cost).padStart(11);
    const share = formatPercent(bucket.tokens, tokens.total).padStart(6);
    rows.push(textRow(`  ${label}${count}  ${amount}  ${share}`, width));
  }

  openSection(rows, "Context composition (latest request)");
  const contextTokens = latestContextTokens(records);
  const composition = latestContextBreakdown(records);
  if (composition) {
    // Denominator = the total the screen shows, which is the provider-reported
    // occupancy when the row has one (R-05.4/R-05.6). The components are
    // estimates, hence `~` on each of them and on the shares they derive; the
    // total itself is measured, so it carries none. An old row whose components
    // sum past its total can therefore read `~103%` — reported, not rewritten
    // (R-05.7/Q-30).
    const denominator = contextShareDenominator(composition, contextTokens);
    const occupancy =
      contextTokens !== undefined && contextWindow && contextWindow > 0
        ? `${formatCompact(contextTokens)} / ${formatCompact(contextWindow)} · ${formatPercent(contextTokens, contextWindow)}`
        : contextTokens !== undefined
          ? `${formatCompact(contextTokens)} tokens`
          : `${formatEstimatedCompact(contextBreakdownTotal(composition))} tokens (estimated)`;
    rows.push(textRow(`  ${occupancy}`, width));
    // `sys+mem`, not `system`: memory is compiled into the system prompt before
    // the request exists, so it is part of this component — the label says so
    // and the separate "memory is included" note is gone (R-05.5).
    for (const part of contextComponents(composition)) {
      rows.push(
        textRow(
          `  ${part.label.padEnd(9)}${formatEstimatedCompact(part.tokens).padStart(7)}  ${formatEstimatedPercent(part.tokens / denominator).padStart(6)}`,
          width,
        ),
      );
    }
  } else {
    rows.push(
      textRow(
        contextTokens === undefined
          ? "  the latest turn reported no occupancy"
          : `  the latest turn used ${formatCompact(contextTokens)} tokens, with no composition`,
        width,
      ),
    );
  }

  openSection(rows, "By model");
  // A fixed-width table (`model/in/hit/out/cost`, R-05.2): same in/hit split as
  // the Automated tasks section, model names ellipsized rather than allowed to
  // push the right-aligned numbers out of their columns.
  const modelRows = [...aggregateUsageByModel(records)];
  const modelCostWidth = costColumnWidth(
    modelRows.map(([, totals]) => money(modelCost(totals))),
  );
  const modelColumns = modelTableColumns({
    availableWidth: width,
    costWidth: modelCostWidth,
  });
  for (const line of renderDetailTable(
    modelColumns,
    modelRows.map(([model, totals]) => [
      model,
      formatCompact(totals.prompt + totals.cacheWrite),
      formatCompact(totals.cachedInput),
      formatCompact(totals.completion),
      money(modelCost(totals)),
    ]),
  )) {
    rows.push(textRow(line, width));
  }

  // F-03 §5.16.5: automated spend sits between the per-model split and the
  // history, so the bill and the runs behind it are read together. The totals
  // above already include these records; this section only separates them.
  openSection(rows, "Automated tasks");
  rows.push(...automatedSectionRows(records, width, fullTable));

  openSection(rows, `History (last ${DETAIL_HISTORY_DAYS} days)`);
  const byDay = aggregateUsageByDay(records);
  const days = recentDays(records, now);
  if (days.length === 0) {
    rows.push(
      textRow(`  no records in the last ${DETAIL_HISTORY_DAYS} days`, width),
    );
  }
  if (days.length > 0) {
    rows.push(
      textRow(
        `  ${"day".padEnd(5)} ${"in".padStart(6)} ${"hit".padStart(6)} ${"write".padStart(6)} ${"out".padStart(6)} ${"cost".padStart(10)}`,
        width,
      ),
    );
  }
  for (const day of days) {
    const totals = byDay.get(day);
    if (!totals) continue;
    const cost = totals.cost.total > 0 ? money(totals.cost.total) : "—";
    const columns = [
      formatCompact(totals.prompt).padStart(6),
      formatCompact(totals.cachedInput).padStart(6),
      formatCompact(totals.cacheWrite).padStart(6),
      formatCompact(totals.completion).padStart(6),
      cost.padStart(10),
    ];
    rows.push(textRow(`  ${day.slice(5)} ${columns.join(" ")}`, width));
  }

  return rows;
}
