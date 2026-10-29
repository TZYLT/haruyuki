import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { addTask, getTask, updateTask } from "@/cron/cron-file";
import { recoverExpiredTaskLease } from "@/cron/cron-lease";
import { getScheduleFilePath } from "@/cron/cron-store";
import type { AddTaskInput, TaskRunnerPort } from "@/cron/cron-types";
import { TASK_LEASE_HEARTBEAT_MS } from "@/cron/cron-types";
import { getCronRunLogPath, readCronRunLogEntries } from "@/cron/run-log";
import {
  clearScheduleEventSubscribers,
  type ScheduleEvent,
  subscribeScheduleEvents,
} from "@/cron/schedule-events";
import {
  __resetSchedulerTickState,
  runSchedulerTick,
} from "@/cron/scheduler-core";

// ── Fixture ─────────────────────────────────────────────────────────

const TEST_DIR = path.join(import.meta.dir, "__scheduler_recovery_test_tmp__");
const origHome = process.env.HARUYUKI_HOME;
let events: ScheduleEvent[] = [];

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.HARUYUKI_HOME = TEST_DIR;
  events = [];
  subscribeScheduleEvents((event) => events.push(event));
  __resetSchedulerTickState();
});

afterEach(() => {
  clearScheduleEventSubscribers();
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  if (origHome) process.env.HARUYUKI_HOME = origHome;
  else delete process.env.HARUYUKI_HOME;
});

const NOW = new Date("2026-10-28T14:05:00.000Z");

function addRecord(overrides: Partial<AddTaskInput> = {}) {
  const { task } = addTask({
    agent_id: "agent-local-core",
    conversation_id: "new",
    name: "Core task",
    description: "",
    cron: "* * * * *",
    timezone: "UTC",
    recurring: true,
    prompt: "hello",
    ...overrides,
  });
  updateTask(task.id, (record) => {
    record.created_at = "2026-10-20T00:00:00.000Z";
    record.jitter_offset_ms = 0;
  });
  const fresh = getTask(task.id);
  if (!fresh) throw new Error("task was not persisted");
  return fresh;
}

function setTask(
  taskId: string,
  update: (record: NonNullable<ReturnType<typeof getTask>>) => void,
) {
  updateTask(taskId, update);
  const fresh = getTask(taskId);
  if (!fresh) throw new Error("task was not persisted");
  return fresh;
}

function stubRunner(
  host: TaskRunnerPort["host"] = "long-lived",
  impl?: (input: { task: unknown; occurrence: string }) => Promise<{
    outcome: "success" | "failed" | "skipped" | "timeout" | "cancelled";
    conversationId?: string;
    error?: string;
  }>,
) {
  const calls: Array<{ occurrence: string }> = [];
  const runner: TaskRunnerPort = {
    host,
    async run(input) {
      calls.push({ occurrence: input.occurrence });
      return impl ? impl(input) : { outcome: "success" as const };
    },
    cancel() {},
  };
  return { runner, calls };
}

function runLog(taskId: string) {
  return readCronRunLogEntries(getCronRunLogPath(taskId), { jobId: taskId });
}

// ── P0-4: recovery consumes the dead run's occurrence ───────────────

const HOUR = 3_600_000;

function deadLease(occurrence: string | null, runId: string) {
  return {
    runId,
    host: "long-lived" as const,
    pid: process.pid,
    token: `token-${runId}`,
    occurrence,
    startedAt: new Date(NOW.getTime() - HOUR).toISOString(),
    heartbeatAt: new Date(NOW.getTime() - HOUR).toISOString(),
    expiresAt: new Date(NOW.getTime() - 30 * 60_000).toISOString(),
  };
}

describe("P0-4: dead-lease recovery", () => {
  test("a crashed claim is recovered once, consumed, and never replayed even with catch_up", async () => {
    const task = addRecord({ cron: "0 * * * *", catch_up: true });
    const occurrence = "2026-10-28T14:00|UTC|2026-10-28T14:00:00.000Z";
    setTask(task.id, (record) => {
      record.last_consumed_occurrence =
        "2026-10-28T12:00|UTC|2026-10-28T12:00:00.000Z";
      record.lease = deadLease(occurrence, "run-crashed");
    });
    const { runner, calls } = stubRunner();

    const first = await runSchedulerTick({ now: NOW, runner });
    expect(first.started).toBeNull();
    expect(calls).toHaveLength(0);
    const fresh = getTask(task.id);
    expect(fresh?.lease).toBeNull();
    expect(fresh?.last_consumed_occurrence).toBe(occurrence);
    expect(fresh?.consecutive_failures).toBe(1);
    expect(
      runLog(task.id).filter((e) => e.error === "lease_expired"),
    ).toHaveLength(1);

    // The catch-up slot was consumed by recovery, so the next tick has nothing
    // to replay.
    const second = await runSchedulerTick({
      now: new Date(NOW.getTime() + 60_000),
      runner,
    });
    expect(second.started).toBeNull();
    expect(calls).toHaveLength(0);
    expect(fresh?.fire_count).toBe(0);
    expect(
      runLog(task.id).filter((e) => e.error === "lease_expired"),
    ).toHaveLength(1);
  });

  test("recovery runs the shared 3-strike accounting and the visible outcome (M1 #9)", async () => {
    const task = addRecord({ cron: "0 * * * *" });
    const occurrences = [
      "2026-10-28T12:00|UTC|2026-10-28T12:00:00.000Z",
      "2026-10-28T13:00|UTC|2026-10-28T13:00:00.000Z",
      "2026-10-28T14:00|UTC|2026-10-28T14:00:00.000Z",
    ];
    const { runner } = stubRunner();
    for (let round = 0; round < 3; round += 1) {
      setTask(task.id, (record) => {
        record.lease = deadLease(
          occurrences[round] ?? null,
          `run-dead-${round}`,
        );
      });
      await runSchedulerTick({
        now: new Date(NOW.getTime() + round * HOUR),
        runner,
      });
    }

    const fresh = getTask(task.id);
    expect(fresh).toMatchObject({
      status: "paused",
      paused_reason: "auto_failures",
      consecutive_failures: 3,
      failed_count: 3,
      last_run_error: "lease_expired",
      last_outcome_v2: "failed",
    });
    expect(events.filter((event) => event.kind === "task-paused")).toHaveLength(
      1,
    );
    expect(
      runLog(task.id).filter((entry) => entry.error === "lease_expired"),
    ).toHaveLength(3);
  });

  test("two hosts racing recovery record the dead lease only once", async () => {
    const task = addRecord({ cron: "0 * * * *" });
    setTask(task.id, (record) => {
      record.lease = deadLease(
        "2026-10-28T14:00|UTC|2026-10-28T14:00:00.000Z",
        "run-race",
      );
    });

    const first = recoverExpiredTaskLease(task.id, NOW, () => {});
    const second = recoverExpiredTaskLease(task.id, NOW, () => {});
    expect(first?.runId).toBe("run-race");
    expect(second).toBeNull();
  });
});

