/**
 * The one path for a TUI startup failure (T-07, 47-2 §2.3).
 *
 * Why this exists: `src/index.ts` used to `console.error(...)` + `process.exit(1)`
 * from inside the Ink render tree. By then Ink has already entered the alternate
 * screen, so the error text is painted into a buffer that the exiting process
 * throws away — the user sees a silent failure (R-07.2). Every startup failure
 * after mount must instead go through **one** function that first gives the
 * screen back and then reports.
 *
 * W-01 freezes the seam; **W-16 implements the body**:
 *
 * 1. `unmount()` the mounted Ink root so the alternate screen is left and the
 *    user's shell/scrollback returns;
 * 2. write `message` to **stderr** as plain text (no stack, no ANSI), including
 *    "what happened + what to run next";
 * 3. exit non-zero.
 *
 * The `--no-provider` empty state gets the same named shape:
 * `NoProviderState` is `{ enabled: true }` when the flag is present and `null`
 * otherwise, so the startup code can branch on it without a second boolean.
 */

import { writeSync } from "node:fs";

/** Set by `--no-provider`: the TUI may start with no agent and no model. */
export type NoProviderState = { enabled: true } | null;

/** The part of Ink's mounted root this seam needs: unmount leaves alt screen. */
export interface TuiStartupRoot {
  unmount: () => void;
}

/**
 * The mounted root, registered right after `render()`.
 *
 * This is the only way `failTuiStartup(message)` keeps the frozen one-argument
 * signature while still owning the screen: the entry point hands over the
 * instance once, and a failure later finds it here.
 */
let mountedRoot: TuiStartupRoot | null = null;

/** Called once by the process entry, immediately after `render()`. */
export function registerTuiStartupRoot(root: TuiStartupRoot): void {
  mountedRoot = root;
}

/** Drop the registration (tests; a process that left the TUI deliberately). */
export function clearTuiStartupRoot(): void {
  mountedRoot = null;
}

/**
 * Write one plain-text block to stderr.
 *
 * `writeSync` on purpose: the caller exits on the next line, and an
 * asynchronous stream write (a pipe or a redirect — which is exactly how a test
 * or a wrapper reads this) can be discarded by `process.exit`.
 */
export function writeStartupFailureText(message: string): void {
  const text = message.endsWith("\n") ? message : `${message}\n`;
  try {
    writeSync(2, text);
  } catch {
    process.stderr.write(text);
  }
}

/**
 * Report a failure detected **before** `render()`: nothing mounted, so there is
 * no alternate screen to leave and no unmount to do. Same stderr text and exit
 * code as `failTuiStartup`, so both halves of the double guard look identical to
 * the user (R-07.1).
 */
export function reportTuiStartupFailureBeforeRender(message: string): never {
  writeStartupFailureText(message);
  process.exit(1);
}

/**
 * Fail TUI startup after mount: restore the screen, print to stderr, exit.
 *
 * Unmount is best-effort: if Ink's teardown throws there is no screen left to
 * recover, but the reason the startup failed must still reach the user, so the
 * stderr write happens either way.
 */
export function failTuiStartup(message: string): never {
  const root = mountedRoot;
  mountedRoot = null;
  try {
    root?.unmount();
  } catch {
    // Nothing to restore with; the message below is still the contract.
  }
  writeStartupFailureText(message);
  process.exit(1);
}
