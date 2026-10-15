/**
 * Per-tool transcript row heights.
 *
 * `ToolCallMessageRich` renders each tool family with its own body: a diff, a
 * shell output block, a todo list, a worktree summary, a one-line count. The
 * full-screen shell virtualizes the transcript, so it has to predict those row
 * counts *without* rendering. This module mirrors the renderer's branch order and
 * reuses the same pure layout helpers the renderer consumes
 * (`@/cli/helpers/diff-rows`, `tool-call-display`, `shell-output`), so the two
 * cannot drift about where a tool call starts and stops.
 *
 * Everything here is pure, cheap and I/O-free by construction:
 *
 * - Diffs come only from the caller's precomputed map. `computeAdvancedDiff`
 *   reads the target file, so the model must never call it; when no diff was
 *   precomputed the model measures the simple renderer the component falls back
 *   to (which is never smaller than the advanced one).
 * - Syntax highlighting (shiki) is never run. The places where the renderer's
 *   row count depends on it are documented approximations on the functions below.
 * - `listTasks()` reads an in-memory map, not a file, so the Task CRUD branch is
 *   measured exactly. It can only disagree with the renderer if the store changes
 *   between the measure and the render in one frame, which cannot happen (no
 *   await sits between them).
 *
 * Approximations all err large: an over-estimate leaves a blank row, an
 * under-estimate hides content from the transcript.
 */

import { getSubagentByToolCallId } from "@/agent/subagent-state.js";
import { memoryResultRows } from "@/cli/app/memory-result-rows";
import { parseEnterWorktreeResult } from "@/cli/components/EnterWorktreeResultRenderer";
import { parseExitWorktreeResult } from "@/cli/components/ExitWorktreeResultRenderer";
import { hasWorktreeResultRenderer } from "@/cli/components/WorktreeResultRenderer.js";
import type { Line, StreamingState } from "@/cli/helpers/accumulator";
import type { AdvancedDiffSuccess } from "@/cli/helpers/diff";
import {
  advancedDiffRowCount,
  editRendererRowCount,
  multiEditRendererRowCount,
  writeRendererRowCount,
} from "@/cli/helpers/diff-rows";
import { parsePatchOperations } from "@/cli/helpers/format-args-display.js";
import { CLI_GLYPHS } from "@/cli/helpers/glyphs";
import { markdownRowCount } from "@/cli/helpers/markdown-rows";
import {
  clipStreamingLine,
  DEFAULT_COLLAPSED_LINES,
  STREAMING_MIN_CONTENT_WIDTH,
  selectCollapsedOutput,
  streamingOutputLayout,
} from "@/cli/helpers/shell-output";
import { countTextRows } from "@/cli/helpers/text-metrics";
import {
  isQuestionToolName,
  resolveToolCallDisplay,
  type ToolCallDisplay,
} from "@/cli/helpers/tool-call-display";
import {
  isFileEditTool,
  isFileReadTool,
  isFileWriteTool,
  isGlobTool,
  isMemoryTool,
  isPatchTool,
  isPlanTool,
  isSearchTool,
  isShellOutputTool,
  isTaskCrudTool,
  isTaskTool,
  isTodoTool,
} from "@/cli/helpers/tool-name-mapping.js";
import { showsDefaultToolResult } from "@/cli/helpers/tool-result-branch";
import { resolveToolResultText } from "@/cli/helpers/tool-result-text";
import { formatUnifiedExecOutputForTui } from "@/cli/helpers/unified-exec-output.js";
import { INTERRUPTED_BY_USER } from "@/constants";
import { listTasks } from "@/tools/impl/tasks/store.js";
import { isRecord } from "@/utils/type-guards";

export type ToolCallLine = Extract<Line, { kind: "tool_call" }>;

/** Gutter the `  └  ` result prefix occupies. */
const RESULT_GUTTER_WIDTH = 5;

