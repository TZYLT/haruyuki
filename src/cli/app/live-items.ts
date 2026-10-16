import type { Line } from "@/cli/helpers/accumulator";
import {
  isFileEditTool,
  isFileWriteTool,
  isPatchTool,
  isShellTool,
  isTaskTool,
} from "@/cli/helpers/tool-name-mapping";
import type { StaticItem } from "./types";

export interface LiveItemFilterContext {
  /** toolCallId of the approval currently owning focus, when any. */
  currentApprovalToolCallId: string | undefined;
  pendingIds: ReadonlySet<string>;
  queuedIds: ReadonlySet<string>;
}

export interface VisibleItemsInput extends LiveItemFilterContext {
  staticItems: readonly StaticItem[];
  liveItems: readonly Line[];
}

/**
 * The item list a transcript region renders: committed items first, then the live
 * ones that draw a row.
 *
 * Both regions render this list — the append shell through `<Static>` and the live
 * tree, the full-screen one through its window — and the full-screen shell also
 * asks it whether an approval is on screen at all. Keeping the composition here
 * is what lets both answers come from one place.
 */
export function buildVisibleItems(input: VisibleItemsInput): StaticItem[] {
  const live = input.liveItems.filter((ln) => shouldRenderLiveItem(ln, input));
  return [...input.staticItems, ...live];
}

/**
 * Whether the item a focused approval substitutes for is in `items`.
 *
 * True when nothing is focused (there is no surface to pin). The full-screen shell
 * asks this of the items it actually drew, because an approval whose tool call the
 * backfill cap dropped — or that the window scrolled past — leaves the user with a
 * disabled input and no visible way to answer.
 */
export function hasFocusedApprovalItem(
  items: readonly StaticItem[],
  currentApprovalToolCallId: string | undefined,
): boolean {
  if (!currentApprovalToolCallId) {
    return true;
  }

  return items.some(
    (item) =>
      item.kind === "tool_call" &&
      item.toolCallId === currentApprovalToolCallId,
  );
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
