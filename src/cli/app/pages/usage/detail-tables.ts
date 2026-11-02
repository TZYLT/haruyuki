/**
 * Column layout for the Usage detail screen's two tables (T-05).
 *
 * The page used to paste its tables together with inline `padStart`s: every
 * width was a literal in the row builder, the cost column assumed it would never
 * exceed eleven characters, the model column had no width at all, and the narrow
 * layout had nowhere to live. The widths, the truncation and the narrow/full
 * column set are layout, not data — they are pure functions over the cells that
 * `detail.ts` has already formatted, so they can be tested without a terminal and
 * the page body stays a list of rows.
 *
 * Two tables share one arithmetic on purpose:
 *
 * - both have the same **non-cost width**: `2` (indent) + `45` (every column but
 *   `cost`), so a single adaptive cost width decides the natural width of
 *   either table;
 * - `AUTOMATED_TABLE_FULL_WIDTH` (O-05) is that width with the minimum cost
 *   column, `47 + 11 = 58` columns: the complete `source/runs/in/hit/out/cost/hit%`
 *   table at its narrowest. Below it the page draws the narrow set
 *   (`source/in/hit/out/cost`) unless the user asks for the full table with `f`.
 *
 * The cost column is **adaptive** (R-05.9): it is the widest formatted cost cell
 * in the table, floored at `DETAIL_COST_MIN_WIDTH`, never a guess. A model with
 * expensive turns widens the table instead of shifting every column after it.
 */

import { truncateText } from "@/cli/helpers/truncate-text";
import { DETAIL_COST_MIN_WIDTH } from "@/cli/helpers/usage-format";

/** Columns every detail table is indented by, so it sits under its section title. */
export const DETAIL_TABLE_INDENT = "  ";

/** Width of the Automated tasks `source` column: `reflection` is exactly ten. */
export const AUTOMATED_SOURCE_WIDTH = 10;

/** Width of the `runs` cell, right-aligned. */
export const AUTOMATED_RUNS_WIDTH = 6;

/** Width of each token cell (`in` / `hit` / `out`), right-aligned. */
export const AUTOMATED_TOKEN_WIDTH = 7;

/** Width of the `hit%` cell, right-aligned two-decimal rate. */
export const AUTOMATED_HIT_RATE_WIDTH = 8;

/** Indent + every Automated tasks column except `cost`: 2+10+6+7+7+7+8. */
const AUTOMATED_NON_COST_WIDTH =
  2 +
  AUTOMATED_SOURCE_WIDTH +
  AUTOMATED_RUNS_WIDTH +
  AUTOMATED_TOKEN_WIDTH * 3 +
  AUTOMATED_HIT_RATE_WIDTH;

/** The complete Automated tasks table's natural width at the minimum cost width
 * (O-05): 47 + 11 = 58 columns. */
export const AUTOMATED_TABLE_FULL_WIDTH =
  AUTOMATED_NON_COST_WIDTH + DETAIL_COST_MIN_WIDTH;

/**
 * The model column is a **fixed** 24 columns in the wide case: long enough for
 * the usual `provider/model` handles, short enough that the fixed table stays
 * inside the content band. Longer names are cut with the ellipsis `truncateText`
 * appends; the numeric columns to their right never move.
 */
export const MODEL_COLUMN_MAX_WIDTH = 24;

/** A model name narrower than this is not worth a column: truncate to it. */
export const MODEL_COLUMN_MIN_WIDTH = 10;

/** How a column's cells are padded. Numbers go right, names go left. */
export type DetailColumnAlign = "left" | "right";

/** One column of a detail table. */
export interface DetailColumn {
  /** Stable identifier, for tests and for callers that build cells by key. */
  key: string;
  header: string;
  /** Terminal columns; left-aligned cells longer than this are ellipsized. */
  width: number;
  align: DetailColumnAlign;
}

/**
 * The width the Automated tasks table needs with this cost column.
 *
 * `AUTOMATED_TABLE_FULL_WIDTH` is the same number when the cost column is at its
 * floor (the O-05 58-column threshold); a wider cost cell moves the threshold by
 * exactly the growth, so the full table never wraps.
 */
export function automatedTableNaturalWidth(
  costWidth: number = DETAIL_COST_MIN_WIDTH,
): number {
  return AUTOMATED_NON_COST_WIDTH + Math.max(DETAIL_COST_MIN_WIDTH, costWidth);
}