/** Gutter the patch "delete" row's `  └` prefix occupies. */
const PATCH_DELETE_GUTTER_WIDTH = 4;

/** Shell command lines the header keeps (mirrors the renderer's cap). */
const SHELL_COMMAND_MAX_LINES = 2;

/** Collapsed shell output still clips to this many characters (renderer arg). */
const SHELL_COLLAPSED_MAX_CHARS = 300;

export interface ToolCallRowOptions {
  /** Total terminal columns. */
  columns: number;
  /** Diffs precomputed for this frame, keyed by tool call id (and `id:path`). */
  diffs?: ReadonlyMap<string, AdvancedDiffSuccess>;
  /** Tool call whose shell output the user expanded (ctrl+o). */
  expandedToolCallId?: string | null;
  /** Shell tool call that owns the ctrl+o expand hint. */
  lastShellToolCallId?: string | null;
}

/**
 * Rows one `tool_call` transcript item occupies, mirroring
 * `ToolCallMessageRich`'s render order: task gate, header, shell continuation
 * lines, streaming output, collapsed output, result body.
 */
export function toolCallRows(
  line: ToolCallLine,
  options: ToolCallRowOptions,
): number {
  const columns = Math.max(1, options.columns);
  const rawName = line.name ?? "?";

  // Task gate: a task call with subagent state is rendered by the subagent
  // group, and an unfinished one by the approval UI, so it occupies no rows.
  if (isTaskTool(rawName)) {
    const subagent = line.toolCallId
      ? getSubagentByToolCallId(line.toolCallId)
      : undefined;
    if (subagent) return 0;
    if (line.phase !== "finished") return 0;
  }

  // The viewport renders tool calls through `TranscriptItemView`, which does not
  // pass `isStreaming`, so args are always treated as complete here.
  const display = resolveToolCallDisplay({
    name: line.name,
    argsText: line.argsText,
    unifiedExecCommandDisplay: line.unifiedExecCommandDisplay,
    resultText: line.resultText,
    phase: line.phase,
    resultOk: line.resultOk,
    columns,
  });

  let rows = toolCallHeaderRows(display, columns);
  rows += shellContinuationRows(display, columns);
  rows += shellOutputRows(line, display, options);

  if (!showsDefaultToolResult(line, rawName)) return rows;
  return rows + defaultResultRows(line, rawName, display, options);
}

/** Rows the tool call header occupies (`ToolCallHeader`). */
function toolCallHeaderRows(display: ToolCallDisplay, columns: number): number {
  const rightWidth = Math.max(0, columns - 2);
  if (rightWidth <= 0) return 1;

  // A name that already fills the row wraps together with its args.
  if (display.headerInline) {
    const argsText = display.hidesArgs ? "" : (display.argsDisplayText ?? "");
    return Math.max(
      1,
      countTextRows(`${display.displayName} ${argsText}`, rightWidth),
    );
  }

  const argsWidth = Math.max(1, display.headerArgsWidth);
  if (display.shellCommand) {
    // Approximation: the renderer echoes the syntax-highlighted first line,
    // clipped to `shellCommandMaxColumns`. Highlighting does not change the
    // text's width, so the plain first line measures the same rows.
    const firstLine = display.shellCommand.split("\n")[0] ?? "";
    const clipped = firstLine.slice(0, display.shellCommandMaxColumns);
    return Math.max(1, countTextRows(clipped, argsWidth));
  }

  if (!display.hidesArgs && display.argsDisplayText !== null) {
    return Math.max(1, countTextRows(display.argsDisplayText, argsWidth));
  }

  // Name only: the row is still one line tall.
  return 1;
}

