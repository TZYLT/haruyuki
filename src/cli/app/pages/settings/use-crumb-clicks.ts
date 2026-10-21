// src/cli/app/pages/settings/use-crumb-clicks.ts

import { type DOMElement, measureElement } from "ink";
import { type RefObject, useEffect, useRef } from "react";
import { terminalTextWidth } from "@/cli/helpers/char-width";
import { createClickTracker } from "@/cli/helpers/mouse-click";
import { registerMouseHandler } from "@/cli/helpers/mouse-router";

/**
 * The pointer's way back up the settings tree.
 *
 * A page owns the main area, so `Esc` is the keyboard's exit and the tab strip is
 * the pointer's — but *inside* the settings tree there was no pointer target for
 * "one level up" at all (reported from the first real run). The breadcrumb is that
 * target: it is already drawn, already says where you are, and each segment names a
 * screen that exists.
 *
 * The geometry follows the tab strip's `regions` shape: the text is laid out left to
 * right from the row's first column, so a click's offset is walked through the
 * segments' own widths (`terminalTextWidth`, which is the width the terminal draws —
 * a CJK label is two cells). Measured at event time, because the header is chrome and
 * the chrome moves with the panel above it.
 *
 * A click on a segment with no target (a level that has no screen of its own) is
 * **declined**, not swallowed: nothing happens, exactly as it would for the keyboard.
 */
export type Crumb = {
  label: string;
  /** Where clicking this segment goes; `undefined` when the level has no screen. */
  target?: "leave" | "root" | "permissions";
};

/** How the segments are joined; the separator belongs to the gap between them. */
export const CRUMB_SEPARATOR = " / ";

/** The full crumb line, as the header draws it. */
export function crumbText(crumbs: readonly Crumb[]): string {
  return crumbs.map((crumb) => crumb.label).join(CRUMB_SEPARATOR);
}

/**
 * Which crumb a column inside the line points at.
 *
 * Columns are 0-based offsets from the first drawn cell. A click in the separator
 * between two segments belongs to neither — the same rule the strip uses for its
 * gaps (`tab-strip-layout.ts`).
 */
export function crumbAt(
  crumbs: readonly Crumb[],
  offset: number,
): Crumb | undefined {
  let start = 0;
  for (const crumb of crumbs) {
    const width = terminalTextWidth(crumb.label);
    if (offset >= start && offset < start + width) return crumb;
    start += width + terminalTextWidth(CRUMB_SEPARATOR);
  }
  return undefined;
}

export function useCrumbClicks(input: {
  ref: RefObject<DOMElement | null>;
  crumbs: readonly Crumb[];
  onSelect: (crumb: Crumb) => void;
}): void {
  const tracker = useRef(createClickTracker());
  const latest = useRef({ crumbs: input.crumbs, onSelect: input.onSelect });
  latest.current = { crumbs: input.crumbs, onSelect: input.onSelect };

  useEffect(() => {
    const ref = input.ref;
    return registerMouseHandler(
      (report) => {
        if (report.wheel) return false;
        const node = ref.current;
        if (!node) return false;
        const box = measureElement(node);
        if (box.width <= 0 || box.height <= 0) return false;
        // The header is one row: the report is 1-based, the layout tree 0-based.
        const headerRow = box.y + 1;
        if (report.row !== headerRow) return false;
        const offset = report.column - (box.x + 1);
        if (offset < 0 || offset >= box.width) return false;
        const crumb = crumbAt(latest.current.crumbs, offset);
        // A segment with no screen is transparent to the pointer: the click is
        // spent on nothing, never on the row block underneath.
        if (!crumb?.target) return false;

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
        const target = crumbAt(
          latest.current.crumbs,
          point.column - (box.x + 1),
        );
        if (target?.target) latest.current.onSelect(target);
        return true;
      },
      { layer: "page", name: "settings-crumbs" },
    );
  }, [input.ref]);
}
