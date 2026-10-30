/**
 * Dream report writer (F-06 M3, route §2.3.5 S4).
 *
 * The agent writes the body; the harness adds the v2 frontmatter, makes sure
 * the report directory has a `MEMORY.md`, and commits the report on its own so
 * a non-compliant body cannot take the run's other memory writes down with it
 * (route C-22, Q-54).
 *
 * L0 stub: returns "nothing to commit" so the run controller's finishing step
 * works before M3 lands. T3 replaces the body; the signature is frozen and
 * only the Lead may change it.
 *
 * Owner: T3 (M3). The file lives under `agent/dream/` because the run
 * controller calls it at finishing time, but it is carved out of T2's scope.
 */

import type { DreamRunMetadata } from "@/types/dream-run-metadata";

export interface DreamReportInput {
  agentId: string;
  conversationId: string;
  /** The run record at finishing time (handoff, tiers, budget, status). */
  metadata: DreamRunMetadata;
  /** Body the agent produced, when it produced one. */
  body?: string;
}

export interface DreamReportResult {
  /** Repo-relative path of the committed report, or `null` when none was written. */
  reportPath: string | null;
  committed: boolean;
}

export async function writeDreamReport(
  _input: DreamReportInput,
): Promise<DreamReportResult> {
  // Filled in by M3 (T3).
  return { reportPath: null, committed: false };
}
