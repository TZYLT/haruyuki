/**
 * Rows the memory diff renderer occupies.
 *
 * `MemoryDiffRenderer` (retired `memory` / `memory_apply_patch` tools, kept so
 * saved transcripts still render) lays out a per-command summary plus a preview
 * of the changed content, with its own caps. The full-screen shell has to
 * predict those rows without rendering, so the layout is mirrored here.
 *
 * Exact for every `memory` command and for `memory_apply_patch` — including
 * `str_replace`, whose preview rows are the renderer's own selection
 * (`helpers/memory-diff-rows.ts`). It used to be an over-estimate instead: every
 * old and new line counted at the widest row's height, which claimed 35 rows for a
 * preview that draws four and left the viewport believing an empty band was full
 * (2026-10-20).
 *
 * Pure and I/O-free: it only reads the tool's own argument JSON.
 */

import {
  memoryContentWidth,
  memoryContextWidth,
  selectMemoryDiffRows,
} from "@/cli/helpers/memory-diff-rows";
import { countTextRows } from "@/cli/helpers/text-metrics";

/** Cap on the `memory_apply_patch` preview lines (mirrors the renderer). */
const MEMORY_PATCH_MAX_LINES = 8;

/** Cap on the `create` preview lines (mirrors the renderer). */
const MEMORY_CREATE_PREVIEW_LINES = 3;

/** Cap on characters the `create` preview shows per line. */
const MEMORY_CREATE_LINE_MAX_CHARS = 60;

/** Cap on characters the `create` header shows of the description. */
const MEMORY_DESCRIPTION_MAX_CHARS = 40;

/**
 * Rows `MemoryDiffRenderer` occupies for a memory tool call. Returns 0 when the
 * args are not parseable JSON, which is what the renderer's null return renders.
 */
export function memoryResultRows(
  rawName: string,
  argsText: string,
  columns: number,
): number {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argsText) as Record<string, unknown>;
  } catch {
    return 0;
  }

  if (rawName === "memory_apply_patch") {
    return memoryPatchRows(args, columns);
  }

  const contentWidth = memoryContentWidth(columns);
  const command = args.command;
  const path =
    firstString(args, ["file_path", "path", "old_path"]) ?? "unknown";
  const blockName = memoryBlockName(path);

  switch (command) {
    case "str_replace": {
      const oldStr = firstString(args, ["old_string", "old_str"]) ?? "";
      const newStr = firstString(args, ["new_string", "new_str"]) ?? "";
      return memoryStrReplaceRows(oldStr, newStr, blockName, contentWidth);
    }
    case "insert": {
      const insertText = firstString(args, ["insert_text"]) ?? "";
      const insertLine = args.insert_line;
      const header = `Inserted into memory block ${blockName}${
        insertLine !== undefined ? ` at line ${insertLine}` : ""
      }`;
      return (
        countTextRows(header, contentWidth) +
        insertText
          .split("\n")
          .reduce(
            (total, line) => total + countTextRows(`+ ${line}`, contentWidth),
            0,
          )
      );
    }
    case "create": {
      const description = firstString(args, ["description"]) ?? "";
      const fileText = firstString(args, ["file_text"]) ?? "";
      const header = description
        ? `Created memory block ${blockName} - ${truncateForMemory(
            description,
            MEMORY_DESCRIPTION_MAX_CHARS,
          )}`
        : `Created memory block ${blockName}`;
      const fileLines = fileText.split("\n");
      let rows = countTextRows(header, contentWidth);
      for (const line of fileLines.slice(0, MEMORY_CREATE_PREVIEW_LINES)) {
        rows += countTextRows(
          `+ ${truncateForMemory(line, MEMORY_CREATE_LINE_MAX_CHARS)}`,
          contentWidth,
        );
      }
      if (fileText && fileLines.length > MEMORY_CREATE_PREVIEW_LINES) {
        rows += 1;
      }
      return rows;
    }
    case "delete":
      return countTextRows(`Deleted memory block ${blockName}`, contentWidth);
    case "rename": {
      const newPath = firstString(args, ["new_path"]) ?? "";
      if (args.description) {
        return countTextRows(
          `Updated description of ${blockName}`,
          contentWidth,
        );
      }
      return countTextRows(
        `Renamed ${blockName} to ${memoryBlockName(newPath)}`,
        contentWidth,
      );
    }
    default:
      return countTextRows(
        `Memory operation: ${String(command)} on ${blockName}`,
        contentWidth,
      );
  }
}

/** Rows `PatchDiffRenderer` occupies for `memory_apply_patch`. */
function memoryPatchRows(
  args: Record<string, unknown>,
  columns: number,
): number {
  const contentWidth = memoryContentWidth(columns);
  const contextWidth = memoryContextWidth(columns);
  const patch = typeof args.input === "string" ? args.input : "";
  const lines = patch.split("\n");

  let rows = countTextRows("Patched memory block memory", contentWidth);
  for (const line of lines.slice(0, MEMORY_PATCH_MAX_LINES)) {
    if (line.startsWith("@@")) continue;
    const marker = line[0];
    const content = line.slice(1);
    if (marker === "+") {
      rows += countTextRows(`+ ${content}`, contentWidth);
    } else if (marker === "-") {
      rows += countTextRows(`- ${content}`, contentWidth);
    } else if (marker === " ") {
      rows += countTextRows(content, contextWidth);
    } else {
      rows += countTextRows(line, contentWidth);
    }
  }
  if (lines.length > MEMORY_PATCH_MAX_LINES) rows += 1;
  return rows;
}

/**
 * Rows the `memory str_replace` preview occupies.
 *
 * Exact, and it used to not be: the first version took every old and new line,
 * measured the **widest** one and multiplied by the number of candidates — a
 * deliberate over-estimate that produced 35 rows for a preview that draws four.
 * The viewport believed the band was full and stopped asking for items, which the
 * machine reported as "big blocks of text vanish while scrolling" (2026-10-20,
 * `blankTail=19` with `tool_call(memory):35` in the window).
 *
 * The rows are the renderer's own selection (`memory-diff-rows.ts`), each measured
 * at the box it is drawn in: the same 4-column indent for every line.
 */
function memoryStrReplaceRows(
  oldStr: string,
  newStr: string,
  blockName: string,
  contentWidth: number,
): number {
  const { rows, hiddenCount } = selectMemoryDiffRows(oldStr, newStr);
  let total = countTextRows(`Updated memory block ${blockName}`, contentWidth);
  for (const row of rows) {
    const prefix = row.type === "add" ? "+" : "-";
    total += countTextRows(`${prefix} ${row.content}`, contentWidth);
  }
  if (hiddenCount > 0) total += 1;
  return total;
}

/** First non-empty string among `keys`. */
function firstString(
  args: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/** The block name the memory renderer shows (last path segment). */
function memoryBlockName(path: string): string {
  return path.split("/").pop() || path;
}

/** Mirror of the memory renderer's private `truncate`. */
function truncateForMemory(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}