// ── P0-5: heartbeat failures never escape ───────────────────────────

function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error("waitFor timed out"));
        return;
      }
      setTimeout(poll, 5);
    };
    poll();
  });
}

describe("P0-5: heartbeat safety", () => {
  test("a throwing heartbeat body is treated as lease loss, never escapes", async () => {
    const task = addRecord({ cron: "* * * * *" });
    const storePath = getScheduleFilePath();
    const releaseRunners: Array<(result: { outcome: "success" }) => void> = [];
    const runner: TaskRunnerPort = {
      host: "long-lived",
      run: () =>
        new Promise((resolve) => {
          releaseRunners.push(resolve);
        }),
      cancel() {},
    };

    const realSetInterval = globalThis.setInterval;
    const heartbeats: Array<() => void> = [];
    globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
      const handle = realSetInterval(...args);
      if (
        typeof args[0] === "function" &&
        Number(args[1] ?? 0) === TASK_LEASE_HEARTBEAT_MS
      ) {
        heartbeats.push(args[0] as () => void);
      }
      return handle;
    }) as typeof setInterval;

    const realNow = new Date();
    try {
      const tickPromise = runSchedulerTick({ now: realNow, runner });
      await waitFor(() => getTask(task.id)?.lease != null);
      const storeBytes = readFileSync(storePath, "utf-8");
      // Corrupt the store: the heartbeat's locked read now throws.
      writeFileSync(storePath, "{ this is not json");
      expect(heartbeats.length).toBeGreaterThan(0);
      expect(() => heartbeats[0]?.()).not.toThrow();
      expect(() => getTask(task.id)).toThrow();

      // Restore the store so accounting can finish, then let the run end.
      writeFileSync(storePath, storeBytes);
      releaseRunners[0]?.({ outcome: "success" });
      await tickPromise;

      const fresh = getTask(task.id);
      // The throw was folded into lease loss: the run is recorded as F2 and the
      // host survived.
      expect(fresh?.last_run_error).toBe("lease_expired");
      expect(fresh?.last_outcome_v2).toBe("failed");
    } finally {
      globalThis.setInterval = realSetInterval;
    }
  });

  test("an expired lease aborts and cancels the run", async () => {
    const task = addRecord({ cron: "* * * * *" });
    const cancels: string[] = [];
    const releaseRunners: Array<(result: { outcome: "success" }) => void> = [];
    const runner: TaskRunnerPort = {
      host: "long-lived",
      run: () =>
        new Promise((resolve) => {
          releaseRunners.push(resolve);
        }),
      cancel(runId) {
        cancels.push(runId);
      },
    };
    const realSetInterval = globalThis.setInterval;
    const heartbeats: Array<() => void> = [];
    globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
      const handle = realSetInterval(...args);
      if (
        typeof args[0] === "function" &&
        Number(args[1] ?? 0) === TASK_LEASE_HEARTBEAT_MS
      ) {
        heartbeats.push(args[0] as () => void);
      }
      return handle;
    }) as typeof setInterval;

    const realNow = new Date();
    try {
      const tickPromise = runSchedulerTick({ now: realNow, runner });
      // Wait for the lease to exist, then expire it.
      await waitFor(() => getTask(task.id)?.lease != null);
      updateTask(task.id, (record) => {
        if (!record.lease) return;
        record.lease.expiresAt = new Date(Date.now() - 1_000).toISOString();
      });
      expect(heartbeats.length).toBeGreaterThan(0);
      heartbeats[0]?.();
      expect(cancels).toHaveLength(1);

      releaseRunners[0]?.({ outcome: "success" });
      await tickPromise;
      const fresh = getTask(task.id);
      expect(fresh?.last_run_error).toBe("lease_expired");
      expect(fresh?.last_outcome_v2).toBe("failed");
    } finally {
      globalThis.setInterval = realSetInterval;
    }
  });
});
