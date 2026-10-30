/**
 * Dream budget math (F-06), pure and shared by the signal source (T1) and the
 * run controller (T2). Kept out of both tracks' modules so the two cannot drift
 * on the user's formula; the run-level accounting (threshold reminders, hard
 * stop) still belongs to `agent/dream/dream-budget.ts`.
 *
 * The weights are the user's 2026-10-30 ruling closing O-1. They are not
 * symmetric on purpose:
 *
 * - **Pressure** decides *whether* a run may start. It is dominated by the
 *   tokens the model actually generated, with cache reads discounted hard
 *   (1/1000) because a warm cache says nothing about how much the conversation
 *   grew.
 * - **Budget** decides *how much* the run may spend. Sum, not max: every token
 *   class costs money, so the allowance tracks the total bill rather than the
 *   single biggest bucket. Cache reads are discounted by 1/200 instead of
 *   1/1000 because they are still billed, just cheaply.
 *
 * Usage parts are raw ledger token counts (output tokens, uncached input/cache
 * write tokens, cached read tokens).
 */

export interface DreamUsageParts {
  /** Tokens the model generated (all assistant steps in the window). */
  outputTokens: number;
  /** Prompt tokens billed at full price (uncached input + cache writes). */
  uncachedReadTokens: number;
  /** Prompt tokens served from the provider's prompt cache. */
  cachedReadTokens: number;
}

export const DREAM_PRESSURE_OUTPUT_WEIGHT = 1;
export const DREAM_PRESSURE_UNCACHED_READ_WEIGHT = 1 / 4;
export const DREAM_PRESSURE_CACHED_READ_WEIGHT = 1 / 1000;

export const DREAM_BUDGET_OUTPUT_WEIGHT = 1;
export const DREAM_BUDGET_UNCACHED_READ_WEIGHT = 1 / 4;
export const DREAM_BUDGET_CACHED_READ_WEIGHT = 1 / 200;

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

/**
 * `max(output, uncachedRead / 4, cachedRead / 1000)`.
 *
 * Fractions are kept, not floored: the threshold is a policy boundary and
 * flooring would make a 74,999.6 score cross it. Callers compare the returned
 * number against `pressureThreshold` directly.
 */
export function computeDreamPressure(parts: DreamUsageParts): number {
  return Math.max(
    nonNegative(parts.outputTokens) * DREAM_PRESSURE_OUTPUT_WEIGHT,
    nonNegative(parts.uncachedReadTokens) * DREAM_PRESSURE_UNCACHED_READ_WEIGHT,
    nonNegative(parts.cachedReadTokens) * DREAM_PRESSURE_CACHED_READ_WEIGHT,
  );
}

/**
 * `output + uncachedRead / 4 + cachedRead / 200`, floored.
 *
 * The budget is a hard token ceiling, so a fractional token is not spendable;
 * flooring keeps "spent >= budget" from being reached a token early.
 */
export function computeDreamBudgetTokens(parts: DreamUsageParts): number {
  const total =
    nonNegative(parts.outputTokens) * DREAM_BUDGET_OUTPUT_WEIGHT +
    nonNegative(parts.uncachedReadTokens) * DREAM_BUDGET_UNCACHED_READ_WEIGHT +
    nonNegative(parts.cachedReadTokens) * DREAM_BUDGET_CACHED_READ_WEIGHT;
  return Math.floor(total);
}

export interface DreamBudgetInput {
  /** Pressure score (see {@link computeDreamPressure}). */
  pressure: number;
  /** `dreamBudgetFactor`, the user's k (default 0.8). */
  factor: number;
  /** `dreamMaxPerRun`, the fixed per-run cap (default 100,000). */
  maxPerRun: number;
  /** `/dream run --budget <n>` override; replaces the computed allowance. */
  overrideTokens?: number;
}

/**
 * The run's token allowance: `min(pressure * factor, maxPerRun)`, or the manual
 * override when one was passed. Always at least 1 when any allowance is
 * possible, never negative.
 */
export function resolveDreamBudgetTokens(input: DreamBudgetInput): number {
  const override = input.overrideTokens;
  if (override !== undefined && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  const pressure = nonNegative(input.pressure);
  const factor =
    typeof input.factor === "number" &&
    Number.isFinite(input.factor) &&
    input.factor > 0
      ? input.factor
      : 0;
  const cap =
    typeof input.maxPerRun === "number" &&
    Number.isFinite(input.maxPerRun) &&
    input.maxPerRun > 0
      ? input.maxPerRun
      : 0;
  return Math.max(0, Math.floor(Math.min(pressure * factor, cap)));
}

/** `true` when the pressure score has reached the configured threshold. */
export function hasReachedDreamPressure(
  pressure: number,
  threshold: number,
): boolean {
  const numericThreshold =
    typeof threshold === "number" && Number.isFinite(threshold) ? threshold : 0;
  // A threshold at or below 0 means "no pressure gate"; never fire on an
  // invalid threshold rather than firing on every tick.
  if (numericThreshold <= 0) return false;
  return pressure >= numericThreshold;
}
