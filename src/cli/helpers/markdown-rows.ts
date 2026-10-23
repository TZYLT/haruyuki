/**
 * Markdown block row measurement.
 *
 * `MarkdownDisplay` classifies a block before it renders it; the full-screen
 * shell has to predict the resulting row count *without* rendering, so the block
 * walk lives here rather than in the row model's own module. It is a pure text
 * helper: the row model measures transcripts with it, and the tool-call row model
 * measures rendered markdown results with it, so neither has to import the other.
 */

// The table layout *decision* is shared rather than re-derived. `MarkdownTable`
// picks between a grid (with its separator rows) and an aligned/stacked record
// list, and that choice depends on the width the renderer was given; a second
// copy of that math here is exactly the drift the module comments warn about.
//
// Deviation, deliberate: the M2 rule is that a pure helper does not import a
// component, and this helper imports one. Sharing the single layout
// implementation matters more — the alternative is a second copy of the
// grid/record decision, which is the failure mode the row model exists to avoid.
// The clean fix is to move the layout half of `MarkdownTable` into a helper both
// sides import; that is a sizeable move (the math and its private helpers live in
// a 650-line component) and belongs in its own change. Recorded in the review log.
import {
  layoutMarkdownTable,
  parseMarkdownTable,
  tableCellDisplayText,
} from "@/cli/components/MarkdownTable";
import {
  BLOCKQUOTE_RE,
  CODE_FENCE_OPEN_RE,
  HEADER_RE,
  HORIZONTAL_RULE_RE,
  isCodeFenceClose,
  isTableStart,
  LIST_ITEM_RE,
  TABLE_ROW_RE,
} from "@/cli/helpers/markdown-blocks";
import { inlineMarkdownDisplayText } from "@/cli/helpers/markdown-text";
import { inkStringWidth, wrappedRowCount } from "@/cli/helpers/text-metrics";

/** `MarkdownTable`'s constants, mirrored for the row math. */
const FIELD_LEADING_PADDING = 1;
const FIELD_GAP = 2;
const MIN_COLUMN_WIDTH = 3;
const RECORD_SEPARATOR_FALLBACK_WIDTH = 40;

export interface MarkdownRowOptions {
  /**
   * The `contentWidth` the caller's `MarkdownDisplay` receives. Table layout
   * depends on it: a table given no width lays out at its natural column widths,
   * a narrow one falls back to a record list. Omit it when the renderer passes
   * no `contentWidth`.
   */
  contentWidth?: number;
}

/**
 * Rows one markdown block occupies at `width`, following `MarkdownDisplay`'s block
 * classification.
 *
 * Inline markers are stripped before the width is taken
 * (`inlineMarkdownDisplayText`), because `InlineMarkdown` does not paint them:
 * counting `**`, `` ` `` or a link's brackets as visible columns made a styled
 * line measure one row taller than it drew whenever the extra columns crossed the
 * wrap boundary. That row is not cosmetic in the full-screen viewport — the
 * window is fitted from these numbers — so the text measured here has to be the
 * text the renderer wraps.
 */
export function markdownRowCount(
  text: string,
  width: number,
  options: MarkdownRowOptions = {},
): number {
  if (!text) return 0;
  const usable = Math.max(1, width);
  const lines = text.split("\n");
  let rows = 0;
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";

    const codeOpen = line.match(CODE_FENCE_OPEN_RE);
    if (codeOpen) {
      const fence = codeOpen[1] ?? "";
      index += 1;
      const codeLines: string[] = [];
      while (index < lines.length) {
        const inner = lines[index] ?? "";
        if (isCodeFenceClose(inner, fence)) {
          index += 1;
          break;
        }
        codeLines.push(inner);
        index += 1;
      }
      const body = codeLines.length > 0 ? codeLines : [""];
      rows += body.reduce(
        (total, codeLine) =>
          total + Math.max(1, wrappedRowCount(codeLine, usable)),
        0,
      );
      continue;
    }

    const header = line.match(HEADER_RE);
    if (header?.[1] && header[2] !== undefined) {
      rows += Math.max(
        1,
        wrappedRowCount(inlineMarkdownDisplayText(header[2]), usable),
      );
      index += 1;
      continue;
    }

    const list = line.match(LIST_ITEM_RE);
    if (list?.[2] && list[3] !== undefined) {
      const bulletWidth = inkStringWidth(`${list[2]} `);
      const indent = (list[1] ?? "").length;
      const available = Math.max(1, usable - indent - bulletWidth);
      rows += Math.max(
        1,
        wrappedRowCount(inlineMarkdownDisplayText(list[3]), available),
      );
      index += 1;
      continue;
    }

    const blockquote = line.match(BLOCKQUOTE_RE);
    if (blockquote && blockquote[1] !== undefined) {
      rows += Math.max(
        1,
        wrappedRowCount(
          inlineMarkdownDisplayText(blockquote[1]),
          Math.max(1, usable - 4),
        ),
      );
      index += 1;
      continue;
    }

    if (HORIZONTAL_RULE_RE.test(line)) {
      rows += 1;
      index += 1;
      continue;
    }

    if (isTableStart(lines, index)) {
      const tableLines: string[] = [];
      let tableIndex = index;
      while (
        tableIndex < lines.length &&
        TABLE_ROW_RE.test(lines[tableIndex] ?? "")
      ) {
        tableLines.push(lines[tableIndex] ?? "");
        tableIndex += 1;
      }
      rows += markdownTableRows(tableLines, usable, options.contentWidth);
      index = tableIndex;
      continue;
    }

    if (line.trim() === "") {
      rows += 1;
      index += 1;
      continue;
    }

    rows += Math.max(
      1,
      wrappedRowCount(inlineMarkdownDisplayText(line), usable),
    );
    index += 1;
  }

  return rows;
}

