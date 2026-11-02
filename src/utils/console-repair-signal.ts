/**
 * The tools → CLI signal that a child process may have disturbed this session's
 * console font (T-08, 47-2 §2.3).
 *
 * Layer: `utils/` (bottom, leaf) because the two speakers sit on opposite sides
 * of a boundary `tools/` must not cross. The shell runner (`tools/`) emits the
 * signal after a pipeline spawn; the console-font guard (`cli/`) registers the
 * handler. A direct `tools/ -> cli/` import is exactly what the layer check
 * forbids, so the shared leaf is this module.
 *
 * The signal carries no data and is best-effort: with no handler registered,
 * `requestConsoleRepairCheck()` is a no-op — headless runs, non-Windows hosts
 * and a guard that is not armed yet must not throw, and a request that arrives
 * while nothing is armed is dropped rather than replayed. W-06 wires both ends
 * (shell-runner emits, `console-font-bun` registers `guard.check`).
 */

/** What the CLI side registers: one immediate guard check, arguments-free. */
export type ConsoleRepairHandler = () => void;

let repairHandler: ConsoleRepairHandler | null = null;

/** Ask the armed guard for one immediate check; a no-op when none is armed. */
export function requestConsoleRepairCheck(): void {
  repairHandler?.();
}

/**
 * Register (CLI side) or clear (`null`) the single repair handler.
 *
 * One handler rather than a listener list: there is one console and one guard
 * per process, and a handler left behind by a stopped guard is exactly how a
 * "repair" would keep firing into a session that no longer owns the console.
 */
export function setConsoleRepairHandler(fn: (() => void) | null): void {
  repairHandler = fn;
}
