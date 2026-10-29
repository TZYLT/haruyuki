/**
 * Turn-level permission plumbing for scheduler-started TUI turns (F-05 P1-1/F9).
 *
 * Why this module exists: `AppCoordinator.tsx` and `use-conversation-loop.ts` are
 * both at their size-ratchet ceiling, and the P1-1 fix is new behaviour, not just
 * a call site. Keeping the state machine here leaves both pinned files with a
 * couple of calls each.
 *
 * Two halves:
 *
 * - **Queue hand-off.** The TUI queue bridge carries text, not task metadata, so
 *   the runner registers the task tier by run id (`schedule-prompt.ts`) and this
 *   keeps it keyed by queue item id. When the dequeue submits a turn it *arms*
 *   the merged permission; `bindScheduledTurnPermission` hands it to
 *   `processConversation` as a turn-level option.
 * - **Turn execution.** The loop builds a context that pins the task tier for the
 *   turn, hands the approval classifier a state built from it, and restores the
 *   user's mode with compare-and-restore (never clobbering a mid-run change).
 */

import { type MutableRefObject, useRef } from "react";
import {
  assertScheduledTurnPermission,
  mergeTuiTurnPermissions,
  type TuiScheduledTurnPermission,
  takeTuiTurnPermission,
} from "@/cli/helpers/schedule-prompt";
import { type PermissionMode, permissionMode } from "@/permissions/mode";
import type { PermissionModeState } from "@/tools/permission-mode-state";
import { peekScheduledRunContext } from "@/usage/scheduled-run-context";
import type { QueuedMessage } from "@/utils/message-queue-bridge";
import type { ProcessConversation, ProcessConversationOptions } from "./types";

/**
 * `ProcessConversationOptions` plus the scheduler turn state.
 *
 * The base type lives in a pinned types module; this narrows the one extra field
 * the loop reads, and the coordinator's wrapper is what writes it.
 */
export type ScheduledConversationOptions = ProcessConversationOptions & {
  scheduledTurnPermission?: TuiScheduledTurnPermission;
};

// ── Queue hand-off ──────────────────────────────────────────────────

export interface ScheduledTurnQueue {
  /**
   * Attach the permission the runner registered to the item just enqueued.
   *
   * Called from the queue-bridge adder while the run's context is current, so
   * only a `cron`-sourced message can pick one up.
   */
  noteEnqueued(message: QueuedMessage, queueItemId: string | null): void;
  /** Merge the permissions of the items just dequeued into the armed turn. */
  armForBatch(items: readonly { id: string }[]): void;
  /** Consume the armed permission (one turn). */
  takeArmed(): TuiScheduledTurnPermission | null;
  /** Drop it so a submission that never ran cannot lend it to a later turn. */
  clearArmed(): void;
}

export function createScheduledTurnQueue(): ScheduledTurnQueue {
  const byItemId = new Map<string, TuiScheduledTurnPermission>();
  let armed: TuiScheduledTurnPermission | null = null;
  return {
    noteEnqueued(message, queueItemId) {
      if (message.source !== "cron" || !queueItemId) return;
      const runId = peekScheduledRunContext()?.runId;
      if (!runId) return;
      const permission = takeTuiTurnPermission(runId);
      if (permission) byItemId.set(queueItemId, permission);
    },
    armForBatch(items) {
      const permissions: TuiScheduledTurnPermission[] = [];
      for (const item of items) {
        const permission = byItemId.get(item.id);
        if (!permission) continue;
        permissions.push(permission);
        byItemId.delete(item.id);
      }
      armed = mergeTuiTurnPermissions(permissions);
    },
    takeArmed() {
      const permission = armed;
      armed = null;
      return permission;
    },
    clearArmed() {
      armed = null;
    },
  };
}

/**
 * The coordinator's one queue for scheduled-turn permissions (stable per mount).
 *
 * A ref, not state: enqueueing a scheduled prompt must not repaint the TUI.
 */
export function useScheduledTurnQueue(): ScheduledTurnQueue {
  const queueRef = useRef<ScheduledTurnQueue | null>(null);
  queueRef.current ??= createScheduledTurnQueue();
  return queueRef.current;
}

/**
 * Bind the armed task tier into one `processConversation` call.
 *
 * The pinned loop only sees `ProcessConversation`, so this is the seam that
 * carries the turn-level state across without touching the session mode.
 */
export function bindScheduledTurnPermission(
  processConversation: ProcessConversation,
  queue: ScheduledTurnQueue,
): ProcessConversation {
  return (input, options) => {
    const permission = queue.takeArmed();
    if (!permission) return processConversation(input, options);
    // `ProcessConversationOptions` is the pinned type; the extra field is the
    // loop's `ScheduledConversationOptions` narrowing of the same value.
    const scheduledOptions = {
      ...(options ?? {}),
      scheduledTurnPermission: permission,
    } as ProcessConversationOptions;
    return processConversation(input, scheduledOptions);
  };
}

// ── Turn execution ──────────────────────────────────────────────────

export interface ScheduledTurnPermissionContext {
  /** True when this turn is scheduler-started (it has a task tier). */
  readonly scheduled: boolean;
  /** The mode a retry must reassert: the task tier, or the user's selection. */
  readonly pinnedMode: PermissionMode;
  /** Reassert the pinned mode after a transient retry. */
  restorePinnedMode(): void;
  /** The mode the approval classifier should classify under. */
  readonly desiredMode: PermissionMode;
  /** The classifier's state, built from the task tier; checked once at creation. */
  classifierState(): PermissionModeState | undefined;
  /** After the turn: return the global mode to the user's, compare-and-restore. */
  restoreAfterTurn(): void;
}

export function createScheduledTurnPermissionContext(
  permission: TuiScheduledTurnPermission | undefined,
  uiModeRef: MutableRefObject<PermissionMode>,
  setUiMode: (mode: PermissionMode) => void,
): ScheduledTurnPermissionContext {
  const pinnedMode = permission?.mode ?? uiModeRef.current;
  const classifierState: PermissionModeState | undefined = permission
    ? { mode: permission.mode, unattended: permission.unattended }
    : undefined;
  // Fail closed before any approval is classified: a scheduled turn that lost
  // its task tier is the P1-1 escalation itself.
  if (permission) assertScheduledTurnPermission(classifierState, permission);

  return {
    scheduled: Boolean(permission),
    pinnedMode,
    restorePinnedMode() {
      if (permission) {
        // The UI's selection is the user's; a scheduled turn never writes it.
        if (permissionMode.getMode() !== permission.mode) {
          permissionMode.setMode(permission.mode);
        }
        return;
      }
      if (permissionMode.getMode() !== pinnedMode) {
        permissionMode.setMode(pinnedMode);
      }
      if (uiModeRef.current !== pinnedMode) {
        setUiMode(pinnedMode);
      }
    },
    get desiredMode() {
      return permission?.mode ?? uiModeRef.current;
    },
    classifierState: () => classifierState,
    restoreAfterTurn() {
      if (!permission) return;
      // Compare-and-restore (M2 F9): only while the global mode still is the
      // task tier. If anything changed it during the turn, that decision wins.
      if (
        permissionMode.getMode() === permission.mode &&
        uiModeRef.current !== permission.mode
      ) {
        permissionMode.setMode(uiModeRef.current);
      }
    },
  };
}
