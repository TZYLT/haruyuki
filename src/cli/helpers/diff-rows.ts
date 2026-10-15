/**
 * Diff line layout, shared by the diff renderers and the transcript row model.
 *
 * The advanced and simple diff renderers split every line into full-width rows so
 * each row can carry its own background colour. The full-screen shell has to know
 * how many rows that produces *without* rendering, so the chunk layout lives here
 * once: the renderers colour these chunks, and the row model counts them with the
 * same splitter (`paddedRows`). A row count derived from different layout code
 * would disagree with the renderer about where the transcript starts and stops.
 *
 * Colours are deliberately not part of this module — only chunk boundaries and
 * text widths affect the row count — which keeps this a pure, React-free helper
 * that the row model can import without dragging Ink in.
 */

import { relative } from "node:path";
import type { AdvancedDiffSuccess } from "@/cli/helpers/diff";
import {
  countTextRows,
  paddedRows,
  type StyledChunk,
  wrappedRowCount,
} from "@/cli/helpers/text-metrics";

/** Width a tab expands to before a diff line is laid out. */
export const DIFF_TAB_WIDTH = 4;

/** Gutter the `  └  ` result prefix occupies. */
export const DIFF_RESULT_GUTTER = 4;

/** Indent the simple diff renderers put before their line-number gutter. */
export const SIMPLE_DIFF_INDENT = "    ";

export type DiffRowKind = "context" | "remove" | "add";

/** A syntax-highlighted piece of a diff line body. */
export interface DiffSyntaxSpan {
  text: string;
  color?: string;
}

/**
 * Path form the advanced diff header uses (relative, `./`-prefixed; the absolute
 * path when the file lives outside the working directory).
 */
export function advancedDiffHeaderPath(filePath: string): string {
  const cwd = process.cwd();
  const relativePath = relative(cwd, filePath);
  return relativePath.startsWith("..") ? relativePath : `./${relativePath}`;
}

/**
 * Path form the simple diff renderers use (relative without `./`; the absolute
 * path when the file lives outside the working directory).
 */
export function simpleDiffDisplayPath(filePath: string): string {
  const cwd = process.cwd();
  const relativePath = relative(cwd, filePath);
  return relativePath.startsWith("..") ? filePath : relativePath;
}

export interface DiffLineInput {
  kind: DiffRowKind;
  /** Number shown in the gutter; ignored when `layout.gutter` is supplied. */
  displayNo: number;
  /** Plain line body, used when there are no syntax spans. */
  text: string;
  /** Syntax-highlighted pieces of the body; they replace `text` when present. */
  syntaxSpanTexts?: readonly string[];
}

export interface DiffLineLayout {
  /** Indent before the gutter (blank on continuation rows). */
  indent: string;
  /** Gutter width used for padded numbers. Ignored when `gutter` is set. */
  gutterWidth: number;
  /** Literal gutter text; replaces the padded number when supplied. */
  gutter?: string;
  /** Gap between the sign and the body. */
  gap?: string;
}

export interface DiffLineChunk {
  text: string;
  role: "indent" | "gutter" | "symbol" | "gap" | "content";
  /** When set, the chunk is `syntaxSpanTexts[index]` of the same input. */
  syntaxIndex?: number;
}

export interface DiffLineChunks {
  chunks: DiffLineChunk[];
  /** Blank indent a continuation row starts with. */
  contIndent: number;
}

export function expandTabsForDiffDisplay(text: string): string {
  return text.replaceAll("\t", " ".repeat(DIFF_TAB_WIDTH));
}

function padLeft(value: number, width: number): string {
  const text = String(value);
  return text.length >= width ? text : " ".repeat(width - text.length) + text;
}

/**
 * Chunk layout for one diff line: `indent + gutter + sign + gap + body`.
 * The continuation indent repeats every non-body chunk's width so wrapped rows
 * line up under the body.
 */
export function buildDiffLineChunks(
  input: DiffLineInput,
  layout: DiffLineLayout,
): DiffLineChunks {
  const symbol =
    input.kind === "add" ? "+" : input.kind === "remove" ? "-" : " ";
  const gutter =
    layout.gutter ?? `${padLeft(input.displayNo, layout.gutterWidth)} `;
  const gap = layout.gap ?? " ";
  const chunks: DiffLineChunk[] = [];
  if (layout.indent) chunks.push({ text: layout.indent, role: "indent" });
  chunks.push({ text: gutter, role: "gutter" });
  chunks.push({ text: symbol, role: "symbol" });
  chunks.push({ text: gap, role: "gap" });
  if (input.syntaxSpanTexts && input.syntaxSpanTexts.length > 0) {
    input.syntaxSpanTexts.forEach((text, index) => {
      chunks.push({
        text: expandTabsForDiffDisplay(text),
        role: "content",
        syntaxIndex: index,
      });
    });
  } else {
    chunks.push({
      text: expandTabsForDiffDisplay(input.text),
      role: "content",
    });
  }

  // Continuation indent = indent + gutter + sign + gap (blank, same width).
  const contIndent = layout.indent.length + gutter.length + 1 + gap.length;
  return { chunks, contIndent };
}

