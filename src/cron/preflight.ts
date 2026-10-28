/**
 * Lightweight preflight for the short-lived host (F-05, R-5.3.2/R-5.3.3).
 *
 * Runs before the backend, the model catalog and the tools are loaded: read the
 * store, compute the next due minute, and exit when nothing can be due. No
 * derived cache file (Q-54) — one small JSON parse is the whole cost.
 *
 * M0 freeze: the entry point name and input shape are part of the frozen
 * barrel. M1 fills the body.
 */

export interface SchedulePreflightInput {
  now: Date;
}

export interface SchedulePreflightResult {
  /** True when the caller must load the runtime and do a real evaluation. */
  due: boolean;
  /** The next minute anything is due, for diagnostics and the log line. */
  nextDueAt: Date | null;
}

/** M1 replaces the body. Must not import anything that reaches the backend. */
export function runSchedulePreflight(
  _input: SchedulePreflightInput,
): SchedulePreflightResult {
  throw new Error("runSchedulePreflight is not implemented yet (F-05 M1).");
}
