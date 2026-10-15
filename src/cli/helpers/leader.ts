/**
 * The leader prefix.
 *
 * A leader is a *prefix*, not a shortcut: `Ctrl+X` alone does nothing, it only
 * makes the next key a command. That is how one more namespace of keys becomes
 * available without taking anything away from typing — after the prefix a plain
 * letter is a command key, and the rest of the time it is just a letter. Emacs'
 * `C-x`, tmux's `Ctrl+B` and VS Code's `Ctrl+K` are the same shape.
 *
 * This module is the state, and nothing else: which prefix is armed, whether the
 * help line is open, and a timeout so a stray prefix cannot leave the keyboard in
 * a mode the user did not ask for. The router reads it, the hint renders it, and
 * the bindings live with the context that owns them (`composer-key-tables.ts`).
 *
 * A module store rather than React state on purpose: this changes on a keystroke,
 * and the TUI red line forbids putting that into `AppCoordinator`/`AppView`. Only
 * the hint leaf subscribes.
 */

/** How long an armed prefix waits for its second key before giving up. */
export const LEADER_TIMEOUT_MS = 2_000;

interface LeaderState {
  /** True between the prefix and its second key. */
  armed: boolean;
  /** True while the help line is expanded (the `?` entry). */
  helpOpen: boolean;
}

let state: LeaderState = { armed: false, helpOpen: false };
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

export function subscribeToLeader(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function isLeaderArmed(): boolean {
  return state.armed;
}

export function isLeaderHelpOpen(): boolean {
  return state.helpOpen;
}

/**
 * Arms the prefix, or refreshes it (the `?` entry re-arms so the user can read
 * the list and then press one of the keys in it).
 */
export function armLeader(options?: { help?: boolean }): void {
  const helpOpen = options?.help ?? false;
  const changed = !state.armed || state.helpOpen !== helpOpen;
  state = { armed: true, helpOpen };
  clearTimer();
  timer = setTimeout(() => {
    timer = null;
    if (!state.armed) return;
    state = { armed: false, helpOpen: false };
    notify();
  }, LEADER_TIMEOUT_MS);
  // A pending timeout must not hold the process open (headless runs, tests).
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    timer.unref();
  }
  if (changed) notify();
}

/** Leaves the prefix without running anything. */
export function disarmLeader(): void {
  clearTimer();
  if (!state.armed && !state.helpOpen) return;
  state = { armed: false, helpOpen: false };
  notify();
}

/** Test seam. */
export function resetLeader(): void {
  clearTimer();
  state = { armed: false, helpOpen: false };
  listeners.clear();
}
