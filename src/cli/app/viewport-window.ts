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
   * Rows to shift the rendered window by: positive pushes it down, negative pulls
   * it up so the band clips what is above it.
   *
   * The window is a row band, so the offset decides *which* rows of the bottom
   * item are shown — and Ink, aligning a column to the end of its box, cannot
   * express that on its own. It is expressed with a negative top margin instead:
   * a content box `rows + contentOffset` tall, of which the band shows the middle.
   *
   * Without it the band was simply bottom-aligned, which made the offset
   * invisible: a scroll that stayed inside an item taller than the band redrew an
   * identical frame, so the wheel moved the offset and nothing on screen — and on
   * Windows an unchanged frame is still cleared and repainted, which is the flash
   * that comes with it.
   */
  contentOffset: number;
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
/**
 * One step of the walk: the items it accounts for, and the rows it covers.
 *
 * One item is the ordinary case. A whole page is the blocked one: when history is
 * paged in, each page has a row count the viewport measured (F1-C), so a walk that
 * is passing *over* a page entirely can account for it in one step instead of
 * measuring every item in it. Nothing else about the two loops below changes,
 * which is what keeps a blocked window and this one selecting the same rows.
 */
export interface WindowStep {
  /** Items the step covers, counted downwards from the boundary. */
  items: number;
  /** Rows the step accounts for. */
  rows: number;
}

/**
 * What the walk can afford at this boundary.
 *
 * `items` is the item-count bound the loops are under. `rows` is the rows the
 * current loop condition would still accept, as the largest row count that
 * satisfies it — the bottom edge allows `<=`, the top edge `<`.
 *
 * A step provider offering more than one item has to respect **both**. This is the
 * trap the differential test caught: a page step that does not fit the rows budget
 * has to be refused by the *provider*, because `walkWindow` breaks on a step that
 * does not fit — which is right for one item (it is what the item walk does) and
 * wrong for a page, since the item walk would have continued with single items and
 * selected a different window.
 */
export interface StepBudget {
  items: number;
  rows: number;
}

export type WindowStepAt = (index: number, budget: StepBudget) => WindowStep;

/** The step that walks one measured item — the unblocked walk. */
export function itemStepAt(rowsAt: (index: number) => number): WindowStepAt {
  return (index) => ({ items: 1, rows: rowsAt(index - 1) });
}

/**
 * Walk from the newest item towards the oldest, in steps.
 *
 * Both loops are the original ones, with `rowsAt(index - 1)` replaced by the step
 * the caller offers at that boundary. A multi-item step is only legal where the
 * *whole* step lies below the edge being found: the top edge keeps `start = index
 * - 1`, which names the item that crosses it, and that is the item above a block
 * step rather than one inside it.
 */
