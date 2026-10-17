/**
 * Evicting the *items* of a page while keeping its identity, its count and its
 * messages.
 *
 * A page's residency is atomic — either its items are materialized and its rows
 * measured, or it is a count. This module owns the first half: turning a materialized
 * page into a count, and reporting what the caller has to do about it. `droppedItems`
 * is a report about the caller's **rendered** array: that many items leave its front.
 *
 * It says nothing about the walk. The walk numbers items over every page, and an
 * evicted page still contributes its `itemCount`, so a parked position does **not**
 * move when items are dropped — compensating one here moves the view by exactly the
 * rows that were dropped, which reads as the transcript going empty.
 */

/** The part of a page entry eviction cares about; callers keep their own fields. */
export interface EvictableBlock {
  /** Items the page contributed, whatever its state. */
  itemCount: number;
  /** Its items, or `null` once it is only a count. */
  items: readonly unknown[] | null;
  /** Measured rows, or `null` while nobody has measured the page. */
  rows: number | null;
}

/**
 * Turn every page before `index` into a count.
 *
 * Pages are oldest first, so this evicts the oldest ones; already-evicted pages are
 * left alone (and contribute nothing to `droppedItems`). When nothing changes the
 * caller's array is handed back unchanged, so a caller can publish on identity.
 *
 * **A page with no measured height is never evicted**, whatever `index` asks for:
 * the walk can only skip a page it has a height for, and a page that is a count
 * without a height would leave it measuring a rendered index that now belongs to
 * another page's item — a silently wrong window rather than a visible failure.
 */
export function evictBlocksBefore<T extends EvictableBlock>(
  blocks: readonly T[],
  index: number,
): { blocks: readonly T[]; droppedItems: number } {
  let keep = Math.max(0, Math.trunc(index));
  for (let position = 0; position < keep; position += 1) {
    const block = blocks[position];
    if (block === undefined || block.rows === null) {
      keep = position;
      break;
    }
  }
  let droppedItems = 0;
  let changed = false;
  const next = blocks.map((block, position) => {
    if (position >= keep || block.items === null) return block;
    droppedItems += Math.max(0, Math.trunc(block.itemCount));
    changed = true;
    return { ...block, items: null } as T;
  });
  return changed ? { blocks: next, droppedItems } : { blocks, droppedItems: 0 };
}

/**
 * Items the count-only prefix still accounts for: how far a rendered item index sits
 * below its position in the walk, and therefore the offset a measure callback needs.
 */
export function countOnlyItems(blocks: readonly EvictableBlock[]): number {
  let items = 0;
  for (const block of blocks) {
    if (block.items === null) items += Math.max(0, Math.trunc(block.itemCount));
  }
  return items;
}
