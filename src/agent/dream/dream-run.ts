/**
 * Dream run controller seam (F-06 M2, route §2.3.5 S1).
 *
 * The short-lived `haruyuki dream run --task <id>` host (T1) resolves the task,
 * takes the dream lock, and hands the whole lifecycle — memory lock, baseline,
 * hidden session, child spawn, budget, finishing, release — to this function.
 * Keeping the controller in `agent/dream` means the CLI host stays thin wiring.
 *
 * L0 stub: the body throws on purpose, so a dream run cannot silently pretend
 * to have succeeded before M2 lands. M2 replaces the body; the signature is
 * frozen and only the Lead may change it.
 */

import type { RunOutcome, ScheduleTaskV2 } from "@/cron/cron-types";

export interface DreamRunTaskInput {
  /** The persisted task, already resolved from `--task <id>`. */
  task: ScheduleTaskV2;
  runId: string;
  /** Claimed scheduled occurrence; empty string for a manual run. */
  occurrence: string;
  signal: AbortSignal;
}

export interface DreamRunTaskResult {
  outcome: RunOutcome;
  error?: string;
}

export async function runDreamTask(
  _input: DreamRunTaskInput,
): Promise<DreamRunTaskResult> {
  throw new Error("dream run controller not implemented yet (F-06 M2)");
}
