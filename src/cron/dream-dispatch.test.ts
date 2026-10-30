import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import {
  addTask,
  DREAM_PLACEHOLDER_CRON,
  getScheduleTask,
  serializeDreamTaskPayload,
  updateTask,
} from "@/cron";
import { createCronSignalSource } from "@/cron/cron-signal";
import type { ScheduleTaskV2 } from "@/cron/cron-types";
import { executeRun } from "@/cron/scheduler-run";
import { evaluateSignals } from "@/cron/signal";
import {
  isScheduledTaskPreflightError,
  runScheduledTaskWithHost,
  type ScheduledTaskHostPort,
  ScheduledTaskPreflightError,
} from "@/cron/task-run";

const TEST_DIR = path.join(import.meta.dir, "__dream_dispatch_test_tmp__");
const origHome = process.env.HARUYUKI_HOME;

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

function addDreamTask(overrides: Record<string, unknown> = {}): string {
  const { task } = addTask({
    agent_id: "agent-dream",
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
    ...overrides,
  });
  return task.id;
}

function dreamTask(id?: string): ScheduleTaskV2 {
  const taskId = id ?? addDreamTask();
  const task = getScheduleTask(taskId);
  if (!task) throw new Error("dream task missing");
  return task;
}

// ── Dispatch (route C-13) ───────────────────────────────────────────

describe("dream dispatch never falls through to the prompt runner", () => {
  test("task-run routes a dream task to host.runDream", async () => {
    const task = dreamTask();
    const calls: string[] = [];
    const host: ScheduledTaskHostPort = {
      isTargetBusy: () => false,
      runPrompt: async () => {
        calls.push("prompt");
        return { outcome: "success" };
      },
      runDream: async () => {
        calls.push("dream");
        return { outcome: "success" };
      },
    };
    const result = await runScheduledTaskWithHost({
      task,
      runId: "run-1",
      occurrence: "dream:1",
      signal: new AbortController().signal,
      host,
      now: () => Date.now(),
    });
    expect(result.outcome).toBe("success");
    expect(calls).toEqual(["dream"]);
  });

  test("a host without runDream makes the run a typed pre-start failure (F1)", async () => {
    const task = dreamTask();
    let prompts = 0;
    const host: ScheduledTaskHostPort = {
      isTargetBusy: () => false,
      runPrompt: async () => {
        prompts += 1;
        return { outcome: "success" };
      },
    };
    let caught: unknown;
    try {
      await runScheduledTaskWithHost({
        task,
        runId: "run-2",
        occurrence: "dream:2",
        signal: new AbortController().signal,
        host,
        now: () => Date.now(),
      });
    } catch (error) {
      caught = error;
    }
    expect(prompts).toBe(0);
    expect(isScheduledTaskPreflightError(caught)).toBe(true);
    expect(caught instanceof ScheduledTaskPreflightError).toBe(true);
  });

  test("a dream task does not wait on a target conversation", async () => {
    const task = dreamTask();
    const host: ScheduledTaskHostPort = {
      isTargetBusy: () => true,
      runPrompt: async () => {
        throw new Error("must not run a prompt");
      },
      runDream: async () => ({ outcome: "success" }),
    };
    const result = await runScheduledTaskWithHost({
      task,
      runId: "run-3",
      occurrence: "dream:3",
      signal: new AbortController().signal,
      host,
      pollIntervalMs: 1,
      now: () => Date.now(),
    });
    expect(result.outcome).toBe("success");
  });
});

// ── Cron source skip (route C-37) ───────────────────────────────────

