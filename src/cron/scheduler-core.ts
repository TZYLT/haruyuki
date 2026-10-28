/**
 * Scheduler core (F-05, M1).
 *
 * The one place that turns "signals say these occurrences are due" into at most
 * one started run: de-dup by occurrence, take the task lease, dispatch to the
 * host's `TaskRunnerPort`, record the result, release, classify failures, and
 * queue the rest for later ticks.
 *
 * M0 freeze: the entry point name and input shape are part of the frozen
 * barrel. M1 fills the body; adding exports is fine, renaming is not.
 */

import type { ScheduleTaskV2, TaskRunnerPort } from "./cron-types";

export interface SchedulerTickInput {
  now: Date;
  /** Which host is ticking — it decides the lease's `host` field. */
  runner: TaskRunnerPort;
}

export interface SchedulerTickResult {
  /** The task this tick started, or null when nothing was due. */
  started: ScheduleTaskV2 | null;
  /** Occurrences that were due but left for the following ticks (Q-42). */
  deferred: number;
}

/** M1 replaces the body. */
export async function runSchedulerTick(
  _input: SchedulerTickInput,
): Promise<SchedulerTickResult> {
  throw new Error("runSchedulerTick is not implemented yet (F-05 M1).");
}
