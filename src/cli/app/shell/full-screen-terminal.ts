import {
  getViewportRows,
  getViewportScrollRows,
} from "@/cli/app/viewport-scroll";
import type { FrameStream } from "@/cli/helpers/terminal-frame";
import {
  getTerminalFrame,
  installTerminalFrameCapture,
  subscribeToTerminalFrame,
} from "@/cli/helpers/terminal-frame";
import { resolveUiV2Once } from "@/experiments/ui-v2";
import { debugLog } from "@/utils/debug";

/**
 * The full-screen shell's terminal hand-over, in one place.
 *
 * The process entry sets up the terminal for the full-screen shell — the
 * alternate screen buffer, and the kitty keyboard protocol next to it. The frame
 * capture belongs at that same seam, and for a reason a component cannot supply:
 * Ink writes its first frame **inside** `render()`, before any React effect runs,
 * so a capture installed by a hook misses the frame that is already on screen and
 * only starts working once something happens to repaint.
 *
 * Capturing is only turned on for the full-screen shell: the append shell has no
 * alt-screen viewport, gains nothing from a selection, and would pay the capture's
 * per-write cost on every static transcript write.
 *
 * Returns the shell decision, so the entry reads exactly as before:
 * `alternateScreen: wireFullScreenTerminal()`.
 */
export function wireFullScreenTerminal(
  stream: FrameStream = process.stdout,
): boolean {
  const fullScreen = resolveUiV2Once();
  if (!fullScreen) return false;
  installTerminalFrameCapture(stream);
  watchFrames(stream);
  return true;
}

/** The rows the terminal reports, for the frame watcher's comparison. */
function terminalRows(stream: FrameStream): number {
  const sized = stream as {
    rows?: number;
    getWindowSize?: () => unknown;
  };
  try {
    const queried = sized.getWindowSize?.();
    if (Array.isArray(queried) && typeof queried[1] === "number") {
      return queried[1];
    }
  } catch {
    // Not a console after all; fall back to the cached property.
  }
  return sized.rows ?? 0;
}

/**
 * `HARUYUKI_DEBUG_FRAME=1`: one line per written frame, for a session being
 * diagnosed on the machine.
 *
 * It exists to tell two artifacts apart that look identical on screen. A frame
 * written with fewer rows than the terminal has is a **layout** artifact — for
 * that one frame the band (or the chrome below it) was measured a size the
 * drawing did not match, and the rows under the frame keep whatever was there
 * before. A frame with the right number of rows that still looks wrong is drawn
 * right and is a **paint** artifact on the terminal's side. Different fixes, and
 * the row counts separate them without a guess.
 *
 * It writes through `debugLog`, i.e. to the session's log file and never to the
 * screen: a line printed while Ink is drawing lands inside the frame and costs
 * the very repaint being measured (`utils/debug.ts` explains that in full).
 */
function watchFrames(stream: FrameStream): void {
  if (process.env.HARUYUKI_DEBUG_FRAME !== "1") return;
  const rows = terminalRows(stream);
  let frames = 0;
  subscribeToTerminalFrame(() => {
    const frame = getTerminalFrame();
    if (frame === null) return;
    frames += 1;
    // `lines` is the frame as written; the width the band is told it has is the
    // one the window was fitted to, so a mismatch here is the artifact itself.
    // `nl` separates a frame that ends on a blank row (as many newlines as rows)
    // from one that ends on content (one fewer): Ink drops the trailing blank row
    // from `lines`, and without this the two read the same.
    debugLog(
      "frame",
      `#${frames} rows=${frame.lines.length} nl=${frame.cursorRow - 1} term=${rows} band=${getViewportRows()} offset=${getViewportScrollRows()} anchored=${frame.anchored}`,
    );
  });
}
