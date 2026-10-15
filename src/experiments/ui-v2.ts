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
 * take effect on the next start; runtime switching is M7's job, and it has to
 * route through here to keep the two in step.
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
