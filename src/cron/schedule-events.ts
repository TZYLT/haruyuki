/**
 * Process-local schedule events (F-05).
 *
 * The scheduler core is the only producer; the TUI subscribes to turn a finished
 * run into a `task_notification` (R-5.11.1). The bus is deliberately
 * process-local: a run hosted by the WS listener cannot reach a TUI in another
 * process, so cross-process visibility stays on the run log plus the startup
 * summary (R-5.11.2), which reads the same log.
 *
 * Listener exceptions are swallowed on purpose — a TUI bug must not fail a
 * scheduled run after its lease was taken.
 */

import { debugWarn } from "@/utils/debug";
import type { RunOutcome } from "./cron-types";

export type ScheduleEventKind =
  | "run-started"
  | "run-finished"
  | "task-paused"
  | "task-missed";

export interface ScheduleEvent {
  kind: ScheduleEventKind;
  /** ISO timestamp of the transition. */
  at: string;
  taskId: string;
  taskName: string;
  agentId: string;
  runId?: string;
  /** Signal occurrence that produced this run, when there is one. */
  occurrence?: string;
  outcome?: RunOutcome;
  conversationId?: string | null;
  error?: string | null;
  durationMs?: number;
  pausedReason?: "manual" | "auto_failures";
  missedCount?: number;
}

export type ScheduleEventListener = (event: ScheduleEvent) => void;

const listeners = new Set<ScheduleEventListener>();

/**
 * Subscribe to schedule events. Returns an unsubscribe function; calling it more
 * than once is safe.
 */
export function subscribeScheduleEvents(
  listener: ScheduleEventListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Publish one event to every current subscriber.
 *
 * A throwing listener is logged and skipped: the scheduler has already taken the
 * task lease by the time it emits, so an exception here would leave the lease to
 * expire instead of reporting the run.
 */
export function emitScheduleEvent(event: ScheduleEvent): void {
  for (const listener of Array.from(listeners)) {
    try {
      listener(event);
    } catch (err) {
      debugWarn(
        "cron",
        `schedule event listener failed for ${event.kind} ${event.taskId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

/** Drop every subscriber. Tests and process teardown use this; nothing else. */
export function clearScheduleEventSubscribers(): void {
  listeners.clear();
}

/** Number of current subscribers. Diagnostics and tests only. */
export function scheduleEventSubscriberCount(): number {
  return listeners.size;
}
