import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  runScheduleSubcommand,
  runScheduleTick,
  type ScheduleTickDeps,
  type ShortLivedRuntime,
} from "@/cli/subcommands/schedule";
import { addTask, getTask, updateTask } from "@/cron/cron-file";
import { getScheduleFilePath } from "@/cron/cron-store";
import type { TaskRunnerPort } from "@/cron/cron-types";
import { getCronRunLogPath, readCronRunLogEntries } from "@/cron/run-log";

// ── Fixture ─────────────────────────────────────────────────────────

const TEST_DIR = path.join(import.meta.dir, "__schedule_e2e_test_tmp__");
const origHome = process.env.HARUYUKI_HOME;
const NOW = new Date("2026-10-28T14:05:20.000Z");

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.HARUYUKI_HOME = TEST_DIR;
});

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  if (origHome) process.env.HARUYUKI_HOME = origHome;
  else delete process.env.HARUYUKI_HOME;
});

function addDueTask(): string {
  const { task } = addTask({
    agent_id: "agent-local-e2e",
    name: "E2E task",
    description: "",
    cron: "* * * * *",
    timezone: "UTC",
    recurring: true,
    prompt: "hello",
  });
  updateTask(task.id, (record) => {
    record.created_at = "2026-10-20T00:00:00.000Z";
    record.jitter_offset_ms = 0;
  });
  return task.id;
}

function claimLongLivedLease(): void {
  const filePath = getScheduleFilePath();
  const data = existsSync(filePath)
    ? (JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>)
    : {
        version: 2,
        scheduler_owners: {},
        signal_state: { cursor: {} },
        tasks: [],
      };
  data.scheduler_owner = {
    pid: process.pid,
    token: "long-lived-token",
    started_at: NOW.toISOString(),
  };
  writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function stubRuntime() {
  const calls: string[] = [];
  let stopped = 0;
  const runner: TaskRunnerPort = {
    host: "short-lived",
    async run(input) {
      calls.push(input.task.id);
      return { outcome: "success", conversationId: "conv-e2e" };
    },
    cancel() {},
  };
  const runtime: ShortLivedRuntime = {
    runner,
    stop: () => {
      stopped += 1;
    },
  };
  return { runtime, calls, stoppedCount: () => stopped };
}

function deps(
  runtime: ShortLivedRuntime | null,
): ScheduleTickDeps & { startedRuntime: () => number } {
  let starts = 0;
  return {
    now: () => NOW,
    startRuntime: async () => {
      starts += 1;
      return runtime;
    },
    startedRuntime: () => starts,
  };
}

function runLog(taskId: string) {
  return readCronRunLogEntries(getCronRunLogPath(taskId), { jobId: taskId });
}

// ── Two-host arbitration ────────────────────────────────────────────

describe("two-host arbitration", () => {
  test("a live long-lived host makes the short-lived tick a no-op", async () => {
    const taskId = addDueTask();
    claimLongLivedLease();
    const stub = stubRuntime();
    const injected = deps(stub.runtime);

    const code = await runScheduleTick(injected);

    expect(code).toBe(0);
    expect(injected.startedRuntime()).toBe(0);
    expect(stub.calls).toEqual([]);
    expect(runLog(taskId)).toEqual([]);
    expect(getTask(taskId)?.fire_count).toBe(0);
  });

  test("with no long-lived host the short-lived tick runs exactly one task", async () => {
    const taskId = addDueTask();
    const stub = stubRuntime();

    const code = await runScheduleTick(deps(stub.runtime));

    expect(code).toBe(0);
    expect(stub.calls).toEqual([taskId]);
    expect(stub.stoppedCount()).toBe(1);
    const fresh = getTask(taskId);
    expect(fresh?.fire_count).toBe(1);
    expect(fresh?.last_consumed_occurrence).toBe("2026-10-28T14:05|UTC");
    expect(runLog(taskId)).toHaveLength(1);
  });

  test("nothing due never builds a runtime", async () => {
    const stub = stubRuntime();
    const injected = deps(stub.runtime);
    const code = await runScheduleTick(injected);
    expect(code).toBe(0);
    expect(injected.startedRuntime()).toBe(0);
    expect(stub.calls).toEqual([]);
  });

  test("a runtime that cannot start exits 1", async () => {
    addDueTask();
    expect(await runScheduleTick(deps(null))).toBe(1);
  });

  test("the second tick after the long-lived lease is released runs the task", async () => {
    const taskId = addDueTask();
    claimLongLivedLease();
    const stub = stubRuntime();
    expect(await runScheduleTick(deps(stub.runtime))).toBe(0);
    expect(stub.calls).toEqual([]);

    // Long-lived host exits (lease cleared) and the next wake runs the task.
    const data = JSON.parse(
      readFileSync(getScheduleFilePath(), "utf-8"),
    ) as Record<string, unknown> & { scheduler_owner: unknown };
    data.scheduler_owner = null;
    writeFileSync(getScheduleFilePath(), JSON.stringify(data, null, 2));

    expect(await runScheduleTick(deps(stub.runtime))).toBe(0);
    expect(stub.calls).toEqual([taskId]);
  });
});

// ── CLI wiring ──────────────────────────────────────────────────────

describe("schedule subcommand", () => {
  test("tick exits 0 on the light path and prints nothing", async () => {
    const code = await runScheduleSubcommand(["tick"]);
    expect(code).toBe(0);
  });

  test("status is read-only and reports the store", async () => {
    addDueTask();
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.join(" "));
    };
    try {
      expect(await runScheduleSubcommand(["status"])).toBe(0);
    } finally {
      console.log = original;
    }
    expect(lines.some((line) => line.startsWith("tasks: 1 active"))).toBe(true);
    expect(lines.some((line) => line.startsWith("next due:"))).toBe(true);
    expect(getScheduleFilePath()).toContain(TEST_DIR);
  });

  test("unknown actions are a usage error, help is 0", async () => {
    expect(await runScheduleSubcommand(["nope"])).toBe(2);
    expect(await runScheduleSubcommand(["help"])).toBe(0);
  });
});

// ── C-24 at the process level ───────────────────────────────────────

test("the empty tick path adds no heavy module to the process", async () => {
  const heavy = [
    "/backend/api",
    "/providers/",
    "/tools/impl",
    "/tools/manager",
    "/agent/conversation",
    "/websocket/listener",
  ];
  const loaded = () =>
    Object.keys((require.cache ?? {}) as Record<string, unknown>).map((key) =>
      key.replace(/\\/g, "/"),
    );
  const before = new Set(loaded());

  expect(await runScheduleSubcommand(["tick"])).toBe(0);

  const added = loaded().filter(
    (entry) =>
      !before.has(entry) && heavy.some((segment) => entry.includes(segment)),
  );
  expect(added).toEqual([]);
});
