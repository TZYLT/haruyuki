/**
 * The toast band: what the full-screen frame paints above the input when
 * something happened that is worth a word and not worth a transcript row.
 *
 * A module store, like the leader prefix and the composer's notice, for the same
 * reason: the writers are event sources outside the component tree (a turn
 * finishing, a connection coming back), and the reader is one leaf that paints a
 * few lines. Putting this in `AppCoordinator`/`AppView` state would make every
 * toast re-render the transcript — the flicker red line in `src/cli/AGENTS.md`
 * (`docs/38` §2 裁定: owner 明确, 独立 store, memo).
 *
 * **The rules, and where they come from** (`docs/38` §15.2):
 *
 * - a toast stays for {@link TOAST_LIFETIME_MS} and then leaves on its own;
 * - the band shows at most {@link MAX_VISIBLE_TOASTS} rows, newest closest to the
 *   input — the row that appeared last is the one the user is looking for;
 * - a fourth live toast does not grow the band: the oldest is dropped and counted,
 *   and the band says `+N` so the user knows something was folded away;
 * - it never takes focus and never blocks a key. A toast is a report, not a
 *   question (`docs/38` §15.3: an approval is the thing that stops and asks, and
 *   that is the approval UI's job).
 *
 * **The band is 0–3 rows, and the §2.1 row budget says 0–2.** §15.2's ruling is
 * later and is the one this milestone implements ("最多 3 条"); the middle band is
 * elastic precisely so the chrome can borrow a row (`docs/38` §2.1). What the
 * budget is really protecting is that an idle band takes *no* rows, which is why
 * the band renders nothing at all when it is empty.
 */

/** How long a toast stays up. */
export const TOAST_LIFETIME_MS = 3_000;

/** How many rows the band may take before it starts folding. */
export const MAX_VISIBLE_TOASTS = 3;

export interface Toast {
  /** Stable identity; the band keys its rows by it. */
  id: number;
  text: string;
}

export interface ToastSnapshot {
  /** Oldest first: the newest toast is the last one, closest to the input. */
  toasts: readonly Toast[];
  /** How many live toasts were dropped to keep the band at its cap. */
  folded: number;
}

let toasts: readonly Toast[] = [];
let folded = 0;
let nextId = 1;
let snapshot: ToastSnapshot = { toasts: [], folded: 0 };
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

function publish(): void {
  snapshot = { toasts, folded };
  for (const listener of listeners) listener();
}

function forget(id: number): void {
  const timer = timers.get(id);
  if (timer === undefined) return;
  clearTimeout(timer);
  timers.delete(id);
}

function drop(id: number): void {
  const next = toasts.filter((toast) => toast.id !== id);
  if (next.length === toasts.length) return;
  toasts = next;
  // The fold count describes the band that is up, so it goes away with it.
  if (toasts.length === 0) folded = 0;
  publish();
}

export function subscribeToToasts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The band's current rows.
 *
 * The snapshot's identity only changes when the band does: `useSyncExternalStore`
 * compares by reference, and a fresh object per call would re-render the band on
 * every frame of everything else.
 */
export function getToastSnapshot(): ToastSnapshot {
  return snapshot;
}

/**
 * Show a toast, dropping the oldest live one if the band is full.
 *
 * `ms <= 0` keeps it up until something clears it (a test seam, and the shape a
 * pinned toast would need). An empty or whitespace-only text is not a toast —
 * every caller builds its text from runtime data, and a blank row would be a
 * `+1` accounting for nothing.
 */
export function pushToast(text: string, ms: number = TOAST_LIFETIME_MS): void {
  const trimmed = text.trim();
  if (trimmed === "") return;

  const toast: Toast = { id: nextId, text: trimmed };
  nextId += 1;
  toasts = [...toasts, toast];
  while (toasts.length > MAX_VISIBLE_TOASTS) {
    const dropped = toasts[0];
    if (dropped === undefined) break;
    toasts = toasts.slice(1);
    forget(dropped.id);
    folded += 1;
  }

  if (ms > 0) {
    const timer = setTimeout(() => {
      timers.delete(toast.id);
      drop(toast.id);
    }, ms);
    // A pending timeout must not hold the process open (headless runs, tests).
    if (typeof timer === "object" && timer !== null && "unref" in timer) {
      timer.unref();
    }
    timers.set(toast.id, timer);
  }

  publish();
}

/** Take the band down before its time (a hard reset, and a test seam). */
export function clearToasts(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  if (toasts.length === 0 && folded === 0) return;
  toasts = [];
  folded = 0;
  publish();
}

/** Test seam. */
export function resetToastsForTests(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  toasts = [];
  folded = 0;
  nextId = 1;
  snapshot = { toasts: [], folded: 0 };
  listeners.clear();
}
