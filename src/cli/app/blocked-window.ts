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
  /**
   * Pages the walk measured **in full** on the way, with the height it found.
   *
   * A page's height is the only thing that lets a later walk skip it in one step, and
   * nobody else can produce it: the walk is what measures items. Reporting it is what
   * makes the second visit cheap instead of the first.
   */
  measuredBlocks: readonly { key: string; rows: number }[];
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

  /** Heights this walk measured item by item, per page. */
  const measured = new Map<string, { rows: number; seen: number }>();

  const steps =
    (rowsAt: (index: number) => number): WindowStepAt =>
    (index, budget: StepBudget) => {
      const block = index > 0 ? blocks[pageEndingAt(index)] : undefined;
      if (block !== undefined) {
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
      const single = rowsAt(index - 1);
      // The walk had to measure this item, and it knows which page it belongs to.
      // Counting them is how a page that nobody had measured gets a height: once
      // every one of its items has been seen, the page is one step from then on.
      if (block !== undefined) {
        const entry = measured.get(block.key);
        measured.set(block.key, {
          rows: (entry?.rows ?? 0) + single,
          seen: (entry?.seen ?? 0) + 1,
        });
      }
      return { items: 1, rows: single };
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

  // Only pages the walk saw in full have a trustworthy height. A partly seen page has
  // no total, and reporting a partial one would make the next walk skip rows it never
  // accounted for.
  const measuredBlocks = blocks.flatMap((block) => {
    const entry = measured.get(block.key);
    if (entry === undefined) return [];
    if (entry.seen < Math.max(1, Math.trunc(block.itemCount))) return [];
    return [{ key: block.key, rows: entry.rows }];
  });

  return {
    ...window,
    resident: historyBlocksForWindow(blocks, window.start, window.end),
    measuredBlocks,
  };
}
