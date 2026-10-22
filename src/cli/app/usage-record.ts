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

export interface TurnUsageIdentity {
  agentId: string | null;
  /** Model handle the turn actually used, when known. */
  model: string | null;
}

/** Append one ledger record for the turn that just ended. */
export function appendTurnUsageRecord(
  snapshot: TrajectoryStatsSnapshot,
  identity: TurnUsageIdentity,
  options: { cancelled?: boolean } = {},
): Promise<boolean> {
  const usage = snapshot.usage;
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
  options: { cancelled?: boolean } = {},
): { snapshot: TrajectoryStatsSnapshot | null; wallMs: number } {
  const snapshot = stats.endTrajectory();
  if (snapshot) {
    void appendTurnUsageRecord(snapshot, identity, options);
  }
  return { snapshot, wallMs: snapshot?.wallMs ?? 0 };
}
