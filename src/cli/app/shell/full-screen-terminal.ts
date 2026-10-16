import type { FrameStream } from "@/cli/helpers/terminal-frame";
import { installTerminalFrameCapture } from "@/cli/helpers/terminal-frame";
import { resolveUiV2Once } from "@/experiments/ui-v2";

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
  if (fullScreen) installTerminalFrameCapture(stream);
  return fullScreen;
}