/**
 * Shell command continuation rows the header echoes under the first line.
 *
 * Approximation: the count comes from the command's own non-empty lines rather
 * than from the highlighter's output (shiki is too expensive to run here). The
 * renderer keeps at most `SHELL_COMMAND_MAX_LINES` lines, so the count is
 * bounded and matches for the ordinary multi-line command.
 *
 * The continuation line is *not* one row: the renderer clips it to
 * `columns - 5` **code units** (`clipStyledSpans`) and then wraps it inside a
 * `columns - 5` box, so 40 columns of CJK text on a 45-column terminal occupy
 * two rows. Measuring the clipped text at the same width keeps the two together.
 */
function shellContinuationRows(
  display: ToolCallDisplay,
  columns: number,
): number {
  if (!display.shellCommand) return 0;
  const nonEmptyLines = display.shellCommand
    .split("\n")
    .filter((line) => line.length > 0);
  const continuationCount = Math.max(
    0,
    Math.min(SHELL_COMMAND_MAX_LINES, nonEmptyLines.length) - 1,
  );
  if (continuationCount === 0) return 0;

  const contentWidth = Math.max(1, columns - RESULT_GUTTER_WIDTH);
  const continuationLine = nonEmptyLines[1] ?? "";
  const clipped = continuationLine.slice(0, contentWidth);
  return Math.max(1, countTextRows(clipped, contentWidth));
}

/**
 * Rows `StreamingOutputDisplay` occupies for a streaming shell body.
 *
 * Shared by the shell tool-call branch and the `bash_command` transcript row —
 * both render the same component, with bash mode adding the interrupt hint.
 *
 * Every row is measured as its inner text at `columns - 5`, because that is the
 * box the renderer gives it: the `  └  ` prefix and the five-space continuation
 * indent are both five-column gutters beside a wrapping `<Text>`. (The leading
 * gutter is *not* folded into the measured string: `wrappedRowCount` drops
 * leading runs of spaces, which would under-count a row that has to wrap.)
 */
export function streamingOutputRows(
  streaming: StreamingState,
  columns: number,
  showInterruptHint = false,
): number {
  const width = Math.max(1, columns);
  const contentWidth = Math.max(1, width - RESULT_GUTTER_WIDTH);
  const hint = showInterruptHint ? " (esc to interrupt)" : "";
  // The elapsed time is read here for the same reason the renderer reads it: the
  // row only has to be wide enough that the wrap is the same.
  const elapsed = Math.floor((Date.now() - streaming.startTime) / 1000);
  const { first, rest, hiddenCount } = streamingOutputLayout(streaming);

  if (!first) {
    // The "Running... (Ns)" row carries its gutter inside the same `<Text>`.
    return Math.max(
      1,
      countTextRows(
        `  ${CLI_GLYPHS.result}  Running... (${elapsed}s)${hint}`,
        width,
      ),
    );
  }

  const clipWidth = Math.max(
    STREAMING_MIN_CONTENT_WIDTH,
    width - RESULT_GUTTER_WIDTH,
  );
  let rows = Math.max(
    1,
    countTextRows(clipStreamingLine(first.text, clipWidth), contentWidth),
  );
  for (const line of rest) {
    rows += Math.max(
      1,
      countTextRows(clipStreamingLine(line.text, clipWidth), contentWidth),
    );
  }
  // Exactly one trailing row: the hidden-line count, or the elapsed time.
  rows += Math.max(
    1,
    countTextRows(
      hiddenCount > 0
        ? `… +${hiddenCount} more lines (${elapsed}s)${hint}`
        : `(${elapsed}s)${hint}`,
      contentWidth,
    ),
  );
  return rows;
}

/** Streaming + collapsed shell output rows, mutually exclusive by phase. */
function shellOutputRows(
  line: ToolCallLine,
  display: ToolCallDisplay,
  options: ToolCallRowOptions,
): number {
  if (!isShellOutputTool(display.rawName)) return 0;

  if (line.phase === "running" && line.streaming) {
    return streamingOutputRows(line.streaming, options.columns);
  }

  if (line.phase === "finished" && line.resultText && line.resultOk !== false) {
    return collapsedOutputRows(line, display, options);
  }

  return 0;
}

