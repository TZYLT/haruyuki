/**
 * Which lines a `memory str_replace` preview shows.
 *
 * The preview is a **line diff**: only the added and removed lines are drawn, at
 * most ten of them, then a "+N more lines" hint. The transcript row model has to
 * predict the height of that preview without rendering it, and it used to do so by
 * taking *every* old and new line, measuring the widest one, and multiplying — a
 * documented over-estimate ("so it over-estimates rather than hiding a change").
 * That estimate is what the machine saw as "big blocks of text vanish while
 * scrolling": a `memory` call whose estimate was 35 rows drew about four, and a
 * viewport that believes the band is full never asks for the next item
 * (`blankTail=19`, 2026-10-20).
 *
 * So the selection lives here, once, and both the renderer and the row model read
 * it — the same arrangement `shell-output.ts` uses for collapsed shell output. Two
 * copies of "which rows are showing" is exactly how the viewport drifts from what
 * is on the screen.
 */

import * as Diff from "diff";
import { ROW_SAFETY_COLUMNS } from "@/cli/display/statusline/formatting";

/** Columns the memory preview indents its content by. */
export const MEMORY_INDENT_WIDTH = 4;

/**
 * The width a memory preview line may occupy.
 *
 * One number, because two files draw and measure these lines: the renderer
 * (`MemoryDiffRenderer`) and the row model (`memory-result-rows`). It is
 * `columns - indent - ROW_SAFETY_COLUMNS`, and the margin is not decoration — the
 * machine reported "a memory diff on screen flickers, the selection lands on the
 * wrong rows, the tab row disappears" (2026-10-20), and the frame showed a lone `e`
 * on its own line: a wrapped preview line that ended **one column** past the
 * terminal. The terminal wrapped it, the frame grew a line, the alternate screen
 * scrolled, and every row the painter had measured moved by one.
 *
 * Ink wraps at the width it is given using a table that does not know how wide the
 * terminal draws `“`, `”` or `—`; two columns of slack absorb that disagreement, and
 * a line that ends inside the terminal cannot wrap.
 */
export function memoryContentWidth(columns: number): number {
  return Math.max(
    1,
    Math.floor(columns) - MEMORY_INDENT_WIDTH - ROW_SAFETY_COLUMNS,
  );
}

/** The narrower box a patch's context lines are drawn in. */
export function memoryContextWidth(columns: number): number {
  return Math.max(1, memoryContentWidth(columns) - 2);
}

/** Cap on the preview rows (the renderer's own limit). */
export const MEMORY_DIFF_MAX_ROWS = 10;

export interface MemoryDiffRow {
  type: "add" | "remove";
  content: string;
  /** The line this one replaces, when the two sides have the same count. */
  pairContent?: string;
}

export interface MemoryDiffSelection {
  /** The rows to draw, already capped. */
  rows: MemoryDiffRow[];
  /** Rows the diff has beyond the cap, for the "+N more lines" hint. */
  hiddenCount: number;
}

function splitLines(value: string): string[] {
  return value.replace(/\n$/, "").split("\n");
}

/**
 * Walk a line diff into the rows the preview draws.
 *
 * Unchanged lines are dropped, adjacent remove/add blocks of equal length are
 * paired so the renderer can highlight the changed words, and the result is capped
 * at `maxRows`.
 */
export function selectMemoryDiffRows(
  oldStr: string,
  newStr: string,
  maxRows: number = MEMORY_DIFF_MAX_ROWS,
): MemoryDiffSelection {
  const lineDiffs = Diff.diffLines(oldStr, newStr);
  const rows: MemoryDiffRow[] = [];

  for (let index = 0; index < lineDiffs.length; index += 1) {
    const part = lineDiffs[index];
    if (!part) continue;
    if (!part.added && !part.removed) continue;

    const lines = splitLines(part.value);

    if (part.removed) {
      const nextPart = lineDiffs[index + 1];
      const nextIsAdd = nextPart?.added === true;
      const nextLines = nextIsAdd && nextPart ? splitLines(nextPart.value) : [];
      for (const [lineIdx, line] of lines.entries()) {
        rows.push({
          type: "remove",
          content: line,
          pairContent:
            nextIsAdd && lines.length === nextLines.length
              ? nextLines[lineIdx]
              : undefined,
        });
      }
      continue;
    }

    const prevPart = lineDiffs[index - 1];
    const prevIsRemove = prevPart?.removed === true;
    const prevLines =
      prevIsRemove && prevPart ? splitLines(prevPart.value) : [];
    for (const [lineIdx, line] of lines.entries()) {
      rows.push({
        type: "add",
        content: line,
        pairContent:
          prevIsRemove && lines.length === prevLines.length
            ? prevLines[lineIdx]
            : undefined,
      });
    }
  }

  return {
    rows: rows.slice(0, maxRows),
    hiddenCount: Math.max(0, rows.length - maxRows),
  };
}
