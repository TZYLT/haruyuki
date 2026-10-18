/**
 * The one classification of a *committed* approval preview's body.
 *
 * An approval is classified twice in this tree, because the two sides read
 * different inputs and one of them predates the other. A live approval is
 * dispatched by `@/cli/helpers/approval-info` (`resolveApproval`) into the
 * inline surface that answers it; a preview committed to the transcript is
 * classified here, from the tool name, args and call id a static item carries.
 * Before this module the committed side was classified *three* times -- the
 * renderer with its own `JSON.parse` and tool-name list, the row model through
 * `getFileEditApprovalInfo`, and the eager-commit gate with the list spelled out
 * again -- so the item that was committed and the rows that were measured could
 * disagree about what the approval was showing.
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
  /**
   * Nothing tool-specific to preview: the caller draws the args, or the bare tool
   * name, from the props it already holds.
   *
   * It carries no payload on purpose. This used to hold a `toolName`, and neither
   * consumer ever read it — both classify, and then fall through to the body they
   * were given (`ApprovalPreview.tsx`, `approval-rows.ts`).
   */
  | { kind: "args" };

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

  return { kind: "args" };
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
