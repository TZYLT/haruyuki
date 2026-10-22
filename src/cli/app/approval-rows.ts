/**
 * Approval row heights.
 *
 * The full-screen viewport does not render a tool call while it is being
 * approved: it substitutes `ApprovalSwitch` for the current request and
 * `PendingApprovalStub` for the parallel ones. Measuring the tool call instead
 * would size the window from a node that is not on screen, so the approval layout
 * is mirrored here.
 *
 * The four inline approval UIs share one chrome (preview, options, hint) and
 * differ only in their preview body. Everything the previews need that is pure
 * comes from the shared helpers the components themselves consume
 * (`@/cli/helpers/approval-info`, `approval-layout`, `approval-preview`,
 * `diff-rows`); the remaining approximations are documented on the functions that
 * carry them, and all of them err large.
 *
 * Pure, cheap and I/O-free: diffs come only from the caller's precomputed map
 * (never `computeAdvancedDiff`, which reads the file) and no syntax highlighting
 * is run.
 */

import type { StaticItem } from "@/cli/app/types";
import {
  type ApprovalKind,
  fileEditApprovalHeaderText,
  getBashApprovalInfo,
  getFileEditApprovalInfo,
  getTaskApprovalInfo,
  resolveApprovalKind,
} from "@/cli/helpers/approval-info";
import {
  APPROVAL_HINT_TEXT,
  APPROVAL_OPTION_GUTTER_WIDTH,
  CUSTOM_DENIAL_LABEL,
  DEFAULT_APPROVE_ALWAYS_LABEL,
  formatApprovalArgs,
  genericApprovalPreviewRows,
  TASK_APPROVE_ALWAYS_LABEL,
  taskApprovalPromptRows,
} from "@/cli/helpers/approval-layout";
import {
  countPreviewRows,
  fitPreviewLines,
} from "@/cli/helpers/approval-preview";
import type { AdvancedDiffSuccess } from "@/cli/helpers/diff";
import {
  advancedDiffRowCount,
  editRendererRowCount,
  simpleDiffDisplayPath,
  writeRendererRowCount,
} from "@/cli/helpers/diff-rows";
import { parsePatchOperations } from "@/cli/helpers/format-args-display";
import { CLI_GLYPHS } from "@/cli/helpers/glyphs";
import type { ApprovalRequest } from "@/cli/helpers/stream";
import { countTextRows } from "@/cli/helpers/text-metrics";
import {
  isFileEditTool,
  isFileWriteTool,
} from "@/cli/helpers/tool-name-mapping";
import {
  isTallPreviewTool,
  resolveApprovalPreviewBody,
} from "@/cli/overlay/preview";
import type { ApprovalContext } from "@/permissions/analyzer";

/** Width the inline previews are indented by inside the approval column. */
const APPROVAL_PREVIEW_INDENT = 2;

/** Solid rule, header and spacer above a preview body. */
const PREVIEW_CHROME_ROWS = 3;

/** The generic fallback preview is the solid rule, a header and a dotted rule. */
const GENERIC_PREVIEW_ROWS = 3;

/** Lines `SyntaxHighlightedCommand` keeps in a bash approval preview. */
const BASH_PREVIEW_MAX_LINES = 3;

export interface QueuedApprovalDecision {
  type: "approve" | "deny";
  reason?: string;
}

/** What every approval measurement needs from the caller. */
export interface ApprovalMeasureOptions {
  /** Total terminal columns. */
  columns: number;
  /** Total terminal rows; sizes the preview row budgets. */
  terminalRows: number;
  /** Diffs precomputed for this frame, keyed by tool call id (and `id:path`). */
  diffs: ReadonlyMap<string, AdvancedDiffSuccess>;
}

export interface ApprovalRowOptions extends ApprovalMeasureOptions {
  /** Whether the preview block is shown (false once it is committed to static). */
  showPreview: boolean;
  /** Custom "always" label from the permission analyzer, when it has one. */
  approveAlwaysText?: string;
  /** Whether the "always" option is offered. */
  allowPersistence: boolean;
}

