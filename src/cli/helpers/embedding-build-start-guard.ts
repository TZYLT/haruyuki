/**
 * Admission control for the embedding build host's async start.
 *
 * `startEmbeddingBuild` is `async`, and the host's `RunningBuild` only exists
 * after its model-install probe, A2's lock preflight and the live calibration.
 * Two facts must therefore be recorded **synchronously, before the first
 * `await`**, or that window is unguarded:
 *
 * 1. **Admission** — a second caller arriving inside the window must not start
 *    a second runner, nor a second detached child racing for the same index
 *    space; the second `current` assignment would also lose the first child's
 *    cancel handle (48-3 §11.7.5-4).
 * 2. **Cancel intent** — a cancel that lands inside the window has no run to
 *    abort, so it must be answered "cancelling" rather than "nothing is
 *    running" (the build would start anyway). The host checks the intent after
 *    every awaited step and refuses the start instead of building.
 *
 * Tokens, not booleans: `reset()` may drop a claim while its start is still
 * parked, and that start's late `finish()` must not clear a newer claim.
 *
 * Layer: `cli/helpers/`. No imports, so every host and test can own an
 * instance.
 */

/** One process's admission window. */
export interface EmbeddingBuildStartGuard {
  /**
   * Claim the window before the first `await`.
   *
   * Returns the admission token, or `null` when another start already owns it.
   * Claiming also clears any stale cancel intent.
   */
  tryBegin(): number | null;
  /**
   * Release a claim when its start settles (installed a run or was refused).
   *
   * A token older than the current claim is ignored, so a late `finally` after
   * {@link EmbeddingBuildStartGuard.reset} cannot clear a newer start.
   */
  finish(token: number): void;
  /** Whether a cancel landed while a start owned the window. */
  isCancelRequested(): boolean;
  /**
   * Record a cancel aimed at the start in the window.
   *
   * Returns `true` when a start owned the window (the caller may answer
   * "cancelling"); `false` means the usual cancel path applies.
   */
  requestCancel(): boolean;
  /** Drop the claim and the intent (host teardown and tests). */
  reset(): void;
}

/** A fresh window; the host keeps one per process. */
export function createEmbeddingBuildStartGuard(): EmbeddingBuildStartGuard {
  let activeAdmission: number | null = null;
  let admissionSeq = 0;
  let cancelRequested = false;
  return {
    tryBegin() {
      if (activeAdmission !== null) return null;
      admissionSeq += 1;
      activeAdmission = admissionSeq;
      cancelRequested = false;
      return activeAdmission;
    },
    finish(token) {
      if (activeAdmission !== token) return;
      activeAdmission = null;
      cancelRequested = false;
    },
    isCancelRequested() {
      return cancelRequested;
    },
    requestCancel() {
      if (activeAdmission === null) return false;
      cancelRequested = true;
      return true;
    },
    reset() {
      activeAdmission = null;
      cancelRequested = false;
    },
  };
}
