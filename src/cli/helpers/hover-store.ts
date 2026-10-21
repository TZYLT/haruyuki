import { useSyncExternalStore } from "react";

/**
 * Which row the pointer is over, for the surfaces that can be hovered.
 *
 * One target at a time (《38》§19.3 1), keyed by a surface name and a row index, so
 * the two readers that matter can ask their own question: a row asks "am I the
 * one?" and gets a boolean, the surface asks "is any of mine hovered?" and gets an
 * index.
 *
 * A module store rather than React state because the writer is a mouse report
 * that arrives outside the component tree, and the reader is one row: putting it
 * in `AppCoordinator` would repaint the composer and the transcript on every cell
 * the pointer crosses, which is the flicker red line in `src/cli/AGENTS.md` with a
 * pointer attached. A boolean snapshot also means only the two rows involved —
 * the one left, the one entered — re-render.
 *
 * **Nothing is written while the mouse is off**: the shell turns any-motion
 * (`1003`) on only while a hoverable surface is up, and a report that arrives
 * anyway is ignored here rather than lighting a row in a mode the user gave back.
 */

export type HoverTarget = {
  /** Which surface the row belongs to (`"autocomplete"`, `"page"`, …). */
  area: string;
  /** The row's index inside that surface. */
  index: number;
};

let current: HoverTarget | null = null;
const listeners = new Set<() => void>();

function publish(): void {
  for (const listener of listeners) listener();
}

export function getHoverTarget(): HoverTarget | null {
  return current;
}

/**
 * Move the highlight, or clear it with `null`.
 *
 * Publishes only on a real change: motion is reported for cells that are already
 * hovered, and repainting the same row on every one of them is exactly the
 * per-motion re-render the design forbids (《38》§19.3 5).
 */
export function setHoverTarget(next: HoverTarget | null): void {
  if (next === null && current === null) return;
  if (
    next !== null &&
    current !== null &&
    next.area === current.area &&
    next.index === current.index
  ) {
    return;
  }
  current = next;
  publish();
}

/** Clear the highlight when it belongs to `area` (a surface unmounting or closing). */
export function clearHoverIn(area: string): void {
  if (current?.area !== area) return;
  current = null;
  publish();
}

export function subscribeToHover(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether `index` inside `area` is the hovered row — the question a row asks. */
export function isRowHovered(area: string, index: number): boolean {
  return current?.area === area && current.index === index;
}

/**
 * The row-level subscription: `true` only for the hovered row.
 *
 * The snapshot is a boolean, so `useSyncExternalStore`'s identity check keeps
 * every other row of the same surface from re-rendering.
 */
export function useRowHovered(area: string, index: number): boolean {
  return useSyncExternalStore(subscribeToHover, () =>
    isRowHovered(area, index),
  );
}

/** Test seam. */
export function resetHoverForTests(): void {
  current = null;
  listeners.clear();
}
