import type { UsageOutcome } from "@/usage/ledger";
import type { UsageCost } from "@/utils/usage-cost";

/**
 * Read-only usage aggregation for app-server clients (M5-A).
 *
 * F-06 §5.2 gives the hidden-session groups a cost column; the TUI reads the
 * ledger directly, a desktop cannot. This command exposes the same numbers
 * without a write path: the listener only reads `usage/ledger`.
 */

/** One aggregate bucket, mirroring `UsageTotals` on the ledger. */
export interface UsageAggregateTotals {
  /** Ledger rows folded in; `0` means "no row", so a client renders `—`. */
  turns: number;
  prompt: number;
  cachedInput: number;
  cacheWrite: number;
  completion: number;
  reasoning: number;
  steps: number;
  wallMs: number;
  apiMs: number;
  cost: UsageCost;
}

/** One run's slice, keyed by the ledger's `runId`. */
export interface UsageAggregateRun {
  runId: string;
  totals: UsageAggregateTotals;
  /** Distinct outcomes recorded for the run; empty when it has no row. */
  outcomes: UsageOutcome[];
}

export interface UsageAggregateCommand {
  type: "usage_aggregate";
  request_id: string;
  /** Required: usage is always read inside one agent's ledger. */
  agent_id: string;
  /** Optional narrowing; `run_id` wins when both are present. */
  run_id?: string;
  session_id?: string;
  /** Inclusive ISO time bounds; omitted = the ledger's own retention window. */
  from?: string;
  to?: string;
}
export interface UsageAggregateResponseMessage {
  type: "usage_aggregate_response";
  request_id: string;
  success: boolean;
  /** Totals over every row that matched the filters (not just `runs`). */
  totals: UsageAggregateTotals;
  /** Per-run buckets; empty when no filter names runs. */
  runs: UsageAggregateRun[];
  error?: string;
}
