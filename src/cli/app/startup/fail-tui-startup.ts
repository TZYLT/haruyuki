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

/** Set by `--no-provider`: the TUI may start with no agent and no model. */
export type NoProviderState = { enabled: true } | null;

/**
 * Fail TUI startup after mount: restore the screen, print to stderr, exit.
 *
 * **Placeholder (W-01): W-16 replaces this body.** Throwing keeps the `never`
 * contract and is unmistakable if the seam is wired before its implementation;
 * it is never called by production code yet.
 */
export function failTuiStartup(message: string): never {
  throw new Error(`TUI startup failed: ${message}`);
}
