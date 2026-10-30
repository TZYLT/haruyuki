/**
 * Run-level dream budget accounting (F-06 M2, requirement R-5.3).
 *
 * The **only** formula lives in `src/dream-budget-math.ts`; this module consumes
 * it. What lives here is everything that is not math:
 *
 * - the 40 % / 80 % / 100 % reminder thresholds and the once-per-run invariant,
 * - the hard stop ("spent ≥ allowance"), including the user's one automatic
 *   +50 % extension (R-5.3.6, O-1),
 * - the reminder text the run controller hands to the next turn.
 *
 * The tracker is deliberately a pure accumulator: no I/O, no clock. The run
 * controller decides when to call it and what to do with the returned crossings,
 * which is what makes the thresholds testable without a provider.
 */

import {
  computeDreamBudgetTokens,
  type DreamUsageParts,
  resolveDreamBudgetTokens,
} from "@/dream-budget-math";
import type { ResolvedDreamSettings } from "@/dream-settings";

/** Ratios of the base allowance that earn a reminder (R-5.3.5). */
export const DREAM_BUDGET_THRESHOLDS: readonly number[] = [0.4, 0.8, 1];

/** The user's ruling: one extra 50 % may be auto-approved. */
export const DREAM_OVER_BUDGET_EXTENSION_RATIO = 0.5;

/** `min(pressure × factor, maxPerRun)`, or the manual override (O-1). */
export function resolveDreamRunBudgetTokens(input: {
  settings: ResolvedDreamSettings;
  pressure: number;
  overrideTokens?: number;
}): number {
  return resolveDreamBudgetTokens({
    pressure: input.pressure,
    factor: input.settings.budgetFactor,
    maxPerRun: input.settings.maxPerRun,
    ...(input.overrideTokens !== undefined
      ? { overrideTokens: input.overrideTokens }
      : {}),
  });
}

/** Identifies which reminder a threshold produced (for prompt text + tests). */
export interface DreamBudgetCrossing {
  /** 0.4 / 0.8 / 1 — the ratio that was crossed. */
  threshold: number;
  /** `spent / baseBudget` at the moment it was first observed. */
  ratio: number;
  spentTokens: number;
  budgetTokens: number;
}

export interface DreamBudgetTrackerInput {
  /** Base allowance: `min(pressure × factor, maxPerRun)` or the override. */
  budgetTokens: number;
  /** Pre-approved extensions (`dreamOverBudgetApprovals`, default 1). */
  overBudgetApprovals: number;
}

/**
 * Accumulates one run's spend and answers the gate questions.
 *
 * Spend is stored in *budget units* (the formula's output), not raw provider
 * tokens: that is the same unit as `budgetTokens`, so `≥` is meaningful.
 */
export class DreamBudgetTracker {
  readonly baseBudgetTokens: number;
  private readonly maxExtensions: number;
  private extensionsUsed = 0;
  private spent = 0;
  private readonly emittedThresholds = new Set<number>();
  private turnParts: DreamUsageParts = {
    outputTokens: 0,
    uncachedReadTokens: 0,
    cachedReadTokens: 0,
  };

  constructor(input: DreamBudgetTrackerInput) {
    this.baseBudgetTokens = Math.max(0, Math.floor(input.budgetTokens));
    this.maxExtensions = Math.max(
      0,
      Math.floor(input.overBudgetApprovals || 0),
    );
  }

  /** Weighted tokens accounted for this run so far. */
  get spentTokens(): number {
    return this.spent;
  }

  /** The allowance currently in force (base + approved extensions). */
  get allowanceTokens(): number {
    return Math.floor(
      this.baseBudgetTokens *
        (1 + DREAM_OVER_BUDGET_EXTENSION_RATIO * this.extensionsUsed),
    );
  }

  get extensionsRemaining(): number {
    return Math.max(0, this.maxExtensions - this.extensionsUsed);
  }

  /** `spent / baseBudget`; `0` when no allowance was resolved. */
  get ratio(): number {
    if (this.baseBudgetTokens <= 0) return this.spent > 0 ? 1 : 0;
    return this.spent / this.baseBudgetTokens;
  }

  /** Every part consumed so far, for the run record's diagnostics. */
  get usageParts(): DreamUsageParts {
    return { ...this.turnParts };
  }