describe("cron source skips dream tasks", () => {
  test("even a dream record whose cron would be due produces no cron occurrence", () => {
    const id = addDreamTask();
    // Simulate a hand-edited/migrated store: the shape is still a dream task,
    // but the cron expression would be due on the next tick if the cron source
    // did not skip it.
    updateTask(id, (task) => {
      task.cron = "* * * * *";
      task.created_at = "2026-10-20T00:00:00.000Z";
      task.jitter_offset_ms = 0;
    });
    const task = getScheduleTask(id);
    if (!task) throw new Error("task missing");
    const evaluation = createCronSignalSource().evaluate({
      now: new Date("2026-10-30T10:00:00.000Z"),
      tasks: [task],
      state: { cursor: {} },
    });
    expect(evaluation.occurrences).toEqual([]);
    // Sanity: an ordinary prompt task with the same schedule is due.
    const { task: promptTask } = addTask({
      agent_id: "agent-dream",
      name: "Prompt",
      description: "",
      cron: "* * * * *",
      timezone: "UTC",
      recurring: true,
      prompt: "hi",
    });
    updateTask(promptTask.id, (record) => {
      record.created_at = "2026-10-20T00:00:00.000Z";
      record.jitter_offset_ms = 0;
    });
    const promptView = getScheduleTask(promptTask.id);
    if (!promptView) throw new Error("prompt task missing");
    const promptEvaluation = createCronSignalSource().evaluate({
      now: new Date("2026-10-30T10:00:00.000Z"),
      tasks: [promptView],
      state: { cursor: {} },
    });
    expect(promptEvaluation.occurrences).toHaveLength(1);
    expect(
      evaluateSignals({ now: new Date(), tasks: [], state: { cursor: {} } }),
    ).toEqual([]);
  });
});

// ── Core pre-start validation (route C-17) ─────────────────────────

describe("scheduler pre-start validation for dream tasks", () => {
  function runner() {
    const calls: string[] = [];
    return {
      calls,
      runner: {
        host: "short-lived" as const,
        async run(input: { task: ScheduleTaskV2 }) {
          calls.push(input.task.id);
          return { outcome: "success" as const };
        },
        cancel() {},
      },
    };
  }

  test("a dream task with the 30-minute default timeout is an F1 and never dispatched", async () => {
    const id = addDreamTask();
    updateTask(id, (task) => {
      task.timeout_minutes = 30;
    });
    const task = getScheduleTask(id);
    if (!task) throw new Error("task missing");
    const fake = runner();
    const result = await executeRun({
      task,
      occurrence: "dream:bad-timeout",
      runner: fake.runner,
      now: new Date(),
      consume: true,
    });
    expect(result.started).toBe(false);
    expect(result.outcome).toBe("failed");
    expect(fake.calls).toEqual([]);
    const after = getScheduleTask(id);
    expect(after?.failedCount).toBe(1);
    expect(after?.consecutiveFailures).toBe(1);
    expect(after?.lastError).toContain("timeout_minutes");
  });

  test("the documented shape dispatches exactly once", async () => {
    const task = dreamTask();
    const fake = runner();
    const result = await executeRun({
      task,
      occurrence: "dream:ok",
      runner: fake.runner,
      now: new Date(),
      consume: true,
    });
    expect(result.started).toBe(true);
    expect(fake.calls).toEqual([task.id]);
    const after = getScheduleTask(task.id);
    expect(after?.lastConsumedOccurrence).toBe("dream:ok");
    expect(after?.consecutiveFailures).toBe(0);
  });
});

// ── Creation validation ─────────────────────────────────────────────

describe("dream task creation validation", () => {
  function baseInput(): Parameters<typeof addTask>[0] {
    return {
      agent_id: "agent-dream",
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
    };
  }

  test("accepts the documented dream record", () => {
    const { task } = addTask(baseInput());
    expect(task.type).toBe("dream");
    expect(task.timeout_minutes).toBe(0);
    expect(task.target).toEqual({ kind: "new", hidden: true });
  });

  test("rejects an existing conversation target", () => {
    expect(() =>
      addTask({
        ...baseInput(),
        target: { kind: "existing", conversation_id: "conv-1" },
        conversation_id: "conv-1",
      }),
    ).toThrow(/hidden/);
  });

  test("rejects a non-hidden new target", () => {
    expect(() =>
      addTask({ ...baseInput(), target: { kind: "new", hidden: false } }),
    ).toThrow(/hidden/);
  });

  test("rejects a one-off dream task", () => {
    expect(() => addTask({ ...baseInput(), recurring: false })).toThrow(
      /recurring/,
    );
  });

  test("rejects the F-05 default timeout", () => {
    expect(() => addTask({ ...baseInput(), timeout_minutes: 30 })).toThrow(
      /timeout_minutes/,
    );
  });

  test("rejects a non-placeholder cron", () => {
    expect(() => addTask({ ...baseInput(), cron: "0 9 * * *" })).toThrow(
      /placeholder/,
    );
  });

  test("rejects a malformed payload", () => {
    expect(() => addTask({ ...baseInput(), payload: "{nope" })).toThrow(
      /payload/,
    );
  });
});
