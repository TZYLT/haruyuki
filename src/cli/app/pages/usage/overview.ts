/**
 * The Usage overview screen (P5), docs/38 §14.6.
 *
 * Layout is a pure function of the summary and the room available, for the same
 * reason the aggregation is: the tier rules are a contract ("block art at ≥46
 * columns and ≥11 rows, one line below that"), and a contract that lives inside
 * a component is a contract nobody can test.
 *
 * **The spec's middle tier is not implemented, on purpose.** §14.6 asks for a
 * two-row quadrant rendering of the hero number that "expresses 10 pixels of
 * height", but the font table it fixes is five rows tall and there is no
 * ten-pixel bitmap anywhere in the spec. Downscaling the 3×5 table through
 * quadrants would give a two-row shape that cannot be read at three columns
 * wide, so the overview drops straight to the single-line tier. Recorded as a
 * pending decision in docs/39 §4.19 rather than faked.
 */

import type { PageRow } from "@/cli/app/pages/page-model";
import { terminalTextWidth } from "@/cli/helpers/char-width";
import { formatCompact } from "@/cli/helpers/format";
import { truncateText } from "@/cli/helpers/truncate-text";
import type { UsageRecord } from "@/usage/ledger";
import { formatCost, formatRate } from "./cost";
import { blockText, blockTextWidth, blockWordmark } from "./font";
import {
  buildHeatmap,
  HEATMAP_WEEKS,
  heatmapLines,
  padToWidth,
  startOfWeek,
} from "./heatmap";
import type { UsageSummary } from "./ledger-view";

/** The two tiers this screen really has (see the note above). */
export type OverviewTier = "block" | "line";

/** Columns the block tier needs; below it the hero is one line. */
export const OVERVIEW_BLOCK_MIN_WIDTH = 46;
/** Rows the block tier needs (wordmark + hero + heatmap + footer). */
export const OVERVIEW_BLOCK_MIN_HEIGHT = 18;

/** Which tier fits the room available. */
export function overviewTier(geometry: {
  width: number;
  height: number;
}): OverviewTier {
  return geometry.width >= OVERVIEW_BLOCK_MIN_WIDTH &&
    geometry.height >= OVERVIEW_BLOCK_MIN_HEIGHT
    ? "block"
    : "line";
}

/**
 * Put two blocks side by side, line by line.
 *
 * `left` is padded to `gutter` columns (the heatmap's own width), so the right
 * column starts in the same cell on every row — the whole point of putting the
 * numbers beside the grid instead of under it.
 */
export function columns(
  left: readonly string[],
  right: readonly string[],
  gutter: number,
  gap = 2,
): string[] {
  const rows = Math.max(left.length, right.length);
  const lines: string[] = [];
  for (let index = 0; index < rows; index += 1) {
    const leftLine = left[index] ?? "";
    const rightLine = right[index] ?? "";
    lines.push(
      rightLine === ""
        ? leftLine
        : `${padToWidth(leftLine, gutter)}${" ".repeat(gap)}${rightLine}`,
    );
  }
  return lines;
}

/** `今日 12.3k tok · 连续 4 天 · 今日缓存率 78%`, wrapped to the width. */
export function footerItems(summary: UsageSummary): string[] {
  return [
    `今日 ${formatCompact(summary.today.tokens)} tok`,
    `连续 ${summary.streakDays} 天`,
    `今日缓存率 ${formatRate(summary.today.cacheHitRate)}`,
  ];
}

/** Join the footer items, dropping to lines when they do not fit. */
function footerLines(summary: UsageSummary, width: number): string[] {
  const items = footerItems(summary);
  const joined = items.join("   ");
  // Terminal columns, not string length: these items are CJK and two cells wide.
  if (terminalTextWidth(joined) <= width) return [joined];
  return items;
}

/** The right-hand data block beside the heatmap. */
function dataLines(summary: UsageSummary): string[] {
  return [
    `总成本(API 估算)   ${formatCost(summary.totals.cost)}`,
    `总回合            ${summary.totals.turns}`,
    `今日              ${formatCost(summary.today.cost)} · ${summary.today.turns} 回合`,
  ];
}

/** `YYYY-MM-DD` in local time, without pulling a date library in. */
function dayLabel(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** `2026-09-28 – 2026-10-22`, the range the grid covers. */
export function rangeLabel(now: Date, weeks: number = HEATMAP_WEEKS): string {
  const start = startOfWeek(now);
  start.setDate(start.getDate() - 7 * (weeks - 1));
  return `${dayLabel(start)} – ${dayLabel(now)}`;
}

function textRow(text: string, width: number): PageRow {
  return { kind: "text", text: truncateText(text, width) };
}

function heroLines(summary: UsageSummary): string[] {
  return blockText(formatCompact(summary.totals.tokens));
}

/**
 * Build the overview's rows.
 *
 * `records` is needed only for the heatmap (it aggregates by day itself), the
 * summary carries everything else.
 */
export function buildOverviewRows(input: {
  summary: UsageSummary;
  records: readonly UsageRecord[];
  now: Date;
  width: number;
  height: number;
}): PageRow[] {
  const { summary, records, now, width, height } = input;
  const rows: PageRow[] = [];
  if (summary.recordCount === 0) {
    rows.push(textRow("还没有用量记录。", width));
    rows.push(
      textRow("跑完一轮对话后，这里会出现今天的 token、成本与热力图。", width),
    );
    return rows;
  }

  const grid = buildHeatmap(records, now);
  const heatmap = heatmapLines(grid);
  const heatmapBlock = [heatmap.title, heatmap.header, ...heatmap.rows];
  const tier = overviewTier({ width, height });

  if (tier === "block") {
    const wordmark = blockWordmark();
    const hero = heroLines(summary);
    const heroLabel = "tokens";
    const lines = [
      "",
      ...wordmark,
      "",
      ...hero,
      heroLabel,
      "",
      ...columns(heatmapBlock, dataLines(summary), heatmap.width),
      "",
    ];
    for (const line of lines) rows.push(textRow(line, width));
    for (const line of footerLines(summary, width)) {
      rows.push(textRow(line, width));
    }
    return rows;
  }

  // One-line tier: the hero number keeps the contract's format (`formatCompact`,
  // the same as `/usage`), and the art is dropped.
  rows.push(textRow(`${formatCompact(summary.totals.tokens)} tokens`, width));
  if (width >= heatmap.width) {
    for (const line of heatmapBlock) rows.push(textRow(line, width));
  }
  rows.push(
    textRow(
      `总成本 ${formatCost(summary.totals.cost)} · 总回合 ${summary.totals.turns}`,
      width,
    ),
  );
  for (const line of footerLines(summary, width)) {
    rows.push(textRow(line, width));
  }
  return rows;
}

/** Width the block tier's hero occupies; exported for the frame test. */
export function heroWidth(summary: UsageSummary): number {
  return blockTextWidth(formatCompact(summary.totals.tokens));
}
