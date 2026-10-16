import { debugWarn } from "@/utils/debug";

/**
 * Mouse reporting, as a terminal mode this app owns.
 *
 * Ink 7 has no mouse support, so the modes are written straight to the terminal:
 *
 * - `1000` — button press and release;
 * - `1002` — the same, plus motion while a button is held: this is what makes a
 *   drag a drag instead of a single click;
 * - `1006` — SGR encoding, so coordinates past column 223 are expressible and
 *   press/release are unambiguous.
 *
 * Two rules make this safe to switch on:
 *
 * 1. **Symmetry.** A terminal left in mouse mode after the app exits prints
 *    escape garbage on every pointer move, in the user's shell, with no way to
 *    tell where it came from. So every enable is paired with a disable: the
 *    owning hook releases on unmount, and a `process` exit hook covers the exits
 *    that never unmount (double Ctrl+C, `/exit`).
 * 2. **Consent.** The mode is off unless someone asks for it, and `1002` steals
 *    the terminal's own text selection, so it is a *toggle* the user can flip —
 *    with the mouse off, shift-drag and the terminal's native selection work
 *    again. The toggle lives on the leader prefix.
 *
 * The module is a plain store (no React) for the same reason the input router
 * is: the writer is a key binding that lives outside the component tree, and the
 * reader is a leaf that renders one line.
 */

export interface MouseTrackingStream {
  write(chunk: string): unknown;
  isTTY?: boolean;
}

/** The exact modes the app asks the terminal for, in the order it asks. */
export const MOUSE_TRACKING_ENABLE = "\u001B[?1000h\u001B[?1002h\u001B[?1006h";

/** The same three modes, off, in reverse order. */
export const MOUSE_TRACKING_DISABLE = "\u001B[?1006l\u001B[?1002l\u001B[?1000l";

let enabled = false;
let currentStream: MouseTrackingStream | null = null;
let exitHook: (() => void) | null = null;
const listeners = new Set<() => void>();

function write(stream: MouseTrackingStream, chunk: string): void {
  try {
    stream.write(chunk);
  } catch (error) {
    // A closed stdout (the process is going away) must not turn "restore the
    // terminal" into a crash that skips the rest of the teardown.
    debugWarn("mouse", "could not write the mouse mode", error);
  }
}

function publish(): void {
  for (const listener of listeners) listener();
}

export function isMouseTrackingEnabled(): boolean {
  return enabled;
}

export function subscribeToMouseTracking(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Turn mouse reporting on. Returns whether this call changed anything, so the
 * caller can tell "now on" from "was already on".
 *
 * Nothing is written when the stream is not a TTY: a piped run has no pointer
 * and no alternate screen, and writing the modes there would put control bytes
 * in whatever is reading the output.
 */
export function enableMouseTracking(
  stream: MouseTrackingStream = process.stdout,
): boolean {
  if (enabled || stream.isTTY !== true) return false;
  enabled = true;
  currentStream = stream;
  write(stream, MOUSE_TRACKING_ENABLE);
  if (!exitHook) {
    exitHook = () => {
      disableMouseTracking();
    };
    // `exit` is the last synchronous moment before the process is gone, and every
    // exit path in the app (the double Ctrl+C guard, `/exit`, Ink's own `exit()`)
    // reaches it. Signals that kill outright are out of its reach; the mode is
    // then restored by the next process that sets it, or by the user's terminal
    // reset — the hook covers the exits the app itself performs.
    process.once("exit", exitHook);
  }
  publish();
  return true;
}

/** Turn mouse reporting off. Returns whether this call changed anything. */
export function disableMouseTracking(): boolean {
  if (!enabled) return false;
  enabled = false;
  const stream = currentStream;
  currentStream = null;
  if (stream) write(stream, MOUSE_TRACKING_DISABLE);
  publish();
  return true;
}

/** Flip the mode and report the state it is in afterwards. */
export function toggleMouseTracking(
  stream: MouseTrackingStream = process.stdout,
): boolean {
  if (enabled) {
    disableMouseTracking();
    return false;
  }
  enableMouseTracking(stream);
  return enabled;
}

/** Test seam: forget the mode, the stream, the exit hook and the subscribers. */
export function resetMouseTrackingForTests(): void {
  enabled = false;
  currentStream = null;
  if (exitHook) {
    process.off("exit", exitHook);
    exitHook = null;
  }
  listeners.clear();
}
