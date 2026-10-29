import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path, { dirname, resolve } from "node:path";
import { Text } from "ink";
import { createElement } from "react";
import {
  currentTuiScheduleHost,
  delegatedTickCommand,
  type SpawnDelegatedTick,
  startTuiScheduleHost,
  type TuiScheduleHost,
  useTuiScheduleHost,
} from "@/cli/helpers/schedule-host";
import { resetScheduleStore } from "@/cli/helpers/schedule-store";
import type { AddTaskInput } from "@/cron";
import {
  addTask,
  claimSchedulerLease,
  listScheduleTasks,
  readScheduleFile,
  releaseSchedulerLease,
  type TaskRunnerPort,
  updateTask,
} from "@/cron";
import { emitScheduleEvent } from "@/cron/schedule-events";
import { mountInkTty, resetInkTtyState } from "@/test-utils/ink-tty";

/**
 * The TUI's host leg: the lease policy (Lead's ruling) and the two things a bug
 * here would break — it must not tick while another live host owns the
 * scheduler, and it must release the lease when the TUI exits.
 *
 * The runner is injected: this file must not depend on T2's queue wiring, and a
 * tick that finds nothing due is enough to prove the leg is wired.
 */

const TEST_DIR = path.join(import.meta.dir, "__schedule_host_test_tmp__");
const origHome = process.env.HARUYUKI_HOME;
const NEVER = 60 * 60 * 1000;

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.HARUYUKI_HOME = TEST_DIR;
  resetScheduleStore();
});

afterEach(() => {
  resetScheduleStore();
  resetInkTtyState();
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  if (origHome) process.env.HARUYUKI_HOME = origHome;
  else delete process.env.HARUYUKI_HOME;
});

function fakeRunner(host: "long-lived" | "short-lived" = "long-lived") {
  const runs: string[] = [];
  const runner: TaskRunnerPort = {
    host,
    async run(input) {
      runs.push(input.task.id);
      return { outcome: "success" };
    },
    cancel() {},
  };
  return { runner, runs };
}

function start(overrides: {
  runner: TaskRunnerPort;
  notifications: string[];
  now?: () => Date;
  spawnDelegatedTick?: SpawnDelegatedTick;
}): TuiScheduleHost {
  return startTuiScheduleHost({
    appendTaskNotificationEvents: (summaries) => {
      overrides.notifications.push(...summaries);
      return true;
    },
    runner: overrides.runner,
    firstTickMs: NEVER,
    tickIntervalMs: NEVER,
    ...(overrides.now ? { now: overrides.now } : {}),
    ...(overrides.spawnDelegatedTick
      ? { spawnDelegatedTick: overrides.spawnDelegatedTick }
      : {}),
  });
}

function createTask(name = "晨报"): string {
  return addTask({
    agent_id: "agent-1",
    name,
    description: "d",
    cron: "0 9 * * *",
    recurring: true,
    prompt: "p",
  }).task.id;
}

const NOW = new Date("2026-10-28T14:05:00.000Z");

/** A task whose current slot is due at `NOW` (same fixture as the core tests). */
function createDueTask(overrides: Partial<AddTaskInput> = {}): string {
  const { task } = addTask({
    agent_id: "agent-1",
    conversation_id: "conv-1",
    name: "到期任务",
    description: "d",
    cron: "* * * * *",
    timezone: "UTC",
    recurring: true,
    prompt: "p",
    ...overrides,
  });
  updateTask(task.id, (record) => {
    record.created_at = "2026-10-20T00:00:00.000Z";
    record.jitter_offset_ms = 0;
  });
  return task.id;
}

