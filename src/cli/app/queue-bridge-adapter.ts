/**
 * The React side of the message-queue bridge (extracted from `AppCoordinator`).
 *
 * `AppCoordinator.tsx` is a pinned size-ratchet file; the queue-bridge effect and
 * its queued-message → `QueueItem` mapping lived inline there and grew when the
 * scheduled-run permission had to ride the hand-off (F-05 P1-1/P1-2). Moving the
 * exact same wiring here keeps the coordinator at one hook call.
 */

import { type MutableRefObject, useEffect, useRef } from "react";
import type { QueueRuntime } from "@/queue/queue-runtime";
import {
  type QueuedMessage,
  setMessageQueueAdder,
} from "@/utils/message-queue-bridge";
import type { ScheduledTurnQueue } from "./scheduled-turn-permission";

/** The parent scope a bridge message carries (P1-2: it must not be dropped). */
function scopeOf(message: QueuedMessage): {
  agentId?: string;
  conversationId?: string;
} {
  return {
    ...(message.agentId ? { agentId: message.agentId } : {}),
    ...(message.conversationId
      ? { conversationId: message.conversationId }
      : {}),
  };
}

/**
 * Convert one bridge message into a `QueueRuntime` item.
 *
 * Kept separate from the hook so the mapping is testable without React. The
 * `agentId`/`conversationId` scope survives (P1-2/F2) and only a `cron`-sourced
 * message can be the scheduled turn the queue hand-off tags.
 */
export function enqueueBridgeMessage(
  runtime: QueueRuntime,
  message: QueuedMessage,
): ReturnType<QueueRuntime["enqueue"]> {
  return runtime.enqueue(
    message.kind === "task_notification"
      ? ({
          kind: "task_notification",
          source: "task_notification",
          text: message.text,
          content: message.content,
          ...scopeOf(message),
        } as Parameters<QueueRuntime["enqueue"]>[0])
      : ({
          kind: "message",
          source: message.source ?? "user",
          content: message.text,
          ...scopeOf(message),
        } as Parameters<QueueRuntime["enqueue"]>[0]),
  );
}

export interface TuiMessageQueueBridgeInput {
  /** The TUI queue runtime; read at callback time (it is created lazily). */
  tuiQueueRef: MutableRefObject<QueueRuntime | null>;
  /** Forces the dequeue effect to re-run after every enqueue. */
  bumpDequeueEpoch: () => void;
  /** Takes the task-tier permission a scheduled prompt registered (P1-1). */
  scheduledTurnQueue: ScheduledTurnQueue;
}

/**
 * Mount the bridge for the lifetime of the app.
 *
 * One effect, no deps: the callbacks are read through a ref, so a new
 * `setDequeueEpoch` identity can never re-install the adder and drop messages
 * enqueued in between.
 */
export function useTuiMessageQueueBridge(
  input: TuiMessageQueueBridgeInput,
): void {
  const inputRef = useRef(input);
  inputRef.current = input;
  useEffect(() => {
    setMessageQueueAdder((message: QueuedMessage) => {
      const { tuiQueueRef, bumpDequeueEpoch, scheduledTurnQueue } =
        inputRef.current;
      const runtime = tuiQueueRef.current;
      if (!runtime) {
        bumpDequeueEpoch();
        return;
      }
      const item = enqueueBridgeMessage(runtime, message);
      // Take the permission while the runner's context is still current
      // (`schedule-prompt` sets it before enqueueing); key it by queue item id.
      scheduledTurnQueue.noteEnqueued(message, item?.id ?? null);
      bumpDequeueEpoch();
    });
    return () => setMessageQueueAdder(null);
  }, []);
}
