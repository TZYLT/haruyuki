/**
 * The Usage detail screen (P5), docs/38 §14.8.
 *
 * Plain text only: the overview owns the bars, the grid and the block art, and
 * this screen is what a person reads when they want the four cost buckets, the
 * context number, the per-model split and the last fourteen days.
 *
 * The percentage column means **share of all tokens** in the same scope, on
 * every row and in the history table. §14.8 fixes that convention only for the
 * history table; using one meaning everywhere is what keeps the two sections
 * comparable, and it makes the four buckets add up to 100%.
 */

import type { PageRow } from "@/cli/app/pages/page-model";
import { formatCompact } from "@/cli/helpers/format";
import { truncateText } from "@/cli/helpers/truncate-text";
import {
  aggregateUsageByDay,
  aggregateUsageByModel,
  type UsageRecord,
  usageDayKey,
} from "@/usage/ledger";
import {
  contextBreakdownTotal,
  type UsageContextBreakdown,
} from "@/utils/usage-context";
import { formatCost, formatCostAmount, formatPercent } from "./cost";
import type { UsageSummary } from "./ledger-view";

/** Days of history the screen shows (docs/38 §14.8). */
export const DETAIL_HISTORY_DAYS = 14;

function textRow(text: string, width: number): PageRow {
  return { kind: "text", text: truncateText(text, width) };
}

function headerRow(text: string): PageRow {
  return { kind: "header", text };
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
    rows.push(textRow("还没有用量记录。", width));
    rows.push(textRow("跑完一轮对话后再回到这里。", width));
    return rows;
  }

  const tokens = bucketTokens(records);
  const breakdown = summary.totals.costBreakdown;
  // No record in scope carried a price: the buckets are unknown, not zero.
  const priced = summary.totals.cost !== undefined;
  rows.push(headerRow(`成本（估算 ${formatCost(summary.totals.cost)}）`));
  const bucketRows: BucketRow[] = [
    {
      label: "输入 miss",
      tokens: tokens.miss,
      cost: priced ? breakdown.input : undefined,
    },
    {
      label: "输入 hit",
      tokens: tokens.hit,
      cost: priced ? breakdown.cacheRead : undefined,
    },
    {
      label: "缓存写",
      tokens: tokens.write,
      cost: priced ? breakdown.cacheWrite : undefined,
    },
    {
      label: "输出",
      tokens: tokens.output,
      cost: priced ? breakdown.output : undefined,
    },
  ];
  for (const bucket of bucketRows) {
    const label = bucket.label.padEnd(12);
    const count = formatCompact(bucket.tokens).padStart(7);
    const money = `¥ ${formatCostAmount(bucket.cost)}`.padStart(9);
    const share = formatPercent(bucket.tokens, tokens.total);
    rows.push(textRow(`  ${label}${count}  ${money}  ${share}`, width));
  }

  rows.push(headerRow("上下文成分（最近一回合估计）"));
  const contextTokens = latestContextTokens(records);
  const composition = latestContextBreakdown(records);
  if (composition) {
    const total = contextBreakdownTotal(composition);
    const occupancy =
      contextTokens !== undefined && contextWindow && contextWindow > 0
        ? `${formatCompact(contextTokens)} / ${formatCompact(contextWindow)} · ${formatPercent(contextTokens, contextWindow)}`
        : contextTokens !== undefined
          ? `${formatCompact(contextTokens)} tokens`
          : `${formatCompact(total)} tokens（估计）`;
    rows.push(textRow(`  ${occupancy}`, width));
    const parts: Array<{ label: string; tokens: number }> = [
      { label: "system", tokens: composition.system },
      { label: "tools", tokens: composition.tools },
      { label: "messages", tokens: composition.messages },
    ];
    for (const part of parts) {
      rows.push(
        textRow(
          `  ${part.label.padEnd(9)}${formatCompact(part.tokens).padStart(7)}  ${formatPercent(part.tokens, total)}`,
          width,
        ),
      );
    }
    // Memory is compiled into the system prompt locally, so a separate row
    // would be a guess. Say so instead of splitting it by eye.
    rows.push(textRow("  memory 本地并入 system，无法单列", width));
  } else {
    rows.push(
      textRow(
        contextTokens === undefined
          ? "  最近一回合没有报告占用量"
          : `  最近一回合 ${formatCompact(contextTokens)} tokens（本回合没有请求成分数据）`,
        width,
      ),
    );
  }

  rows.push(headerRow("按模型"));
  for (const [model, totals] of aggregateUsageByModel(records)) {
    const input = totals.prompt + totals.cachedInput + totals.cacheWrite;
    const cost = totals.cost.total > 0 ? formatCost(totals.cost.total) : "—";
    rows.push(
      textRow(
        `  ${model}  in ${formatCompact(input)}  out ${formatCompact(totals.completion)}  ${cost}`,
        width,
      ),
    );
  }

  rows.push(headerRow(`历史消耗（近 ${DETAIL_HISTORY_DAYS} 天）`));
  const byDay = aggregateUsageByDay(records);
  const days = recentDays(records, now);
  if (days.length === 0) {
    rows.push(textRow(`  近 ${DETAIL_HISTORY_DAYS} 天没有记录`, width));
  }
  for (const day of days) {
    const totals = byDay.get(day);
    if (!totals) continue;
    const dayTokens =
      totals.prompt +
      totals.cachedInput +
      totals.cacheWrite +
      totals.completion;
    const parts = [
      day.slice(5),
      `读${formatCompact(totals.prompt)} ${formatPercent(totals.prompt, dayTokens)}`,
      `缓${formatCompact(totals.cachedInput)} ${formatPercent(totals.cachedInput, dayTokens)}`,
      `写${formatCompact(totals.cacheWrite)} ${formatPercent(totals.cacheWrite, dayTokens)}`,
      `出${formatCompact(totals.completion)} ${formatPercent(totals.completion, dayTokens)}`,
      formatCost(totals.cost.total > 0 ? totals.cost.total : undefined),
    ];
    rows.push(textRow(`  ${parts.join(" ")}`, width));
  }

  return rows;
}
