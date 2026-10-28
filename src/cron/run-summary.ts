/**
 * Startup summary (F-05, R-5.11.2/R-5.11.3).
 *
 * "While you were away the scheduler ran N tasks" — built from the run log, not
 * from a second ledger, and shown once (a seen marker is persisted).
 *
 * M0 freeze: the names below are part of the frozen barrel. M1/M3 fill the body.
 */

import type { RunOutcome } from "./cron-types";

export interface RunSummaryEntry {
  runId: string;
  taskId: string;
  taskName: string;
  outcome: RunOutcome;
  startedAt: string;
  finishedAt: string;
  conversationId?: string;
}

/** M1/M3 replace the body. */
export function appendRunSummaryEntry(_entry: RunSummaryEntry): void {
  throw new Error("appendRunSummaryEntry is not implemented yet (F-05 M1).");
}

/** M1/M3 replace the body. */
export function readPendingRunSummary(): RunSummaryEntry[] {
  throw new Error("readPendingRunSummary is not implemented yet (F-05 M1).");
}

/** M1/M3 replace the body. Called once the TUI has rendered the summary. */
export function markRunSummarySeen(): void {
  throw new Error("markRunSummarySeen is not implemented yet (F-05 M1).");
}
