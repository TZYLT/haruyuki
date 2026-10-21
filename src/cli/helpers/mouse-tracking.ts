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

/**
 * Any-motion reporting, which is what a *hover* needs (`1003`).
 *
 * It is a separate mode on purpose: `1002` reports motion only while a button is
 * held (that is the drag), while `1003` reports every cell the pointer crosses.
 * The ruling is that it is on **only while something can be hovered** — the slash
 * popup, a page, a face (《38》§19.3 4) — because a terminal that streams motion at
 * every mouse move is a terminal whose pointer is no longer cheap: the reports
 * arrive continuously whether or not anyone moves, and every one of them is a
 * keystroke's worth of work.
 */
export const MOUSE_HOVER_ENABLE = "\u001B[?1003h";

/** Any-motion off. */
export const MOUSE_HOVER_DISABLE = "\u001B[?1003l";

let enabled = false;
let currentStream: MouseTrackingStream | null = null;
let exitHook: (() => void) | null = null;
/** How many mounted surfaces want any-motion; the mode is on iff this is > 0. */
let hoverClaims = 0;
/** Whether `1003` is currently written, so a redundant write is not sent. */
let hoverWritten = false;
/**
 * How many mounted shells own the base modes, and whether the user still consents.
 *
 * Both are needed, and neither alone is enough: the count is what makes a remount
 * (the app is keyed by `agentId:conversationId`, so a conversation switch builds a
 * new tree) leave the mode on instead of blinking it off and back on, and `consent`
 * is what keeps a page opening from silently undoing a `Ctrl+X m`.
 */
let owners = 0;
let consent = true;
/** A release that has not been confirmed yet; a re-acquire in the same tick cancels it. */
let pendingDisable: ReturnType<typeof setTimeout> | null = null;
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
  if (enabled) return false;
  // Not a TTY means no mode was written, and the caller cannot tell that apart
  // from "the user's terminal ignores mouse reports": every click then does
  // nothing and there is no trace of why. One line in the session log names it —
  // when a session log exists yet: the shell can mount before the session log is
  // initialised, in which case this line is dropped. The click trace in
  // `mouse-router.ts` is the one that is always there.
  if (stream.isTTY !== true) {
    debugWarn("mouse", "not a TTY: mouse reporting was never requested");
    return false;
  }
  enabled = true;
  currentStream = stream;
  write(stream, MOUSE_TRACKING_ENABLE);
  debugWarn("mouse", `reporting on (${MOUSE_TRACKING_ENABLE.length} bytes)`);
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
  syncHoverMode();
  publish();
  return true;
}

/** Turn mouse reporting off. Returns whether this call changed anything. */
export function disableMouseTracking(): boolean {
  cancelPendingDisable();
  if (!enabled) return false;
  enabled = false;
  const wasHover = hoverWritten;
  hoverWritten = false;
  const stream = currentStream;
  currentStream = null;
  // `1003` goes only when it was actually asked for: a run that never hovered
  // anything must hand back exactly the three modes it took, or every byte-level
  // assertion of "the same modes, once" becomes a special case. When it *was* on it
  // goes first, so the pointer stops being reported before the modes underneath it
  // are released.
  if (stream) {
    write(
      stream,
      (wasHover ? MOUSE_HOVER_DISABLE : "") + MOUSE_TRACKING_DISABLE,
    );
  }
  debugWarn("mouse", "reporting off");
  publish();
  return true;
}

/**
 * Ask for mouse reporting while a shell is mounted.
 *
 * Reference-counted, for the same reason `acquireMouseHover` is: the app root is
 * keyed by `agentId:conversationId` (`index.ts`), so **every conversation switch
 * builds a new tree while the old one unmounts**. With a plain enable/disable pair
 * the two can interleave — the new shell asks while the old one has not released
 * yet, or the release lands after the new ask — and the last write wins. In the
 * first case the terminal is left with the modes off while the live shell believes
 * it turned them on, which is exactly "the mouse dies after a tab operation, and
 * `Ctrl+X m` twice brings it back".
 *
 * A release defers the disable by one tick: a re-acquire in the same tick cancels
 * it, so a remount writes nothing at all instead of toggling the modes twice.
 *
 * `consent` is separate on purpose: a user who switched reporting off with
 * `Ctrl+X m` must not get it back because a page mounted.
 */
