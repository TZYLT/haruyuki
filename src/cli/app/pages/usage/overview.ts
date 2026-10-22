/**
 * The Usage overview screen (P5), docs/38 §14.6.
 *
 * Layout is a pure function of the summary and the room available, for the same
 * reason the aggregation is: the tier rules are a contract ("block art at ≥46
 * columns and ≥18 rows, one line below that"), and a contract that lives inside
 * a component is a contract nobody can test.
 *
 * **The second visual pass (2026-10-22).** The first version left everything
 * against the left edge, so the screen read as three unrelated left-aligned
 * blocks, and the wordmark ran straight into the hero number: the blank rows
 * between them were composed but *painted away* — Ink collapses an empty
 * `<Text>` to zero height, so a design can ask for a blank line and get none
 * (fixed in `page-frame.tsx`, which now paints an empty row as one space).
 * The block tier is now centred on the band's axis, the two big texts are
 * separated by a blank row, and the grid and the numbers sit in one two-column
 * block instead of two blocks at different indents.
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
import { formatCost, formatRate } from "@/cli/helpers/usage-format";
import type { UsageRecord } from "@/usage/ledger";
import type { UsageSummary } from "@/usage/summary";
import { blockText, blockTextWidth, blockWordmark } from "./font";
import {
  buildHeatmap,
  gridWidth,
  HEATMAP_WEEKS,
  heatmapLines,
  padToWidth,
  startOfWeek,
} from "./heatmap";

/** The two tiers this screen really has (see the note above). */
export type OverviewTier = "block" | "line";

/**
 * Columns the block tier needs.
 *
 * The widest row is not the art (31 columns) but the `today … · today hit … ·
 * streak …` line under the grid: 49 columns for a four-digit compact number, and
 * it must never be cut, so the minimum is that plus a column of air. Narrower
 * than this the hero drops to one line instead of printing a truncated summary.
 */
export const OVERVIEW_BLOCK_MIN_WIDTH = 50;
/**
 * Rows the block tier needs, exactly what it draws: a blank under the page's
 * header, the wordmark (5), a blank, the hero (5), the unit, a blank, the
 * two-column block (6), a blank, and the today/streak line.
 *
 * The two blanks are the ones the M6.5 pass asked for ("多隔一个空行"): the art
 * used to start on the header's row and the grid used to start on the unit's.
 */
export const OVERVIEW_BLOCK_MIN_HEIGHT = 22;

/** The unit under the hero number. */
const HERO_UNIT = "tokens";

/** Labels and values line up in the right-hand column. */
const DATA_LABEL_WIDTH = 14;

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

/** Center one line in `width`. */
export function centerLine(text: string, width: number): string {
  const pad = Math.max(0, Math.floor((width - gridWidth(text)) / 2));
  return `${" ".repeat(pad)}${text}`;
}

/**
 * Center a block: every line gets **one** left margin.
 *
 * Per-line centring would stagger a block whose lines differ in width (the data
 * column is narrower than the heatmap beside it), which reads as broken rather
 * than centred. A shared margin keeps the block's own columns intact.
 */
export function centerBlock(lines: readonly string[], width: number): string[] {
  const widest = lines.reduce((max, line) => Math.max(max, gridWidth(line)), 0);
  const pad = " ".repeat(Math.max(0, Math.floor((width - widest) / 2)));
  return lines.map((line) => `${pad}${line}`);
}

/**
 * Put two blocks side by side, line by line, padded to one uniform width.
 *
 * `left` is padded to `gutter` columns (the heatmap's own width), so the right
 * column starts in the same cell on every row — the whole point of putting the
 * numbers beside the grid instead of under it. The result is a rectangle, so
 * `centerBlock` can place it without the rows sliding against each other.
 */
export function twoColumnBlock(
  left: readonly string[],
  right: readonly string[],
  gutter: number,
  gap = 2,
): string[] {
  const rightWidth = right.reduce(
    (max, line) => Math.max(max, gridWidth(line)),
    0,
  );
  const width = gutter + gap + rightWidth;
  const rows = Math.max(left.length, right.length);
  const lines: string[] = [];
  for (let index = 0; index < rows; index += 1) {
    const leftLine = left[index] ?? "";
    const rightLine = right[index] ?? "";
    const line =
      rightLine === ""
        ? leftLine
        : `${padToWidth(leftLine, gutter)}${" ".repeat(gap)}${rightLine}`;
    lines.push(padToWidth(line, width));
  }
  return lines;
}

/** `1 day` / `4 days`. */
export function streakLabel(days: number): string {
  return days === 1 ? "1 day" : `${days} days`;
}