/**
 * Rows `CollapsedOutputDisplay` occupies for a finished shell tool call: the
 * visible lines plus the hidden-count / collapse / clipped hints. The
 * visible-line selection is the renderer's own (`selectCollapsedOutput`).
 */
function collapsedOutputRows(
  line: ToolCallLine,
  display: ToolCallDisplay,
  options: ToolCallRowOptions,
): number {
  const columns = Math.max(1, options.columns);
  const result = resolveToolResultText(line.resultText ?? "", display.rawName);
  const output = formatUnifiedExecOutputForTui(result.extractedText, {
    hideEmptyCompletion: display.rawName === "write_stdin",
  });
  if (!output) return 0;

  const contentWidth = Math.max(1, columns - RESULT_GUTTER_WIDTH);
  const expanded = options.expandedToolCallId === line.id;
  const { lines, visibleLines, hiddenCount, clippedByChars } =
    selectCollapsedOutput(output, {
      maxLines: DEFAULT_COLLAPSED_LINES,
      maxChars: SHELL_COLLAPSED_MAX_CHARS,
      expanded,
    });
  if (lines.length === 0) return 0;

  let rows = visibleLines.reduce(
    (total, outputLine) => total + markdownRowCount(outputLine, contentWidth),
    0,
  );
  const isLast = options.lastShellToolCallId === line.id;
  if (hiddenCount > 0) {
    rows += countTextRows(
      `     … +${hiddenCount} lines${isLast ? " (ctrl+o to expand)" : ""}`,
      contentWidth,
    );
  }
  if (expanded && lines.length > DEFAULT_COLLAPSED_LINES) {
    rows += countTextRows("     (ctrl+o to collapse)", contentWidth);
  }
  if (clippedByChars && hiddenCount === 0) {
    rows += countTextRows(
      `     … output clipped${isLast ? " (ctrl+o to expand)" : ""}`,
      contentWidth,
    );
  }
  return rows;
}

/**
 * Rows the result body occupies. Mirrors `getResultElement`: the leading
 * branches are tool-specific summaries, and everything that does not match falls
 * through to the markdown/error text.
 */
function defaultResultRows(
  line: ToolCallLine,
  rawName: string,
  display: ToolCallDisplay,
  options: ToolCallRowOptions,
): number {
  const resultText = line.resultText;
  if (!resultText) return 0;

  const columns = Math.max(1, options.columns);
  const contentWidth = Math.max(1, columns - RESULT_GUTTER_WIDTH);

  if (resultText === "Running...") {
    return countTextRows("Running...", contentWidth);
  }
  if (resultText === INTERRUPTED_BY_USER) {
    return countTextRows(INTERRUPTED_BY_USER, contentWidth);
  }

  const result = resolveToolResultText(resultText, rawName);

  const todo = todoResultRows(line, rawName, display, columns);
  if (todo !== null) return todo;

  const taskCrud = taskCrudResultRows(line, rawName, columns);
  if (taskCrud !== null) return taskCrud;

  const plan = planResultRows(line, rawName, display, columns);
  if (plan !== null) return plan;

  if (isMemoryTool(rawName) && line.resultOk !== false && line.argsText) {
    // `MemoryDiffRenderer` is always returned once this branch is taken (a JSX
    // element is truthy), so an unusable result renders nothing rather than
    // falling through to the text body.
    return memoryResultRows(rawName, line.argsText, columns);
  }

  const question = questionResultRows(line, rawName, columns);
  if (question !== null) return question;

  if (hasWorktreeResultRenderer(rawName, result.extractedText, line.resultOk)) {
    return worktreeResultRows(rawName, result.extractedText, columns);
  }

  const fileEdit = fileEditResultRows(line, rawName, options);
  if (fileEdit !== null) return fileEdit;

  const fileWrite = fileWriteResultRows(line, rawName, options);
  if (fileWrite !== null) return fileWrite;

  const patch = patchResultRows(line, rawName, options);
  if (patch !== null) return patch;

  // One-line summaries: read/grep/glob.
  if (isFileReadTool(rawName) && line.resultOk !== false) {
    return 1;
  }
  if (isSearchTool(rawName) && line.resultOk !== false) {
    return 1;
  }
  if (isGlobTool(rawName) && line.resultOk !== false) {
    if (
      /^Found (\d+) files?/.test(resultText) ||
      resultText === "No files found"
    ) {
      return 1;
    }
  }

  return plainResultRows(
    result.displayResultText,
    line.resultOk === false,
    columns,
  );
}

