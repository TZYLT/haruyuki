/**
 * Feature ②'s run-time bookkeeping: the failure counter, the breaker, and the
 * one line the user gets when something went wrong.
 *
 * Three decisions shape this module, all of them from 《26》§6.6:
 *
 * - **In memory only.** A restart clears the count and the trip. Persisting the
 *   trip would turn a transient environment fault (a locked file, a slow disk)
 *   into a setting the user has to remember to undo.
 * - **Only timeouts and exceptions count.** "No match" is a successful recall
 *   that found nothing, and a missing index is degradation — counting either
 *   would make the first few turns of a fresh install trip the breaker.
 * - **Global, not per conversation.** The counter is process-wide because the
 *   faults it watches for are process-wide: one unreadable store or one overloaded
 *   disk affects every conversation.
 *
 * The module is deliberately free of backend imports. The provider in `engine.ts`
 * is the only writer, and everything that only *reads* — `/recall status`, the
 * three notice outlets — can import this without dragging the backend along.
 */
import type { RecallDecision } from "./recall-port";

/** Consecutive timeouts/exceptions that switch the feature off (《26》§6.6). */
export const RECALL_BREAKER_THRESHOLD = 3;

/** What the user is told about the turn that just ran, if anything. */
export type RecallNotice =
  | { kind: "timed-out"; reason: string }
  | { kind: "failed"; reason: string }
  /** The index is missing, so nothing could be recalled; `build` is the fix. */
  | { kind: "index-missing" }
  /** The breaker just tripped. Shown instead of the failure it tripped on. */
  | { kind: "tripped"; failures: number; reason: string };

export interface RecallRuntimeStatus {
  /** The most recent turn's decision, for `/recall status`. */
  lastDecision: RecallDecision | null;
  consecutiveFailures: number;
  tripped: boolean;
  lastFailureReason: string | null;
}

let lastDecision: RecallDecision | null = null;
let consecutiveFailures = 0;
let tripped = false;
let lastFailureReason: string | null = null;
/**
 * Whether the user has already been told that this agent's transcript index is
 * missing. Latched because the condition persists: without it, every turn of a
 * fresh install would print the same line until `build` is run.
 */
let indexMissingReported = false;

/** Clear the breaker, the counter, and every latch. `/recall on` calls this. */
export function resetRecallRuntime(): void {
  lastDecision = null;
  consecutiveFailures = 0;
  tripped = false;
  lastFailureReason = null;
  indexMissingReported = false;
}

/** True while the breaker is tripped: the turn path must not even try. */
export function recallBreakerTripped(): boolean {
  return tripped;
}

export function readRecallRuntimeStatus(): RecallRuntimeStatus {
  return {
    lastDecision,
    consecutiveFailures,
    tripped,
    lastFailureReason,
  };
}

/**
 * The reason to show for a decision the caller has classified as a failure.
 *
 * `decision.reason` is usually set; a source-level failure that still produced a
 * status the service could not attribute needs a fallback, or the user gets a
 * line with nothing after the colon.
 */
function failureReason(decision: RecallDecision): string {
  if (decision.reason) return decision.reason;
  if (decision.timedOut) return "the recall deadline expired";
  return "the recall sources failed";
}

/** A turn the breaker watches: a timeout, or every source throwing. */
function isFailure(decision: RecallDecision): boolean {
  return decision.timedOut === true || decision.status === "failed";
}

/**
 * The one actionable degradation: a transcript index that does not exist yet.
 *
 * Not "any source unavailable" — the memory source is unavailable whenever the
 * agent has no memory workspace, which is a normal state the user cannot fix by
 * running `build`.
 */
function indexMissing(decision: RecallDecision): boolean {
  return decision.diagnostics.sources.some(
    (source) =>
      source.source === "transcript" && source.status === "unavailable",
  );
}

/**
 * Record one turn's outcome and return the line the user should see, if any.
 *
 * Called for every turn that reaches the sources, whether or not it injected
 * anything: "nothing matched" is evidence the feature is working, and it is what
 * resets the count (《26》§6.6 "成功一次即清零").
 */
export function recordRecallDecision(
  decision: RecallDecision,
): RecallNotice | null {
  lastDecision = decision;

  if (isFailure(decision)) {
    const reason = failureReason(decision);
    consecutiveFailures += 1;
    lastFailureReason = reason;
    if (consecutiveFailures >= RECALL_BREAKER_THRESHOLD) {
      tripped = true;
      return { kind: "tripped", failures: consecutiveFailures, reason };
    }
    return decision.timedOut === true
      ? { kind: "timed-out", reason }
      : { kind: "failed", reason };
  }

  consecutiveFailures = 0;
  // The last reason outlives the failure on purpose: `/recall status` is asked
  // after the problem, and a cleared field would answer "never" to "what went
  // wrong last time".
  if (indexMissing(decision)) {
    if (indexMissingReported) return null;
    indexMissingReported = true;
    return { kind: "index-missing" };
  }
  indexMissingReported = false;
  return null;
}

/** The user-facing line: never sent to the model, never part of the transcript. */
export function formatRecallNoticeLine(notice: RecallNotice): string {
  switch (notice.kind) {
    case "timed-out":
      return `Recall timed out and was skipped for this turn: ${notice.reason}`;
    case "failed":
      return `Recall failed and was skipped for this turn: ${notice.reason}`;
    case "index-missing":
      return "Recall has no transcript index yet. Run /recall build to create it.";
    case "tripped":
      return `Recall failed ${notice.failures} turns in a row (last: ${notice.reason}) and has switched itself off. /recall on re-enables it.`;
  }
}

/**
 * Claim the notice the provider parked on a reminder state, if any.
 *
 * Typed structurally rather than against `SharedReminderState` so this module
 * stays a leaf: `state.ts` imports the notice type from here, and importing the
 * state back would close the loop. Claiming clears the field, which is what makes
 * "exactly one surface prints it" true even when a turn is retried and two
 * surfaces both run.
 */
export function takePendingRecallNotice(state: {
  pendingRecallNotice: RecallNotice | null;
}): RecallNotice | null {
  const notice = state.pendingRecallNotice;
  state.pendingRecallNotice = null;
  return notice;
}
