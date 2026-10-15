/**
 * Transcript row model.
 *
 * Given a terminal width, how many rows does a transcript item occupy once it is
 * laid out? The full-screen shell answers this *without rendering* so it can
 * virtualize: it decides which items intersect the viewport and how tall the
 * scroll extent is.
 *
 * This module reuses the same measurement primitives the renderers use
 * (`@/cli/helpers/text-metrics`) and mirrors the block layout of
 * `MarkdownDisplay`. Where a renderer's row count depends on runtime display
 * state (ctrl+r / ctrl+t) or on a tool-specific body, the caller passes the state
 * in and the model documents the approximation. Nothing outside the tests
 * consumes this yet: the virtualized viewport is the first consumer.
 */

import type { StaticItem } from "@/cli/app/types";
import type { Line } from "@/cli/helpers/accumulator";
import { CLI_GLYPHS } from "@/cli/helpers/glyphs";
import {
  countTextRows,
  inkStringWidth,
  wrappedRowCount,
} from "@/cli/helpers/text-metrics";

/** Two-column gutter used by assistant/reasoning/error rows. */
export const TRANSCRIPT_GUTTER_WIDTH = 2;

/** Blank row `StaticTranscript` inserts between two committed items. */
export const STATIC_ITEM_GAP_ROWS = 1;

/** Cap on tool-argument rows, mirroring the previous height estimator. */
const TOOL_ARGS_MAX_ROWS = 5;

/** Approximate height of the welcome banner (it is a fixed template). */
const WELCOME_ROWS = 12;

/** Rows per subagent entry in a committed subagent group. */
const SUBAGENT_ROWS = 4;

export interface RowMeasureOptions {
  /** Total terminal columns. */
  columns: number;
  /** Full prompt prefix for user rows; defaults to `<glyph> `. */
  userPromptPrefix?: string;
  /** Whether collapsed reasoning rows render their body (ctrl+t). */
  reasoningExpanded?: boolean;
}

