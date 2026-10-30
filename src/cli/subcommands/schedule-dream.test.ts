import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import {
  runScheduleSubcommand,
  runScheduleTick,
  type ShortLivedRuntime,
} from "@/cli/subcommands/schedule";
import {
  addTask,
  clearSignalSources,
  DREAM_PLACEHOLDER_CRON,
  getScheduleTask,
  registerSignalSource,
  serializeDreamTaskPayload,
} from "@/cron";
import type { ScheduleTaskV2, TaskRunnerPort } from "@/cron/cron-types";
import { settingsManager } from "@/settings-manager";

const TEST_DIR = path.join(import.meta.dir, "__schedule_dream_test_tmp__");
const origHome = process.env.HARUYUKI_HOME;

beforeEach(async () => {
  // The preflight/tick paths read the settings singleton; keep it uninitialized
  // (defaults) per test so another file's initialized state cannot leak in.
  await settingsManager.reset();
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.HARUYUKI_HOME = TEST_DIR;
  clearSignalSources();
});

afterEach(async () => {
  clearSignalSources();
  await settingsManager.reset();
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  if (origHome) process.env.HARUYUKI_HOME = origHome;
  else delete process.env.HARUYUKI_HOME;
});

function addDreamTask(): string {
  return addTask({
    agent_id: "agent-1",
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

function registerDueDreamStub(): void {
  registerSignalSource({
    id: "dream",
    evaluate: ({ now, tasks }) => ({
      occurrences: tasks
        .filter((task) => task.type === "dream" && task.status === "active")
        .map((task) => ({
          taskId: task.id,
          occurrence: `dream:${now.toISOString()}`,
          intendedAt: new Date(now.getTime() - 1_000).toISOString(),
        })),
    }),
    nextDueAt: () => null,
  });
}

describe("autostart short-lived host delegates deferred dreams (F-06 M1)", () => {
  test("spawns the dream child for a deferred dream occurrence", async () => {
    const dreamId = addDreamTask();
    registerDueDreamStub();
    const delegated: ScheduleTaskV2[] = [];
    const runner: TaskRunnerPort = {
      host: "short-lived",
      canRun: () => false,
      async run() {
        return { outcome: "success" };
      },
      cancel() {},
      async runDream(input) {
        delegated.push(input.task);
        return { outcome: "success" };
      },
    };
    let stopped = 0;
    const runtime: ShortLivedRuntime = {
      runner,
      stop: () => {
        stopped += 1;
      },
    };
    const code = await runScheduleTick({
      now: () => new Date(),
      startRuntime: async () => runtime,
      runTick: async () => ({ started: null, deferredTaskIds: [dreamId] }),
    });
    expect(code).toBe(0);
    expect(stopped).toBe(1);
    expect(delegated.map((task) => task.id)).toEqual([dreamId]);
    expect(delegated[0]?.type).toBe("dream");
  });

  test("ignores a deferred id that is not a dream task", async () => {
    const { task: promptTask } = addTask({
      agent_id: "agent-1",
      name: "Prompt",
      description: "",
      cron: "* * * * *",
      timezone: "UTC",
      recurring: true,
      prompt: "hi",
    });
    // Nothing is due (no dream task, no due cron minute), so the tick exits
    // before the runtime. Force the delegated path by injecting the runtime and
    // trusting the preflight: register a due dream stub plus a dream task.
    const dreamId = addDreamTask();
    registerDueDreamStub();
    const delegatedDreams: string[] = [];
    const runner: TaskRunnerPort = {
      host: "short-lived",
      async run() {
        return { outcome: "success" };
      },
      cancel() {},
      async runDream(input) {
        delegatedDreams.push(input.task.id);
        return { outcome: "success" };
      },
    };
    const code = await runScheduleTick({
      now: () => new Date(),
      startRuntime: async () => ({ runner, stop: () => {} }),
      runTick: async () => ({
        started: null,
        deferredTaskIds: [promptTask.id, dreamId],
      }),
    });
    expect(code).toBe(0);
    expect(delegatedDreams).toEqual([dreamId]);
    expect(getScheduleTask(dreamId)?.type).toBe("dream");
  });
});

describe("schedule subcommand still dispatches", () => {
  test("unknown action exits 2", async () => {
    expect(await runScheduleSubcommand(["nope"])).toBe(2);
  });

  test("status is read-only and exits 0", async () => {
    addDreamTask();
    expect(await runScheduleSubcommand(["status"])).toBe(0);
  });
});