  /**
   * Fold one turn's usage parts in and report which reminder thresholds were
   * crossed for the first time. A turn whose parts are all zero (the
   * deterministic executor, or a crashed turn) still counts as a turn but
   * crosses nothing.
   */
  addTurn(parts: DreamUsageParts): DreamBudgetCrossing[] {
    const turnSpend = computeDreamBudgetTokens(parts);
    this.turnParts = {
      outputTokens: this.turnParts.outputTokens + parts.outputTokens,
      uncachedReadTokens:
        this.turnParts.uncachedReadTokens + parts.uncachedReadTokens,
      cachedReadTokens:
        this.turnParts.cachedReadTokens + parts.cachedReadTokens,
    };
    this.spent += turnSpend;
    const crossed: DreamBudgetCrossing[] = [];
    for (const threshold of DREAM_BUDGET_THRESHOLDS) {
      if (this.emittedThresholds.has(threshold)) continue;
      // 100 % is reported once the *base* allowance is reached, even though an
      // approved extension keeps the run alive.
      if (this.ratio >= threshold) {
        this.emittedThresholds.add(threshold);
        crossed.push({
          threshold,
          ratio: this.ratio,
          spentTokens: this.spent,
          budgetTokens: this.baseBudgetTokens,
        });
      }
    }
    return crossed;
  }

  /** True when the run must stop: spend reached the allowance in force. */
  isExhausted(): boolean {
    if (this.baseBudgetTokens <= 0) return true;
    return this.spent >= this.allowanceTokens;
  }

  /**
   * Spend an auto-approved extension (R-5.3.6): the run may continue on
   * `base × 1.5`. Returns false when no approval is left — the run then stops
   * as `budget_exhausted`, which is not a failure.
   */
  requestExtension(): boolean {
    if (this.extensionsRemaining <= 0) return false;
    this.extensionsUsed += 1;
    return true;
  }
}

function formatTokenCount(value: number): string {
  return Math.max(0, Math.round(value)).toLocaleString("en-US");
}

export interface DreamBudgetReminderInput {
  crossing: DreamBudgetCrossing;
  /** Allowance in force when the reminder is written. */
  allowanceTokens: number;
  /** Tier the run is about to enter, when known. */
  tier?: string;
}

/**
 * Reminder text for one crossed threshold.
 *
 * The text is delivered as a normal user-role message (wrapped in
 * `<system-reminder>` by the run controller when it becomes the next turn's
 * input). Never as a `system` role message — AGENTS.md's runtime rule, and
 * Anthropic can reject a system-role notification mid-transcript.
 */
export function buildDreamBudgetReminder(
  input: DreamBudgetReminderInput,
): string {
  const percent = Math.round(input.crossing.threshold * 100);
  const spent = formatTokenCount(input.crossing.spentTokens);
  const budget = formatTokenCount(input.crossing.budgetTokens);
  const allowance = formatTokenCount(input.allowanceTokens);
  const nextTier = input.tier ? ` Continue with the ${input.tier} tier.` : "";
  if (input.crossing.threshold >= 1) {
    return [
      `<system-reminder>`,
      `Dream run budget reached: ${spent}/${budget} budget tokens (${percent}%).`,
      `The user is not present; do not ask for approval.`,
      `Finish the current tier's committed work, then write a short handoff: what changed, what is left, and where the next run should start.`,
      `Further tiers are skipped unless the harness has auto-approved an extension (allowance ${allowance}).`,
      `</system-reminder>`,
    ].join("\n");
  }
  return [
    `<system-reminder>`,
    `Dream run budget reminder: ${spent}/${budget} budget tokens used (${percent}%).${nextTier}`,
    `Start wrapping up the remaining plan; keep memory commits small and finish within the current tier.`,
    `</system-reminder>`,
  ].join("\n");
}

/** The text written into the run's handoff when the budget stopped the run. */
export function describeDreamBudgetStop(
  tracker: DreamBudgetTracker,
  lastTier?: string,
): string {
  const spent = formatTokenCount(tracker.spentTokens);
  const allowance = formatTokenCount(tracker.allowanceTokens);
  return [
    `Budget exhausted after spending ${spent} of ${allowance} budget tokens.`,
    lastTier
      ? `The ${lastTier} tier completed; later tiers were not started.`
      : `No tier completed.`,
    `Continue from the next unfinished tier on the next run.`,
  ].join(" ");
}