/** Rows the generic (markdown or error) result body occupies. */
function plainResultRows(
  displayResultText: string,
  isError: boolean,
  columns: number,
): number {
  const contentWidth = Math.max(1, columns - RESULT_GUTTER_WIDTH);

  let displayText = displayResultText;
  try {
    const parsed = JSON.parse(displayResultText);
    if (parsed.error && typeof parsed.error === "string") {
      displayText = parsed.error;
    }
  } catch {
    // Not JSON, use the raw text
  }

  if (isError && displayText.includes("request to call tool denied")) {
    const match = displayText.match(/User reason: ([\s\S]+)$/);
    const reason = match?.[1]?.trim() || "(empty)";
    displayText = `User rejected the tool call with reason: ${reason}`;
  }

  return isError
    ? countTextRows(displayText, contentWidth)
    : markdownRowCount(displayText, contentWidth);
}

/** `todo_write` renders a checkbox list. `null` when the branch does not apply. */
function todoResultRows(
  line: ToolCallLine,
  rawName: string,
  display: ToolCallDisplay,
  columns: number,
): number | null {
  if (
    !isTodoTool(rawName, display.displayName) ||
    line.resultOk === false ||
    !line.argsText
  ) {
    return null;
  }
  try {
    const parsedArgs = JSON.parse(line.argsText);
    if (!parsedArgs?.todos || !Array.isArray(parsedArgs.todos)) return null;
    const entries = parsedArgs.todos.map((todo: unknown) => {
      const record = isRecord(todo) ? todo : {};
      const content =
        typeof record.content === "string"
          ? record.content
          : typeof record.description === "string"
            ? record.description
            : JSON.stringify(todo);
      return { content, status: todoStatus(record.status) };
    });
    return checkboxListRows(entries, columns);
  } catch {
    return null;
  }
}

/**
 * Task CRUD tools render a snapshot of the task store. `listTasks()` reads an
 * in-memory map (it is not I/O) and is the same source the renderer reads, so
 * this is exact rather than an approximation.
 */
function taskCrudResultRows(
  line: ToolCallLine,
  rawName: string,
  columns: number,
): number | null {
  if (!isTaskCrudTool(rawName) || line.resultOk === false) return null;
  try {
    const tasks = listTasks();
    if (tasks.length === 0) return null;
    return checkboxListRows(
      tasks.map((task) => ({
        content: task.subject,
        // A deleted task is shown as completed by the renderer.
        status:
          task.status === "deleted" ? "completed" : todoStatus(task.status),
      })),
      columns,
    );
  } catch {
    return null;
  }
}

/** `UpdatePlan` renders an explanation plus a checkbox list. */
function planResultRows(
  line: ToolCallLine,
  rawName: string,
  display: ToolCallDisplay,
  columns: number,
): number | null {
  if (
    !isPlanTool(rawName, display.displayName) ||
    line.resultOk === false ||
    !line.argsText
  ) {
    return null;
  }
  try {
    const parsedArgs = JSON.parse(line.argsText);
    if (!parsedArgs?.plan || !Array.isArray(parsedArgs.plan)) return null;
    const contentWidth = Math.max(1, columns - RESULT_GUTTER_WIDTH);
    const explanation =
      typeof parsedArgs.explanation === "string"
        ? parsedArgs.explanation
        : undefined;
    const entries = parsedArgs.plan.map((item: unknown) => {
      const record = isRecord(item) ? item : {};
      const step =
        typeof record.step === "string" ? record.step : JSON.stringify(item);
      return { content: step, status: todoStatus(record.status) };
    });
    return (
      (explanation ? countTextRows(explanation, contentWidth) : 0) +
      checkboxListRows(entries, columns)
    );
  } catch {
    return null;
  }
}

