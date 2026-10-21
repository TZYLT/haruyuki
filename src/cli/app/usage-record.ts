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

import type { TrajectoryStatsSnapshot } from "@/agent/stats";
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
    cost: snapshot.cost,
  });
  return appendUsageRecord(record);
}
