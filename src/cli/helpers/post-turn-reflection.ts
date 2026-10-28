import { isReflectionRunActive } from "@/agent/reflection-run";
import type { ContextTracker } from "@/cli/helpers/context-tracker";
import {
  type ReflectionSettings,
  shouldFireUserMessageTrigger,
} from "@/cli/helpers/memory-reminder";
import {
  applyPendingReflectionUserMessages,
  consumeReflectionUserMessageTrigger,
  getReflectionTranscriptState,
  markReflectionUserMessagesReflected,
} from "@/cli/helpers/reflection-transcript";
import {
  type SharedReminderState,
  syncReminderStateFromContextTracker,
} from "@/reminders/state";

export type PostTurnReflectionTrigger = "compaction" | "user-messages";

export type PostTurnReflectionLauncher = (
  triggerSource: PostTurnReflectionTrigger,
  /**
   * The resolved run policy, so the launcher gets the per-agent timeout and the
   * fork's lifetime. The launcher no longer reads settings itself (F-03 §3.4).
   */
  reflectionSettings: Pick<
    ReflectionSettings,
    "timeoutMinutes" | "deleteSessionOnSuccess"
  >,
) => Promise<boolean>;

/**
 * Evaluate the two independent reflection switches at turn end and launch the
 * reflection subagent if one fires.
 *
 * The compaction trigger wins: when a compaction event is pending and the
 * switch is on, this turn launches for `compaction` and the message counter is
 * not consulted. Otherwise the counter fires only for a turn that **counted a
 * new user message** (the count helper arms a one-shot flag) and whose unreflected
 * count reached `everyUserMessages`. Automated turns — completion
 * task-notifications, cron prompts, approval continuations — arm nothing, so
 * they never launch a counter reflection.
 *
 * The reflected mark advances when the run *finishes*, not when it starts: a
 * staged mark becomes real once {@link isReflectionRunActive} reports the run
 * gone. That keeps "reflected" honest and stops a run's own notification turn
 * from re-reading a still-unreflected delta.
 *
 * The pending-compaction flag is cleared on **every** exit path: it describes
 * one event, and no later turn may launch a second reflection for it.
 */
export async function maybeLaunchPostTurnReflection(params: {
  agentId?: string | null;
  conversationId: string;
  memfsEnabled: boolean;
  reflectionSettings: ReflectionSettings;
  reminderState: SharedReminderState;
  contextTracker: ContextTracker;
  launch: PostTurnReflectionLauncher;
  onCompaction?: () => Promise<void>;
  getTranscriptState?: typeof getReflectionTranscriptState;
  markUserMessagesReflected?: typeof markReflectionUserMessagesReflected;
  consumeUserMessageTrigger?: typeof consumeReflectionUserMessageTrigger;
  applyPendingUserMessages?: typeof applyPendingReflectionUserMessages;
  isReflectionActive?: (agentId: string) => boolean;
}): Promise<boolean> {
  // Reminder restoration is client context maintenance, not reflection work.
  // Always consume compaction state even when MemFS or reflection is disabled.
  syncReminderStateFromContextTracker(
    params.reminderState,
    params.contextTracker,
  );

  const hadCompactionEvent = params.reminderState.pendingReflectionTrigger;
  params.reminderState.pendingReflectionTrigger = false;

  if (hadCompactionEvent) {
    await params.onCompaction?.();
  }

  if (!params.agentId || !params.memfsEnabled) {
    return false;
  }

  const readTranscriptState =
    params.getTranscriptState ?? getReflectionTranscriptState;
  const isReflectionActive = params.isReflectionActive ?? isReflectionRunActive;
  const runSettings = {
    timeoutMinutes: params.reflectionSettings.timeoutMinutes,
    deleteSessionOnSuccess: params.reflectionSettings.deleteSessionOnSuccess,
  };

  // Finish a previous launch before deciding anything: "reflected" means the run
  // finished, so its staged total becomes the mark as soon as the run is gone.
  const before = await readTranscriptState(
    params.agentId,
    params.conversationId,
  );
  if (
    before.pending_reflected_user_messages !== undefined &&
    !isReflectionActive(params.agentId)
  ) {
    const applyPending =
      params.applyPendingUserMessages ?? applyPendingReflectionUserMessages;
    await applyPending(params.agentId, params.conversationId);
  }

  // Only a turn that counted a user message may evaluate the counter. The flag
  // is one-shot: consuming it here is what keeps completion/notification turns
  // out of this branch entirely.
  const consumeTrigger =
    params.consumeUserMessageTrigger ?? consumeReflectionUserMessageTrigger;

  if (hadCompactionEvent && params.reflectionSettings.onCompaction) {
    // Compaction wins this turn; discard the counter arm so the run's own
    // notification turn cannot launch a second reflection for the same turn.
    await consumeTrigger(params.agentId, params.conversationId);
    return params.launch("compaction", runSettings);
  }

  if (params.reflectionSettings.everyUserMessages <= 0) {
    // The counter is off: leave no stale arm behind for a later re-enable.
    await consumeTrigger(params.agentId, params.conversationId);
    return false;
  }

  if (!(await consumeTrigger(params.agentId, params.conversationId))) {
    return false;
  }

  const transcriptState = await readTranscriptState(
    params.agentId,
    params.conversationId,
  );
  if (
    !shouldFireUserMessageTrigger(
      transcriptState.messages_since_last_successful_reflection,
      params.reflectionSettings,
    )
  ) {
    return false;
  }

  const launched = await params.launch("user-messages", runSettings);
  if (launched) {
    const markReflected =
      params.markUserMessagesReflected ?? markReflectionUserMessagesReflected;
    await markReflected(params.agentId, params.conversationId);
  }
  return launched;
}
