/**
 * The dream segment of the product-status line (T-01, 47-2 §1.1/§2.3/§4.2).
 *
 * This module is the **frozen seam** between the TUI and a running dream: the
 * polling hook (`use-dream-run-status.ts`) reads the lease, computes `elapsedMs`
 * from its own clock and hands this shape to the pure renderer; `default.ts`
 * then merges the result with the reflection segment on the same line.
 *
 * Everything here is pure — no file reads, no timers, no `process.env`. The
 * renderer receives the panel's `chalk` instance (never a second one) and the
 * already-styled spinner frame, so a styled caller and a test strip the same
 * bytes.
 *
 * R-01.1–R-01.5:
 *
 * - running segment: `dreaming · tidy · 12m · 42%`;
 * - done segment: `✓ dreaming · tidy · 12m` (the 30 s linger is the hook's job);
 * - narrow widths drop the budget percentage first, then the elapsed time, then
 *   the tier, then fall back to `dreaming` (+ spinner); when even that does not
 *   fit the whole segment gives way to the reflection half (returns `""`).
 */

import type { ChalkInstance } from "chalk";
import { colors } from "@/cli/components/colors";
import { terminalTextWidth } from "@/cli/helpers/char-width";
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
 * The separator between the reflection and dream halves, and between the dream
 * half's own fields (R-01.2). `default.ts` uses it to price the dream half's
 * remaining width before rendering it.
 */
export const DREAM_SEGMENT_SEPARATOR = " · ";

/**
 * `65s` / `12m` / `1h 5m`: the elapsed half of the dream segment.
 *
 * Elapsed time counts *up*, so the seconds are floored — rounding would show
 * `60s` for the last half-second of the first minute while the lease's own
 * `startedAt` still says "less than a minute".
 */
export function formatDreamElapsedMs(ms: number): string {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

/**
 * `42%`: `spentTokens / budgetTokens`, rounded.
 *
 * The percentage steps at tier/turn boundaries because the lease only records
 * spend there (O-02); the renderer must not imply live accounting. Returns
 * `null` when either figure is missing (an old lease) or the budget is not a
 * positive number, so the caller drops the field instead of printing `NaN%`.
 */
export function formatDreamBudgetPercent(
  spentTokens: number | null,
  budgetTokens: number | null,
): string | null {
  if (
    spentTokens === null ||
    budgetTokens === null ||
    !Number.isFinite(spentTokens) ||
    !Number.isFinite(budgetTokens) ||
    budgetTokens <= 0
  ) {
    return null;
  }
  const ratio = Math.max(0, spentTokens) / budgetTokens;
  return `${Math.round(ratio * 100)}%`;
}

interface DreamSegmentParts {
  /** `⠋ dreaming` / `✓ dreaming` (the marker may be empty when merged). */
  head: string;
  tier: string | null;
  elapsed: string | null;
  percent: string | null;
}

function buildDreamSegmentParts(
  snap: DreamStatusSnapshot,
  spinner: string,
  chalk: ChalkInstance,
): DreamSegmentParts {
  const label = chalk.hex(colors.bgSubagent.label)("dreaming");
  const marker =
    snap.phase === "done" ? chalk.hex(colors.state.success)("✓") : spinner;
  const head = marker.length > 0 ? `${marker} ${label}` : label;
  const percent = formatDreamBudgetPercent(snap.spentTokens, snap.budgetTokens);
  return {
    head,
    tier: snap.tier === null ? null : chalk.dim(snap.tier),
    elapsed: chalk.dim(formatDreamElapsedMs(snap.elapsedMs)),
    // A finished run shows the duration it ran for, never a spend figure
    // (R-01.5's example has no percentage).
    percent:
      snap.phase === "done" || percent === null ? null : chalk.dim(percent),
  };
}

/**
 * The `dreaming · tidy · 12m · 42%` segment, or `""` when it must give way.
 *
 * `width` is the columns the merged line has left for this segment (the caller
 * has already paid for the reflection half and the separator). `spinner` is the
 * already-styled frame `default.ts` uses; pass `""` when the line already
 * starts with that spinner because reflection is sharing it. `chalk` is the
 * panel's own instance — the separator and dim styling come from it too.
 */
export function renderDreamSegment(
  snap: DreamStatusSnapshot,
  width: number,
  spinner: string,
  chalk: ChalkInstance,
): string {
  if (width <= 0) return "";
  const parts = buildDreamSegmentParts(snap, spinner, chalk);
  // Display order is also the degradation order's reverse (R-01.4): the array
  // is [head, tier, elapsed, percent], so truncating from the tail drops the
  // budget percentage, then the duration, then the tier, and finally leaves
  // only the label the spinner is attached to.
  const ordered = [parts.head, parts.tier, parts.elapsed, parts.percent].filter(
    (part): part is string => part !== null,
  );
  for (let count = ordered.length; count >= 1; count -= 1) {
    const candidate = ordered.slice(0, count).join(DREAM_SEGMENT_SEPARATOR);
    if (terminalTextWidth(candidate) <= width) return candidate;
  }
  return "";
}
