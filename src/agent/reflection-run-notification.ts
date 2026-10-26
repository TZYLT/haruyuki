/**
 * The user-facing text for one finished reflection run (F-03 §5.11.2).
 *
 * The run controller owns *when* a run finished; each surface owns *where* the
 * notification goes (TUI transcript notification, headless queue/item, listener
 * protocol delta). This module owns the *words*, so the three surfaces cannot
 * drift into three different descriptions of the same outcome. It is pure: no
 * backend reads, no reminder state, no formatting of anything the caller has to
 * fetch.
 */
import type { ReflectionRunFinishedEvent } from "@/agent/reflection-run";

function durationLabel(durationMs: number): string {
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

function backupLabel(event: ReflectionRunFinishedEvent): string {
  const coordinates = [
    event.backupPatch ? `patch ${event.backupPatch}` : null,
    event.backupRef ? `ref ${event.backupRef}` : null,
  ].filter((value): value is string => value !== null);
  return coordinates.length > 0
    ? `Uncommitted memory changes were backed up (${coordinates.join(", ")}) and then discarded;`
    : "Uncommitted memory changes were discarded;";
}

/**
 * One line (plus, for a timeout, one sentence of advice) per outcome. Kept as a
 * plain paragraph: the listener wraps it in `task-notification` XML, the TUI and
 * headless show it verbatim.
 */
export function formatReflectionRunFinishedNotification(
  event: ReflectionRunFinishedEvent,
): string {
  const run = `run ${event.runId}, ${durationLabel(event.durationMs)}`;
  switch (event.status) {
    case "succeeded":
      return `Reflection finished: this agent's memory was updated (${run}).`;
    case "timeout":
      return `Reflection timed out and was stopped (${run}). ${backupLabel(event)} committed memory changes were kept. If reflection keeps hitting its limit, raise reflectionTimeoutMinutes.`;
    case "failed":
      return `Reflection failed (${run}). Uncommitted memory work may still be in the repository; check it before editing memory, and see /maintenance sessions for the fork.`;
    case "cancelled":
      return `Reflection was cancelled (${run}). Uncommitted memory work may still be in the repository; check it before editing memory.`;
    default:
      return `Reflection ended (${event.status}; ${run}).`;
  }
}
