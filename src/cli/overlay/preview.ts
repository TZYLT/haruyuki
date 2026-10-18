/**
 * The one classification of an approval's preview body.
 *
 * An approval's preview is drawn twice: live, inside the inline approval the
 * user answers, and committed to the transcript for the tall bodies
 * (`ApprovalPreview`), whose height the row model has to predict before
 * anything renders. The committed side classified the tool name and parsed the
 * args itself -- its own `JSON.parse`, its own tool-name list, its own
 * `file_path` default -- while the row model went through
 * `getFileEditApprovalInfo`, so the item that was committed and the rows that
 * were measured could disagree about what the approval was showing.
 *
 * This module is that decision, once, as data. Pure: no React, no Ink, and no
 * filesystem -- the one thing a renderer adds on top is the existence probe
 * behind a file-edit header, which `fileEditApprovalHeaderText` already takes as
 * an argument precisely so the row model can pass both answers instead of
 * touching the filesystem.
 */

import {
  type BashApprovalInfo,
  type FileEditApprovalInfo,
  getFileEditApprovalInfo,
  parseBashApprovalArgs,
} from "@/cli/helpers/approval-info";
import {
  type PatchOperation,
  parsePatchOperations,
} from "@/cli/helpers/format-args-display";
import {
  isFileEditPreviewTool,
  isShellTool,
} from "@/cli/helpers/tool-name-mapping";

/** A tool name, args and tool call id -- what a committed item carries. */
export interface ApprovalPreviewInput {
  toolName: string;
  toolArgs: string;
  toolCallId?: string;
}

/** The body a committed approval preview draws. */
export type ApprovalPreviewBody =
  | { kind: "command"; info: BashApprovalInfo }
  | {
      kind: "diff";
      info: FileEditApprovalInfo;
      /** Patch operations, in order; empty for a single edit or write. */
      operations: PatchOperation[];
    }
  /** Nothing tool-specific to preview: the args, or the bare tool name. */
  | { kind: "args"; toolName: string };

/**
 * Classify a committed preview.
 *
 * The order is the interface: a shell tool whose args do not parse falls
 * through to the generic body rather than rendering an empty command, which is
 * what the inline approval and the row model have always done.
 */
export function resolveApprovalPreviewBody(
  input: ApprovalPreviewInput,
): ApprovalPreviewBody {
  const { toolName, toolArgs } = input;

  if (isShellTool(toolName)) {
    const info = parseBashApprovalArgs(toolName, toolArgs);
    if (info) return { kind: "command", info };
  }

  if (isFileEditPreviewTool(toolName)) {
    const info = getFileEditApprovalInfo({
      toolName,
      toolArgs,
      toolCallId: input.toolCallId,
    });
    if (info) {
      return {
        kind: "diff",
        info,
        operations: info.patchInput
          ? parsePatchOperations(info.patchInput)
          : [],
      };
    }
  }

  return { kind: "args", toolName };
}

/**
 * Whether a tool's committed preview is a tall body at all.
 *
 * The eager-commit gate asks this before it measures anything: a shell command
 * block or a file edit/write/patch diff can overflow the live area, while the
 * generic args body is three rows and never can. Note that eligibility is a
 * property of the tool name, not of the body: a shell tool whose args do not
 * parse still qualifies, because the alternatives were measured before this
 * predicate existed and the generic body it falls back to is what gets
 * committed.
 */
export function isTallPreviewTool(toolName: string): boolean {
  return isShellTool(toolName) || isFileEditPreviewTool(toolName);
}