/** What the viewport substitutes for a tool call item. */
export interface ApprovalSubstitutions {
  currentApproval?: ApprovalRequest | null;
  currentApprovalContext?: ApprovalContext | null;
  approvalMap?: ReadonlyMap<string, ApprovalRequest>;
  pendingIds?: ReadonlySet<string>;
  queuedIds?: ReadonlySet<string>;
  queuedDecisions?: ReadonlyMap<string, QueuedApprovalDecision>;
  stubDescriptions?: ReadonlyMap<string, string>;
  showPreview?: boolean;
}

const EMPTY_SET: ReadonlySet<string> = new Set<string>();

/**
 * Rows the current approval occupies for a tool call item: the preview block
 * (when shown), the options, and the hint.
 */
export function approvalRows(
  approval: ApprovalRequest,
  options: ApprovalRowOptions,
): number {
  const kind = resolveApprovalKind(approval);
  return (
    inlinePreviewRows(approval, kind, options) +
    approvalOptionsRows(kind, options)
  );
}

/**
 * Rows the substituted node for a tool call item occupies, or `null` when the
 * viewport renders the ordinary tool call for it.
 */
export function substitutedApprovalRows(
  item: StaticItem,
  substitutions: ApprovalSubstitutions,
  options: ApprovalMeasureOptions,
): number | null {
  if (item.kind !== "tool_call") return null;
  const toolCallId = item.toolCallId;
  if (toolCallId === undefined) return null;

  const currentApproval = substitutions.currentApproval;
  if (currentApproval && currentApproval.toolCallId === toolCallId) {
    return approvalRows(currentApproval, {
      ...options,
      showPreview: substitutions.showPreview ?? true,
      approveAlwaysText:
        substitutions.currentApprovalContext?.approveAlwaysText,
      allowPersistence:
        substitutions.currentApprovalContext?.allowPersistence ?? true,
    });
  }

  const isQueued = (substitutions.queuedIds ?? EMPTY_SET).has(toolCallId);
  const isPending = (substitutions.pendingIds ?? EMPTY_SET).has(toolCallId);
  if (!isQueued && !isPending) return null;

  return pendingApprovalStubRows(
    {
      toolName:
        substitutions.approvalMap?.get(toolCallId)?.toolName ||
        item.name ||
        "Unknown",
      description: substitutions.stubDescriptions?.get(toolCallId),
      decision: isQueued
        ? substitutions.queuedDecisions?.get(toolCallId)
        : undefined,
    },
    options.columns,
  );
}

/** Rows the `PendingApprovalStub` occupies. */
export function pendingApprovalStubRows(
  input: {
    toolName: string;
    description?: string;
    decision?: QueuedApprovalDecision;
  },
  columns: number,
): number {
  const text = input.decision
    ? `${input.decision.type === "approve" ? "✓" : "✕"} Decision queued: ${
        input.decision.type === "approve" ? "approve" : "deny"
      } (${input.toolName})`
    : `${CLI_GLYPHS.pendingApproval} Awaiting approval: ${input.toolName}${
        input.description ? ` (${input.description})` : ""
      }`;
  return countTextRows(text, Math.max(1, columns));
}

/**
 * Rows the eagerly-committed `approval_preview` static item occupies.
 *
 * `ApprovalPreview` draws the same preview as the inline approvals but with the
 * advanced diff header shown (the inline previews suppress it) and with the
 * options and hint left to the live area. Which body it draws is not decided
 * here either: `@/cli/overlay/preview` classifies the item once and the
 * renderer draws from that classification, so the committed content and the
 * rows the viewport walks cannot disagree -- they used to, because this
 * mirrored `ApprovalPreview`'s dispatch by hand. The file-edit body is shared
 * with the inline approval outright (`@/cli/components/previews/FileEditPreview`),
 * so for that one the two are the same markup and only `showDiffHeader` differs.
 */
