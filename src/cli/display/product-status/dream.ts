/**
 * The dream segment of the product-status line (T-01, 47-2 §2.3).
 *
 * This module is the **frozen seam** between the TUI and a running dream: W-02
 * owns the real rendering (tier, elapsed, budget, the R-01.4 narrow-width
 * degradation and the 30 s done linger). W-01 only fixes the shapes every later
 * package compiles against, so the polling hook, the merged `default.ts` line
 * and the frame tests can be written in parallel without re-deciding them.
 *
 * The snapshot is a projection of `dream-lease.ts` (plus the run metadata the
 * lease cannot carry): the poller reads the lease, computes `elapsedMs` from its
 * own clock and hands this shape to the pure renderer. Keep this module pure —
 * no file reads, no timers, no `process.env` in the renderer.
 */

import type { ChalkInstance } from "chalk";
import type { DreamTier } from "@/types/dream-run-metadata";

/** The one running (or just-finished) dream worth showing for an agent. */
export interface DreamStatusSnapshot {
  /** The lease's run id; a changed id resets the panel instead of animating on. */
  runId: string;
  /** The agent the run belongs to; only the current agent's run is shown. */
  agentId: string;
  /** `done` is the linger phase after the run ended (R-01.5, 30 s). */
  phase: "running" | "done";
  /** Current/next tier, or `null` while the run has not entered one yet. */
  tier: DreamTier | null;
  /** Time since the run started, computed locally from the lease timestamp. */
  elapsedMs: number;
  /** Tokens spent so far; `null` when the lease has no figure yet. */
  spentTokens: number | null;
  /** The run's token budget; `null` when the lease has no figure yet. */
  budgetTokens: number | null;
  /** Set only while `phase === "done"`: when the run ended. */
  endedAtMs?: number;
}

/**
 * `12m` / `65s`: the elapsed half of the dream segment.
 *
 * **W-02 implements the final durations** (and R-01.4 decides when the elapsed
 * part is dropped for width). This placeholder is deliberately trivial so the
 * seam compiles; do not build a test on its exact output.
 */
export function formatDreamElapsedMs(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m`;
}

/**
 * The `dreaming · tidy · 12m · 42%` segment, or `""` when it must give way.
 *
 * **W-02 owns the real body**: tier/elapsed/budget ordering, the narrow-width
 * degradation order (R-01.4), the done glyph and the styling. W-01 freezes the
 * signature only — `width` is the columns the merged line has left, `spinner`
 * is the already-styled frame `default.ts` uses, and `chalk` is the panel's
 * chalk instance (not a second one).
 */
export function renderDreamSegment(
  snap: DreamStatusSnapshot,
  width: number,
  spinner: string,
  chalk: ChalkInstance,
): string {
  // Placeholder: W-02 replaces this with the full segment. Keeping it to the
  // label means an accidental wiring is inert rather than misleading.
  void width;
  const label = chalk.dim("dreaming");
  if (snap.phase === "done") return `${chalk.green("✓")} ${label}`;
  return `${spinner} ${label}`;
}