describe("the TUI host leg", () => {
  test("claims the all-scope lease, and releases it on dispose", () => {
    const { runner } = fakeRunner();
    const host = start({ runner, notifications: [] });
    try {
      expect(host.hasLease()).toBe(true);
      expect(currentTuiScheduleHost()).toBe(host);
    } finally {
      host.dispose();
    }
    // Disposed: nobody holds the all lease any more, so a fresh claim works.
    expect(currentTuiScheduleHost()).toBeNull();
    const token = claimSchedulerLease("all");
    releaseSchedulerLease(token, "all");
  });

  test("does not tick while another live host holds the scheduler", async () => {
    // A live *scoped* owner (the listener's shape) blocks an all-scope claim;
    // `process.ppid` is a process that exists, which is all the lease checks.
    const { runner, runs } = fakeRunner();
    const scheduleFile = path.join(TEST_DIR, "schedules.json");
    writeFileSync(
      scheduleFile,
      JSON.stringify({
        version: 2,
        scheduler_owner: null,
        scheduler_owners: {
          local: {
            pid: process.ppid,
            token: "other",
            started_at: new Date().toISOString(),
          },
        },
        signal_state: { cursor: {} },
        tasks: [],
      }),
    );

    const host = start({ runner, notifications: [] });
    try {
      expect(host.hasLease()).toBe(false);
      await host.tick();
      expect(runs).toEqual([]);
      expect(host.hasLease()).toBe(false);
    } finally {
      host.dispose();
    }
  });

  test("a tick with nothing due starts no run", async () => {
    createTask();
    const { runner, runs } = fakeRunner();
    const host = start({ runner, notifications: [] });
    try {
      await host.tick();
      expect(runs).toEqual([]);
      expect(listScheduleTasks()).toHaveLength(1);
    } finally {
      host.dispose();
    }
  });

  test("a finished run becomes one notification line per run", async () => {
    const notifications: string[] = [];
    const { runner } = fakeRunner();
    const host = start({ runner, notifications });
    try {
      emitScheduleEvent({
        kind: "run-finished",
        at: new Date().toISOString(),
        taskId: "a1b2c3d4",
        taskName: "晨报",
        agentId: "agent-1",
        runId: "run-1",
        outcome: "success",
        durationMs: 3_000,
      });
      emitScheduleEvent({
        kind: "task-paused",
        at: new Date().toISOString(),
        taskId: "a1b2c3d4",
        taskName: "晨报",
        agentId: "agent-1",
        pausedReason: "auto_failures",
      });
      await Bun.sleep(30);
      // Coalesced into one flush, one line each: two events must not mean two
      // React updates of the transcript.
      expect(notifications).toHaveLength(2);
      expect(notifications[0]).toContain("晨报");
      expect(notifications[0]).toContain("成功");
      expect(notifications[1]).toContain("已暂停");
    } finally {
      host.dispose();
    }
  });

  test("/schedule run drives the core's manual entry, not a private path", async () => {
    const id = createTask();
    const { runner, runs } = fakeRunner();
    const host = start({ runner, notifications: [] });
    try {
      const result = await host.runTaskNow(id);
      expect(result?.outcome).toBe("success");
      expect(runs).toEqual([id]);
    } finally {
      host.dispose();
    }
  });

  test("a manual run refuses a completed task instead of starting it", async () => {
    const id = createTask();
    const { runner, runs } = fakeRunner();
    const host = start({ runner, notifications: [] });
    try {
      // Pause then delete the record, which leaves nothing to run.
      const { deleteTask } = await import("@/cron");
      deleteTask(id);
      await expect(host.runTaskNow(id)).rejects.toThrow();
      expect(runs).toEqual([]);
    } finally {
      host.dispose();
    }
  });
});

// ── P1-2 (user ruling B): delegate what this host cannot run ────────

