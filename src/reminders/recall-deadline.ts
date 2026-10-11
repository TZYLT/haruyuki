/**
 * Feature ②'s time budget for one recall turn.
 *
 * The recall path is synchronous end to end — the corpus loader stats and reads
 * each conversation's sidecar, the scorer walks every indexed record, and the
 * memory source reads each workspace file with `readFileSync`. None of that can
 * be pre-empted, so the budget is *cooperative*: the loops ask this object
 * whether they may continue, and a loop that is told to stop returns what it has
 * (《27》M5-1). The turn is therefore bounded by the gap between two checkpoints,
 * never by a timer that cannot interrupt the work.
 *
 * `0` means "no budget at all", and is why the check happens before any
 * comparison rather than through a timer: `setTimeout(fn, 0)` would fire on the
 * next tick and expire a budget the user asked to be unlimited.
 */
export type RecallDeadline = {
  /** True once the budget is spent; loops treat it as "stop now". */
  expired(): boolean;
  /** The budget this deadline was built from; `0` for unlimited. */
  readonly timeoutMs: number;
};

/**
 * A budget of `timeoutMs` milliseconds, starting now.
 *
 * An unusable value (negative, not finite) is treated as unlimited, the same way
 * `0` is: a corrupt setting must not turn recall into a feature that can never
 * finish a turn.
 */
export function createRecallDeadline(
  timeoutMs: number,
  now: () => number = Date.now,
): RecallDeadline {
  const budget =
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.trunc(timeoutMs) : 0;
  const expiresAt = budget === 0 ? 0 : now() + budget;
  return {
    timeoutMs: budget,
    expired: () => expiresAt !== 0 && now() >= expiresAt,
  };
}
