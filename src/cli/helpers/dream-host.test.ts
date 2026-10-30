import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import {
  createDreamTaskRunner,
  type DreamHostDeps,
  runDreamHost,
} from "@/cli/helpers/dream-host";
import {
  addTask,
  DREAM_PLACEHOLDER_CRON,
  getScheduleTask,
  parseDreamTaskPayload,
  readDreamSignalState,
  serializeDreamTaskPayload,
  updateTask,
} from "@/cron";
import {
  DREAM_SETTINGS_DEFAULTS,
  type ResolvedDreamSettings,
} from "@/dream-settings";
import { settingsManager } from "@/settings-manager";

const TEST_DIR = path.join(import.meta.dir, "__dream_host_test_tmp__");
const origHome = process.env.HARUYUKI_HOME;

function local(
  year: number,
  month: number,
  day: number,
  hours: number,
  minutes: number,
): Date {
  return new Date(year, month - 1, day, hours, minutes, 0, 0);
}

const WINDOW_NOW = local(2026, 10, 30, 23, 30);
const OUTSIDE_NOW = local(2026, 10, 30, 15, 0);

function settings(
  overrides: Partial<ResolvedDreamSettings> = {},
): ResolvedDreamSettings {
  return {
    ...DREAM_SETTINGS_DEFAULTS,
    enabled: true,
    autoTrigger: true,
    tiers: { tidy: true, think: true, task: true, wander: true },
    idleWindows: [{ start: "22:00", end: "07:00" }],
    ...overrides,
  };
}

beforeEach(async () => {
  await settingsManager.reset();
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.HARUYUKI_HOME = TEST_DIR;
});

