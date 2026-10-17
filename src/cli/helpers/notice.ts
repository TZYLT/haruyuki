/**
 * A one-line transient notice for the composer's hint slot.
 *
 * Some actions have no visible result of their own: flipping mouse reporting
 * changes nothing on screen, and copying to the clipboard writes to a place the
 * user cannot see. Without a word from the app both are indistinguishable from
 * "the key did nothing".
 *
 * A module store, like the leader prefix next to it, for the same reason: these
 * are written by key bindings that live outside the component tree, and the
 * reader is one leaf that renders a single line. Toasts and notification history
 * are the panel milestone's job; this is the small slot that exists until then.
 */

/** How long a notice stays up. */
export const DEFAULT_NOTICE_MS = 3_000;

let notice: string | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function clearTimer(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

function notify(): void {
  for (const listener of listeners) listener();
}

export function subscribeToNotice(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getNotice(): string | null {
  return notice;
}

/**
 * Show a notice, replacing any notice already up and restarting the clock.
 *
 * `ms <= 0` keeps it up until something replaces or clears it (a test seam, and
 * the shape a pinned notice would need).
 */
export function showNotice(text: string, ms: number = DEFAULT_NOTICE_MS): void {
  clearTimer();
  notice = text;
  if (ms > 0) {
    timer = setTimeout(() => {
      timer = null;
      if (notice !== text) return;
      notice = null;
      notify();
    }, ms);
    // A pending timeout must not hold the process open (headless runs, tests).
    if (typeof timer === "object" && timer !== null && "unref" in timer) {
      timer.unref();
    }
  }
  notify();
}

/** Clear the notice early (a pinned notice's counterpart, and a test seam). */
export function clearNotice(): void {
  clearTimer();
  if (notice === null) return;
  notice = null;
  notify();
}

/** Test seam. */
export function resetNoticeForTests(): void {
  clearTimer();
  notice = null;
  listeners.clear();
}
