/**
 * Markdown block row measurement.
 *
 * `MarkdownDisplay` classifies a block before it renders it; the full-screen
 * shell has to predict the resulting row count *without* rendering, so the block
 * walk lives here rather than in the row model's own module. It is a pure text
 * helper: the row model measures transcripts with it, and the tool-call row model
 * measures rendered markdown results with it, so neither has to import the other.
 */

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
import { inkStringWidth, wrappedRowCount } from "@/cli/helpers/text-metrics";

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
      rows += Math.max(1, wrappedRowCount(header[2], usable));
      index += 1;
      continue;
    }

    const list = line.match(LIST_ITEM_RE);
    if (list?.[2] && list[3] !== undefined) {
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

    if (HORIZONTAL_RULE_RE.test(line)) {
      rows += 1;
      index += 1;
      continue;
    }

    if (isTableStart(lines, index)) {
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
