import { debugLog } from "@/utils/debug";
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
 *
 * **Chrome is consulted first, whatever order the tree mounted in.** Two layers
 * legitimately claim the same report: the tab row belongs to the chrome, and the
 * selection layer is offered everything that is not a wheel notch. While the
 * order was registration order, the answer depended on which component's effect
 * ran first — and an effect order is not an invariant, it is a consequence of
 * where the strip sits in the tree. The reported defect (2026-10-20 实机, the tab
 * row ignoring every click) is exactly what a flipped order looks like: the
 * selection layer "ends the selection" on a press it was handed, the chrome never
 * sees the press, and the row is dead with no error anywhere.
 */

export type MouseHandler = (report: MouseReport) => boolean | void;

/**
 * Which claim wins.
 *
 * `chrome` is the shell's own rows — the tab strip — which are drawn *outside*
 * the transcript band and are nobody else's business. `content` is everything
 * below: the wheel, the drag selection, and whatever a later milestone adds.
 */
export type MouseLayer = "chrome" | "content";

/** Consultation order, highest first. Mirrors `INPUT_SCOPE_PRIORITY`. */
const LAYER_ORDER: readonly MouseLayer[] = ["chrome", "content"];

type Entry = { handler: MouseHandler; name: string };

const handlers = new Map<MouseLayer, Map<symbol, Entry>>();

function bucket(layer: MouseLayer): Map<symbol, Entry> {
  const existing = handlers.get(layer);
  if (existing) return existing;
  const created = new Map<symbol, Entry>();
  handlers.set(layer, created);
  return created;
}

/**
 * Register a handler; call the result on unmount.
 *
 * `name` is diagnostic only — it is what makes `HARUYUKI_DEBUG_MOUSE` readable
 * ("the press was taken by `selection`" is an answer, "handler#2" is a puzzle).
 */
export function registerMouseHandler(
  handler: MouseHandler,
  options: { layer?: MouseLayer; name?: string } = {},
): () => void {
  const layer = options.layer ?? "content";
  const token = Symbol("mouse-handler");
  bucket(layer).set(token, { handler, name: options.name ?? layer });
  return () => {
    const entries = handlers.get(layer);
    if (!entries) return;
    entries.delete(token);
    if (entries.size === 0) handlers.delete(layer);
  };
}

/** Offer a report to the registered handlers; true when one acted on it. */
export function routeMouseReport(report: MouseReport): boolean {
  for (const layer of LAYER_ORDER) {
    const entries = handlers.get(layer);
    if (!entries) continue;
    for (const { handler, name } of entries.values()) {
      if (handler(report) !== false) {
        trace(report, name);
        return true;
      }
    }
  }
  trace(report, "nobody");
  return false;
}

/**
 * `HARUYUKI_DEBUG_MOUSE=1`: one line per motion report and per wheel notch.
 *
 * Presses and releases are traced **unconditionally**: a click that "does
 * nothing" has three very different causes — the report never arrived (the
 * terminal never sent it), it arrived and a layer other than the one that should
 * have taken it claimed it, or the right layer took it and did not act. On the
 * screen all three look identical, and the state a test can assert is not the
 * state that failed. A press/release pair per click is a handful of lines, so
 * those are always written; motion under `1002` reports once per cell and a wheel
 * can be rolled for a long time, which is why those two kinds are behind a flag.
 *
 * Never written to the screen: `debugLog` goes to the session log, because a line
 * printed while Ink is drawing lands inside the frame.
 */
function trace(report: MouseReport, claimed: string): void {
  const flagged = process.env.HARUYUKI_DEBUG_MOUSE === "1";
  if (!flagged && report.kind === "move") return;
  if (!flagged && report.wheel) return;
  const wheel = report.wheel ? ` wheel=${report.wheel}` : "";
  debugLog(
    "mouse",
    `${report.kind} ${report.button}${wheel} row=${report.row} col=${report.column} -> ${claimed}`,
  );
}

/** The handlers currently registered, for diagnostics and tests. */
export function registeredMouseHandlers(): number {
  let total = 0;
  for (const entries of handlers.values()) total += entries.size;
  return total;
}

/** Test seam. */
export function resetMouseHandlers(): void {
  handlers.clear();
}
