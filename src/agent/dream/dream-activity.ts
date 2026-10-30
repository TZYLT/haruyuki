/**
 * User-activity markers for dream runs (F-06 M2, route §2.3.5 S2).
 *
 * A dream run aborts when the user comes back: the TUI submit path and the
 * listener turn path stamp the agent's activity, and the run controller
 * compares that stamp with the run's start time.
 *
 * Both functions are synchronous on purpose — `DreamSignalDeps` reads the last
 * activity time synchronously during a scheduler tick, and the submit path
 * must not await disk I/O before sending.
 *
 * L0 stub: a no-op / `null` so the wiring compiles and stays harmless until
 * M2 replaces the body. The signature is frozen and only the Lead may change it.
 */

/** Record that the user just interacted with this agent. */
export function markDreamActivity(_agentId: string, _at?: number): void {
  // Filled in by M2 (`agent/dream/dream-activity.ts` owner).
}

/** The last recorded interaction time in ms, or `null` when there is none. */
export function readDreamActivity(_agentId: string): number | null {
  // Filled in by M2.
  return null;
}