describe("delegated short-lived ticks", () => {
  test("the child re-enters through the lightweight entry, not the full app", () => {
    const { command, args } = delegatedTickCommand("a1b2c3d4");
    expect(command).toBe(process.execPath);
    const entry = process.versions.bun
      ? resolve(
          dirname(process.argv[1] ?? "src/index.ts"),
          "standalone-entry.ts",
        )
      : (process.argv[1] ?? "haruyuki.js");
    expect(args).toEqual([entry, "schedule", "tick", "--task", "a1b2c3d4"]);
    // The dev entry is resolved next to the invoked one, so a TUI started from
    // a directory other than the repository root still finds it.
    expect(args[0]).toContain("standalone-entry.ts");
  });

  test("a task this host can run runs in-process and delegates nothing", async () => {
    const id = createDueTask();
    const { runner, runs } = fakeRunner();
    const canRunChecks: string[] = [];
    runner.canRun = (task) => {
      canRunChecks.push(task.id);
      return true;
    };
    const delegated: string[] = [];
    const host = start({
      runner,
      notifications: [],
      now: () => NOW,
      spawnDelegatedTick: (taskId) => {
        delegated.push(taskId);
        return { pid: 1 };
      },
    });
    try {
      await host.tick();
      expect(canRunChecks).toContain(id);
      expect(runs).toEqual([id]);
      expect(delegated).toEqual([]);
    } finally {
      host.dispose();
    }
  });

  test("a due task this host cannot run is delegated once, and not again while the child lives", async () => {
    const id = createDueTask({
      agent_id: "agent-other",
      conversation_id: "conv-other",
    });
    const { runner, runs } = fakeRunner();
    const canRunChecks: string[] = [];
    runner.canRun = (task) => {
      canRunChecks.push(task.id);
      return false;
    };
    const spawned: Array<{ taskId: string; exit: () => void }> = [];
    const host = start({
      runner,
      notifications: [],
      now: () => NOW,
      spawnDelegatedTick: (taskId, onExit) => {
        spawned.push({ taskId, exit: onExit });
        return { pid: 1 };
      },
    });
    try {
      await host.tick();
      // The tick asked its runner about the task (so the tick is not filtered
      // by the current conversation) and then handed it to a child instead of
      // running it here.
      expect(canRunChecks).toContain(id);
      expect(runs).toEqual([]);
      expect(spawned.map((entry) => entry.taskId)).toEqual([id]);

      // The occurrence is untouched, so the next tick sees it again — but the
      // still-running child must not be started twice.
      await host.tick();
      expect(spawned).toHaveLength(1);

      // Only after the child exits may a retry get a second child.
      spawned[0]?.exit();
      await host.tick();
      expect(spawned).toHaveLength(2);
    } finally {
      host.dispose();
    }
  });
});

// ── P1-3 / M3 #1: one host per session, not one per tool flip ──────

describe("useTuiScheduleHost lifecycle", () => {
  test("busy flips do not recreate the host or rewrite the scheduler lease", async () => {
    function Probe({ busy }: { busy: boolean }) {
      useTuiScheduleHost({
        appendTaskNotificationEvents: () => true,
        isConversationBusy: () => busy,
        getActiveTarget: () => ({
          agentId: "agent-1",
          conversationId: "conv-1",
        }),
      });
      return createElement(Text, null, busy ? "busy" : "idle");
    }

    const tty = mountInkTty(createElement(Probe, { busy: false }));
    try {
      await Bun.sleep(20);
      const firstHost = currentTuiScheduleHost();
      expect(firstHost).not.toBeNull();
      // The claim is the lease write: its token changes when a host re-takes it.
      const leaseToken = readScheduleFile().scheduler_owner?.token;
      expect(leaseToken).toBeTruthy();

      // The flips that used to dispose+recreate the host: a busy tool flip is a
      // new `isConversationBusy`/`isExecutingTool` closure on every render.
      for (const busy of [true, false, true, false, true]) {
        await tty.rerender(createElement(Probe, { busy }));
        await Bun.sleep(5);
      }

      expect(currentTuiScheduleHost()).toBe(firstHost);
      expect(readScheduleFile().scheduler_owner?.token).toBe(leaseToken);

      // Exactly one lease write: nobody else may have claimed in between (the
      // second claim would have replaced the token above).
      expect(readScheduleFile().scheduler_owner?.pid).toBe(process.pid);
    } finally {
      tty.stop();
    }
  });
});
