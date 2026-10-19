// src/cli/app/shell/use-chrome-clicks.ts

import { useEffect, useRef } from "react";
import { clearSelection } from "@/cli/app/viewport-selection";
import { owningInputScope } from "@/cli/helpers/focus-ledger";
import { registerMouseHandler } from "@/cli/helpers/mouse-router";
import { createClickTracker } from "./chrome-click";
import type { TabStripRegion } from "./tab-strip-layout";

/**
 * The mouse half of the top bar.
 *
 * A mouse report already arrives in **screen** coordinates, and the full-screen
 * frame is pinned to the screen's rows, so the frame's row 1 is the tab row and a
 * report's `column` is the column the strip laid its regions out in. That is why
 * this file needs no coordinate conversion: it looks the click up in the same
 * `regions` the strip painted from (`tab-strip-layout.ts`), so what the user aimed
 * at and what was clicked cannot drift.
 *
 * Four rules, all from 《38》§4:
 *
 * 1. **Chrome rows are claimed.** A press on the tab row is spent here — never
 *    offered to the selection, and never typed into the draft.
 * 2. **A click is decided by `chrome-click.ts`**, and only then does it resolve to
 *    a region: the name switches, the `×` closes.
 * 3. **An open overlay or approval owns the pointer too.** The ruling is that the
 *    keyboard has one owner; a click that switched tabs out from under a selector
 *    would be the same defect through a different input, so a blocked scope is
 *    declined outright (2026-10-19 ruling).
 * 4. **While a page owns the main area, nothing there is text.** The transcript is
 *    not mounted, so a press in its place must not start a selection over whatever
 *    numbers the band last reported.
 *
 * The handler is registered once and reads its inputs through a ref: the layout
 * changes on every title or resize, and re-registering a mouse handler mid-drag
 * would reorder the handler chain.
 */
export type ChromeClicksOptions = {
  /** The tab row's clickable rectangles, from the layout the strip drew. */
  regions: readonly TabStripRegion[];
  /** A click on a tab's name. */
  onSelect: (tabId: string) => void;
  /** A click on a tab's `×`. */
  onClose: (tabId: string) => void;
  /** Whether the main area is a page right now. */
  pageActive: boolean;
};

/** The strip's label row. The rule under it is chrome that is not clickable. */
const TAB_ROW = 1;

function regionAt(
  regions: readonly TabStripRegion[],
  column: number,
): TabStripRegion | undefined {
  return regions.find((region) => column >= region.from && column <= region.to);
}

/** The scope that owns the keyboard is also the one that owns the pointer. */
function pointerIsBlocked(): boolean {
  const owning = owningInputScope();
  return owning === "modal" || owning === "overlay";
}

export function useChromeClicks(options: ChromeClicksOptions): void {
  const tracker = useRef(createClickTracker());
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    return registerMouseHandler((report) => {
      if (pointerIsBlocked()) return false;
      if (report.wheel) return false;

      if (report.kind === "press") {
        if (report.button !== "left") return false;
        if (report.row === TAB_ROW) {
          tracker.current.press(report, Date.now());
          return true;
        }
        if (latest.current.pageActive && report.row > TAB_ROW) {
          clearSelection();
          return true;
        }
        return false;
      }

      if (report.kind === "move") {
        // A drag that began on the strip is not a click and not a selection.
        if (!tracker.current.isPending()) return false;
        tracker.current.cancel();
        return true;
      }

      // A press this layer claimed owns its release even when it was not a click:
      // a slow press, or a release on a different cell after the motion handler
      // cancelled the candidate. Returning `false` there would hand the tail of a
      // chrome gesture to the selection layer, which reads a release as the end of
      // a drag it never had.
      const wasPending = tracker.current.isPending();
      const point = tracker.current.release(report, Date.now());
      if (!point) return wasPending;
      const region = regionAt(latest.current.regions, point.column);
      if (!region) return true;
      if (region.part === "close") latest.current.onClose(region.id);
      else latest.current.onSelect(region.id);
      return true;
    });
  }, []);
}
