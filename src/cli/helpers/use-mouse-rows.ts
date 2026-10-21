import { type DOMElement, measureElement } from "ink";
import { type RefObject, useEffect, useRef } from "react";
import { clearHoverIn, setHoverTarget } from "./hover-store";
import { createClickTracker } from "./mouse-click";
import type { MouseLayer } from "./mouse-router";
import { registerMouseHandler } from "./mouse-router";
import type { MouseReport } from "./mouse-sequence";
import { acquireMouseHover } from "./mouse-tracking";

/**
 * A block of rows that the pointer can aim at, one row per index.
 *
 * This is the row counterpart of the tab strip's `regions` (`app/shell/
 * tab-strip-layout.ts`): the component draws a list, and the same numbers that
 * drew it answer the pointer. What differs is where the geometry comes from. The
 * strip is on a fixed row of a pinned frame and only needs columns; a popup or a
 * page body can sit anywhere, so it measures itself — `measureElement` returns
 * the box's *absolute* layout position (Ink 7 walks up the ancestors), and the
 * frame is pinned to the screen, so that `y` is a screen row and `x` is a screen
 * column. Nothing here guesses an absolute row from the tree's shape.
 *
 * The contract is 《38》§19.2: **a click is that row's `Enter`**, nothing more. It
 * moves the cursor (the row's own component does that in `activate`) and calls the
 * handler the keyboard calls — there is no second execution path. Rows the surface
 * does not act on (a group title, a blank, a disabled item) are reported by
 * `isInteractive` and are transparent to the pointer, exactly as they are to
 * `↑↓`.
 *
 * The handler claims the block, not the frame: a press outside its rectangle
 * returns `false` so the next layer is offered it (the page's own wheel, the
 * transcript's selection). That is what keeps a popup from eating clicks on the
 * composer it sits above.
 */
export type MouseRowsOptions = {
  /** Which surface these rows belong to (`"autocomplete"`, `"page"`, …). */
  area: string;
  /** The element that lays the rows out; measured at event time. */
  ref: RefObject<DOMElement | null>;
  /** How many rows the block has. */
  rowCount: number;
  /** Rows above index 0 inside the same box (a header line, say). */
  firstRow?: number;
  /** Rows the pointer may act on. Default: every row. */
  isInteractive?: (index: number) => boolean;
  /** Click on a row: move the cursor there and run that row's Enter. */
  activate: (index: number) => void;
  /** Whether hovering paints a row (`surface.hoverBg`). Default: true. */
  hoverable?: boolean;
  /** Which mouse layer claims the block. Default: `content`. */
  layer?: MouseLayer;
  /** Off while the surface is not up (it is unmounted or hidden). */
  enabled?: boolean;
};

type Row = { index: number; row: number; from: number; to: number };

function rowAt(options: MouseRowsOptions, report: MouseReport): Row | null {
  const node = options.ref.current;
  if (!node) return null;
  const box = measureElement(node);
  if (box.height <= 0 || box.width <= 0) return null;
  const firstRow = options.firstRow ?? 0;
  // `measureElement` is 0-based on both axes (the layout tree's origin), while a
  // mouse report is 1-based: the frame's first row and column are 1.
  const index = report.row - 1 - box.y - firstRow;
  if (index < 0 || index >= options.rowCount) return null;
  if (report.column < box.x + 1 || report.column > box.x + box.width)
    return null;
  if (options.isInteractive && !options.isInteractive(index)) return null;
  return {
    index,
    row: box.y + 1 + firstRow + index,
    from: box.x + 1,
    to: box.x + box.width,
  };
}

/**
 * Register a block of rows with the mouse router.
 *
 * The handler reads `options` through a ref, so a handler registered once sees the
 * current render's rows and callbacks — re-registering per render would reorder
 * the handler chain mid-gesture, the defect `mouse-router.ts` documents for the
 * tab row.
 */
export function useMouseRows(options: MouseRowsOptions): void {
  const tracker = useRef(createClickTracker());
  const latest = useRef(options);
  latest.current = options;
  const enabled = options.enabled ?? true;
  const hoverable = (options.hoverable ?? true) && enabled;

  // Any-motion is asked for only while a hoverable surface is up, and given back
  // with it (《38》§19.3 4). `Ctrl+X m` switching reporting off is honoured inside
  // `mouse-tracking.ts`, so a claim cannot leave `1003` on.
  useEffect(() => {
    if (!hoverable) return undefined;
    return acquireMouseHover();
  }, [hoverable]);

  // A surface that goes away while hovered must not leave a row lit underneath
  // whatever replaces it.
  //
  // That includes the surface **unmounting**, which is the case this effect
  // started out missing: the cleanup was attached only when `enabled` was false,
  // so a page whose rows the pointer had lit went away without telling the store.
  // The target then stayed behind — climbing back to the same page painted a row
  // the pointer was nowhere near, until the next motion report cleared it. A live
  // surface is unaffected: `enabled` does not toggle on a re-render, and an area
  // clears only its own rows.
  useEffect(() => {
    if (!enabled) return undefined;
    return () => {
      clearHoverIn(latest.current.area);
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return undefined;
    return registerMouseHandler(
      (report) => {
        const current = latest.current;
        if (report.wheel) return false;

        if (report.kind === "press") {
          const row = rowAt(current, report);
          if (!row) return false;
          tracker.current.press(report, Date.now());
          return true;
        }

        if (report.kind === "move") {
          // A press this block claimed owns the motion of its own gesture: the
          // release is still to come, and offering the cells to the layer below
          // would start a selection under the pointer.
          if (tracker.current.isPending()) {
            tracker.current.move(report);
            return true;
          }
          const row = rowAt(current, report);
          if (!row) {
            clearHoverIn(current.area);
            return false;
          }
          if ((current.hoverable ?? true) && current.enabled !== false) {
            setHoverTarget({ area: current.area, index: row.index });
          }
          return true;
        }

        // Release: a click resolves to the press cell (the tracker's rule), and
        // the row it landed in is the row whose `Enter` runs.
        const wasPending = tracker.current.isPending();
        const point = tracker.current.release(report, Date.now());
        if (!point) return wasPending;
        const row = rowAt(current, {
          ...report,
          row: point.row,
          column: point.column,
        });
        if (!row) return true;
        current.activate(row.index);
        return true;
      },
      { layer: options.layer ?? "content", name: options.area },
    );
  }, [enabled, options.layer, options.area]);
}