afterEach(async () => {
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

function deps(overrides: Partial<DreamHostDeps> = {}): DreamHostDeps {
  return {
    readSettings: () => settings(),
    readPressure: () => 80_000,
    readLastActiveAt: () => null,
    now: () => WINDOW_NOW,
    runDreamTask: async () => ({ outcome: "success" }),
    // Never touch git/the memory lock from a unit test.
    recoverStaleRuns: async () => ({ recovered: 0 }),
    ...overrides,
  };
}

function call(
  taskId: string,
  options: {
    deps?: DreamHostDeps;
    manual?: boolean;
    budgetOverrideTokens?: number;
    signal?: AbortSignal;
  } = {},
) {
  return runDreamHost(
    {
      taskId,
      runId: "run-1",
      occurrence: "dream:occ-1",
      signal: options.signal ?? new AbortController().signal,
      manual: options.manual ?? false,
      ...(options.budgetOverrideTokens !== undefined
        ? { budgetOverrideTokens: options.budgetOverrideTokens }
        : {}),
    },
    options.deps ?? deps(),
  );
}

describe("dream host gating", () => {
  test("refuses every trigger when the explicit configuration gate is closed", async () => {
    const taskId = addDreamTask();
    const result = await call(taskId, {
      deps: deps({ readSettings: () => settings({ enabled: false }) }),
    });
    expect(result.outcome).toBe("skipped");
    expect(result.error).toContain("not enabled");
    expect(readDreamSignalState("agent-1").dayCount).toBe(0);
  });

  test("an automatic run outside the idle window is skipped and deferred", async () => {
    const taskId = addDreamTask();
    const result = await call(taskId, {
      deps: deps({ now: () => OUTSIDE_NOW }),
    });
    expect(result.outcome).toBe("skipped");
    expect(result.error).toContain("not due");
    const state = readDreamSignalState("agent-1");
    expect(state.dayCount).toBe(0);
    // R-5.2.5: the child pushes nextEligibleAt to the next window start.
    expect(state.nextEligibleAt).toBe(local(2026, 10, 30, 22, 0).getTime());
  });

  test("an eligible automatic run advances the attempt state", async () => {
    const taskId = addDreamTask();
    const seen: string[] = [];
    const result = await call(taskId, {
      deps: deps({
        runDreamTask: async ({ task, runId, occurrence }) => {
          seen.push(`${task.id}:${runId}:${occurrence}`);
          return { outcome: "success" };
        },
      }),
    });
    expect(result.outcome).toBe("success");
    expect(seen).toEqual([`${taskId}:run-1:dream:occ-1`]);
    const state = readDreamSignalState("agent-1");
    expect(state.dayCount).toBe(1);
    expect(state.nextEligibleAt).toBe(WINDOW_NOW.getTime() + 10 * 60_000);
    // The in-flight marker and `lastOutcome` belong to S1 (Lead ruling): an
    // injected controller that never writes them leaves the host's state clean.
    expect(state.running).toBeNull();
    expect(state.lastOutcome).toBeNull();
  });

  test("a controller failure is reported without the host writing the S1 status", async () => {
    const taskId = addDreamTask();
    const result = await call(taskId, {
      deps: deps({
        runDreamTask: async () => {
          throw new Error("boom");
        },
      }),
    });
    expect(result.outcome).toBe("failed");
    expect(result.error).toContain("boom");
    const state = readDreamSignalState("agent-1");
    // The host still counts the attempt, but the marker/status are S1's.
    expect(state.dayCount).toBe(1);
    expect(state.running).toBeNull();
    expect(state.lastOutcome).toBeNull();
  });

  test("a controller failure is surfaced, never swallowed", async () => {
    const taskId = addDreamTask();
    // No injected controller: whatever S1 currently is (L0 throws; M2's real
    // controller is running in the same tree), its failure must reach the run
    // outcome instead of being reported as a success.
    const result = await call(taskId, {
      deps: deps({ runDreamTask: undefined }),
    });
    expect(result.outcome).toBe("failed");
    expect(result.error).toBeTruthy();
  });

  test("a manual run bypasses the trigger but not the configuration gate", async () => {
    const taskId = addDreamTask();
    const result = await call(taskId, {
      manual: true,
      deps: deps({ now: () => OUTSIDE_NOW }),
    });
    expect(result.outcome).toBe("success");
    const state = readDreamSignalState("agent-1");
    // Manual runs do not spend one of the six automatic self-advances.
    expect(state.dayCount).toBe(0);
    expect(state.running).toBeNull();
  });

  test("a malformed dream record is an F1 and never reaches S1", async () => {
    const taskId = addDreamTask();
    updateTask(taskId, (record) => {
      record.timeout_minutes = 30;
    });
    let called = 0;
    let caught: unknown;
    try {
      await call(taskId, {
        deps: deps({
          runDreamTask: async () => {
            called += 1;
            return { outcome: "success" };
          },
        }),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toBe("ScheduledTaskPreflightError");
    expect(called).toBe(0);
  });

  test("--budget applies to one run and the payload is restored", async () => {
    const taskId = addDreamTask();
    let observedOverride: number | undefined;
    const result = await call(taskId, {
      budgetOverrideTokens: 12_345,
      deps: deps({
        runDreamTask: async ({ task }) => {
          observedOverride = parseDreamTaskPayload(
            task.payload,
          )?.budgetOverrideTokens;
          return { outcome: "success" };
        },
      }),
    });
    expect(result.outcome).toBe("success");
    expect(observedOverride).toBe(12_345);
    const after = getScheduleTask(taskId);
    expect(parseDreamTaskPayload(after?.payload)?.budgetOverrideTokens).toBe(
      undefined,
    );
  });
});

describe("crash recovery call site (R-5.8.4)", () => {
  test("recovery runs once, before S1, on every run attempt", async () => {
    const taskId = addDreamTask();
    const order: string[] = [];
    const result = await call(taskId, {
      deps: deps({
        recoverStaleRuns: async () => {
          order.push("recover");
          // A crashed earlier run is repaired before S1 builds this run.
          expect(readDreamSignalState("agent-1").running).toBeNull();
          return { recovered: 1 };
        },
        runDreamTask: async () => {
          order.push("s1");
          return { outcome: "success" };
        },
      }),
    });
    expect(result.outcome).toBe("success");
    expect(order).toEqual(["recover", "s1"]);
  });

  test("a recovery failure is logged and does not block the run", async () => {
    const taskId = addDreamTask();
    const result = await call(taskId, {
      deps: deps({
        recoverStaleRuns: async () => {
          throw new Error("harness home is read-only");
        },
        runDreamTask: async () => ({ outcome: "success" }),
      }),
    });
    expect(result.outcome).toBe("success");
  });
});

describe("dream task runner (short-lived host)", () => {
  test("routes a dream task through the envelope to S1", async () => {
    const taskId = addDreamTask();
    const task = getScheduleTask(taskId);
    if (!task) throw new Error("task missing");
    const runner = createDreamTaskRunner({
      manual: true,
      deps: deps({
        runDreamTask: async () => ({ outcome: "success" }),
      }),
    });
    expect(runner.canRun?.(task)).toBe(true);
    const result = await runner.run({
      task,
      runId: "run-runner",
      occurrence: "manual:test",
      signal: new AbortController().signal,
    });
    expect(result.outcome).toBe("success");
  });

  test("a cancelled envelope reports cancelled, not success", async () => {
    const taskId = addDreamTask();
    const controller = new AbortController();
    const runner = createDreamTaskRunner({
      manual: true,
      deps: deps({
        runDreamTask: async ({ signal }) => {
          controller.abort();
          expect(signal.aborted).toBe(true);
          return { outcome: "success" };
        },
      }),
    });
    const task = getScheduleTask(taskId);
    if (!task) throw new Error("task missing");
    const result = await runner.run({
      task,
      runId: "run-cancelled",
      occurrence: "manual:test",
      signal: controller.signal,
    });
    expect(result.outcome).toBe("cancelled");
  });
});
