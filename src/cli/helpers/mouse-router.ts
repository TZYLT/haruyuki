import type { MouseReport } from "./mouse-sequence";

/**
 * Where a mouse report goes once the router has read it.
 *
 * The mirror of the binding registry, for the same reason: the layer that *reads*
 * the raw input (the router, which owns the stdin event) is not the layer that
 * knows what a wheel notch or a drag should do (the viewport, which knows the
 * band's height and the scroll position). Registering a handler keeps the
 * decision where the state is, and keeps the router free of viewport knowledge.
 *
 * A handler returns `false` to decline a report it does not act on, the same
 * convention a key binding uses; the report is spent either way — the router's
 * contract is that a mouse report never reaches the text editor.
 */

export type MouseHandler = (report: MouseReport) => boolean | void;

const handlers = new Map<symbol, MouseHandler>();

/** Register a handler; call the result on unmount. */
export function registerMouseHandler(handler: MouseHandler): () => void {
  const token = Symbol("mouse-handler");
  handlers.set(token, handler);
  return () => {
    handlers.delete(token);
  };
}

/** Offer a report to the registered handlers; true when one acted on it. */
export function routeMouseReport(report: MouseReport): boolean {
  for (const handler of handlers.values()) {
    if (handler(report) !== false) return true;
  }
  return false;
}

/** The handlers currently registered, for diagnostics and tests. */
export function registeredMouseHandlers(): number {
  return handlers.size;
}

/** Test seam. */
export function resetMouseHandlers(): void {
  handlers.clear();
}
