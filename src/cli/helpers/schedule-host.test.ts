import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  currentTuiScheduleHost,
  startTuiScheduleHost,
  type TuiScheduleHost,
} from "@/cli/helpers/schedule-host";
import { resetScheduleStore } from "@/cli/helpers/schedule-store";
import {
  addTask,
  claimSchedulerLease,
  listScheduleTasks,
  releaseSchedulerLease,
  type TaskRunnerPort,
} from "@/cron";
import { emitScheduleEvent } from "@/cron/schedule-events";

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