export function approvalPreviewItemRows(
  item: Extract<StaticItem, { kind: "approval_preview" }>,
  options: ApprovalMeasureOptions,
): number {
  const body = resolveApprovalPreviewBody({
    toolName: item.toolName,
    toolArgs: item.toolArgs,
    toolCallId: item.toolCallId,
  });

  if (body.kind === "command") {
    return bashPreviewRows(
      body.info.command,
      body.info.description,
      options,
      false,
    );
  }

  if (body.kind === "diff") {
    return fileEditPreviewRows(
      {
        toolName: item.toolName,
        filePath: body.info.filePath,
        toolCallId: item.toolCallId,
        patchInput: body.info.patchInput,
        content: body.info.content,
        oldString: body.info.oldString,
        newString: body.info.newString,
      },
      options,
      { showHeader: true, diff: item.precomputedDiff },
    );
  }

  return GENERIC_PREVIEW_ROWS;
}

/**
 * The `approval_preview` static item the eager-commit path appends.
 *
 * Shared with the decision that triggers the commit, so the item that gets
 * committed is always the item that was measured: an approval preview is
 * committed early precisely when it would overflow the live area, and a second
 * copy of this construction would let the two disagree about the diff.
 */
export function buildApprovalPreviewItem(
  approval: ApprovalRequest,
  diffs: ReadonlyMap<string, AdvancedDiffSuccess>,
): Extract<StaticItem, { kind: "approval_preview" }> {
  const item: Extract<StaticItem, { kind: "approval_preview" }> = {
    kind: "approval_preview",
    id: `approval-preview-${approval.toolCallId}`,
    toolCallId: approval.toolCallId,
    toolName: approval.toolName,
    toolArgs: approval.toolArgs || "{}",
  };

  // `ApprovalPreview` renders the diff from the item itself for the single-file
  // tools and from `allDiffs` (keyed `id:path`) for patch operations, so only the
  // former is attached here.
  const { toolName } = approval;
  if (
    (isFileEditTool(toolName) || isFileWriteTool(toolName)) &&
    diffs.has(approval.toolCallId)
  ) {
    item.precomputedDiff = diffs.get(approval.toolCallId);
  }

  return item;
}

/**
 * Rows an approval's preview needs in the live area before it is worth committing
 * to static — or 0 when that approval never qualifies.
 *
 * Only the tall previews qualify: a shell command block or a file edit/write/patch
 * diff. The generic preview is three rows and can never overflow the viewport, so
 * committing it would add static churn without fixing a flicker source.
 *
 * Keeping the gate here rather than at the call site means the decision, the
 * measured layout and the committed item are all in one module, tested together.
 */
export function eagerCommitPreviewRows(
  approval: ApprovalRequest,
  options: ApprovalMeasureOptions,
): number {
  const { toolName, toolCallId } = approval;
  if (!toolName || !toolCallId) return 0;
  if (!isTallPreviewTool(toolName)) return 0;

  return approvalPreviewItemRows(
    buildApprovalPreviewItem(approval, options.diffs),
    options,
  );
}

/** Rows the inline approval's preview block occupies (0 when it is hidden). */
function inlinePreviewRows(
  approval: ApprovalRequest,
  kind: ApprovalKind,
  options: ApprovalRowOptions,
): number {
  // The task approval has no `showPreview` switch: its preview always renders.
  if (kind !== "task" && !options.showPreview) return 0;

  switch (kind) {
    case "fileEdit": {
      const info = getFileEditApprovalInfo(approval);
      if (!info) return GENERIC_PREVIEW_ROWS;
      return fileEditPreviewRows(
        {
          toolName: info.toolName,
          filePath: info.filePath,
          toolCallId: info.toolCallId,
          patchInput: info.patchInput,
          content: info.content,
          oldString: info.oldString,
          newString: info.newString,
        },
        options,
        {
          showHeader: false,
          diff: info.toolCallId
            ? options.diffs.get(info.toolCallId)
            : undefined,
        },
      );
    }
    case "shell": {
      const info = getBashApprovalInfo(approval);
      if (!info) return GENERIC_PREVIEW_ROWS;
      return bashPreviewRows(info.command, info.description, options, true);
    }
    case "task":
      return taskPreviewRows(approval, options);
    default:
      return genericPreviewRows(approval, options);
  }
}

