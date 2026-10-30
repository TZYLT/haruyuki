/**
 * Clear a stale `/dream run --budget` override (F-06 M2 review fix).
 *
 * A manual run carries its one-run budget override in the task payload. The
 * T1 host restores the previous payload after the run, but a crash can leave the
 * override on the record; every later automatic run would then inherit a budget
 * the user only asked for once. Crash recovery clears it while it repairs the
 * run's lease, and this module is the one place that knows the payload codec.
 *
 * Kept out of `dream-run-wiring.ts` so the schedule-store touch is testable on
 * its own and the wiring file stays about the run's side effects.
 */

import {
  getScheduleTask,
  parseDreamTaskPayload,
  serializeDreamTaskPayload,
  updateScheduleTask,
} from "@/cron";

/**
 * Rewrite a dream task's payload to the plain default (`{version:1}`).
 *
 * Returns `true` only when an override was actually present and removed:
 * a missing task, a non-dream task, a malformed payload, or a payload without an
 * override all mean "nothing to clean", and recovery should not report work.
 */
export function clearDreamBudgetOverride(taskId: string): boolean {
  const task = getScheduleTask(taskId);
  if (!task || task.type !== "dream") return false;
  const payload = parseDreamTaskPayload(task.payload);
  if (!payload || payload.budgetOverrideTokens === undefined) return false;
  const updated = updateScheduleTask(taskId, (view) => {
    view.payload = serializeDreamTaskPayload({ version: 1 });
  });
  return updated !== null;
}