/**
 * Rows one cell's text occupies inside a cell `cellWidth` wide.
 *
 * A cell whose display text fits is padded to exactly `cellWidth` and therefore
 * occupies one row; a wider one is not padded at all and hard-wraps instead.
 */
function tableCellRows(value: string, cellWidth: number): number {
  const display = tableCellDisplayText(value);
  const width = Math.max(1, cellWidth);
  if (inkStringWidth(display) <= width) return 1;
  return wrappedRowCount(display, width);
}

/**
 * Rows a `MarkdownTable` occupies, in whichever of its three layouts the given
 * width selects: grid (`header + rule + 2n-1` rows), aligned records (one row
 * per field, the label and the value side by side) or stacked records (a label
 * row above each value).
 *
 * `width` is the caller's content width; `contentWidth` is the value its
 * `MarkdownDisplay` was given, which is what `MarkdownTable` itself uses to
 * decide between the layouts. The two differ only when the renderer passes no
 * `contentWidth` (then `width` is still the box the table sits in).
 */
function markdownTableRows(
  tableLines: string[],
  width: number,
  contentWidth: number | undefined,
): number {
  const table = parseMarkdownTable(tableLines);
  // A malformed table still renders as its own lines, one row each.
  if (!table) return Math.max(1, tableLines.length);

  const layout = layoutMarkdownTable(table, contentWidth);
  const rowCount = table.rows.length;
  if (rowCount === 0 && layout.mode !== "grid") return 0;

  if (layout.mode === "grid") {
    const gridRowRows = (row: readonly string[]): number =>
      row.reduce(
        (tallest, value, column) =>
          Math.max(
            tallest,
            tableCellRows(
              value,
              layout.columnWidths[column] ?? MIN_COLUMN_WIDTH,
            ),
          ),
        1,
      );
    // Header row, then the `━` rule, then the records with a `─` rule between
    // them and none after the last.
    let rows = gridRowRows(table.headers) + 1;
    for (let index = 0; index < rowCount; index += 1) {
      rows += gridRowRows(table.rows[index] ?? []);
      if (index + 1 < rowCount) rows += 1;
    }
    return rows;
  }

  if (layout.mode === "aligned-records") {
    // `FIELD_LEADING_PADDING` + the label box + the value box.
    const valueWidth = Math.max(
      1,
      width - FIELD_LEADING_PADDING - (layout.labelWidth + FIELD_GAP),
    );
    let rows = Math.max(0, rowCount - 1); // record separators
    for (const row of table.rows) {
      for (const value of row) rows += tableCellRows(value, valueWidth);
    }
    return Math.max(1, rows);
  }

  // Stacked records: a label row above each value, the value indented by 2.
  const valueWidth = Math.max(1, width - 2);
  let rows = 0;
  for (let index = 0; index < rowCount; index += 1) {
    const row = table.rows[index] ?? [];
    row.forEach((value, column) => {
      const label = table.headers[column] ?? `Column ${column + 1}`;
      rows += tableCellRows(label, Math.max(1, width - FIELD_LEADING_PADDING));
      rows += tableCellRows(value || " ", valueWidth);
    });
    if (index + 1 < rowCount) {
      rows += recordSeparatorRows(contentWidth, width);
    }
  }
  return Math.max(1, rows);
}

/** Rows `MarkdownTable`'s `RecordSeparator` occupies inside a `width` box. */
function recordSeparatorRows(
  contentWidth: number | undefined,
  width: number,
): number {
  const ruleWidth = Math.max(
    1,
    contentWidth ?? RECORD_SEPARATOR_FALLBACK_WIDTH,
  );
  return Math.max(
    1,
    wrappedRowCount("─".repeat(ruleWidth), Math.max(1, width)),
  );
}