const HEADER_RE = /^(#{1,6})\s+(.*)$/;
const CODE_OPEN_RE = /^ *(`{3,}|~{3,}) *([^\s`~]*)?.*$/;
const CODE_CLOSE_RE = /^ *(`{3,}|~{3,}) *$/;
const LIST_RE = /^(\s*)([*\-+]|\d+\.)\s+(.*)$/;
const BLOCKQUOTE_RE = /^>\s*(.*)$/;
const HR_RE = /^[-*_]{3,}$/;
const TABLE_ROW_RE = /^\|(.+)\|$/;
const TABLE_SEP_RE = /^\|[\s:]*[-]+[\s:]*(\|[\s:]*[-]+[\s:]*)*\|$/;

/**
 * Rows a markdown block occupies at `width`, following `MarkdownDisplay`'s block
 * classification. Inline markers (`**bold**`, `` `code` ``) are not stripped, so
 * decorated text is over-estimated slightly — an over-estimate leaves a blank
 * row, an under-estimate hides content, and the render pass clips to the
 * measured height.
 */
export function markdownRowCount(text: string, width: number): number {
  if (!text) return 0;
  const usable = Math.max(1, width);
  const lines = text.split("\n");
  let rows = 0;
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";

    const codeOpen = line.match(CODE_OPEN_RE);
    if (codeOpen) {
      const fence = codeOpen[1] ?? "";
      index += 1;
      const codeLines: string[] = [];
      while (index < lines.length) {
        const inner = lines[index] ?? "";
        const close = inner.match(CODE_CLOSE_RE);
        if (
          close &&
          (close[1] ?? "").startsWith(fence[0] ?? "") &&
          (close[1] ?? "").length >= fence.length
        ) {
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
      rows += Math.max(1, wrappedRowCount(header[2], usable));
      index += 1;
      continue;
    }

    const list = line.match(LIST_RE);
    if (list && list[2] && list[3] !== undefined) {
      const bulletWidth = inkStringWidth(`${list[2]} `);
      const indent = (list[1] ?? "").length;
      const available = Math.max(1, usable - indent - bulletWidth);
      rows += Math.max(1, wrappedRowCount(list[3], available));
      index += 1;
      continue;
    }

    const blockquote = line.match(BLOCKQUOTE_RE);
    if (blockquote && blockquote[1] !== undefined) {
      rows += Math.max(
        1,
        wrappedRowCount(blockquote[1], Math.max(1, usable - 4)),
      );
      index += 1;
      continue;
    }

    if (HR_RE.test(line)) {
      rows += 1;
      index += 1;
      continue;
    }

    const nextLine = lines[index + 1];
    if (TABLE_ROW_RE.test(line) && nextLine && TABLE_SEP_RE.test(nextLine)) {
      let tableRows = 0;
      let tableIndex = index;
      while (
        tableIndex < lines.length &&
        TABLE_ROW_RE.test(lines[tableIndex] ?? "")
      ) {
        tableRows += 1;
        tableIndex += 1;
      }
      rows += Math.max(1, tableRows);
      index = tableIndex;
      continue;
    }

    if (line.trim() === "") {
      rows += 1;
      index += 1;
      continue;
    }

    rows += Math.max(1, wrappedRowCount(line, usable));
    index += 1;
  }

  return rows;
}

/** Rows for optional body text: absent text occupies no rows. */
function optionalTextRows(text: string | undefined, width: number): number {
  if (!text) return 0;
  return countTextRows(text, width);
}

/**
 * Rows a single transcript `Line` occupies at the given width.
 *
 * Approximations are noted per kind. They are deliberately conservative on the
 * bounded/streaming paths so the viewport never silently drops content.
 */
export function measureLineRows(
  line: Line,
  options: RowMeasureOptions,
): number {
  const columns = options.columns;
  const gutterWidth = TRANSCRIPT_GUTTER_WIDTH;
  const contentWidth = Math.max(0, columns - gutterWidth);

  switch (line.kind) {
    case "separator":
      return 1;

    case "trajectory_summary":
      return 1;

    case "status":
      return Math.max(1, line.lines.length);

    case "assistant":
      return markdownRowCount(line.text, contentWidth);

    case "reasoning": {
      if (line.isContinuation && !options.reasoningExpanded) return 0;
      if (!options.reasoningExpanded) return line.isContinuation ? 0 : 1;
      // Expanded: header + blank spacer + body.
      return 2 + markdownRowCount(line.text, contentWidth);
    }

    case "recall":
      return Math.max(1, markdownRowCount(line.text, contentWidth));

    case "error":
      // Approximation: the error renderer wraps its text in one block.
      return Math.max(1, countTextRows(line.text, Math.max(1, columns)));

    case "user": {
      const prefix = options.userPromptPrefix ?? `${CLI_GLYPHS.prompt} `;
      const prefixWidth = inkStringWidth(prefix);
      const usable = Math.max(1, columns - prefixWidth);
      // Approximation: reminder/recall blocks are measured as plain text and the
      // blank row between blocks is not counted (display state is caller-side).
      return Math.max(1, countTextRows(line.text, usable));
    }

    case "command":
    case "bash_command": {
      // Approximation: one input header row plus wrapped input and output.
      const usable = Math.max(1, columns);
      return (
        1 +
        optionalTextRows(line.input, usable) +
        optionalTextRows(line.output, usable)
      );
    }

    case "tool_call": {
      // Approximation: a header row plus bounded args and the result body. The
      // tool-specific renderers (edit/write/bash/diff) are measured exactly once
      // the viewport needs per-tool heights.
      const usable = Math.max(1, columns);
      const argsRows = Math.min(
        optionalTextRows(line.argsText, usable),
        TOOL_ARGS_MAX_ROWS,
      );
      const resultRows = optionalTextRows(line.resultText, usable);
      return 1 + argsRows + resultRows;
    }

    case "event": {
      const summaryRows = line.summary
        ? markdownRowCount(line.summary, Math.max(1, columns))
        : 0;
      return 1 + summaryRows;
    }

    default:
      return 1;
  }
}

/**
 * Rows a whole transcript item occupies, including the leading blank line that
 * `TranscriptItemView` inserts for every item after the first.
 *
 * `index` is the item's position in the rendered list (0 = first), so the caller
 * must pass the global index when rendering a window.
 */
export function measureTranscriptItemRows(
  item: StaticItem,
  options: RowMeasureOptions & { index: number },
): number {
  const gap = options.index > 0 ? STATIC_ITEM_GAP_ROWS : 0;
  const columns = Math.max(1, options.columns);

  switch (item.kind) {
    case "welcome":
      return gap + WELCOME_ROWS;
    case "subagent_group":
      return gap + Math.max(1, item.agents.length) * SUBAGENT_ROWS;
    case "approval_preview":
      return (
        gap +
        1 +
        Math.min(countTextRows(item.toolArgs, columns), TOOL_ARGS_MAX_ROWS)
      );
    default:
      return gap + measureLineRows(item, options);
  }
}
