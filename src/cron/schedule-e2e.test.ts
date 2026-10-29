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
  runScheduleStatus,
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
    expect(fresh?.last_consumed_occurrence).toBe(
      "2026-10-28T14:05|UTC|2026-10-28T14:05:00.000Z",
    );
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

// ── C-24 at the process level (P1-6) ────────────────────────────────

/**
 * Documented wall-time budget (P1-6/C-24).
 *
 * Measured on the dev machine (empty HARUYUKI_HOME, nothing due, three runs):
 *   bun src/standalone-entry.ts schedule tick  ~0.28-0.31s  (this entry)
 *   node ./haruyuki.js schedule tick           ~0.62-0.68s  (bundle)
 *   bun src/index.ts schedule tick             ~1.34-1.42s  (heavy dev entry)
 * Process start-up itself is ~0.2s and cannot be removed, so the target is
 * "roughly one process start plus the light modules", not <100ms. The budget
 * keeps 3x headroom over the measured dev number for slow machines.
 */
const SCHEDULE_TICK_BUDGET_MS = 1_000;

/**
 * Spawn the real entry with a module-resolve probe and return what loaded.
 *
 * The probe is a Bun preload plugin: it records every module specifier the
 * process resolves after startup, which is the process-level evidence the
 * in-process `require.cache` check could not give (C-24).
 */
async function runEntryWithProbe(
  entry: string,
  args: string[],
): Promise<{
  wallMs: number;
  exitCode: number;
  moduleCount: number;
  heavyModules: string[];
}> {
  const probePath = path.join(TEST_DIR, "module-probe.ts");
  const outPath = path.join(TEST_DIR, "module-probe-out.json");
  writeFileSync(
    probePath,
    [
      "const specs = new Set<string>();",
      "Bun.plugin({",
      '  name: "schedule-tick-module-probe",',
      "  setup(build) {",
      "    build.onResolve({ filter: /.*/ }, (resolveArgs) => {",
      "      specs.add(resolveArgs.path);",
      "      return undefined;",
      "    });",
      "  },",
      "});",
      'process.on("exit", () => {',
      '  require("node:fs").writeFileSync(',
      "    process.env.PROBE_OUT as string,",
      "    JSON.stringify([...specs]),",
      "  );",
      "});",
      "",
    ].join("\n"),
  );
  const startedAt = performance.now();
  const child = Bun.spawn(
    [
      process.execPath,
      "--preload",
      probePath,
      path.join(process.cwd(), entry),
      ...args,
    ],
    {
      env: { ...process.env, HARUYUKI_HOME: TEST_DIR, PROBE_OUT: outPath },
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  const exitCode = await child.exited;
  const wallMs = performance.now() - startedAt;
  const specs = existsSync(outPath)
    ? (JSON.parse(readFileSync(outPath, "utf-8")) as string[])
    : [];
  const heavyModules = specs.filter(
    (spec) =>
      spec.includes("@/backend") ||
      spec.includes("@/providers") ||
      spec.includes("@/tools/") ||
      spec.includes("@/websocket/listener") ||
      spec.includes("@/agent/") ||
      spec.includes("@earendil-works/pi-ai"),
  );
  return { wallMs, exitCode, moduleCount: specs.length, heavyModules };
}

test("the light schedule-tick entry stays under the documented budget and loads no heavy modules", async () => {
  const result = await runEntryWithProbe("src/standalone-entry.ts", [
    "schedule",
    "tick",
  ]);
  expect(result.exitCode).toBe(0);
  expect(result.wallMs).toBeLessThan(SCHEDULE_TICK_BUDGET_MS);
  // Measured baseline: ~0.28s and no heavy module (the in-test wall time is
  // lower than a cold shell run because the runtime is already warm).
  expect(result.moduleCount).toBeLessThan(200);
  expect(result.heavyModules).toEqual([]);
});

// ── P1-2 B: delegated `schedule tick --task <id>` ───────────────────

describe("delegated tick", () => {
  test("--task ignores a live long-lived host and ticks only that task", async () => {
    const targetId = addDueTask();
    const otherId = addDueTask();
    claimLongLivedLease();
    const stub = stubRuntime();
    let includeTask: ((task: { id: string }) => boolean) | undefined;
    let ticked = 0;

    const code = await runScheduleTick({
      taskId: targetId,
      now: () => NOW,
      startRuntime: async () => stub.runtime,
      runTick: async (input) => {
        ticked += 1;
        includeTask = input.includeTask as (task: { id: string }) => boolean;
        return { started: null, deferredTaskIds: [] };
      },
    });

    expect(code).toBe(0);
    expect(ticked).toBe(1);
    expect(stub.stoppedCount()).toBe(1);
    expect(includeTask?.({ id: targetId })).toBe(true);
    expect(includeTask?.({ id: otherId })).toBe(false);
  });

  test("--task for a missing id exits 0 with a diagnostic and builds no runtime", async () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.join(" "));
    };
    const stub = stubRuntime();
    try {
      const code = await runScheduleTick({
        taskId: "does-not-exist",
        now: () => NOW,
        startRuntime: async () => stub.runtime,
      });
      expect(code).toBe(0);
    } finally {
      console.error = original;
    }
    expect(errors.join("\n")).toContain("not found");
    expect(stub.calls).toEqual([]);
  });

  test("--task for a not-due task exits 0 with a diagnostic", async () => {
    const { task } = addTask({
      agent_id: "agent-local-e2e",
      name: "Future one-shot",
      description: "",
      cron: "0 0 1 1 *",
      recurring: false,
      scheduled_for: new Date(NOW.getTime() + 3_600_000),
      prompt: "later",
    });
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.join(" "));
    };
    try {
      const code = await runScheduleTick({
        taskId: task.id,
        now: () => NOW,
        startRuntime: async () => null,
      });
      expect(code).toBe(0);
    } finally {
      console.error = original;
    }
    expect(errors.join("\n")).toContain("not due");
  });

  test("an unknown tick option is a usage error", async () => {
    expect(await runScheduleSubcommand(["tick", "--bogus"])).toBe(2);
  });
});

