/**
 * Dream launcher seam (F-06 M1, route §2.3.5 S5).
 *
 * The `/dream run` command (M4, T4) does not start a run in the TUI process:
 * it asks this launcher, which resolves settings and spawns the detached
 * `haruyuki dream run --task <id>` host (M1, T1) exactly like the scheduler's
 * delegation. Returning immediately keeps the input loop responsive.
 *
 * L0 stub: `started: false` with a reason, so the command can report "not
 * available yet" instead of crashing before M1 lands. T1 replaces the body;
 * the signature is frozen and only the Lead may change it.
 *
 * Owner: T1 (M1).
 */

export interface StartDreamRunInput {
  agentId: string;
  /** `--budget` override for this one run, when the user passed one. */
  budgetOverrideTokens?: number;
}

export interface StartDreamRunResult {
  started: boolean;
  runId: string | null;
  /** Why the run did not start (settings off, lock held, already running). */
  reason?: string;
}

export async function startDreamRun(
  _input: StartDreamRunInput,
): Promise<StartDreamRunResult> {
  // Filled in by M1 (T1).
  return {
    started: false,
    runId: null,
    reason: "dream run is not available yet",
  };
}
