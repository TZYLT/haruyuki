/**
 * Transcript viewport windowing.
 *
 * The full-screen shell renders only the items that intersect the viewport.
 * Given each item's measured row height, the viewport height, how far the user
 * has scrolled up from the bottom, and a hard cap on how many items to render,
 * this computes the visible slice.
 *
 * Pure and height-based so it can be unit-tested independently of Ink: the
 * caller measures rows with the row model and renders `[start, end)`.
 *
 * `fitScrolledItemsFromEnd` walks up from the newest item, measuring as it goes,
 * and stops once the scroll offset plus the viewport are covered. That is what
 * keeps a streaming frame cheap on a long transcript (`scrollFromBottom = 0` --
 * following the newest row -- touches only the window). Reaching the oldest item
 * means the history was measured after all, which is the one case where the walk
 * can also report the total row count and fold back an offset that went past the
 * top.
 *
 * The window is a **row band**, not a set of whole items: it runs from the first
 * item that intersects `[windowTop, windowBottom)` to the last. The top item may
 * therefore be clipped mid-row by Ink (`overflow="hidden"`). Requiring whole
 * items instead would make the middle of an item taller than the viewport
 * unreachable: a long answer could never be read past its first screen.
 */

export interface ViewportWindow {
  /** First visible item index (inclusive). */
  start: number;
  /** Last visible item index (exclusive). */
  end: number;
  /**
   * The scroll offset actually applied: the requested offset clamped to the
   * extent of the history. The clamp is possible only when the walk reached the
   * oldest item, because until then the history length is unknown by design.
   */
  scrollFromBottom: number;
  /**
   * The same position as content, for holding the view while rows arrive below:
   * the window's bottom item and the rows of it scrolled past.
   */
  anchor: ViewportAnchor;
}

/**
 * A scroll position expressed as content rather than as a distance.
 *
 * While the agent streams, rows keep appearing below the viewport. A row offset
 * would then show *older* content every frame — the text under the reader's eyes
 * would crawl upward. An anchor names the window's bottom item and how much of
 * it sits below the viewport instead, so the same rows stay on screen however
 * much arrives underneath. `delta` is always less than that item's height.
 */
export interface ViewportAnchor {
  /** The window's bottom item index. */
  end: number;
  /** Rows of that item which are scrolled past (below the viewport). */
  delta: number;
}

interface WindowWalk {
  start: number;
  end: number;
  /** Set when the walk reached the oldest item, so the whole history is measured. */
  reachedStart: boolean;
  /** Rows in the items at and after `end`: the ones the offset passes over. */
  belowWindow: number;
  /**
   * Rows the walk accumulated in total. It equals the history's row count when
   * `reachedStart` is set; otherwise it covers the offset, the window, and the
   * one item that crossed the top edge.
   */
  measuredRows: number;
}

/**
 * The window for one offset.
 *
 * `scroll` and `topLimit` are both expressed in rows above the newest row:
 * `end` is the first item whose rows below it no longer fit in `scroll`, and the
 * window's top edge is the first item more than `topLimit` rows below the newest
 * one. The caller passes `scroll + height`, or the history's total when it is
 * shorter than the viewport.
 */
function walkWindow(
  count: number,
  limit: number,
  scroll: number,
  topLimit: number,
  rowsAt: (index: number) => number,
): WindowWalk {
  let index = count;
  let rowsBelow = 0;

  // Bounded on purpose. An item with no rows of its own cannot consume an
  // offset, so a run of them would otherwise be walked to the start of the
  // history — and the bound costs nothing for items that do have rows, where
  // each skipped item consumes at least one row of the offset.
  while (
    index > 0 &&
    count - index < scroll + limit &&
    rowsBelow + rowsAt(index - 1) <= scroll
  ) {
    rowsBelow += rowsAt(index - 1);
    index -= 1;
  }
  const end = index;
  const belowWindow = rowsBelow;

  while (
    index > 0 &&
    end - index < limit &&
    rowsBelow + rowsAt(index - 1) < topLimit
  ) {
    rowsBelow += rowsAt(index - 1);
    index -= 1;
  }

  // `index` is the item that crosses the top edge; the window starts there.
  let start = Math.max(0, index - 1);
  // Bounded residency: keep the items nearest the bottom when capped.
  if (end - start > limit) start = end - limit;

  return {
    start,
    end,
    reachedStart: index === 0,
    belowWindow,
    measuredRows: rowsBelow,
  };
}

export function fitScrolledItemsFromEnd(
  itemCount: number,
  height: number,
  maxItems: number,
  scrollFromBottom: number,
  measure: (index: number) => number,
  anchor?: ViewportAnchor,
): ViewportWindow {
  const count = Math.max(0, Math.trunc(itemCount));
  const limit = Math.max(0, Math.trunc(maxItems));
  if (count === 0 || height < 1 || limit === 0) {
    return {
      start: 0,
      end: 0,
      scrollFromBottom: 0,
      anchor: { end: 0, delta: 0 },
    };
  }

  // Heights are memoised because taking an anchor or folding an over-scroll back
  // re-walks the same items.
  const heights = new Map<number, number>();
  const rowsAt = (index: number): number => {
    const cached = heights.get(index);
    if (cached !== undefined) return cached;
    const measured = measure(index);
    const rows = Number.isFinite(measured)
      ? Math.max(0, Math.trunc(measured))
      : 0;
    heights.set(index, rows);
    return rows;
  };

  // An anchor is translated back into an offset here, and only here: it needs the
  // rows that have arrived below it, which is exactly what the walk measures.
  let applied = Math.max(0, Math.trunc(scrollFromBottom));
  if (anchor) {
    const anchorEnd = Math.min(Math.max(0, Math.trunc(anchor.end)), count);
    let belowAnchor = 0;
    for (let index = count; index > anchorEnd; index -= 1) {
      belowAnchor += rowsAt(index - 1);
    }
    applied = belowAnchor + Math.max(0, Math.trunc(anchor.delta));
  }

  const first = walkWindow(count, limit, applied, applied + height, rowsAt);
  if (!first.reachedStart) {
    return {
      start: first.start,
      end: first.end,
      scrollFromBottom: applied,
      anchor: { end: first.end, delta: applied - first.belowWindow },
    };
  }

  // The walk reached the oldest item, so every height is known and the history's
  // row count is `rowsBelow`. That fixes the two things the lazy pass cannot know
  // earlier: the largest offset that still shows something new, and the window's
  // top edge for a history shorter than the viewport -- the band then degenerates
  // to the whole history.
  const total = first.measuredRows;
  if (total <= 0) {
    return {
      start: 0,
      end: 0,
      scrollFromBottom: 0,
      anchor: { end: 0, delta: 0 },
    };
  }

  const clamped = Math.min(applied, Math.max(0, total - height));
  const second = walkWindow(
    count,
    limit,
    clamped,
    Math.min(clamped + height, total),
    rowsAt,
  );
  return {
    start: second.start,
    end: second.end,
    scrollFromBottom: clamped,
    anchor: { end: second.end, delta: clamped - second.belowWindow },
  };
}