// ── M1 #14: status survives a broken store ──────────────────────────

test("schedule status reports a corrupt store instead of throwing", () => {
  writeFileSync(getScheduleFilePath(), "{ not json at all");
  const lines: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => {
    lines.push(args.join(" "));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.join(" "));
  };
  try {
    expect(runScheduleStatus()).toBe(1);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  expect(errors.join("\n")).toContain("store unreadable");
  expect(lines.some((line) => line.startsWith("store: version"))).toBe(false);
});

// ── M1 #18: the short-lived host only executes its own lane ─────────

test("the short-lived host filters out tasks from another backend lane", async () => {
  addDueTask();
  const stub = stubRuntime();
  let includeTask: ((task: { agentId: string }) => boolean) | undefined;
  const code = await runScheduleTick({
    now: () => NOW,
    startRuntime: async () => stub.runtime,
    runTick: async (input) => {
      includeTask = input.includeTask as (task: { agentId: string }) => boolean;
      return { started: null, deferredTaskIds: [] };
    },
  });
  expect(code).toBe(0);
  expect(includeTask).toBeTypeOf("function");
  expect(includeTask?.({ agentId: "agent-local-e2e" })).toBe(true);
  expect(includeTask?.({ agentId: "agent-cloud-e2e" })).toBe(false);
});

test("schedule status names a newer-store version instead of throwing", () => {
  writeFileSync(
    getScheduleFilePath(),
    JSON.stringify({
      version: 99,
      scheduler_owner: null,
      signal_state: { cursor: {} },
      tasks: [],
    }),
  );
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = (...args: unknown[]) => {
    errors.push(args.join(" "));
  };
  try {
    expect(runScheduleStatus()).toBe(1);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  const message = errors.join("\n");
  expect(message).toContain("store unreadable");
  expect(message).toContain("Version");
  // A diagnostic, not a stack trace.
  expect(message).not.toContain("    at ");
});

// ── M2 F8: the short-lived runtime says so at construction time ─────

test("the short-lived runtime passes host=short-lived to the listener runner", () => {
  const sourcePath = path.resolve(
    import.meta.dir,
    "..",
    "cli",
    "subcommands",
    "schedule.ts",
  );
  const source = readFileSync(sourcePath, "utf-8");
  expect(source).toContain('host: "short-lived"');
  // The old shallow patch silently kept the factory's `long-lived` default.
  expect(source).not.toContain('{ ...runner, host: "short-lived" }');
});