/** Rows the generic approval preview occupies. */
function genericPreviewRows(
  approval: ApprovalRequest,
  options: ApprovalMeasureOptions,
): number {
  const contentWidth = Math.max(1, options.columns - APPROVAL_PREVIEW_INDENT);
  const formattedArgs = formatApprovalArgs(
    approval.toolArgs,
    genericApprovalPreviewRows(options.terminalRows),
    contentWidth,
  );
  return GENERIC_PREVIEW_ROWS + countTextRows(formattedArgs, contentWidth);
}

/**
 * Rows the bash approval preview occupies.
 *
 * `withDescriptionGap` mirrors the difference between the inline approval, which
 * separates the description from the command with a blank row, and the committed
 * preview, which does not.
 */
function bashPreviewRows(
  command: string,
  description: string | undefined,
  options: ApprovalMeasureOptions,
  withDescriptionGap: boolean,
): number {
  const contentWidth = Math.max(1, options.columns - APPROVAL_PREVIEW_INDENT);
  let rows =
    PREVIEW_CHROME_ROWS +
    syntaxHighlightedCommandRows(command, options.columns);
  if (description) {
    rows +=
      (withDescriptionGap ? 1 : 0) + countTextRows(description, contentWidth);
  }
  return rows;
}

/**
 * Rows `SyntaxHighlightedCommand` occupies in a bash approval preview.
 *
 * Approximation: the renderer highlights the command with shiki and keeps at most
 * `BASH_PREVIEW_MAX_LINES` highlighted lines, which is far too expensive to run
 * during measurement. The command's own lines are split the way the highlighter
 * splits them, clipped to the same column budget, and measured at the width the
 * preview text actually gets (the padded block minus the `$ ` prompt column).
 */
function syntaxHighlightedCommandRows(
  command: string,
  columns: number,
): number {
  const maxColumns = Math.max(10, columns - APPROVAL_PREVIEW_INDENT);
  const textWidth = Math.max(1, columns - APPROVAL_PREVIEW_INDENT - 2);
  const hintWidth = Math.max(1, columns - APPROVAL_PREVIEW_INDENT);
  const lines = command.split("\n");
  const visibleLines = lines.slice(0, BASH_PREVIEW_MAX_LINES);
  const hiddenCount = Math.max(0, lines.length - visibleLines.length);

  let rows = 0;
  let columnClipped = false;
  for (const line of visibleLines) {
    const clipped = line.slice(0, maxColumns);
    if (clipped.length < line.length) columnClipped = true;
    rows += Math.max(1, countTextRows(clipped, textWidth));
  }

  if (hiddenCount > 0) {
    rows += countTextRows(`… +${hiddenCount} more lines`, hintWidth);
  } else if (columnClipped) {
    rows += countTextRows("… output clipped", hintWidth);
  }
  return rows;
}

/**
 * Rows the task approval preview occupies: solid rule, header, the subagent
 * summary, and as much of the prompt as the row budget allows.
 */
function taskPreviewRows(
  approval: ApprovalRequest,
  options: ApprovalMeasureOptions,
): number {
  const contentWidth = Math.max(1, options.columns - 4);
  const info = getTaskApprovalInfo(approval);
  if (!info) return PREVIEW_CHROME_ROWS;

  const summary = `${info.subagentType}${
    info.isBackground ? " [background]" : ""
  } — ${info.description}${info.model ? ` (${info.model})` : ""}`;
  const summaryRows = countTextRows(summary, contentWidth);
  const truncatedPrompt = fitPreviewLines(
    info.prompt.split("\n"),
    taskApprovalPromptRows(
      options.terminalRows,
      countPreviewRows(summary.split("\n"), contentWidth),
    ),
    contentWidth,
  ).join("\n");

  return (
    PREVIEW_CHROME_ROWS +
    summaryRows +
    1 /* the prompt's marginTop */ +
    countTextRows(truncatedPrompt, contentWidth)
  );
}

interface FileEditPreviewInput {
  toolName: string;
  filePath: string;
  toolCallId?: string;
  patchInput?: string;
  content?: string;
  oldString?: string;
  newString?: string;
}

