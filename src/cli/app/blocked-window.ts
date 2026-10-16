import {
  type HistoryBlock,
  historyBlockItems,
  historyBlocksForWindow,
} from "./history-blocks";
import {
  fitItemsFromEnd,
  type StepBudget,
  type ViewportAnchor,
  type ViewportWindow,
  type WindowStepAt,
} from "./viewport-window";

/**
 * The viewport window over a **paged** history: the same orchestration as the item
 * walk, with the only difference being the *steps*. A page whose rows the viewport
 * measured is one step, so a walk passing over it costs arithmetic instead of
 * measuring every item in it (a deep position otherwise measures the whole history).
 *
 * A page is one step only when the boundary is its own first item, its rows are
 * measured, and it fits **both** budgets. The row budget is the trap a differential
 * test caught: `walkWindow` breaks on a step that does not fit, right for one item
 * and wrong for a page, so the refusal has to happen here.
 */
export interface BlockedWindowInput {
  /** Pages, oldest first, contiguous from item 0 (`history-blocks.ts`). */
  blocks: readonly HistoryBlock[];
  /** Items after the last page: the core list. */
  coreItemCount: number;
  height: number;
  maxItems: number;
  scrollFromBottom: number;
  anchor?: ViewportAnchor;
  /** Rows of one item. Only indices the walk descends into are asked for. */
  measure: (index: number) => number;
}

export interface BlockedViewportWindow extends ViewportWindow {
  /** Pages the window touches, and therefore has to be resident. */
  resident: { from: number; to: number } | null;
}

export function fitBlockedItemsFromEnd(
  input: BlockedWindowInput,
): BlockedViewportWindow {
  const { blocks } = input;

  // Cumulative ends, so "which page ends exactly here" is a binary search: a deep
  // walk takes one step per page it passes.
  const ends: number[] = [];
  {
    let items = 0;
    for (const block of blocks) {
      items += Math.max(0, Math.trunc(block.itemCount));
      ends.push(items);
    }
  }
  const pageEndingAt = (index: number): number => {
    let low = 0;
    let high = ends.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const end = ends[mid] ?? -1;
      if (end === index) return mid;
      if (end < index) low = mid + 1;
      else high = mid - 1;
    }
    return -1;
  };

  const steps =
    (rowsAt: (index: number) => number): WindowStepAt =>
    (index, budget: StepBudget) => {
      if (index > 0) {
        const blockIndex = pageEndingAt(index);
        const block = blockIndex >= 0 ? blocks[blockIndex] : undefined;
        const rows = block?.rows;
        const items = Math.max(1, Math.trunc(block?.itemCount ?? 1));
        if (
          block !== undefined &&
          rows !== null &&
          rows !== undefined &&
          items < budget.items &&
          rows <= budget.rows
        ) {
          return { items, rows: Math.max(0, Math.trunc(rows)) };
        }
      }
      return { items: 1, rows: rowsAt(index - 1) };
    };

  const window = fitItemsFromEnd({
    itemCount:
      historyBlockItems(blocks) + Math.max(0, Math.trunc(input.coreItemCount)),
    height: input.height,
    maxItems: input.maxItems,
    scrollFromBottom: input.scrollFromBottom,
    measure: input.measure,
    anchor: input.anchor,
    steps,
  });

  return {
    ...window,
    resident: historyBlocksForWindow(blocks, window.start, window.end),
  };
}
