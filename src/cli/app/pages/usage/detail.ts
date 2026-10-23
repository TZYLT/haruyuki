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
 */

import type { PageRow } from "@/cli/app/pages/page-model";
import { formatCompact } from "@/cli/helpers/format";
import { truncateText } from "@/cli/helpers/truncate-text";
import {
  DETAIL_COST_DECIMALS,
  formatCost,
  formatPercent,
} from "@/cli/helpers/usage-format";
import {
  aggregateUsageByDay,
  aggregateUsageByModel,
  type UsageRecord,
  usageDayKey,
} from "@/usage/ledger";
import type { UsageSummary } from "@/usage/summary";
import {
  contextBreakdownTotal,
  type UsageContextBreakdown,
} from "@/utils/usage-context";

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

/** Build the detail screen's rows. */
export function buildDetailRows(input: {
  summary: UsageSummary;
  records: readonly UsageRecord[];
  now: Date;
  width: number;
  /** The conversation's context window, for the occupancy line. */
  contextWindow?: number | null;
}): PageRow[] {
  const { summary, records, now, width, contextWindow } = input;
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
    const total = contextBreakdownTotal(composition);
    const occupancy =
      contextTokens !== undefined && contextWindow && contextWindow > 0
        ? `${formatCompact(contextTokens)} / ${formatCompact(contextWindow)} · ${formatPercent(contextTokens, contextWindow)}`
        : contextTokens !== undefined
          ? `${formatCompact(contextTokens)} tokens`
          : `${formatCompact(total)} tokens (estimated)`;
    rows.push(textRow(`  ${occupancy}`, width));
    const parts: Array<{ label: string; tokens: number }> = [
      { label: "system", tokens: composition.system },
      { label: "tools", tokens: composition.tools },
      { label: "messages", tokens: composition.messages },
    ];
    for (const part of parts) {
      rows.push(
        textRow(
          `  ${part.label.padEnd(9)}${formatCompact(part.tokens).padStart(7)}  ${formatPercent(part.tokens, total).padStart(6)}`,
          width,
        ),
      );
    }
    // Memory is compiled into the system prompt locally, so a separate row
    // would be a guess. Say so instead of splitting it by eye.
    rows.push(
      textRow("  memory is folded into the system prompt locally", width),
    );
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
  for (const [model, totals] of aggregateUsageByModel(records)) {
    const input = totals.prompt + totals.cachedInput + totals.cacheWrite;
    const cost = totals.cost.total > 0 ? money(totals.cost.total) : "—";
    rows.push(
      textRow(
        `  ${model}  in ${formatCompact(input)}  out ${formatCompact(totals.completion)}  ${cost}`,
        width,
      ),
    );
  }

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
