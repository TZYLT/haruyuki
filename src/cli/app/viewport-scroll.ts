import type { ViewportAnchor } from "./viewport-window";

/**
 * Where the full-screen transcript viewport sits.
 *
 * A plain module store, not React state: it is written by key bindings that live
 * outside the viewport and read by the viewport renderer, and adding state that
 * updates on keystroke to `AppCoordinator` is the one thing the TUI guidance
 * forbids. Only the viewport subscribes.
 *
 * Two kinds of position, and the difference is the reason this module exists:
 *
 * - **Following** (`{ kind: "rows", rows: 0 }`) — pinned to the newest row. New
 *   rows push the transcript up, which is what following means.
 * - **An anchor** (`{ kind: "anchor", anchor }`) — the window's bottom item plus
 *   how much of it is scrolled past. Scrolling up parks the view on *content*:
 *   rows that arrive below it while the agent streams no longer drag the text
 *   under the reader's eyes. `jumpTranscriptToNewest` is the way back.
 */
export type ViewportScrollRequest =
  | { kind: "rows"; rows: number }
  | { kind: "anchor"; anchor: ViewportAnchor };

const listeners = new Set<() => void>();

/** Bumped whenever the position changes, so subscribers can re-read it. */
let version = 0;
let request: ViewportScrollRequest = { kind: "rows", rows: 0 };
/** Rows the last frame showed, for relative moves (a page, a line). */
let lastRows = 0;
let viewportRows = 0;
let reported: ViewportAnchor | null = null;

function publish(): void {
  version += 1;
  for (const listener of listeners) listener();
}

export function subscribeToViewportScroll(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Snapshot for `useSyncExternalStore`; read the request itself with `getViewportScrollRequest`. */
export function getViewportScrollVersion(): number {
  return version;
}

export function getViewportScrollRequest(): ViewportScrollRequest {
  return request;
}

/** The viewport reports its height so a page has a size. */
export function setViewportRows(rows: number): void {
  viewportRows = Math.max(0, Math.trunc(rows));
}

/** Move by rows: positive scrolls up (older), negative back down. */
export function scrollTranscriptBy(rows: number): void {
  const next = Math.max(0, Math.trunc(lastRows + rows));
  if (request.kind === "rows" && request.rows === next) return;
  request = { kind: "rows", rows: next };
  reported = null;
  publish();
}

/**
 * One screen of scroll, keeping a row of overlap so the line at the seam is not
 * lost between pages.
 */
export function scrollTranscriptPage(direction: "up" | "down"): void {
  const page = Math.max(1, viewportRows - 1);
  scrollTranscriptBy(direction === "up" ? page : -page);
}

/** Resume following: pin to the newest row and drop the anchor. */
export function jumpTranscriptToNewest(): void {
  if (request.kind === "rows" && request.rows === 0 && reported === null)
    return;
  request = { kind: "rows", rows: 0 };
  reported = null;
  publish();
}

/**
 * Called by the viewport once it has rendered, with the position it actually
 * shows (the window's bottom item and the rows of it below the viewport).
 *
 * Following reports `rows: 0` and stays a rows-request: that is the same thing
 * however much arrives, so it must not turn into an anchor that changes identity
 * on every append. Any other position becomes an anchor, which is what keeps the
 * view on the same content while rows keep arriving underneath.
 */
export function reportViewportPosition(position: {
  rows: number;
  anchor: ViewportAnchor;
}): void {
  lastRows = Math.max(0, Math.trunc(position.rows));
  if (lastRows === 0) {
    reported = null;
    if (request.kind !== "rows" || request.rows !== 0) {
      request = { kind: "rows", rows: 0 };
      publish();
    }
    return;
  }

  const changed =
    reported === null ||
    reported.end !== position.anchor.end ||
    reported.delta !== position.anchor.delta;
  reported = position.anchor;
  if (request.kind === "rows") {
    // The explicit request has been honoured; the anchor holds it from here.
    request = { kind: "anchor", anchor: position.anchor };
    return;
  }
  if (changed) {
    request = { kind: "anchor", anchor: position.anchor };
    publish();
  }
}

/** Test seam. */
export function resetViewportScroll(): void {
  version = 0;
  request = { kind: "rows", rows: 0 };
  lastRows = 0;
  viewportRows = 0;
  reported = null;
  listeners.clear();
}
