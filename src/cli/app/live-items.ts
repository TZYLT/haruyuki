import type { Line } from "@/cli/helpers/accumulator";
import {
  isFileEditTool,
  isFileWriteTool,
  isPatchTool,
  isShellTool,
  isTaskTool,
} from "@/cli/helpers/tool-name-mapping";

export interface LiveItemFilterContext {
  /** toolCallId of the approval currently owning focus, when any. */
  currentApprovalToolCallId: string | undefined;
  pendingIds: ReadonlySet<string>;
  queuedIds: ReadonlySet<string>;
}

/**
 * Whether a live item should render a row in the transcript.
 *
 * Several tool calls render nothing on their own while they stream (shell tools
 * show their output inline, file tools render through the approval surface, and
 * Task calls without a pending approval would be blank boxes). Both shells apply
 * the same rule, so it lives here rather than in either one.
 */
export function shouldRenderLiveItem(
  ln: Line,
  ctx: LiveItemFilterContext,
): boolean {
  const isFileTool =
    ln.kind === "tool_call" &&
    ln.name &&
    (isFileEditTool(ln.name) ||
      isFileWriteTool(ln.name) ||
      isPatchTool(ln.name));
  const isApprovalTracked =
    ln.kind === "tool_call" &&
    ln.toolCallId &&
    (ln.toolCallId === ctx.currentApprovalToolCallId ||
      ctx.pendingIds.has(ln.toolCallId) ||
      ctx.queuedIds.has(ln.toolCallId));
  if (
    ln.kind === "tool_call" &&
    ln.name &&
    isShellTool(ln.name) &&
    !isApprovalTracked &&
    (ln.phase === "streaming" || ln.phase === "ready")
  ) {
    return false;
  }
  if (isFileTool && !isApprovalTracked) {
    return false;
  }
  // Skip Task tools that don't have a pending approval: they render as empty
  // boxes, which would leave N blank lines for N parallel Task calls.
  if (
    ln.kind === "tool_call" &&
    ln.name &&
    isTaskTool(ln.name) &&
    ln.toolCallId &&
    !ctx.pendingIds.has(ln.toolCallId) &&
    ln.toolCallId !== ctx.currentApprovalToolCallId
  ) {
    return false;
  }
  return true;
}
