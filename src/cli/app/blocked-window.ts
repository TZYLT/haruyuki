import {
  type HistoryBlock,
  historyBlockAt,
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
 * A page is one step only when the walk's boundary is that page's **end** (its last
 * item, plus one), its rows are measured, and it fits **both** budgets. The row budget
 * is the trap a differential test caught: `walkWindow` breaks on a step that does not
 * fit, right for one item and wrong for a page, so the refusal has to happen here.
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
  /**
   * Whether the item at this index is actually in the rendered list.
   *
   * A page whose items were dropped is still walked by its count, but the walk can
   * land **inside** one, and then the item heights it reads are not measurements: the
   * rows are not there to be measured. Reporting those as a page height poisons the
   * ledger — a page recorded as zero rows is skipped by every later walk, so its rows
   * can never be drawn again. Defaults to "everything is materialized".
   */
  isMaterialized?: (index: number) => boolean;
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

  /**
   * Heights this walk measured item by item, per page, **by item index**.
   *
   * Keyed by index rather than accumulated per call on purpose: the step provider is
   * asked more than once at the same boundary (the first walk breaks on a step that
   * does not fit and the second restarts there; the anchor translation and the
   * fold-back re-walk go over the same ground), and counting calls made a page look
   * "seen in full" with a height of roughly twice its rows. A height recorded that way
   * is skipped by every later walk, so the window it selects drifts from the rows on
   * screen.
   */
  const seenRows = new Map<string, Map<number, number>>();

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
      // The walk had to measure this item, and it knows which page it belongs to. It
      // is the item at `index - 1` that was measured, so the page is the one that
      // *contains* it: asking which page ends at `index` would count only each page's
      // last item, and no page would ever look fully measured.
      const owningIndex = historyBlockAt(blocks, index - 1);
      const owningBlock =
        owningIndex === null ? undefined : blocks[owningIndex];
      // Only a row that was really there counts as a height. An item whose page is
      // only a count has no rows to measure, whatever the caller's fallback reads.
      const measuredHere = input.isMaterialized?.(index - 1) ?? true;
      if (owningBlock !== undefined && measuredHere) {
        let perItem = seenRows.get(owningBlock.key);
        if (perItem === undefined) {
          perItem = new Map();
          seenRows.set(owningBlock.key, perItem);
        }
        perItem.set(index - 1, single);
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
    const perItem = seenRows.get(block.key);
    if (perItem === undefined) return [];
    if (perItem.size < Math.max(1, Math.trunc(block.itemCount))) return [];
    let rows = 0;
    for (const value of perItem.values()) rows += value;
    return [{ key: block.key, rows }];
  });

  return {
    ...window,
    resident: historyBlocksForWindow(blocks, window.start, window.end),
    measuredBlocks,
  };
}