/** Style-free projection used for measuring: colours never affect width. */
function toMeasurableChunks(chunks: readonly DiffLineChunk[]): StyledChunk[] {
  return chunks.map((chunk) => ({ text: chunk.text }));
}

/** Rows one diff line occupies at `columns`, split exactly as the renderer does. */
export function diffLineRowCount(
  input: DiffLineInput,
  layout: DiffLineLayout,
  columns: number,
): number {
  const { chunks, contIndent } = buildDiffLineChunks(input, layout);
  return paddedRows(toMeasurableChunks(chunks), columns, contIndent).length;
}

/** Gutter width for a set of diff rows (fits the largest display number). */
export function diffGutterWidth(displayNos: readonly number[]): number {
  const max = displayNos.reduce((m, value) => Math.max(m, value), 1);
  return String(max).length;
}

/** One renderable diff line, as produced by a hunk walk. */
export interface AdvancedDiffRenderRow {
  kind: DiffRowKind;
  displayNo: number;
  text: string;
  syntaxSpans?: DiffSyntaxSpan[];
}

/**
 * Walk diff hunks into render rows: skips `\ No newline` meta lines, numbers old
 * and new lines separately, and marks each row's kind.
 */
export function buildAdvancedDiffRows(
  hunks: AdvancedDiffSuccess["hunks"],
  hunkSyntaxLines: (DiffSyntaxSpan[] | undefined)[][] = [],
): AdvancedDiffRenderRow[] {
  const rows: AdvancedDiffRenderRow[] = [];

  for (let hunkIndex = 0; hunkIndex < hunks.length; hunkIndex++) {
    const hunk = hunks[hunkIndex];
    if (!hunk) {
      continue;
    }

    const syntaxForHunk = hunkSyntaxLines[hunkIndex] ?? [];
    let oldNo = hunk.oldStart;
    let newNo = hunk.newStart;
    let displayLineIdx = 0; // index into syntaxForHunk
    for (const line of hunk.lines) {
      if (!line) continue;
      const raw = line.raw || "";
      const ch = raw.charAt(0);
      const body = raw.slice(1);
      // Skip meta lines (e.g., "\ No newline at end of file")
      if (ch === "\\") continue;

      const spans = syntaxForHunk[displayLineIdx];
      displayLineIdx++;

      if (ch === " ") {
        rows.push({
          kind: "context",
          displayNo: newNo,
          text: body,
          syntaxSpans: spans,
        });
        oldNo++;
        newNo++;
      } else if (ch === "-") {
        rows.push({
          kind: "remove",
          displayNo: oldNo,
          text: body,
          syntaxSpans: spans,
        });
        oldNo++;
      } else if (ch === "+") {
        rows.push({
          kind: "add",
          displayNo: newNo,
          text: body,
          syntaxSpans: spans,
        });
        newNo++;
      } else {
        rows.push({
          kind: "context",
          displayNo: newNo,
          text: raw,
          syntaxSpans: spans,
        });
        oldNo++;
        newNo++;
      }
    }
  }

  return rows;
}

/** Header text the advanced renderer prints above a diff. */
export function advancedDiffHeaderText(
  kind: "write" | "edit",
  filePath: string,
): string {
  const path = advancedDiffHeaderPath(filePath);
  return kind === "write" ? `Wrote changes to ${path}` : `Updated ${path}`;
}

/** Rows one of the advanced renderer's `  └` header boxes occupies. */
function diffHeaderBoxRows(text: string, columns: number): number {
  return countTextRows(text, Math.max(1, columns - DIFF_RESULT_GUTTER));
}

export interface AdvancedDiffMeasureOptions {
  columns: number;
  /** Whether the renderer draws the header (everything except inline previews). */
  showHeader: boolean;
  kind: "write" | "edit";
  filePath: string;
  /**
   * Syntax-highlighted lines per hunk, as the renderer passes them. Omit to
   * measure the unhighlighted layout (the row model cannot run the highlighter).
   */
  hunkSyntaxLines?: (DiffSyntaxSpan[] | undefined)[][];
}

/**
 * Rows an `AdvancedDiffRenderer` instance occupies for a successful diff.
 *
 * Mirrors the renderer's branches: an empty diff renders the header plus the
 * "No changes" line, otherwise the header pair plus one entry per diff line.
 */