export function acquireMouseTracking(
  stream: MouseTrackingStream = process.stdout,
): () => void {
  owners += 1;
  cancelPendingDisable();
  if (consent && !enabled) enableMouseTracking(stream);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    owners = Math.max(0, owners - 1);
    if (owners === 0) scheduleDisable();
  };
}

/** How many shell owners are mounted (diagnostics and tests). */
export function mouseTrackingOwners(): number {
  return owners;
}

/**
 * Write the base modes again, if this process believes they are on.
 *
 * The terminal is a peer, not a variable: a full-screen redraw, an alt-screen
 * entry or a terminal-side reset can clear reporting without telling us. Tab
 * operations are the moment that would show, so the shell re-asserts the modes
 * after each focus change — three short sequences, and no state change.
 */
export function syncMouseTracking(): boolean {
  if (!enabled || !currentStream) return false;
  write(currentStream, MOUSE_TRACKING_ENABLE);
  // Any-motion is a fourth mode and can be lost with the other three; a page that
  // is still up would otherwise stop hovering until it was remounted.
  if (hoverWritten) write(currentStream, MOUSE_HOVER_ENABLE);
  debugWarn("mouse", "reporting re-asserted");
  return true;
}

function cancelPendingDisable(): void {
  if (pendingDisable === null) return;
  clearTimeout(pendingDisable);
  pendingDisable = null;
}

function scheduleDisable(): void {
  cancelPendingDisable();
  pendingDisable = setTimeout(() => {
    pendingDisable = null;
    if (owners === 0) disableMouseTracking();
  }, 0);
  // Never hold the process open for a teardown that will not be needed.
  pendingDisable.unref?.();
}

/**
 * Ask for any-motion reporting while a hoverable surface is mounted.
 *
 * Reference-counted, because a page and its slash popup can both be open: the
 * mode has to stay on until the last of them is gone. The returned function is
 * idempotent so an effect cleanup that runs twice cannot underflow the count.
 */
export function acquireMouseHover(): () => void {
  hoverClaims += 1;
  syncHoverMode();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    hoverClaims = Math.max(0, hoverClaims - 1);
    syncHoverMode();
  };
}

/** Whether any-motion is on right now (diagnostics and tests). */
export function isMouseHoverActive(): boolean {
  return hoverWritten;
}

function syncHoverMode(): void {
  // Any-motion without reporting is nothing: the mode only exists inside the
  // window where the mouse is enabled, which is also what `Ctrl+X m` promises.
  const want = enabled && hoverClaims > 0;
  if (want === hoverWritten) return;
  hoverWritten = want;
  if (!currentStream) return;
  write(currentStream, want ? MOUSE_HOVER_ENABLE : MOUSE_HOVER_DISABLE);
  debugWarn("mouse", want ? "any-motion on" : "any-motion off");
}

/** Flip the mode and report the state it is in afterwards. */
export function toggleMouseTracking(
  stream: MouseTrackingStream = process.stdout,
): boolean {
  if (enabled) {
    // The user's own answer beats every mount: `acquireMouseTracking` reads this
    // before turning the modes back on.
    consent = false;
    disableMouseTracking();
    return false;
  }
  consent = true;
  enableMouseTracking(stream);
  return enabled;
}

/** Test seam: forget the mode, the stream, the exit hook and the subscribers. */
export function resetMouseTrackingForTests(): void {
  cancelPendingDisable();
  enabled = false;
  currentStream = null;
  hoverClaims = 0;
  hoverWritten = false;
  owners = 0;
  consent = true;
  if (exitHook) {
    process.off("exit", exitHook);
    exitHook = null;
  }
  listeners.clear();
}
