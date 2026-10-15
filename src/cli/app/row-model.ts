/**
 * Transcript row model.
 *
 * Given a terminal width, how many rows does a transcript item occupy once it is
 * laid out? The full-screen shell answers this *without rendering* so it can
 * virtualize: it decides which items intersect the viewport and how tall the
 * scroll extent is.
 *
 * This module owns the item-level dispatch (gap, welcome, subagent group) and the
 * plain transcript lines. Two kinds are delegated because their height is a
 * layout of their own:
 *
 * - `tool_call` → `@/cli/app/tool-call-rows` (one branch per tool family)
 * - approvals → `@/cli/app/approval-rows` (the viewport substitutes an approval
 *   UI or a pending stub for a tool call item)
 *
 * Every branch reuses the same pure primitives the renderers use
 * (`@/cli/helpers/text-metrics`, `markdown-rows`, `diff-rows`), so the model and
 * the render pass cannot disagree about a row count. Where a renderer's height
 * depends on runtime display state (ctrl+r / ctrl+t / ctrl+o) or on data the model
 * must not fetch (a diff, a syntax highlight), the caller passes the state in and
 * the approximation is documented on the branch that carries it.
 */

import {
  type ApprovalMeasureOptions,
  type ApprovalSubstitutions,
  approvalPreviewItemRows,
  substitutedApprovalRows,
} from "@/cli/app/approval-rows";
import { toolCallRows } from "@/cli/app/tool-call-rows";
import type { StaticItem } from "@/cli/app/types";
import type { Line } from "@/cli/helpers/accumulator";
import type { AdvancedDiffSuccess } from "@/cli/helpers/diff";
import { CLI_GLYPHS } from "@/cli/helpers/glyphs";
import { markdownRowCount } from "@/cli/helpers/markdown-rows";
import { countTextRows, inkStringWidth } from "@/cli/helpers/text-metrics";

/** Two-column gutter used by assistant/reasoning/error rows. */
export const TRANSCRIPT_GUTTER_WIDTH = 2;

/** Blank row `StaticTranscript` inserts between two committed items. */
export const STATIC_ITEM_GAP_ROWS = 1;

/** Approximate height of the welcome banner (it is a fixed template). */
const WELCOME_ROWS = 12;

/** Rows per subagent entry in a committed subagent group. */
const SUBAGENT_ROWS = 4;

/**
 * Preview row budget used when the caller does not report the terminal height.
 * Approval previews shrink to fit the terminal; measuring them unbounded is the
 * larger answer, which is the safe direction for a window calculation.
 */
const UNBOUNDED_PREVIEW_ROWS = Number.MAX_SAFE_INTEGER;

/** No precomputed diffs, for callers that measure without a render frame. */
const EMPTY_DIFFS: ReadonlyMap<string, AdvancedDiffSuccess> = new Map();

export interface RowMeasureOptions {
  /** Total terminal columns. */
  columns: number;
  /** Full prompt prefix for user rows; defaults to `<glyph> `. */
  userPromptPrefix?: string;
  /** Whether collapsed reasoning rows render their body (ctrl+t). */
  reasoningExpanded?: boolean;
  /** Total terminal rows; sizes the approval preview budgets. */
  terminalRows?: number;
  /** Diffs precomputed for this frame, keyed by tool call id (and `id:path`). */
  diffs?: ReadonlyMap<string, AdvancedDiffSuccess>;
  /** Tool call whose shell output the user expanded (ctrl+o). */
  expandedToolCallId?: string | null;
  /** Shell tool call that owns the ctrl+o expand hint. */
  lastShellToolCallId?: string | null;
  /**
   * Set by the full-screen viewport, which substitutes the current approval and
   * the pending/queued stubs for a tool call item. Omit it when the item really
   * renders as a tool call (the append shell's measurement).
   */
  substitutions?: ApprovalSubstitutions;
}

/** The subset of the measure options the approval layout needs. */
function approvalMeasureOptions(
  options: RowMeasureOptions,
): ApprovalMeasureOptions {
  return {
    columns: options.columns,
    terminalRows: options.terminalRows ?? UNBOUNDED_PREVIEW_ROWS,
    diffs: options.diffs ?? EMPTY_DIFFS,
  };
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

    case "tool_call":
      // Measured branch by branch against the renderer (`tool-call-rows`).
      return toolCallRows(line, options);

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

  // The full-screen viewport substitutes an approval UI or a stub for a tool call
  // item, so the substituted node — not the tool call — is what occupies rows.
  if (item.kind === "tool_call" && options.substitutions) {
    const substituted = substitutedApprovalRows(
      item,
      options.substitutions,
      approvalMeasureOptions(options),
    );
    if (substituted !== null) return gap + substituted;
  }

  switch (item.kind) {
    case "welcome":
      return gap + WELCOME_ROWS;
    case "subagent_group":
      return gap + Math.max(1, item.agents.length) * SUBAGENT_ROWS;
    case "approval_preview":
      // Measured against `ApprovalPreview` itself; it renders only the preview,
      // with the options and hint left to the live area.
      return (
        gap + approvalPreviewItemRows(item, approvalMeasureOptions(options))
      );
    default:
      return gap + measureLineRows(item, options);
  }
}
