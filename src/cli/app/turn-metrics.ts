/**
 * Small derived numbers the end-of-turn branch needs, kept out of
 * `use-conversation-loop.ts` so they can be tested as pure functions.
 *
 * `use-conversation-loop.ts` sits at its size cap; extracting this logic is the
 * intended remedy (it is the only reason the file has room for the usage
 * ledger's one call site).
 */

import type { SessionStats, TrajectoryStatsSnapshot } from "@/agent/stats";
import type { Buffers } from "@/cli/helpers/accumulator";

/**
 * Wall time of the turn so far: the segments that already closed, plus the one
 * still running.
 *
 * The trajectory snapshot only counts segments closed by
 * `closeTrajectorySegment`, so during the final segment it lags until the
 * caller closes it. `segmentStartMs === null` means nothing is running.
 */
export function liveTrajectoryElapsedMs(
  stats: SessionStats,
  segmentStartMs: number | null,
): number {
  const base = stats.getTrajectorySnapshot()?.wallMs ?? 0;
  if (segmentStartMs === null) return base;
  return base + (performance.now() - segmentStartMs);
}

/** What the summary line shows, and whether the turn earned one. */
export interface TrajectorySummaryPlan {
  wallMs: number;
  shouldShow: boolean;
}

/**
 * The turn is worth a one-line summary when it was long, or when it took many
 * steps and was not trivial: a 12-second, three-step turn is noise, a 90-second
 * one is not.
 */
export function trajectorySummary(
  snapshot: TrajectoryStatsSnapshot,
  liveElapsedMs: number,
): TrajectorySummaryPlan {
  const wallMs = Math.max(liveElapsedMs, snapshot.wallMs);
  return {
    wallMs,
    shouldShow: (snapshot.stepCount > 3 && wallMs > 10_000) || wallMs > 60_000,
  };
}

/** Renderable tokens added since the turn started (never negative). */
export function tokenCountDelta(
  buffers: Buffers,
  runTokenStart: number,
): number {
  return Math.max(0, buffers.tokenCount - runTokenStart);
}