/** `AskUserQuestion` renders one row per `"question"="answer"` pair. */
function questionResultRows(
  line: ToolCallLine,
  rawName: string,
  columns: number,
): number | null {
  if (!isQuestionToolName(rawName) || line.resultOk === false) return null;
  const contentWidth = Math.max(1, columns - RESULT_GUTTER_WIDTH);
  const pairs: Array<{ question: string; answer: string }> = [];
  const qaRegex = /"([^"]+)"="([^"]*)"/g;
  for (const match of (line.resultText || "").matchAll(qaRegex)) {
    if (match[1] && match[2] !== undefined) {
      pairs.push({ question: match[1], answer: match[2] });
    }
  }
  if (pairs.length === 0) return null;
  return pairs.reduce(
    (total, pair) =>
      total +
      countTextRows(`· ${pair.question} → ${pair.answer}`, contentWidth),
    0,
  );
}

/**
 * Rows the worktree summary renderer occupies: one header row plus one row per
 * present detail field. Every field uses `wrap="truncate-end"`, so no field wraps
 * and each is exactly one row.
 */
function worktreeResultRows(
  rawName: string,
  extractedText: string,
  columns: number,
): number {
  const contentWidth = Math.max(1, columns - RESULT_GUTTER_WIDTH);
  if (rawName === "EnterWorktree") {
    const parsed = parseEnterWorktreeResult(extractedText);
    if (!parsed) return 0;
    return (
      countTextRows(
        parsed.action === "created"
          ? "Created worktree"
          : "Switched to existing worktree",
        contentWidth,
      ) +
      (parsed.path ? 1 : 0) +
      (parsed.branch ? 1 : 0) +
      (parsed.base ? 1 : 0) +
      (parsed.switchedCwd === undefined ? 0 : 1)
    );
  }
  if (rawName === "ExitWorktree") {
    const parsed = parseExitWorktreeResult(extractedText);
    if (!parsed) return 0;
    return (
      countTextRows(
        parsed.action === "removed"
          ? "Removed worktree"
          : "Left worktree (kept on disk)",
        contentWidth,
      ) +
      (parsed.path ? 1 : 0) +
      (parsed.branch ? 1 : 0) +
      (parsed.lock ? 1 : 0) +
      1 // The CWD row is always rendered
    );
  }
  return 0;
}

/** Rows the file edit body occupies (diff, multi-edit, or simple renderer). */
function fileEditResultRows(
  line: ToolCallLine,
  rawName: string,
  options: ToolCallRowOptions,
): number | null {
  if (!isFileEditTool(rawName) || line.resultOk === false || !line.argsText) {
    return null;
  }
  const columns = Math.max(1, options.columns);
  try {
    const parsedArgs = JSON.parse(line.argsText);
    const filePath = parsedArgs.file_path || "";

    if (parsedArgs.edits && Array.isArray(parsedArgs.edits)) {
      const edits = parsedArgs.edits.map(
        (edit: { old_string?: string; new_string?: string }) => ({
          old_string: edit.old_string || "",
          new_string: edit.new_string || "",
        }),
      );
      return multiEditRendererRowCount(filePath, edits, columns, {
        showLineNumbers: false,
      });
    }

    const diff = toolCallDiff(line, options);
    if (diff) {
      return advancedDiffRowCount(diff, {
        columns,
        showHeader: true,
        kind: "edit",
        filePath,
      });
    }

    if (parsedArgs.old_string !== undefined) {
      return editRendererRowCount(
        filePath,
        parsedArgs.old_string || "",
        parsedArgs.new_string || "",
        columns,
        { showLineNumbers: false },
      );
    }
  } catch {
    return null;
  }
  return null;
}

/** Rows the file write body occupies (advanced diff, or the simple renderer). */
function fileWriteResultRows(
  line: ToolCallLine,
  rawName: string,
  options: ToolCallRowOptions,
): number | null {
  if (!isFileWriteTool(rawName) || line.resultOk === false || !line.argsText) {
    return null;
  }
  const columns = Math.max(1, options.columns);
  try {
    const parsedArgs = JSON.parse(line.argsText);
    const filePath = parsedArgs.file_path || "";
    const content = parsedArgs.content || "";
    if (!filePath || !content) return null;
    const diff = toolCallDiff(line, options);
    if (diff) {
      return advancedDiffRowCount(diff, {
        columns,
        showHeader: true,
        kind: "write",
        filePath,
      });
    }
    return writeRendererRowCount(content, filePath, columns);
  } catch {
    return null;
  }
}

/** Rows the patch body occupies: one block per operation, with no separators. */
function patchResultRows(
  line: ToolCallLine,
  rawName: string,
  options: ToolCallRowOptions,
): number | null {
  if (!isPatchTool(rawName) || line.resultOk === false || !line.argsText) {
    return null;
  }
  const columns = Math.max(1, options.columns);
  try {
    const parsedArgs = JSON.parse(line.argsText);
    if (!parsedArgs.input) return null;
    const operations = parsePatchOperations(parsedArgs.input);
    if (operations.length === 0) return null;

    let rows = 0;
    for (const operation of operations) {
      // Patch operations look their diff up under a compound key.
      const diff = options.diffs?.get(`${line.toolCallId}:${operation.path}`);
      if (operation.kind === "add") {
        rows += diff
          ? advancedDiffRowCount(diff, {
              columns,
              showHeader: true,
              kind: "write",
              filePath: operation.path,
            })
          : writeRendererRowCount(operation.content, operation.path, columns);
      } else if (operation.kind === "update") {
        rows += diff
          ? advancedDiffRowCount(diff, {
              columns,
              showHeader: true,
              kind: "edit",
              filePath: operation.path,
            })
          : editRendererRowCount(
              operation.path,
              operation.oldString,
              operation.newString,
              columns,
              { showLineNumbers: false },
            );
      } else {
        rows += countTextRows(
          `Deleted ${operation.path}`,
          Math.max(1, columns - PATCH_DELETE_GUTTER_WIDTH),
        );
      }
    }
    return rows;
  } catch {
    return null;
  }
}

/** Rows a todo/plan checkbox list occupies (`TodoRenderer`/`PlanRenderer`). */
function checkboxListRows(
  entries: Array<{
    content: string;
    status: "pending" | "in_progress" | "completed";
  }>,
  columns: number,
): number {
  const contentWidth = Math.max(1, columns - RESULT_GUTTER_WIDTH);
  return entries.reduce((total, entry) => {
    const checkbox = entry.status === "completed" ? "☒" : "☐";
    return total + countTextRows(`${checkbox} ${entry.content}`, contentWidth);
  }, 0);
}

/** Normalize a todo/plan status the way the renderers do. */
function todoStatus(status: unknown): "pending" | "in_progress" | "completed" {
  return status === "completed"
    ? "completed"
    : status === "in_progress"
      ? "in_progress"
      : "pending";
}

/** Precomputed diff for a tool call, when one was supplied for this frame. */
function toolCallDiff(
  line: ToolCallLine,
  options: ToolCallRowOptions,
): AdvancedDiffSuccess | undefined {
  if (!line.toolCallId) return undefined;
  return options.diffs?.get(line.toolCallId);
}
