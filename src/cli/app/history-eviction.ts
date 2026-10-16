/**
 * Evicting the *items* of a page while keeping its identity, its count and its
 * messages.
 *
 * A page's residency is atomic — either its items are materialized and its rows
 * measured, or it is a count. This module owns the first half: turning a
 * materialized page into a count, and reporting what the caller has to do about it.
 * `droppedItems` is the whole report: the caller drops that many items from the front
 * of its rendered array **and** moves a parked anchor — which names an item index — by
 * the same amount. `older-history.ts` does both in one place, next to the notice that
 * tells the frame they arrived together.
 *
 * `droppedItems` is that report, and it is the whole reason this returns a value
 * rather than mutating: the caller's rendered item array has to lose exactly those
 * items from its **front**, and a parked anchor — which names an item *index* —
 * has to move down by exactly that many. Dropping the items without shifting the
 * anchor is what "the parked view moves on its own" looks like.
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
