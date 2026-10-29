import { afterEach, describe, expect, test } from "bun:test";
import {
  __testResetTuiTurnPermissions,
  registerTuiTurnPermission,
  type TuiScheduledTurnPermission,
} from "@/cli/helpers/schedule-prompt";
import { type PermissionMode, permissionMode } from "@/permissions/mode";
import {
  __testResetScheduledRunContext,
  setScheduledRunContext,
} from "@/usage/scheduled-run-context";
import {
  bindScheduledTurnPermission,
  createScheduledTurnPermissionContext,
  createScheduledTurnQueue,
} from "./scheduled-turn-permission";
import type { ProcessConversation } from "./types";

/**
 * The P1-1 plumbing: a scheduled run's task tier travels queue item → turn →
 * approval classifier, and never through the session's permission mode.
 */

const STANDARD: TuiScheduledTurnPermission = {
  mode: "standard",
  unattended: true,
  taskId: "task-1",
  runId: "run-1",
};

afterEach(() => {
  __testResetTuiTurnPermissions();
  __testResetScheduledRunContext();
  permissionMode.reset();
});

describe("the queue hand-off", () => {
  test("a cron message picks up the permission its runner registered", () => {
    registerTuiTurnPermission(STANDARD);
    setScheduledRunContext({
      runId: "run-1",
      taskId: "task-1",
      source: "cron",
      conversationId: "conv-1",
    });

    const queue = createScheduledTurnQueue();
    queue.noteEnqueued(
      {
        kind: "user",
        text: "scheduled prompt",
        source: "cron",
        agentId: "agent-1",
        conversationId: "conv-1",
      },
      "item-1",
    );
    // A user message in the same queue never inherits it.
    queue.noteEnqueued({ kind: "user", text: "hi" }, "item-2");

    queue.armForBatch([{ id: "item-1" }, { id: "item-2" }]);
    expect(queue.takeArmed()).toMatchObject({
      mode: "standard",
      unattended: true,
      runId: "run-1",
    });
    // One turn only.
    expect(queue.takeArmed()).toBeNull();
  });

  test("a cleared arm never reaches a later turn", () => {
    registerTuiTurnPermission(STANDARD);
    setScheduledRunContext({
      runId: "run-1",
      taskId: "task-1",
      source: "cron",
      conversationId: "conv-1",
    });
    const queue = createScheduledTurnQueue();
    queue.noteEnqueued(
      { kind: "user", text: "p", source: "cron", conversationId: "conv-1" },
      "item-1",
    );
    queue.armForBatch([{ id: "item-1" }]);
    queue.clearArmed();
    expect(queue.takeArmed()).toBeNull();
  });

  test("the bound wrapper injects the tier into exactly one processConversation call", async () => {
    registerTuiTurnPermission(STANDARD);
    setScheduledRunContext({
      runId: "run-1",
      taskId: "task-1",
      source: "cron",
      conversationId: "conv-1",
    });
    const queue = createScheduledTurnQueue();
    queue.noteEnqueued(
      { kind: "user", text: "p", source: "cron", conversationId: "conv-1" },
      "item-1",
    );
    queue.armForBatch([{ id: "item-1" }]);

    const seen: Array<Record<string, unknown> | undefined> = [];
    const raw: ProcessConversation = async (_input, options) => {
      seen.push(options as Record<string, unknown> | undefined);
    };
    const bound = bindScheduledTurnPermission(raw, queue);

    await bound([]);
    await bound([]);

    expect(seen[0]).toMatchObject({
      scheduledTurnPermission: { mode: "standard", unattended: true },
    });
    // The second, user-driven call is untouched.
    expect(seen[1]).toBeUndefined();
  });
});

describe("turn execution", () => {
  function createContext(
    permission: TuiScheduledTurnPermission | undefined,
    uiMode: PermissionMode,
  ) {
    const uiModeRef = { current: uiMode };
    const setUiModeCalls: PermissionMode[] = [];
    const context = createScheduledTurnPermissionContext(
      permission,
      uiModeRef,
      (mode) => {
        setUiModeCalls.push(mode);
        uiModeRef.current = mode;
      },
    );
    return { context, uiModeRef, setUiModeCalls };
  }

  test("a scheduled turn pins and classifies with the task tier", () => {
    permissionMode.setMode("unrestricted");
    const { context, uiModeRef, setUiModeCalls } = createContext(
      STANDARD,
      "unrestricted",
    );

    expect(context.scheduled).toBe(true);
    expect(context.pinnedMode).toBe("standard");
    expect(context.desiredMode).toBe("standard");
    expect(context.classifierState()).toEqual({
      mode: "standard",
      unattended: true,
    });
    // A retry reasserts the task tier, never the user's selection.
    permissionMode.setMode("unrestricted");
    context.restorePinnedMode();
    expect(permissionMode.getMode()).toBe("standard");
    expect(uiModeRef.current).toBe("unrestricted");
    expect(setUiModeCalls).toEqual([]);
  });

  test("after the turn the user's mode comes back (compare-and-restore)", () => {
    permissionMode.setMode("unrestricted");
    const { context } = createContext(STANDARD, "unrestricted");

    permissionMode.setMode("standard");
    context.restoreAfterTurn();
    expect(permissionMode.getMode()).toBe("unrestricted");
  });

  test("a mode changed during the turn wins over the stale restore", () => {
    permissionMode.setMode("unrestricted");
    const { context } = createContext(STANDARD, "unrestricted");

    // Something else (a mod, a settings reload) changed the mode mid-run.
    permissionMode.setMode("strict");
    context.restoreAfterTurn();
    expect(permissionMode.getMode()).toBe("strict");
  });

  test("a user turn keeps the old pin/restore behaviour", () => {
    permissionMode.setMode("standard");
    const { context, uiModeRef } = createContext(undefined, "acceptEdits");

    expect(context.scheduled).toBe(false);
    expect(context.pinnedMode).toBe("acceptEdits");
    expect(context.classifierState()).toBeUndefined();
    permissionMode.setMode("unrestricted");
    context.restorePinnedMode();
    expect(permissionMode.getMode()).toBe("acceptEdits");
    expect(uiModeRef.current).toBe("acceptEdits");
  });
});
