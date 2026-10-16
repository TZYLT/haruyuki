import type { HistoryBlock } from "./history-blocks";

/**
 * A position in a paged history that survives materialization.
 *
 * `ViewportAnchor` names its window's bottom item by **global item index**, which is
 * only meaningful while every loaded page is materialized: evicting one page shifts
 * every index above it, so a parked view would move whenever the resident set
 * changed. A block anchor names the page **itself** — by the cursor it was fetched
 * before, which does not change for the page's whole life — plus the offset inside
 * it, so materializing or evicting any page leaves the triple untouched.
 *
 * That property is the whole reason this type exists, and it is what a frame test
 * has to hold: a page's residency is atomic (either its items are materialized and
 * its rows measured, or it is a count), so eviction cannot move an `offsetInBlock`,
 * and paging only ever inserts whole pages *outside* the resident ones.
 */
export interface HistoryAnchor {
  /** The page's identity: the cursor it was fetched before. */
  blockKey: string;
  /** Items into that page, counted from its start. */
  offsetInBlock: number;
  /** Rows of that item scrolled past, as in `ViewportAnchor`. */
  delta: number;
}

/** Where a page starts, in global item indices, or `null` when it is not loaded. */
function startOfBlock(
  blocks: readonly HistoryBlock[],
  blockKey: string,
): number | null {
  let start = 0;
  for (const block of blocks) {
    if (block.key === blockKey) return start;
    start += Math.max(0, Math.trunc(block.itemCount));
  }
  return null;
}

/** The global item index an anchor names, or `null` when its page is gone. */
export function globalItemForHistoryAnchor(
  blocks: readonly HistoryBlock[],
  anchor: HistoryAnchor,
): number | null {
  const start = startOfBlock(blocks, anchor.blockKey);
  if (start === null) return null;
  return start + Math.max(0, Math.trunc(anchor.offsetInBlock));
}

/**
 * The anchor naming a global item index, or `null` when that index falls in the
 * core — which is not a page, and does not move when pages do.
 */
export function historyAnchorForGlobalItem(
  blocks: readonly HistoryBlock[],
  itemIndex: number,
  delta: number,
): HistoryAnchor | null {
  const index = Math.max(0, Math.trunc(itemIndex));
  let start = 0;
  for (const block of blocks) {
    const items = Math.max(0, Math.trunc(block.itemCount));
    if (index < start + items) {
      return { blockKey: block.key, offsetInBlock: index - start, delta };
    }
    start += items;
  }
  return null;
}

/** Whether the anchor still names a page that is loaded, so a caller can fall back. */
export function historyAnchorIsLive(
  blocks: readonly HistoryBlock[],
  anchor: HistoryAnchor,
): boolean {
  return startOfBlock(blocks, anchor.blockKey) !== null;
}
