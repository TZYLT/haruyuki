/**
 * The tail every `/compact` surface runs after a *successful* compaction.
 *
 * The TUI and the websocket listener each own their own reflection wiring and
 * their own description regeneration, so those arrive as callbacks. What is shared
 * is the ordering and the failure rule: the reminder state has to know the context
 * changed before the next turn is built, a reflection is best-effort, and a
 * failure in any of it must never be reported as a failed compaction — the trim
 * already happened.
 *
 * F-03: a manual compaction is its own reflection trigger. The two `/compact`
 * surfaces consume the pending flag with {@link consumePendingCompactionTrigger}
 * and launch from there; the post-turn check must not launch a second time for
 * the same compaction.
 */

import type { ContextTracker } from "@/cli/helpers/context-tracker";
import type { SharedReminderState } from "@/reminders/state";
import { markPostCompactionContextRemindersPending } from "@/reminders/state";
import { debugLog } from "@/utils/debug";

export interface PostCompactionTailInput {
  reminderState: SharedReminderState;
  /**
   * Compaction-event reflection. Called inside the guard, so it may both decide
   * (reading the agent's settings) and launch; it must not throw for a reason it
   * can check itself, and it must not return a promise that rejects unhandled.
   */
  reflect: () => void;
  /** Refresh the conversation description / search metadata. */
  regenerateDescription: () => void;
}

/**
 * Drop the pending compaction flag so the turn-end check cannot launch a second
 * reflection for a compaction a `/compact` surface already handled.
 *
 * Both holders of the flag are cleared: the reminder state is the one the
 * trigger and the reminder engine read, and the context tracker is the one the
 * accumulator sets when it sees the compaction in the stream. Returns whether
 * either was set, for logging only. This is idempotent.
 */
export function consumePendingCompactionTrigger(input: {
  reminderState: SharedReminderState;
  contextTracker: Pick<ContextTracker, "pendingReflectionTrigger">;
}): boolean {
  const wasPending =
    input.reminderState.pendingReflectionTrigger ||
    input.contextTracker.pendingReflectionTrigger;
  input.reminderState.pendingReflectionTrigger = false;
  input.contextTracker.pendingReflectionTrigger = false;
  return wasPending;
}

/**
 * Mark the post-compaction reminders pending, run the optional reflection, then
 * refresh the description. Read the ordering as the contract: a surface that
 * regenerates the description before marking the reminders has them land in the
 * wrong turn.
 */
export function runPostCompactionTail(input: PostCompactionTailInput): void {
  markPostCompactionContextRemindersPending(input.reminderState);
  try {
    input.reflect();
  } catch (error) {
    debugLog(
      "memory",
      "Skipping post-compaction reflection:",
      error instanceof Error ? error.message : String(error),
    );
  }
  input.regenerateDescription();
}
