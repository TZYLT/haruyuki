/**
 * Rows the memory diff renderer occupies.
 *
 * `MemoryDiffRenderer` (retired `memory` / `memory_apply_patch` tools, kept so
 * saved transcripts still render) lays out a per-command summary plus a preview
 * of the changed content, with its own caps. The full-screen shell has to
 * predict those rows without rendering, so the layout is mirrored here.
 *
 * Exact for every `memory` command and for `memory_apply_patch`. The one
 * approximation is `str_replace`: the renderer runs a line diff (`diff.diffLines`)
 * and shows at most `MEMORY_STR_REPLACE_MAX_ROWS` changed lines, and running that
 * diff here would duplicate its row selection. The bound treats every old and new
 * line as a changed line measured at its wrapped width, so it over-estimates
 * rather than hiding a change.
 *
 * Pure and I/O-free: it only reads the tool's own argument JSON.
 */

import { countTextRows } from "@/cli/helpers/text-metrics";

/** Rows the renderer shows behind a 4-column indent. */
const MEMORY_INDENT_WIDTH = 4;

/** Cap on the `str_replace` preview rows (mirrors the renderer). */
const MEMORY_STR_REPLACE_MAX_ROWS = 10;

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

  const contentWidth = Math.max(1, columns - MEMORY_INDENT_WIDTH);
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
  const contentWidth = Math.max(1, columns - MEMORY_INDENT_WIDTH);
  const contextWidth = Math.max(1, columns - MEMORY_INDENT_WIDTH - 2);
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

/** Documented over-estimate for the `memory str_replace` diff (see module doc). */
function memoryStrReplaceRows(
  oldStr: string,
  newStr: string,
  blockName: string,
  contentWidth: number,
): number {
  const candidates = [
    ...oldStr.split("\n").map((line) => `- ${line}`),
    ...newStr.split("\n").map((line) => `+ ${line}`),
  ];
  let widestRow = 1;
  for (const candidate of candidates) {
    widestRow = Math.max(widestRow, countTextRows(candidate, contentWidth));
  }
  const shown = Math.min(MEMORY_STR_REPLACE_MAX_ROWS, candidates.length);
  return (
    countTextRows(`Updated memory block ${blockName}`, contentWidth) +
    shown * widestRow +
    (candidates.length > MEMORY_STR_REPLACE_MAX_ROWS ? 1 : 0)
  );
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