/**
 * The Automated tasks columns.
 *
 * The narrow set drops `runs` and `hit%` and keeps `source/in/hit/out/cost`
 * (R-05.8); the full set is the spec's seven columns. `costWidth` comes from the
 * table's own formatted cost cells (`costColumnWidth`), so the column is exactly
 * as wide as it has to be.
 */
export function automatedTableColumns(input: {
  full: boolean;
  costWidth?: number;
}): readonly DetailColumn[] {
  const costWidth = Math.max(
    DETAIL_COST_MIN_WIDTH,
    input.costWidth ?? DETAIL_COST_MIN_WIDTH,
  );
  const columns: DetailColumn[] = [
    {
      key: "source",
      header: "source",
      width: AUTOMATED_SOURCE_WIDTH,
      align: "left",
    },
  ];
  if (input.full) {
    columns.push({
      key: "runs",
      header: "runs",
      width: AUTOMATED_RUNS_WIDTH,
      align: "right",
    });
  }
  columns.push(
    {
      key: "in",
      header: "in",
      width: AUTOMATED_TOKEN_WIDTH,
      align: "right",
    },
    {
      key: "hit",
      header: "hit",
      width: AUTOMATED_TOKEN_WIDTH,
      align: "right",
    },
    {
      key: "out",
      header: "out",
      width: AUTOMATED_TOKEN_WIDTH,
      align: "right",
    },
    { key: "cost", header: "cost", width: costWidth, align: "right" },
  );
  if (input.full) {
    columns.push({
      key: "hit%",
      header: "hit%",
      width: AUTOMATED_HIT_RATE_WIDTH,
      align: "right",
    });
  }
  return columns;
}

/**
 * The By model columns: `model/in/hit/out/cost` (R-05.2).
 *
 * The model column is fixed at {@link MODEL_COLUMN_MAX_WIDTH} when the band has
 * the room; below that it shrinks — never under
 * {@link MODEL_COLUMN_MIN_WIDTH} — so the row still fits and the numeric columns
 * keep their alignment instead of being pushed off the right edge. `cost` is
 * adaptive like the automated table's.
 */
export function modelTableColumns(input: {
  availableWidth: number;
  costWidth?: number;
}): readonly DetailColumn[] {
  const costWidth = Math.max(
    DETAIL_COST_MIN_WIDTH,
    input.costWidth ?? DETAIL_COST_MIN_WIDTH,
  );
  // What the model column may take: the band minus the indent, the three token
  // cells and the cost column.
  const room =
    input.availableWidth - (2 + AUTOMATED_TOKEN_WIDTH * 3 + costWidth);
  const modelWidth = Math.max(
    MODEL_COLUMN_MIN_WIDTH,
    Math.min(MODEL_COLUMN_MAX_WIDTH, room),
  );
  return [
    { key: "model", header: "model", width: modelWidth, align: "left" },
    { key: "in", header: "in", width: AUTOMATED_TOKEN_WIDTH, align: "right" },
    { key: "hit", header: "hit", width: AUTOMATED_TOKEN_WIDTH, align: "right" },
    { key: "out", header: "out", width: AUTOMATED_TOKEN_WIDTH, align: "right" },
    { key: "cost", header: "cost", width: costWidth, align: "right" },
  ];
}

/**
 * Render one table: a header line, then one line per cell row.
 *
 * Left-aligned cells are truncated with the ellipsis before they are padded —
 * padding first and cutting afterwards would shift every column after the long
 * name, which is the bug this module exists to prevent. Right-aligned cells are
 * numeric and sized to their content by the caller, so they are padded only.
 */
export function renderDetailTable(
  columns: readonly DetailColumn[],
  rows: readonly (readonly string[])[],
): string[] {
  return [
    tableLine(
      columns,
      columns.map((column) => column.header),
    ),
    ...rows.map((cells) => tableLine(columns, cells)),
  ];
}

function tableLine(
  columns: readonly DetailColumn[],
  cells: readonly string[],
): string {
  let line = DETAIL_TABLE_INDENT;
  for (let index = 0; index < columns.length; index += 1) {
    const column = columns[index];
    if (!column) continue;
    const cell = cells[index] ?? "";
    line +=
      column.align === "left"
        ? truncateText(cell, column.width).padEnd(column.width)
        : cell.padStart(column.width);
  }
  return line;
}