/**
 * Rows a file edit/write/patch preview occupies: the solid rule, header and
 * dotted rule, the diff or patch body, and the trailing dotted rule.
 *
 * The header ("Overwrite x?" vs "Write to x?") depends on whether the file
 * exists, which the renderer probes with `existsSync`. Measurement must not touch
 * the filesystem, so the taller of the two headers is used: a one-row
 * over-estimate at worst, never an under-estimate.
 *
 * A patch body is one block per operation, separated by a blank row, with the
 * operation's path on its own row. `showHeader` mirrors the renderer: the
 * committed preview draws the advanced diff header, the inline previews suppress
 * it.
 */
function fileEditPreviewRows(
  input: FileEditPreviewInput,
  options: ApprovalMeasureOptions,
  layout: { showHeader: boolean; diff?: AdvancedDiffSuccess },
): number {
  const columns = Math.max(1, options.columns);
  const headerInput = {
    toolName: input.toolName,
    filePath: input.filePath,
    patchInput: input.patchInput,
  };

  let rows =
    2 /* solid and dotted rules */ +
    Math.max(
      countTextRows(
        fileEditApprovalHeaderText(headerInput, () => true),
        columns,
      ),
      countTextRows(
        fileEditApprovalHeaderText(headerInput, () => false),
        columns,
      ),
    );

  if (input.patchInput) {
    const operations = parsePatchOperations(input.patchInput);
    for (const [index, operation] of operations.entries()) {
      if (index > 0) rows += 1; // blank separator between operations
      rows += countTextRows(simpleDiffDisplayPath(operation.path), columns);
      if (operation.kind === "delete") {
        // The one red "File will be deleted" row both surfaces draw.
        rows += 1;
        continue;
      }
      const operationDiff = input.toolCallId
        ? options.diffs.get(`${input.toolCallId}:${operation.path}`)
        : undefined;
      if (operationDiff) {
        rows += advancedDiffRowCount(operationDiff, {
          columns,
          showHeader: false,
          kind: operation.kind === "add" ? "write" : "edit",
          filePath: operation.path,
        });
      } else if (operation.kind === "add") {
        rows += writeRendererRowCount(
          operation.content,
          operation.path,
          columns,
        );
      } else {
        rows += editRendererRowCount(
          operation.path,
          operation.oldString,
          operation.newString,
          columns,
          { showLineNumbers: false },
        );
      }
    }
  } else if (input.toolName.toLowerCase() === "write") {
    rows += layout.diff
      ? advancedDiffRowCount(layout.diff, {
          columns,
          showHeader: layout.showHeader,
          kind: "write",
          filePath: input.filePath,
        })
      : writeRendererRowCount(input.content ?? "", input.filePath, columns);
  } else {
    rows += layout.diff
      ? advancedDiffRowCount(layout.diff, {
          columns,
          showHeader: layout.showHeader,
          kind: "edit",
          filePath: input.filePath,
        })
      : editRendererRowCount(
          input.filePath,
          input.oldString ?? "",
          input.newString ?? "",
          columns,
          { showLineNumbers: false },
        );
  }

  return rows + 1 /* trailing dotted rule */;
}

/** Rows the inline approval options plus hint occupy. */
function approvalOptionsRows(
  kind: ApprovalKind,
  options: ApprovalRowOptions,
): number {
  const columns = Math.max(1, options.columns);

  // Only the task approval always shows its preview, so its options always carry
  // the separating margin; the others drop it when the preview is committed.
  const optionsMarginTop = kind === "task" || options.showPreview ? 1 : 0;

  const approveAlwaysLabel =
    options.approveAlwaysText ??
    (kind === "task"
      ? TASK_APPROVE_ALWAYS_LABEL
      : DEFAULT_APPROVE_ALWAYS_LABEL);
  const labels = options.allowPersistence
    ? ["Yes", approveAlwaysLabel, CUSTOM_DENIAL_LABEL]
    : ["Yes", CUSTOM_DENIAL_LABEL];

  const optionWidth = Math.max(1, columns - APPROVAL_OPTION_GUTTER_WIDTH);
  const optionRows = labels.reduce(
    (total, label) => total + countTextRows(label, optionWidth),
    0,
  );

  return (
    optionsMarginTop +
    optionRows +
    1 /* the hint's marginTop */ +
    countTextRows(APPROVAL_HINT_TEXT, columns)
  );
}
