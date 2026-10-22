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
  HEATMAP_WEEKS,
  heatmapLines,
  padToWidth,
  startOfWeek,
} from "./heatmap";

/** The two tiers this screen really has (see the note above). */
export type OverviewTier = "block" | "line";

/** Columns the block tier needs; below it the hero is one line. */
export const OVERVIEW_BLOCK_MIN_WIDTH = 46;
/**
 * Rows the block tier needs: wordmark (5) + gap + hero (5) + unit + the
 * two-column block (6). It is exactly what the block draws — a taller minimum
 * only says "there is unused room below"; a shorter one would scroll the block.
 */
export const OVERVIEW_BLOCK_MIN_HEIGHT = 18;

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
  const pad = Math.max(0, Math.floor((width - terminalTextWidth(text)) / 2));
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
  const widest = lines.reduce(
    (max, line) => Math.max(max, terminalTextWidth(line)),
    0,
  );
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
    (max, line) => Math.max(max, terminalTextWidth(line)),
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

/** The right-hand numbers beside the grid. */
function dataLines(summary: UsageSummary): string[] {
  const row = (label: string, value: string) =>
    `${label.padEnd(DATA_LABEL_WIDTH)}${value}`;
  return [
    row("cost (est.)", formatCost(summary.totals.cost)),
    row("total turns", `${summary.totals.turns}`),
    row("today tokens", formatCompact(summary.today.tokens)),
    row("today cost", formatCost(summary.today.cost)),
    row("today hit", formatRate(summary.today.cacheHitRate)),
    row("streak", streakLabel(summary.streakDays)),
  ];
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
    // Wordmark, a blank row, the number, its unit, then the grid beside the
    // numbers. Centred per block, all on the same axis.
    for (const line of blockWordmark()) {
      rows.push(textRow(centerLine(line, width), width, true));
    }
    rows.push(textRow("", width));
    for (const line of heroLines(summary)) {
      rows.push(textRow(centerLine(line, width), width));
    }
    rows.push(textRow(centerLine(HERO_UNIT, width), width, true));
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
