// src/cli/app/pages/settings/use-crumb-clicks.ts

import type { DOMElement } from "ink";
import type { RefObject } from "react";
import {
  type ClickSegment,
  lineText,
  segmentAt,
  useLineClicks,
} from "@/cli/app/pages/click-line";

/**
 * The pointer's way back up the settings tree.
 *
 * A page owns the main area, so `Esc` is the keyboard's exit and the tab strip is
 * the pointer's — but *inside* the settings tree there was no pointer target for
 * "one level up" at all (reported from the first real run). The breadcrumb is that
 * target: it is already drawn, already says where you are, and each segment names a
 * screen that exists.
 *
 * The hit-testing itself is `pages/click-line.ts`: a settings breadcrumb is one
 * line of clickable segments, and so is the usage page's screen switcher, and the
 * repository's rule is to import the owner of the behaviour rather than another
 * feature's copy of it. What is settings-specific here is the vocabulary
 * (`leave`/`root`/`permissions`) and the `/` separator the tree is written with.
 *
 * A click on a segment with no target (a level that has no screen of its own) is
 * **declined**, not swallowed: nothing happens, exactly as it would for the keyboard.
 */
type CrumbTarget = "leave" | "root" | "permissions";

export type Crumb = ClickSegment<CrumbTarget>;

/** How the segments are joined; the separator belongs to the gap between them. */
export const CRUMB_SEPARATOR = " / ";

/** The full crumb line, as the header draws it. */
export function crumbText(crumbs: readonly Crumb[]): string {
  return lineText(crumbs, CRUMB_SEPARATOR);
}

/** Which crumb a column inside the line points at. */
export function crumbAt(
  crumbs: readonly Crumb[],
  offset: number,
): Crumb | undefined {
  return segmentAt(crumbs, offset, CRUMB_SEPARATOR);
}

export function useCrumbClicks(input: {
  ref: RefObject<DOMElement | null>;
  crumbs: readonly Crumb[];
  onSelect: (crumb: Crumb) => void;
}): void {
  useLineClicks({
    ref: input.ref,
    segments: input.crumbs,
    onSelect: input.onSelect,
    separator: CRUMB_SEPARATOR,
    name: "settings-crumbs",
  });
}
