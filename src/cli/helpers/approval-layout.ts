/**
 * Approval preview layout, shared by the inline approval components and the
 * transcript row model.
 *
 * Two rules decide how tall an inline approval preview gets: how many terminal
 * rows are left for the preview body after the dialog chrome, and how the args
 * are formatted (a `script` argument shows verbatim instead of JSON-escaped, and
 * anything longer than the budget collapses into an "… (N more lines)" row). The
 * row model has to apply the same rules to predict the approval's height, so both
 * live here.
 */

import { fitPreviewLines } from "@/cli/helpers/approval-preview";

const SCRIPT_PREVIEW_MAX_LINES = 40;

/**
 * The approval options, shared by the one control that renders them
 * (`@/cli/components/ApprovalOptions`) and the row model that measures them.
 *
 * They are constants here rather than literals at either site because the two
 * must agree: an option label that wraps one row more than the row model
 * predicted is a viewport that clips the approval it is showing.
 */

/** Columns the numbered selector gutter takes. */
export const APPROVAL_OPTION_GUTTER_WIDTH = 5;

/** The custom-denial option every inline approval offers. */
export const CUSTOM_DENIAL_LABEL =
  "No, and tell Haruyuki what to do differently";

/** Default "always" label for the non-task approvals. */
export const DEFAULT_APPROVE_ALWAYS_LABEL =
  "Yes, and don't ask again for this project";

/** Default "always" label for the task approval. */
export const TASK_APPROVE_ALWAYS_LABEL =
  "Yes, allow subagent operations during this session";

/**
 * Hint text the options show while one of them is selected.
 *
 * The custom option's two hints are not longer than this one, which is why the
 * row model can measure the hint with this constant whatever the cursor is on.
 */
export const APPROVAL_HINT_TEXT = "Enter to select · Esc to cancel";

/** Hint text for the state the cursor is in. */
export function approvalHintText(
  isOnCustomOption: boolean,
  hasReason: boolean,
): string {
  if (!isOnCustomOption) return APPROVAL_HINT_TEXT;
  return hasReason
    ? "Enter to submit · Esc to clear"
    : "Type reason · Esc to cancel";
}

/**
 * Rows the live area needs besides the argument preview while a generic approval
 * is shown: rule, header, spacer, options with spacer, hint with spacer, the
 * live-item margin above and the collapsed input margin below, plus slack for
 * wrapped option text.
 */
export const GENERIC_APPROVAL_CHROME_ROWS = 14;

/** Minimum preview rows a generic approval keeps on screen. */
export const MIN_APPROVAL_PREVIEW_ROWS = 3;

/**
 * Rows the live area needs besides the summary and prompt while a Task approval
 * is shown: rule, header, spacers, options with spacer, hint with spacer, the
 * live-item margin above and the collapsed input margin below, plus slack for
 * wrapped option text.
 */
export const TASK_APPROVAL_CHROME_ROWS = 15;

/** Minimum prompt rows a Task approval keeps on screen. */
export const MIN_TASK_PROMPT_ROWS = 3;

/** Preview row budget for a generic approval, given the terminal height. */
export function genericApprovalPreviewRows(terminalRows: number): number {
  return Math.max(
    MIN_APPROVAL_PREVIEW_ROWS,
    terminalRows - GENERIC_APPROVAL_CHROME_ROWS,
  );
}

/** Prompt row budget for a Task approval, given the terminal height. */
export function taskApprovalPromptRows(
  terminalRows: number,
  summaryRows: number,
): number {
  return Math.max(
    MIN_TASK_PROMPT_ROWS,
    terminalRows - TASK_APPROVAL_CHROME_ROWS - summaryRows,
  );
}

/**
 * A `script` argument is source the user is approving to run; show it verbatim
 * (not JSON-escaped and cut mid-line) after the other arguments.
 */
function formatScriptArgs(
  parsed: Record<string, unknown>,
  maxRows: number,
  width: number,
): string {
  const { script, ...rest } = parsed;
  const header =
    Object.keys(rest).length > 0 ? `${JSON.stringify(rest, null, 2)}\n\n` : "";
  const headerLines = header ? header.split("\n").slice(0, -1) : [];
  const lines = [...headerLines, ...String(script).split("\n")];
  return fitPreviewLines(
    lines,
    maxRows,
    width,
    headerLines.length + SCRIPT_PREVIEW_MAX_LINES,
  ).join("\n");
}

/**
 * Format tool arguments for display, keeping the start within `maxRows`
 * terminal rows at `width` columns.
 */
export function formatApprovalArgs(
  toolArgs: string,
  maxRows: number,
  width: number,
): string {
  try {
    const parsed = JSON.parse(toolArgs);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.script === "string"
    ) {
      return formatScriptArgs(
        parsed as Record<string, unknown>,
        maxRows,
        width,
      );
    }
    // Pretty print with 2-space indent, but limit length
    let formatted = JSON.stringify(parsed, null, 2);
    // Truncate if too long
    if (formatted.length > 500) {
      formatted = `${formatted.slice(0, 500)}\n...`;
    }
    return fitPreviewLines(formatted.split("\n"), maxRows, width).join("\n");
  } catch {
    // If not valid JSON, return as-is
    const raw = toolArgs || "(no arguments)";
    return fitPreviewLines(raw.split("\n"), maxRows, width).join("\n");
  }
}
