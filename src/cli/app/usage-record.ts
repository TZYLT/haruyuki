/**
 * The one place the TUI hands a finished turn to the usage ledger.
 *
 * Kept out of `use-conversation-loop.ts` (which is at its size cap) and out of
 * the ledger itself (which must stay free of CLI types): this module owns the
 * mapping between the trajectory snapshot's field names and the ledger's.
 *
 * Fire-and-forget on purpose. The ledger never throws, and a usage record is
 * not worth delaying the next turn or surfacing an error for.
 */

import type { SessionStats, TrajectoryStatsSnapshot } from "@/agent/stats";
import { appendUsageRecord, buildUsageRecord } from "@/usage/ledger";
import {
  consumeScheduledRunContext,
  type ScheduledRunContext,
  type ScheduledRunTurnOutcome,
} from "@/usage/scheduled-run-context";

export interface TurnUsageIdentity {
  agentId: string | null;
  /**
   * Conversation the turn ran in. Lets the scheduled-run context be consumed by
   * scope instead of by "the one global pending run" (M2 F5/F12): a turn in
   * another conversation must not settle a scheduled run it never ran.
   */
  conversationId?: string | null;
  /** Model handle the turn actually used, when known. */
  model: string | null;
}

/**
 * How the turn ended, in the vocabulary the scheduled runner waits on.
 *
 * `cancelled` is the only one the TUI names today; the other two exist so a
 * caller that knows better can say so, and so a scheduled run never has to fall
 * back to the runner's timeout to learn that its turn failed.
 */
export type TurnEndOutcome = "completed" | "failed" | "cancelled" | "timeout";

export interface TurnUsageOptions {
  cancelled?: boolean;
  /** Overrides the outcome derived from `cancelled`. */
  outcome?: TurnEndOutcome;
}

/** Append one ledger record for the turn that just ended. */
export function appendTurnUsageRecord(
  snapshot: TrajectoryStatsSnapshot,
  identity: TurnUsageIdentity,
  options: TurnUsageOptions = {},
): Promise<boolean> {
  const usage = snapshot.usage;
  // F-05: a turn the scheduler started carries its own `runId` from the queue
  // hand-off; reading and clearing the context here is what tags the row and
  // keeps the next interactive turn from inheriting the tag. The outcome rides
  // the same call: consuming is also the scheduled runner's terminal signal, so
  // a turn that failed must not be reported as `completed`.
  const turnOutcome =
    options.outcome ?? (options.cancelled ? "cancelled" : "completed");
  // The conversation is passed so a context owned by another conversation is
  // not consumed (F5): the consumer returns null then, and this turn is simply
  // an interactive one. (`as` keeps this compatible with the scoped consumer
  // while WS-C lands it; the optional `conversationId`/`outcome` fields below are
  // used when present.)
  const scheduled = consumeScheduledRunContext({
    outcome: turnOutcome,
    ...(identity.conversationId
      ? { conversationId: identity.conversationId }
      : {}),
  }) as (ScheduledRunContext & { outcome?: ScheduledRunTurnOutcome }) | null;
  const record = buildUsageRecord({
    agentId: identity.agentId ?? "unknown",
    model: identity.model ?? "unknown",
    prompt: usage.promptTokens,
    cachedInput: usage.cachedInputTokens,
    cacheWrite: usage.cacheWriteTokens,
    completion: usage.completionTokens,
    reasoning: usage.reasoningTokens,
    steps: snapshot.usageSteps,
    wallMs: snapshot.wallMs,
    apiMs: snapshot.apiMs,
    contextTokens: usage.contextTokens,
    contextBreakdown: snapshot.contextBreakdown,
    cost: snapshot.cost,
    // F-03 §5.16.2: a turn the user drove is tagged as such, so the Usage page
    // can keep automated spend apart from it. Old rows have no source and read
    // as this same value (ledger §5.16.3). `command` tasks are scheduled too,
    // and the ledger's enum has one bucket for both (Lead's ruling).
    source: scheduled ? "cron" : "interactive",
    ...(scheduled
      ? {
          runId: scheduled.runId,
          // F12: a scheduled row must carry the outcome the runner waited on,
          // or the Usage page cannot tell a failed run from a successful one.
          outcome: scheduled.outcome ?? turnOutcome,
        }
      : {}),
    ...(identity.conversationId ? { sessionId: identity.conversationId } : {}),
    ...(options.cancelled ? { cancelled: true } : {}),
  });
  return appendUsageRecord(record);
}

/**
 * End the turn's trajectory and record it, in that order and once.
 *
 * Both call sites (a completed turn, a cancelled one) need the same three
 * steps: end the accumulator, write the ledger line, hand the snapshot back for
 * whatever the caller still shows. Keeping it here is what stops the two paths
 * from drifting in the details that matter (a cancelled turn must **end** the
 * trajectory, not just read it, or its tokens land in the next turn's record).
 */
export function finishTurnTrajectory(
  stats: SessionStats,
  identity: TurnUsageIdentity,
  options: TurnUsageOptions = {},
): { snapshot: TrajectoryStatsSnapshot | null; wallMs: number } {
  const snapshot = stats.endTrajectory();
  if (snapshot) {
    void appendTurnUsageRecord(snapshot, identity, options);
  }
  return { snapshot, wallMs: snapshot?.wallMs ?? 0 };
}
