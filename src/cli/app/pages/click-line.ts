// src/cli/app/pages/click-line.ts

import { type DOMElement, measureElement } from "ink";
import { type RefObject, useEffect, useRef } from "react";
import { terminalTextWidth } from "@/cli/helpers/char-width";
import { createClickTracker } from "@/cli/helpers/mouse-click";
import { registerMouseHandler } from "@/cli/helpers/mouse-router";

/**
 * One row of page header that the pointer can aim at, word by word.
 *
 * Pages own the main area, so a page's header is chrome the pointer otherwise
 * cannot use: the settings page had a breadcrumb that *named* screens but did
 * nothing when clicked (reported from the first real run), and the usage page
 * named its two screens in the same way. Both need the same arithmetic — the
 * line is drawn left to right from the row's first cell, so a click's offset is
 * the cell count walked through the segments' own widths — and neither may
 * import the other's implementation, so the arithmetic lives here once.
 *
 * Two rules the pages depend on:
 *
 * - **Only the words are targets.** A segment with no `target` (the `Usage /`
 *   prefix, the date, the key hints, a breadcrumb separator) is transparent: the
 *   click is spent on nothing rather than on the page behind it. That is also the
 *   keyboard's answer — `Esc` is the way out, not a stray click.
 * - **Measured at event time.** The header's row moves with the chrome above it
 *   (a panel, a taller composer), and a cached row would aim at whatever used to
 *   be there.
 */
export type ClickSegment<T extends string = string> = {
  /** What the segment draws; its width in cells is the click's extent. */
  label: string;
  /** Where clicking this segment goes; `undefined` when it goes nowhere. */
  target?: T;
};

/** The whole line, as the header draws it: segments joined by `separator`. */
export function lineText<T extends string>(
  segments: readonly ClickSegment<T>[],
  separator = "",
): string {
  return segments.map((segment) => segment.label).join(separator);
}

/**
 * Which segment a column inside the line points at.
 *
 * Columns are 0-based offsets from the first drawn cell. A click in a separator
 * between two segments belongs to neither — the same rule the tab strip uses for
 * its gaps (`tab-strip-layout.ts`). Widths come from `terminalTextWidth`, which
 * is what the terminal draws, not the code-point count (a CJK label is two
 * cells).
 */
export function segmentAt<T extends string>(
  segments: readonly ClickSegment<T>[],
  offset: number,
  separator = "",
): ClickSegment<T> | undefined {
  let start = 0;
  const gap = terminalTextWidth(separator);
  for (const segment of segments) {
    const width = terminalTextWidth(segment.label);
    if (offset >= start && offset < start + width) return segment;
    start += width + gap;
  }
  return undefined;
}

/**
 * Make a header line's segments clickable.
 *
 * The geometry is the settings breadcrumb's: the line is one row at the box's own
 * y, and its text starts at the box's own x (both the layout tree's 0-based
 * coordinates, while a mouse report is 1-based — the conversion happens here,
 * once). A press starts a candidate, motion is remembered, and the release
 * decides whether it was a click (mouse-click.ts), so a drag across the header
 * does not fire a screen switch.
 *
 * `onSelect` is read through a ref: the page re-renders on every screen change
 * and every keystroke, and re-registering a handler mid-gesture would reorder the
 * chain under a live press (`mouse-router.ts`). `name` is diagnostic only — it is
 * what makes `HARUYUKI_DEBUG_MOUSE` say which header claimed a press.
 */
export function useLineClicks<T extends string>(input: {
  ref: RefObject<DOMElement | null>;
  segments: readonly ClickSegment<T>[];
  onSelect: (segment: ClickSegment<T>) => void;
  /** What separates two segments in the drawn line; `""` when they abut. */
  separator?: string;
  name?: string;
}): void {
  const tracker = useRef(createClickTracker());
  const latest = useRef(input);
  latest.current = input;
  const { ref, name } = input;

  useEffect(() => {
    return registerMouseHandler(
      (report) => {
        if (report.wheel) return false;
        const node = ref.current;
        if (!node) return false;
        const box = measureElement(node);
        if (box.width <= 0 || box.height <= 0) return false;
        // The header is one row: the report is 1-based, the layout tree 0-based.
        if (report.row !== box.y + 1) return false;
        const offset = report.column - (box.x + 1);
        if (offset < 0 || offset >= box.width) return false;
        const segment = segmentAt(
          latest.current.segments,
          offset,
          latest.current.separator,
        );
        // A segment with no screen behind it declines the press: the click is
        // spent on nothing, never on the page's rows under the header.
        if (!segment?.target) return false;

        if (report.kind === "press") {
          tracker.current.press(report, Date.now());
          return true;
        }
        if (report.kind === "move") {
          if (!tracker.current.isPending()) return false;
          tracker.current.move(report);
          return true;
        }
        const point = tracker.current.release(report, Date.now());
        if (!point) return false;
        // The press cell decides, not the release: that is what makes a drag
        // that began on a word a click on that word, and a drag that ended on it
        // not a click at all.
        const hit = segmentAt(
          latest.current.segments,
          point.column - (box.x + 1),
          latest.current.separator,
        );
        if (hit?.target) latest.current.onSelect(hit);
        return true;
      },
      { layer: "page", name: name ?? "page-header" },
    );
  }, [ref, name]);
}
