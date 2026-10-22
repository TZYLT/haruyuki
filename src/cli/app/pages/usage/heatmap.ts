/**
 * The overview's four-week heatmap (docs/38 §14.6): **one row per week, seven
 * columns for the weekdays**, newest week on top, labelled `now`/`-1w`/`-2w`/
 * `-3w`.
 *
 * Why weeks by weekday rather than GitHub's weeks-across: the spec chose it, and
 * it spends 4 rows instead of 7 — on a 30-row terminal the band is ~21 rows and
 * the hero plus the data column already use most of it.
 *
 * The level is a **quartile of the busiest day in the window**, not an absolute
 * threshold: an agent with 2k-token days and one with 2M-token days should both
 * see contrast. Zero stays zero, and the glyph ladder (`·░▒▓█`) means the grid
 * still reads when the terminal has no colour.
 */

import { terminalTextWidth } from "@/cli/helpers/char-width";
import type { UsageRecord } from "@/usage/ledger";
import { aggregateUsageByDay, usageDayKey } from "@/usage/ledger";

export const HEATMAP_WEEKS = 4;
export const HEATMAP_WEEKDAYS = 7;

/** Glyph per level; level 0 is "no turns that day". */
export const HEATMAP_GLYPHS = ["·", "░", "▒", "▓", "█"] as const;

const WEEKDAY_INITIALS = "MTWTFSS";

export interface HeatmapDay {
  /** Local day, `YYYY-MM-DD`. */
  dayKey: string;
  tokens: number;
  turns: number;
  /** 0 = quiet, 1..4 = quartile of the window's busiest day. */
  level: 0 | 1 | 2 | 3 | 4;
}

export interface HeatmapGrid {
  /** Oldest week first; every week is Monday..Sunday. */
  weeks: HeatmapDay[][];
  /** Busiest day in the window, the level denominator. */
  maxTokens: number;
}

/** Monday-based start of the week containing `date`. */
export function startOfWeek(date: Date): Date {
  const start = new Date(date.getTime());
  const weekday = (start.getDay() + 6) % 7; // Monday = 0
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - weekday);
  return start;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + days);
  return next;
}

function levelFor(tokens: number, maxTokens: number): 0 | 1 | 2 | 3 | 4 {
  if (tokens <= 0) return 0;
  if (maxTokens <= 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil((tokens / maxTokens) * 4))) as
    | 1
    | 2
    | 3
    | 4;
}

/** Total tokens of one day's bucket (the four billed buckets added up). */
function totalTokens(totals: {
  prompt: number;
  cachedInput: number;
  cacheWrite: number;
  completion: number;
}): number {
  return (
    totals.prompt + totals.cachedInput + totals.cacheWrite + totals.completion
  );
}

/**
 * Build the grid from the ledger, ending at the week that contains `now`.
 *
 * Days without records are present with zeroes: the grid is a calendar, and a
 * missing cell would shift every day after it into the wrong column.
 */
export function buildHeatmap(
  records: readonly UsageRecord[],
  now: Date = new Date(),
  weeks: number = HEATMAP_WEEKS,
): HeatmapGrid {
  const byDay = aggregateUsageByDay(records);
  const currentWeekStart = startOfWeek(now);
  const firstWeekStart = addDays(currentWeekStart, -7 * (weeks - 1));
  const grid: HeatmapDay[][] = [];
  let maxTokens = 0;

  for (let week = 0; week < weeks; week += 1) {
    const days: HeatmapDay[] = [];
    for (let weekday = 0; weekday < HEATMAP_WEEKDAYS; weekday += 1) {
      const date = addDays(firstWeekStart, week * 7 + weekday);
      const dayKey = usageDayKey(date);
      const totals = byDay.get(dayKey);
      const tokens = totals ? totalTokens(totals) : 0;
      maxTokens = Math.max(maxTokens, tokens);
      days.push({ dayKey, tokens, turns: totals?.turns ?? 0, level: 0 });
    }
    grid.push(days);
  }

  for (const days of grid) {
    for (const day of days) {
      day.level = levelFor(day.tokens, maxTokens);
    }
  }
  return { weeks: grid, maxTokens };
}

/** The label for week `index` counting back from the current one. */
export function weekLabel(indexFromNewest: number): string {
  return indexFromNewest === 0 ? "now" : `-${indexFromNewest}w`;
}

/** Pad with spaces to a terminal-column width (CJK counts as two). */
export function padToWidth(text: string, width: number): string {
  const current = terminalTextWidth(text);
  return current >= width ? text : text + " ".repeat(width - current);
}

/**
 * The heatmap as drawable lines, newest week **first**.
 *
 * `title` is the block's caption, `header` aligns the weekday initials under the
 * label column, and `rows` are the four weeks. The block is 17 columns wide
 * (`now ` + seven cells separated by spaces), which is what the overview uses to
 * place the data column beside it.
 *
 * The labels are English like the rest of the panel: `now`, `-1w`, `-2w`, `-3w`
 * are three columns each, so one trailing space puts every week's first cell in
 * the same column as the header's `M`.
 */
export function heatmapLines(grid: HeatmapGrid): {
  title: string;
  header: string;
  rows: string[];
  width: number;
} {
  const labelWidth = 4; // "now " — three columns of label plus one space
  const cells = HEATMAP_WEEKDAYS;
  const rows = [...grid.weeks].reverse().map((days, index) => {
    const cellsText = days
      .map((day) => HEATMAP_GLYPHS[day.level] ?? "·")
      .join(" ");
    return `${padToWidth(weekLabel(index), labelWidth)}${cellsText}`;
  });
  return {
    title: "Last 4 weeks",
    header: `${" ".repeat(labelWidth)}${[...WEEKDAY_INITIALS].join(" ")}`,
    rows,
    width: labelWidth + cells * 2 - 1,
  };
}
