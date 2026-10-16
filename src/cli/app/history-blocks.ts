/**
 * The paged history as blocks, so a deep transcript can be walked without
 * materializing every page (F1-C).
 *
 * Blocks are **oldest first and contiguous from the start of the history**: paging
 * prepends a page, so block 0 is the oldest page ever fetched and the core's items
 * sit after the last block. That ordering is what makes a global item index a
 * prefix sum, which is all the window walk needs to jump a whole page.
 *
 * `rows` is filled in by the viewport, never by this module: a block's row height
 * depends on display state (Ctrl+T/R), column width, terminal rows and diffs, so
 * only the measuring path can answer it. `rows === null` therefore means "not
 * measured yet", and a block in that state must be materialized before a walk can
 * skip over it — the count is a number, but the *height* is not known until then.
 */

export interface HistoryBlock {
  /** Identity: the cursor the page was fetched before (`null` for the oldest page). */
  key: string;
  /** Items the page assembled. */
  itemCount: number;
  /** Rows measured for the whole block, or `null` until the viewport reports them. */
  rows: number | null;
}

function blockItems(block: HistoryBlock | undefined): number {
  return Math.max(0, Math.trunc(block?.itemCount ?? 0));
}

/** Items the blocks hold, together: where the core's items start. */
export function historyBlockItems(blocks: readonly HistoryBlock[]): number {
  let items = 0;
  for (const block of blocks) items += blockItems(block);
  return items;
}

/** The block a global item index falls in, or `null` when the index is in the core. */
export function historyBlockAt(
  blocks: readonly HistoryBlock[],
  index: number,
): number | null {
  if (index < 0) return null;
  let start = 0;
  for (let i = 0; i < blocks.length; i += 1) {
    start += blockItems(blocks[i]);
    if (index < start) return i;
  }
  return null;
}

/**
 * The blocks a window of global item indices touches, plus `slack` blocks either
 * side. `null` when the window is entirely in the core, which is the steady state
 * while following the newest row: no block has to be resident for that frame.
 */
export function historyBlocksForWindow(
  blocks: readonly HistoryBlock[],
  firstItem: number,
  lastItem: number,
  slack = 1,
): { from: number; to: number } | null {
  if (blocks.length === 0 || lastItem <= firstItem) return null;
  const from = historyBlockAt(blocks, Math.max(0, firstItem));
  const to = historyBlockAt(blocks, Math.max(0, lastItem - 1));
  if (from === null && to === null) return null;
  const first = from ?? to ?? 0;
  const last = to ?? from ?? 0;
  return {
    from: Math.max(0, first - slack),
    to: Math.min(blocks.length - 1, last + Math.max(0, slack)),
  };
}

/**
 * Record a measured block height. Returns the same list when nothing changed, so a
 * caller can use identity to decide whether a re-render is needed — the viewport
 * reports on every frame, but a height only moves when the layout does.
 */
export function withHistoryBlockRows(
  blocks: readonly HistoryBlock[],
  key: string,
  rows: number,
): readonly HistoryBlock[] {
  let changed = false;
  const next = blocks.map((block) => {
    if (block.key !== key || block.rows === rows) return block;
    changed = true;
    return { ...block, rows };
  });
  return changed ? next : blocks;
}
