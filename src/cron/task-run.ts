/**
 * Single-run orchestration (F-05, M2).
 *
 * Waits for a busy target conversation, enforces the timeout, maps interrupts
 * onto `RunOutcome`, and installs the unattended-approval port (every `ask` is
 * denied, Q-51). The host supplies the effectful parts through
 * `TaskRunnerPort`; this module supplies the policy.
 *
 * M0 freeze: the names below are part of the frozen barrel. M2 fills the body.
 */

import type { ScheduleTaskV2 } from "./cron-types";

/**
 * Commands a scheduled task may run. Fixed by Q-17: only commands that finish
 * without a human at the keyboard, whose arguments pass through verbatim.
 */
export const TASK_COMMAND_WHITELIST: ReadonlySet<string> = new Set([
  "compact",
  "reflect",
]);

/** `compact` is allowed without an explicit selection (F-04 default policy). */
export function isAllowedScheduledCommand(_command: string): boolean {
  throw new Error(
    "isAllowedScheduledCommand is not implemented yet (F-05 M2).",
  );
}

export interface ScheduledTaskRunResult {
  outcome: "success" | "failed" | "skipped" | "timeout" | "cancelled";
  conversationId?: string;
  error?: string;
}

/** M2 replaces the body. */
export async function runScheduledTask(_input: {
  task: ScheduleTaskV2;
  runId: string;
  signal: AbortSignal;
}): Promise<ScheduledTaskRunResult> {
  throw new Error("runScheduledTask is not implemented yet (F-05 M2).");
}