/**
 * The right-hand numbers beside the grid.
 *
 * Totals first, then today's — the same order the M6.5 report drew it in. The
 * three figures that *are* today (tokens, hit rate, streak) are not repeated here:
 * they read better as one line under the grid, where each of them can carry its
 * own label without a 14-column column around it.
 */
function dataLines(summary: UsageSummary): string[] {
  const row = (label: string, value: string) =>
    `${label.padEnd(DATA_LABEL_WIDTH)}${value}`;
  return [
    row("total cost", formatCost(summary.totals.cost)),
    row("total tokens", formatCompact(summary.totals.tokens)),
    row("total turns", `${summary.totals.turns}`),
    row("today cost", formatCost(summary.today.cost)),
    row("today turns", `${summary.today.turns}`),
  ];
}

/**
 * The one line under the grid: today's three figures.
 *
 * Which ones live here rather than in the column is the M6.5 ruling — today's
 * consumption, the cache hit rate and the streak are the "how is it going right
 * now" trio, and reading them left to right on one line is faster than scanning a
 * six-row column. Its width (49 at four digits) is what sets
 * `OVERVIEW_BLOCK_MIN_WIDTH`.
 */
export function todaySummaryLine(summary: UsageSummary): string {
  return [
    `today ${formatCompact(summary.today.tokens)} tok`,
    `today hit ${formatRate(summary.today.cacheHitRate)}`,
    `streak ${streakLabel(summary.streakDays)}`,
  ].join(" · ");
}

/**
 * The one-line tier's items: what the block tier puts in its data column,
 * without the column.
 */
export function summaryItems(summary: UsageSummary): string[] {
  return [
    `today ${formatCompact(summary.today.tokens)} tok`,
    `turns ${summary.totals.turns}`,
    `cost (est.) ${formatCost(summary.totals.cost)}`,
    `cache hit ${formatRate(summary.today.cacheHitRate)}`,
    `streak ${streakLabel(summary.streakDays)}`,
  ];
}

/** Join the items, dropping to one line each when they do not fit. */
function summaryLines(summary: UsageSummary, width: number): string[] {
  const items = summaryItems(summary);
  const joined = items.join(" · ");
  // Terminal columns, not string length: a wide glyph counts twice.
  if (terminalTextWidth(joined) <= width) return [joined];
  return items;
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

function textRow(text: string, width: number, dim = false): PageRow {
  return { kind: "text", text: truncateText(text, width), dim };
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
    rows.push(textRow("No usage recorded yet.", width));
    rows.push(textRow("A finished turn writes one line to the ledger;", width));
    rows.push(textRow("this page reads that file.", width));
    return rows;
  }

  const grid = buildHeatmap(records, now);
  const heatmap = heatmapLines(grid);
  const heatmapBlock = [heatmap.title, heatmap.header, ...heatmap.rows];

  if (overviewTier({ width, height }) === "block") {
    // A blank under the page's header, the wordmark, a blank, the number, its
    // unit, a blank, the grid beside the numbers, a blank, and today's line.
    // Every block is centred on the same axis (M6.5: the art used to start on the
    // header's own row and the grid on the unit's).
    rows.push(textRow("", width));
    for (const line of blockWordmark()) {
      rows.push(textRow(centerLine(line, width), width, true));
    }
    rows.push(textRow("", width));
    for (const line of heroLines(summary)) {
      rows.push(textRow(centerLine(line, width), width));
    }
    rows.push(textRow(centerLine(HERO_UNIT, width), width, true));
    rows.push(textRow("", width));
    const parallel = twoColumnBlock(
      heatmapBlock,
      dataLines(summary),
      heatmap.width,
      // Three columns of air: the grid's last cell and the label column are
      // both dense, and two columns read as one block.
      3,
    );
    for (const line of centerBlock(parallel, width)) {
      rows.push(textRow(line, width));
    }
    rows.push(textRow("", width));
    rows.push(textRow(centerLine(todaySummaryLine(summary), width), width));
    return rows;
  }

  // One-line tier: the hero keeps the contract's format (`formatCompact`, the
  // same as `/usage`), and the art is dropped rather than crammed.
  rows.push(textRow(`${formatCompact(summary.totals.tokens)} tokens`, width));
  if (width >= heatmap.width) {
    for (const line of heatmapBlock) rows.push(textRow(line, width));
  }
  for (const line of summaryLines(summary, width)) {
    rows.push(textRow(line, width));
  }
  return rows;
}

/** Width the block tier's hero occupies; exported for the frame test. */
export function heroWidth(summary: UsageSummary): number {
  return blockTextWidth(formatCompact(summary.totals.tokens));
}