export function walkWindow(
  count: number,
  limit: number,
  scroll: number,
  topLimit: number,
  stepAt: WindowStepAt,
): WindowWalk {
  let index = count;
  let rowsBelow = 0;

  // Bounded on purpose. An item with no rows of its own cannot consume an
  // offset, so a run of them would otherwise be walked to the start of the
  // history — and the bound costs nothing for items that do have rows, where
  // each skipped item consumes at least one row of the offset.
  while (index > 0 && count - index < scroll + limit) {
    const step = stepAt(index, {
      items: scroll + limit - (count - index),
      rows: scroll - rowsBelow,
    });
    if (rowsBelow + step.rows > scroll) break;
    rowsBelow += step.rows;
    index -= Math.max(1, step.items);
  }
  const end = index;
  const belowWindow = rowsBelow;

  while (index > 0 && end - index < limit) {
    const step = stepAt(index, {
      items: limit - (end - index),
      rows: topLimit - rowsBelow - 1,
    });
    if (rowsBelow + step.rows >= topLimit) break;
    rowsBelow += step.rows;
    index -= Math.max(1, step.items);
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

export interface FitItemsInput {
  itemCount: number;
  height: number;
  maxItems: number;
  scrollFromBottom: number;
  measure: (index: number) => number;
  anchor?: ViewportAnchor;
  /**
   * The steps the walk may take, built from the memoised row reader. Omitted means
   * one measured item per step. This is the seam a paged history uses
   * (`blocked-window.ts`): with a row count measured per page, a walk passing over
   * a whole page accounts for it in one step instead of measuring every item.
   */
  steps?: (rowsAt: (index: number) => number) => WindowStepAt;
}

/**
 * The window for one position, over steps the caller chooses.
 *
 * `fitScrolledItemsFromEnd` is this with the default one-item steps. Keeping one
 * implementation of the orchestration — the anchor translation, the two walks, the
 * offset clamp, `contentOffset` — is what leaves a step provider as the *only*
 * thing a paged history has to get right, and a differential test able to isolate
 * exactly it.
 */
export function fitItemsFromEnd(input: FitItemsInput): ViewportWindow {
  const count = Math.max(0, Math.trunc(input.itemCount));
  const limit = Math.max(0, Math.trunc(input.maxItems));
  const height = input.height;
  if (count === 0 || height < 1 || limit === 0) {
    return {
      start: 0,
      end: 0,
      scrollFromBottom: 0,
      contentOffset: 0,
      anchor: { end: 0, delta: 0 },
    };
  }

  // Heights are memoised because taking an anchor or folding an over-scroll back
  // re-walks the same items.
  const heights = new Map<number, number>();
  const rowsAt = (index: number): number => {
    const cached = heights.get(index);
    if (cached !== undefined) return cached;
    const measured = input.measure(index);
    const rows = Number.isFinite(measured)
      ? Math.max(0, Math.trunc(measured))
      : 0;
    heights.set(index, rows);
    return rows;
  };

  const stepAt = (input.steps ?? itemStepAt)(rowsAt);

  // An anchor is translated back into an offset here, and only here: it needs the
  // rows that have arrived below it, which is exactly what the walk measures. It
  // steps like the walk does, so a paged history does not pay per item here either.
  let applied = Math.max(0, Math.trunc(input.scrollFromBottom));
  const anchor = input.anchor;
  if (anchor) {
    const anchorEnd = Math.min(Math.max(0, Math.trunc(anchor.end)), count);
    let belowAnchor = 0;
    let index = count;
    while (index > anchorEnd) {
      const step = stepAt(index, {
        items: Number.POSITIVE_INFINITY,
        rows: Number.POSITIVE_INFINITY,
      });
      if (step.items > 1 && index - step.items >= anchorEnd) {
        belowAnchor += step.rows;
        index -= step.items;
        continue;
      }
      belowAnchor += rowsAt(index - 1);
      index -= 1;
    }
    applied = belowAnchor + Math.max(0, Math.trunc(anchor.delta));
  }

  const first = walkWindow(count, limit, applied, applied + height, stepAt);
  const contentRows = (start: number, end: number): number => {
    let rows = 0;
    for (let index = start; index < end; index += 1) rows += rowsAt(index);
    return rows;
  };

  if (!first.reachedStart) {
    return {
      start: first.start,
      end: first.end,
      scrollFromBottom: applied,
      // `delta` rows of the bottom item sit below the band, so the band's top row
      // is that much further up inside the content.
      contentOffset:
        height -
        contentRows(first.start, first.end) +
        applied -
        first.belowWindow,
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
      contentOffset: 0,
      anchor: { end: 0, delta: 0 },
    };
  }

  const clamped = Math.min(applied, Math.max(0, total - height));
  const second = walkWindow(
    count,
    limit,
    clamped,
    Math.min(clamped + height, total),
    stepAt,
  );
  return {
    start: second.start,
    end: second.end,
    scrollFromBottom: clamped,
    contentOffset:
      height -
      contentRows(second.start, second.end) +
      clamped -
      second.belowWindow,
    anchor: { end: second.end, delta: clamped - second.belowWindow },
  };
}

/**
 * The window for one position over a fully materialised list: one measured item per
 * step. Kept as its own name because that is what every caller and test reads, and
 * because it is the oracle a paged history is weighed against.
 */
export function fitScrolledItemsFromEnd(
  itemCount: number,
  height: number,
  maxItems: number,
  scrollFromBottom: number,
  measure: (index: number) => number,
  anchor?: ViewportAnchor,
): ViewportWindow {
  return fitItemsFromEnd({
    itemCount,
    height,
    maxItems,
    scrollFromBottom,
    measure,
    anchor,
  });
}
