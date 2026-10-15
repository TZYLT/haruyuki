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
 * `fitWholeItemsFromEnd` is the window the full-screen shell uses: it takes a
 * measure callback so only the items on screen are measured, which is what keeps
 * a streaming frame cheap on a long transcript. `layoutViewport` is the
 * scroll-aware row-band variant the scrolling input will need.
 *
 * Scrolling is expressed as `scrollFromBottom` (0 = pinned to the newest row),
 * which is what "sticky to bottom" needs: following is just keeping the offset
 * at 0.
 */

export interface ViewportLayoutOptions {
  /** Rows available for the transcript viewport. */
  height: number;
  /** Rows scrolled up from the bottom; 0 keeps the view pinned to the newest row. */
  scrollFromBottom?: number;
  /** Hard cap on how many items to render (bounded residency). */
  maxItems?: number;
}

export interface ViewportLayout {
  /** First visible item index (inclusive). */
  start: number;
  /** Last visible item index (exclusive). */
  end: number;
  /** Rows hidden above the first visible item. */
  rowsAbove: number;
  /** Rows hidden below the last visible item. */
  rowsBelow: number;
  /** Total rows across all items. */
  totalRows: number;
  /** Set when the tallest single item exceeds the viewport height. */
  clipped: boolean;
}

/** Sum of the row heights. */
export function totalRows(rows: readonly number[]): number {
  return rows.reduce((sum, row) => sum + Math.max(0, row), 0);
}

/**
 * Bottom-anchored selection of whole items that fit in `height` rows.
 *
 * Items are kept whole so nothing has to be clipped mid-item; a partially
 * visible top item is deferred to the next scroll step instead.
 */
/**
 * Bottom-anchored selection of whole items that fit in `height` rows, measuring
 * each item lazily from the end.
 *
 * Only the items on screen need a height, so `measure` is called from the end
 * backwards and stops as soon as one more item would not fit. The work is
 * therefore bounded by the window (plus the one item that did not fit), never by
 * the history length — which matters because this runs on every streaming frame,
 * where a full pass over a long transcript costs more than the frame budget.
 *
 * The walk also stops at `maxItems`, so the residency cap bounds the *measuring*
 * as well as the rendering.
 */
export function fitWholeItemsFromEnd(
  itemCount: number,
  height: number,
  maxItems: number,
  measure: (index: number) => number,
): { start: number; end: number } {
  const end = Math.max(0, Math.trunc(itemCount));
  const limit = Math.max(0, Math.trunc(maxItems));

  let used = 0;
  let start = end;
  while (start > 0 && end - start < limit) {
    const next = Math.max(0, measure(start - 1));
    if (used + next > height) break;
    used += next;
    start -= 1;
  }
  return { start, end };
}

export function layoutViewport(
  rows: readonly number[],
  options: ViewportLayoutOptions,
): ViewportLayout {
  const height = Math.max(0, options.height);
  const total = totalRows(rows);

  if (height <= 0 || rows.length === 0 || total <= 0) {
    return {
      start: 0,
      end: 0,
      rowsAbove: 0,
      rowsBelow: total,
      totalRows: total,
      clipped: total > height,
    };
  }

  const maxScroll = Math.max(0, total - height);
  const scroll = Math.min(
    Math.max(0, options.scrollFromBottom ?? 0),
    maxScroll,
  );

  // Visible row band, in absolute row coordinates.
  const windowBottom = total - scroll;
  const windowTop = Math.max(0, windowBottom - height);

  // Prefix sums to find the items that intersect the band.
  let start = 0;
  let cumulative = 0;
  while (
    start < rows.length &&
    cumulative + Math.max(0, rows[start] ?? 0) <= windowTop
  ) {
    cumulative += Math.max(0, rows[start] ?? 0);
    start += 1;
  }

  let end = start;
  let running = cumulative;
  while (end < rows.length && running < windowBottom) {
    running += Math.max(0, rows[end] ?? 0);
    end += 1;
  }

  // Bounded residency: keep the items nearest the bottom when capped.
  const maxItems = options.maxItems ?? Number.POSITIVE_INFINITY;
  if (end - start > maxItems) {
    start = end - Math.trunc(maxItems);
    cumulative = 0;
    for (let i = 0; i < start; i += 1) {
      cumulative += Math.max(0, rows[i] ?? 0);
    }
  }

  const rowsAbove = cumulative;
  const rowsBelow = Math.max(0, total - running);

  return {
    start,
    end,
    rowsAbove,
    rowsBelow,
    totalRows: total,
    clipped: total > height,
  };
}
