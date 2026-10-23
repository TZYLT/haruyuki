import { experimentManager } from "./manager";

/**
 * The full-screen shell decision, taken once per process.
 *
 * Two places have to agree on it:
 *
 * - `render()`'s `alternateScreen` option, in the process entry, where the
 *   terminal buffer is chosen;
 * - `AppShell`, which picks the shell that draws into it.
 *
 * Reading the experiment twice would let the two answers diverge, and both
 * mismatches are bad in a way that is hard to see: an append-style shell drawing
 * into the alternate screen writes its transcript into a buffer that Ink
 * discards on exit, and a full-screen shell *without* the alternate screen paints
 * a full-height frame into the primary buffer on every tick, where Ink cannot
 * incrementally erase it.
 *
 * The first read therefore wins for both. `/experiments` and `HARUYUKI_UI_V2`
 * take effect on the next start.
 *
 * **Runtime switching was ruled out (2026-10-23).** It cannot be made seamless:
 * the transcript is a committed `<Static>` in the append shell, so swapping the
 * shell mid-session re-prints history, and `alternateScreen` is a `render()`
 * option chosen once for the process. Rather than pretend, the switch now says
 * what it is — the settings row carries `restart` and `/experiments` carries a
 * footer — and the resolution stays cache-once. Anything that made this value
 * changeable at runtime would have to answer both the `<Static>` identity and the
 * buffer question in the same keystroke.
 */
let resolved: boolean | null = null;

export function resolveUiV2Once(): boolean {
  if (resolved === null) {
    resolved = experimentManager.isEnabled("ui_v2");
  }
  return resolved;
}

/** Test seam: forget the resolved value. */
export function resetUiV2Resolution(): void {
  resolved = null;
}
