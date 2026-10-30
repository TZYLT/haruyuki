import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import {
  requestTuiScheduleTick,
  startTuiScheduleHost,
  type TuiScheduleHost,
} from "@/cli/helpers/schedule-host";
import { resetScheduleStore } from "@/cli/helpers/schedule-store";
import {
  addTask,
  clearSignalSources,
  DREAM_PLACEHOLDER_CRON,
  getScheduleTask,
  registerSignalSource,
  serializeDreamTaskPayload,
  type TaskRunnerPort,
  updateTask,
} from "@/cron";
import { requestSchedulerTick } from "@/cron/scheduler";
import { settingsManager } from "@/settings-manager";

const TEST_DIR = path.join(import.meta.dir, "__schedule_host_dream_test_tmp__");
const origHome = process.env.HARUYUKI_HOME;
const NEVER = 60 * 60 * 1000;
const NOW = new Date("2026-10-30T14:05:00.000Z");

beforeEach(async () => {
  await settingsManager.reset();
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.HARUYUKI_HOME = TEST_DIR;
  resetScheduleStore();
  clearSignalSources();
});

afterEach(async () => {
  resetScheduleStore();
  clearSignalSources();
  await settingsManager.reset();
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  if (origHome) process.env.HARUYUKI_HOME = origHome;
  else delete process.env.HARUYUKI_HOME;
});

/** A dream signal stub: every active dream task is due right now. */
function registerDueDreamSource(): void {
  registerSignalSource({
    id: "dream",
    evaluate: ({ now, tasks }) => ({
      occurrences: tasks
        .filter((task) => task.type === "dream" && task.status === "active")
        .map((task) => ({
          taskId: task.id,
          occurrence: `dream:${now.toISOString()}`,
          intendedAt: new Date(now.getTime() - 1_000).toISOString(),
          missedCycles: 1,
        })),
    }),
    nextDueAt: () => null,
  });
}

function addDreamTask(agentId = "agent-1"): string {
  return addTask({
    agent_id: agentId,
    name: "Dream",
    description: "",
    cron: DREAM_PLACEHOLDER_CRON,
    timezone: "UTC",
    recurring: true,
    prompt: "",
    payload: serializeDreamTaskPayload({ version: 1 }),
    type: "dream",
    target: { kind: "new", hidden: true },
    timeout_minutes: 0,
    wait_minutes: 0,
  }).task.id;
}

function fakeRunner() {
  const runs: string[] = [];
  const runner: TaskRunnerPort = {
    host: "long-lived",
    async run(input) {
      runs.push(input.task.id);
      return { outcome: "success" };
    },
    cancel() {},
  };
  return { runner, runs };
}

interface SpawnedDream {
  taskId: string;
  exit: () => void;
}

function startHost(overrides: {
  runner: TaskRunnerPort;
  spawned: SpawnedDream[];
}): TuiScheduleHost {
  return startTuiScheduleHost({
    appendTaskNotificationEvents: () => true,
    runner: overrides.runner,
    now: () => NOW,
    firstTickMs: NEVER,
    tickIntervalMs: NEVER,
    spawnDreamRun: (taskId, onExit) => {
      overrides.spawned.push({ taskId, exit: onExit });
      return { pid: 4242 };
    },
  });
}

describe("TUI host delegates a dream occurrence (F-06 Q-47 / C-16)", () => {
  test("spawns one dream child and never runs the dream as a prompt", async () => {
    const taskId = addDreamTask();
    registerDueDreamSource();
    const { runner, runs } = fakeRunner();
    const spawned: SpawnedDream[] = [];
    const host = startHost({ runner, spawned });
    try {
      await host.tick();
      expect(spawned.map((entry) => entry.taskId)).toEqual([taskId]);
      // The dream never reaches the in-process prompt runner (route C-13).
      expect(runs).toEqual([]);
      // The core deferred it: no claim, no consumption, no failure.
      const task = getScheduleTask(taskId);
      expect(task?.lastConsumedOccurrence).toBeNull();
      expect(task?.lease).toBeNull();
      expect(task?.failedCount).toBe(0);
    } finally {
      host.dispose();
    }
  });

  test("one due occurrence never spawns two children (in-flight guard)", async () => {
    const taskId = addDreamTask();
    registerDueDreamSource();
    const { runner } = fakeRunner();
    const spawned: SpawnedDream[] = [];
    const host = startHost({ runner, spawned });
    try {
      await host.tick();
      await host.tick();
      await host.tick();
      expect(spawned).toHaveLength(1);
      // A retry is allowed only once the first child is gone.
      spawned[0]?.exit();
      await host.tick();
      expect(spawned.map((entry) => entry.taskId)).toEqual([taskId, taskId]);
    } finally {
      host.dispose();
    }
  });

  test("a non-dream deferred task still uses schedule tick delegation", async () => {
    const dreamId = addDreamTask();
    registerDueDreamSource();
    // A due prompt task: the cron source reports it, and the injected runner
    // refuses everything so the core defers it too.
    const { task: promptTask } = addTask({
      agent_id: "agent-1",
      name: "Prompt",
      description: "",
      cron: "* * * * *",
      timezone: "UTC",
      recurring: true,
      prompt: "p",
    });
    updateTask(promptTask.id, (record) => {
      record.created_at = "2026-10-20T00:00:00.000Z";
      record.jitter_offset_ms = 0;
    });
    const { runner } = fakeRunner();
    const delegatedTicks: string[] = [];
    const spawned: SpawnedDream[] = [];
    const host = startTuiScheduleHost({
      appendTaskNotificationEvents: () => true,
      runner: { ...runner, canRun: () => false },
      now: () => NOW,
      firstTickMs: NEVER,
      tickIntervalMs: NEVER,
      spawnDreamRun: (taskId, onExit) => {
        spawned.push({ taskId, exit: onExit });
        return { pid: 1 };
      },
      spawnDelegatedTick: (taskId) => {
        delegatedTicks.push(taskId);
        return { pid: 2 };
      },
    });
    try {
      await host.tick();
      // The dream went to `dream run --task`, the prompt to `schedule tick
      // --task`: the two delegation paths are dispatched by task type.
      expect(spawned.map((entry) => entry.taskId)).toEqual([dreamId]);
      expect(delegatedTicks).toEqual([promptTask.id]);
    } finally {
      host.dispose();
    }
  });
});

describe("requestSchedulerTick (R-5.2.4)", () => {
  test("is a no-op when no long-lived host owns this process", () => {
    expect(() => requestSchedulerTick()).not.toThrow();
  });
});

describe("requestTuiScheduleTick (turn-end nudge, R-5.2.4)", () => {
  test("wakes the mounted TUI host without waiting for the 60 s interval", async () => {
    const taskId = addDreamTask();
    registerDueDreamSource();
    const { runner } = fakeRunner();
    const spawned: SpawnedDream[] = [];
    const host = startHost({ runner, spawned });
    try {
      requestTuiScheduleTick(10);
      await Bun.sleep(200);
      expect(spawned.map((entry) => entry.taskId)).toEqual([taskId]);
    } finally {
      host.dispose();
    }
  });

  test("is a no-op when no host is mounted", () => {
    expect(() => requestTuiScheduleTick(10)).not.toThrow();
  });
});