export function advancedDiffRowCount(
  result: AdvancedDiffSuccess,
  options: AdvancedDiffMeasureOptions,
): number {
  const { columns, showHeader, kind, filePath } = options;
  const rows = buildAdvancedDiffRows(result.hunks, options.hunkSyntaxLines);

  if (rows.length === 0) {
    const header = showHeader
      ? diffHeaderBoxRows(advancedDiffHeaderText(kind, filePath), columns)
      : 0;
    const noChanges = diffHeaderBoxRows(
      `No changes to ${advancedDiffHeaderPath(filePath)} (file content identical)`,
      columns,
    );
    return header + Math.max(1, noChanges);
  }

  const header = showHeader
    ? diffHeaderBoxRows(advancedDiffHeaderText(kind, filePath), columns) +
      diffHeaderBoxRows("Showing ~1 context line", columns)
    : 0;
  const gutterWidth = diffGutterWidth(rows.map((row) => row.displayNo));
  const indent = showHeader ? " ".repeat(DIFF_RESULT_GUTTER) : "";
  const body = rows.reduce(
    (total, row) =>
      total +
      diffLineRowCount(
        {
          kind: row.kind,
          displayNo: row.displayNo,
          text: row.text,
          syntaxSpanTexts: row.syntaxSpans?.map((span) => span.text),
        },
        { indent, gutterWidth },
        columns,
      ),
    0,
  );

  return header + body;
}

/** Header text `WriteRenderer` prints above the written content. */
export function writeRendererHeaderText(
  lineCount: number,
  filePath: string,
): string {
  return `Wrote ${lineCount} line${lineCount !== 1 ? "s" : ""} to ${simpleDiffDisplayPath(filePath)}`;
}

/** Header text `EditRenderer`/`MultiEditRenderer` print above the diff body. */
export function editRendererHeaderText(
  filePath: string,
  additions: number,
  removals: number,
): string {
  return `Updated ${simpleDiffDisplayPath(filePath)} with ${additions} addition${additions !== 1 ? "s" : ""} and ${removals} removal${removals !== 1 ? "s" : ""}`;
}

/** Rows a `WriteRenderer` instance occupies. */
export function writeRendererRowCount(
  content: string,
  filePath: string,
  columns: number,
): number {
  const contentWidth = Math.max(1, columns - DIFF_RESULT_GUTTER);
  const lines = content.split("\n");
  const header = countTextRows(
    writeRendererHeaderText(lines.length, filePath),
    contentWidth,
  );
  const body = lines.reduce(
    (total, line) => total + Math.max(1, wrappedRowCount(line, contentWidth)),
    0,
  );
  return header + body;
}

export interface SimpleDiffLineCountOptions {
  /** The transcript passes `false`; the components default to `true`. */
  showLineNumbers: boolean;
}

/** Rows the remove+add line blocks of one simple-diff edit occupy. */
function simpleDiffBlockRows(
  oldLines: readonly string[],
  newLines: readonly string[],
  columns: number,
  options: SimpleDiffLineCountOptions,
): number {
  const layout = (index: number): DiffLineLayout => ({
    indent: SIMPLE_DIFF_INDENT,
    gutterWidth: 0,
    gutter: options.showLineNumbers ? `${index + 1} ` : "",
    gap: "  ",
  });
  const removals = oldLines.reduce(
    (total, line, index) =>
      total +
      diffLineRowCount(
        { kind: "remove", displayNo: index + 1, text: line },
        layout(index),
        columns,
      ),
    0,
  );
  const additions = newLines.reduce(
    (total, line, index) =>
      total +
      diffLineRowCount(
        { kind: "add", displayNo: index + 1, text: line },
        layout(index),
        columns,
      ),
    0,
  );
  return removals + additions;
}

/** Rows an `EditRenderer` instance occupies. */
export function editRendererRowCount(
  filePath: string,
  oldString: string,
  newString: string,
  columns: number,
  options: SimpleDiffLineCountOptions = { showLineNumbers: false },
): number {
  const contentWidth = Math.max(1, columns - DIFF_RESULT_GUTTER);
  const oldLines = oldString.split("\n");
  const newLines = newString.split("\n");
  const header = countTextRows(
    editRendererHeaderText(filePath, newLines.length, oldLines.length),
    contentWidth,
  );
  return header + simpleDiffBlockRows(oldLines, newLines, columns, options);
}

/** Rows a `MultiEditRenderer` instance occupies. */
export function multiEditRendererRowCount(
  filePath: string,
  edits: readonly { old_string: string; new_string: string }[],
  columns: number,
  options: SimpleDiffLineCountOptions = { showLineNumbers: false },
): number {
  const contentWidth = Math.max(1, columns - DIFF_RESULT_GUTTER);
  let totalAdditions = 0;
  let totalRemovals = 0;
  for (const edit of edits) {
    // `MultiEditRenderer` counts its header with `countLines`, which reports 0
    // rows for an empty string (unlike `String.split("\n").length`).
    totalAdditions += edit.new_string ? edit.new_string.split("\n").length : 0;
    totalRemovals += edit.old_string ? edit.old_string.split("\n").length : 0;
  }
  const header = countTextRows(
    editRendererHeaderText(filePath, totalAdditions, totalRemovals),
    contentWidth,
  );
  const body = edits.reduce(
    (total, edit) =>
      total +
      simpleDiffBlockRows(
        edit.old_string.split("\n"),
        edit.new_string.split("\n"),
        columns,
        options,
      ),
    0,
  );
  return header + body;
}
