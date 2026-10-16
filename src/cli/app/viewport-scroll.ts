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
/**
 * Relative moves made since that report, not yet on screen.
 *
 * A relative move has to be measured from where the view will be, not from where
 * it last was: the viewport reports only after it has drawn, so every notch that
 * arrives in between would otherwise be measured from the same stale position and
 * thrown away (see `scrollTranscriptBy`).
 */
let pendingRows = 0;
let viewportRows = 0;
let reported: ViewportAnchor | null = null;
/**
 * The largest offset the window could actually apply, as far as it has said.
 *
 * Learned from a report that came back short of what was asked: that is the
 * oldest row reachable, so every further up-move draws the same frame. Those are
 * refused rather than published — a frame that does not change is still cleared
 * and repainted on Windows, which is a screen-wide flash for nothing, and that
 * flash is exactly what holding the wheel at the top produces.
 *
 * It is only as good as the last report: a report with nothing clamped (or an
 * offset the window could honour in full) resets it to "no known limit".
 */
let topLimit = Number.POSITIVE_INFINITY;

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

/**
 * Move by rows: positive scrolls up (older), negative back down.
 *
 * The base is the position the viewport last **reported** plus every relative
 * move made since (`pendingRows`), because a report only arrives once the frame
 * it describes has been drawn. Measuring from the report alone silently loses
 * every notch that arrives before that frame: a wheel spin delivers many reports
 * in one stdin read, Ink emits them in one batch, React renders once, and the
 * notches after the first were all dropped — measured as 40 notches moving three
 * rows. A single notch is unaffected either way, which is why this only shows up
 * as "the wheel sometimes does nothing".
 */
export function scrollTranscriptBy(rows: number): void {
  const base = lastRows + pendingRows;
  // Nothing above the oldest row: the window would clamp, the frame would come
  // out identical, and the user would get a flash instead of a scroll. The
  // bottom already behaved this way (a down-move at offset 0 is a no-op request);
  // this is the same rule at the other end.
  if (rows > 0 && base >= topLimit) return;
  const next = Math.max(0, Math.trunc(base + rows));
  if (request.kind === "rows" && request.rows === next) return;
  pendingRows = next - lastRows;
  request = { kind: "rows", rows: next };
  reported = null;
  publish();
}

/**
 * Rows one wheel notch moves.
 *
 * Three, per the user's ruling of 2026-10-15 ("a wheel notch should move three
 * rows by default"): one row per notch is too slow to cross a long answer with a
 * wheel, and a full page makes the reader lose the line they were on.
 */
export const WHEEL_ROWS_PER_NOTCH = 3;

/** One screen of scroll, keeping a row of overlap so the line at the seam is not
 * lost between pages. */
export function scrollTranscriptPage(direction: "up" | "down"): void {
  const page = Math.max(1, viewportRows - 1);
  scrollTranscriptBy(direction === "up" ? page : -page);
}

/** One wheel notch: three rows, in the direction the wheel turned. */
export function scrollTranscriptWheel(direction: "up" | "down"): void {
  scrollTranscriptBy(
    direction === "up" ? WHEEL_ROWS_PER_NOTCH : -WHEEL_ROWS_PER_NOTCH,
  );
}

/**
 * The rows the viewport last reported, so a caller outside it (the mouse layer)
 * can translate a screen position into a row of the band.
 */
export function getViewportRows(): number {
  return viewportRows;
}

/**
 * The offset the window last reported showing.
 *
 * A reader for the selection, which is written in screen rows and has to know how
 * far the transcript moved underneath it: an increase here means older rows came
 * in at the top, so everything on screen moved down by the same amount.
 */
export function getViewportScrollRows(): number {
  return lastRows;
}

/** Resume following: pin to the newest row and drop the anchor. */
export function jumpTranscriptToNewest(): void {
  if (request.kind === "rows" && request.rows === 0 && reported === null)
    return;
  lastRows = 0;
  pendingRows = 0;
  topLimit = Number.POSITIVE_INFINITY;
  request = { kind: "rows", rows: 0 };
  reported = null;
  publish();
}

/**
 * Jump to the oldest loaded row.
 *
 * The offset is deliberately absurd rather than "the total": the window clamps
 * it to the history's extent and reports back what it actually showed, and that
 * is the only place the total is known — it is what the lazy walk measures.
 */
export function jumpTranscriptToOldest(): void {
  // The sentinel is not a position, so it is not accumulated onto and the pending
  // relative moves are dropped with it: the next report is what pins the view.
  // The known top limit is left as it is — the report that follows this jump is
  // what says where the oldest row actually is.
  pendingRows = 0;
  request = { kind: "rows", rows: Number.MAX_SAFE_INTEGER };
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
  // What the honoured request asked for, read before the request is replaced:
  // asking for more than was shown is the one signal that the window is at the
  // top of the history.
  const asked = request.kind === "rows" ? request.rows : null;
  lastRows = Math.max(0, Math.trunc(position.rows));
  topLimit =
    asked !== null && asked > lastRows ? lastRows : Number.POSITIVE_INFINITY;
  // Whatever was asked for is answered by this report — including a request the
  // window clamped — so relative moves go back to measuring from here.
  pendingRows = 0;
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
  pendingRows = 0;
  topLimit = Number.POSITIVE_INFINITY;
  viewportRows = 0;
  reported = null;
  listeners.clear();
}
