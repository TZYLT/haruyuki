/**
 * Money spent on one turn, split by the four buckets providers bill separately.
 *
 * Layer: `utils/` (bottom, no domain deps). The shape lives here rather than in
 * `usage/` because three different owners speak it — the provider adapter
 * (`backend/dev/provider-turn-executor.ts` sends it over the stream), the
 * per-turn aggregate (`agent/stats.ts`) and the usage ledger (`usage/ledger.ts`)
 * — and a redeclared copy in any one of them would silently drift.
 *
 * **Nothing here prices anything.** pi-ai computes the numbers with the model's
 * own rates (including request-wide pricing tiers) as it finishes a request, so
 * the four buckets are already mutually exclusive and their sum is what the
 * provider would charge. Re-deriving them from a local price table would be a
 * second source of truth that goes stale the moment a model is repriced.
 */
export interface UsageCost {
  /** Input tokens billed at the miss (full) rate. */
  input: number;
  /** Input tokens billed at the cache-read (hit) rate. */
  cacheRead: number;
  /** Input tokens billed at the cache-write rate. */
  cacheWrite: number;
  output: number;
  total: number;
}

/** A zero-cost accumulator. Always returns a fresh object. */
export function emptyUsageCost(): UsageCost {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 };
}

/**
 * Add `delta` into `target` in place and return `target`.
 *
 * In place because the call sites are accumulators on hot paths (per stream
 * chunk, per drain segment). `undefined` is a no-op so a provider that reports
 * no cost needs no special case at those call sites.
 */
export function addUsageCost(
  target: UsageCost,
  delta: UsageCost | undefined,
): UsageCost {
  if (!delta) return target;
  target.input += delta.input;
  target.output += delta.output;
  target.cacheRead += delta.cacheRead;
  target.cacheWrite += delta.cacheWrite;
  target.total += delta.total;
  return target;
}

/** True when every bucket (and the total) is zero. */
export function isZeroUsageCost(cost: UsageCost): boolean {
  return (
    cost.input === 0 &&
    cost.output === 0 &&
    cost.cacheRead === 0 &&
    cost.cacheWrite === 0 &&
    cost.total === 0
  );
}
