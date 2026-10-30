/**
 * Shared helpers for turning child telemetry into the dream budget's unit.
 *
 * `src/dream-budget-math.ts` owns the weights; these helpers only add and map.
 * They live here rather than in the controller because both the spawn wiring
 * (stream events, result envelope) and the state machine (turn accounting) need
 * the same definition of "this turn's usage parts".
 */

import type { DreamUsageParts } from "@/dream-budget-math";

const ZERO_PARTS: DreamUsageParts = {
  outputTokens: 0,
  uncachedReadTokens: 0,
  cachedReadTokens: 0,
};

/** Add two usage-part sets (stream accumulation, turn folds). */
export function mergeDreamUsageParts(
  base: DreamUsageParts,
  add: DreamUsageParts,
): DreamUsageParts {
  return {
    outputTokens: base.outputTokens + add.outputTokens,
    uncachedReadTokens: base.uncachedReadTokens + add.uncachedReadTokens,
    cachedReadTokens: base.cachedReadTokens + add.cachedReadTokens,
  };
}

/** `true` when nothing was spent (deterministic executor, crashed turn). */
export function isEmptyDreamUsageParts(parts: DreamUsageParts): boolean {
  return (
    parts.outputTokens === 0 &&
    parts.uncachedReadTokens === 0 &&
    parts.cachedReadTokens === 0
  );
}

/** Raw-token total, for diagnostics only (never compared with a budget). */
export function totalDreamUsageTokens(parts: DreamUsageParts): number {
  return parts.outputTokens + parts.uncachedReadTokens + parts.cachedReadTokens;
}

/** Bucket names as `usage/ledger` stores them, mapped to the formula's classes. */
export interface DreamResultUsageBuckets {
  /** Input tokens billed at the miss rate. */
  prompt: number;
  /** Input tokens served from the provider's prompt cache. */
  cachedInput: number;
  /** Input tokens billed at the cache-write rate. */
  cacheWrite: number;
  /** Output tokens. */
  completion: number;
}

/**
 * Map a child's result-envelope buckets into the budget formula's classes.
 *
 * `DreamUsageParts.uncachedReadTokens` is documented as "uncached input + cache
 * writes" — both are prompt tokens billed above the cache-read rate — so the two
 * ledger buckets are summed rather than kept apart.
 */
export function dreamUsagePartsFromBuckets(
  buckets: DreamResultUsageBuckets,
): DreamUsageParts {
  return {
    outputTokens: buckets.completion,
    uncachedReadTokens: buckets.prompt + buckets.cacheWrite,
    cachedReadTokens: buckets.cachedInput,
  };
}

export { ZERO_PARTS as EMPTY_DREAM_USAGE_PARTS };
