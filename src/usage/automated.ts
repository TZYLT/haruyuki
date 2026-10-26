/**
 * Ledger writer for automated (non-interactive) model spend — reflection now,
 * scheduled runs and dreaming later (F-03 §5.16).
 *
 * The interactive path keeps its own writer; this module exists so a child
 * process that spent tokens on someone else's behalf can record one row tagged
 * with its source, outcome and the two session ids (the requirement's privacy
 * contract change: ids yes, message text never).
 *
 * M0 ships the seam only: the call is accepted and reports `false` (nothing
 * written). The ledger work item adds the row mapping, the shared append lock
 * with `rewriteUsageLedger`, the 60s bounded wait and the debug log on drop.
 */
import { debugLog } from "@/utils/debug";
import type { UsageCost } from "@/utils/usage-cost";

/** Where the spend came from. `interactive` is deliberately absent. */
export type AutomatedUsageSource =
  | "reflection"
  | "dream"
  | "cron"
  | "subagent"
  | "other";

export type AutomatedUsageOutcome =
  | "completed"
  | "timeout"
  | "failed"
  | "cancelled";

/** Token counters exactly as the child's own turn reports them. */
export interface AutomatedUsageTokens {
  prompt: number;
  cachedInput: number;
  cacheWrite: number;
  completion: number;
  reasoning: number;
  steps: number;
}

export interface AutomatedUsageInput {
  source: AutomatedUsageSource;
  /** The requirement records failures too: money spent is money spent. */
  outcome: AutomatedUsageOutcome;
  /** Stable id of one automated run (reflection uses the fork run id). */
  runId?: string;
  /** Conversation the spend happened in. */
  sessionId: string;
  /** Source conversation when this run was a fork of another one. */
  parentSessionId?: string;
  agentId: string;
  /** `"unknown"` when the model cannot be resolved; never omitted silently. */
  model: string;
  usage: AutomatedUsageTokens;
  wallMs: number;
  apiMs: number;
  cost?: UsageCost;
  contextTokens?: number;
}

/**
 * Append one automated usage row. Returns `true` when a row was written and
 * `false` when the record was dropped (lock timeout or an unusable input);
 * a drop never fails the run that produced it.
 */
export async function recordAutomatedUsage(
  input: AutomatedUsageInput,
): Promise<boolean> {
  // A dropped row is an allowed outcome (the requirement forbids a ledger write
  // from breaking a turn), so M0 reports the drop instead of throwing — but it
  // logs, because a silently-missing row is the failure mode that hid spending.
  debugLog(
    "usage",
    `automated usage not recorded yet (M1i): source=${input.source} outcome=${input.outcome} run=${input.runId ?? "-"}`,
  );
  return false;
}
