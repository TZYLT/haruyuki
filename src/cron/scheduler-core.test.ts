import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { addTask, getTask, updateTask } from "@/cron/cron-file";
import { readScheduleFile } from "@/cron/cron-store";
import type {
  AddTaskInput,
  ScheduleTaskV2,
  SignalSource,
  TaskRunnerPort,
} from "@/cron/cron-types";
import { getCronRunLogPath, readCronRunLogEntries } from "@/cron/run-log";
import {
  clearScheduleEventSubscribers,
  type ScheduleEvent,
  subscribeScheduleEvents,
} from "@/cron/schedule-events";
import {
  __resetSchedulerTickState,
  recordMissingScheduleRunner,
  runScheduledTaskNow,
  runSchedulerTick,
} from "@/cron/scheduler-core";
import {
  clearSignalSources,
  registerSignalSource,
  unregisterSignalSource,
} from "@/cron/signal";

// ── Fixture ─────────────────────────────────────────────────────────

const TEST_DIR = path.join(import.meta.dir, "__scheduler_core_test_tmp__");
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
  clearSignalSources();
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
  // Created well before the test clock so the current slot is eligible.
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
  impl?: (input: { task: ScheduleTaskV2; occurrence: string }) => Promise<{
    outcome: "success" | "failed" | "skipped" | "timeout" | "cancelled";
    conversationId?: string;
    error?: string;
  }>,
) {
  const calls: Array<{ task: ScheduleTaskV2; occurrence: string }> = [];
  const cancelled: string[] = [];
  const runner: TaskRunnerPort = {
    host,
    async run(input) {
      calls.push({ task: input.task, occurrence: input.occurrence });
      return impl ? impl(input) : { outcome: "success" as const };
    },
    cancel(runId: string) {
      cancelled.push(runId);
    },
  };
  return { runner, calls, cancelled };
}

function runLog(taskId: string) {
  return readCronRunLogEntries(getCronRunLogPath(taskId), { jobId: taskId });
}

// ── Tick ────────────────────────────────────────────────────────────

describe("runSchedulerTick", () => {
  test("runs a due task once, consumes the occurrence and records the run", async () => {
    const task = addRecord();
    const { runner, calls } = stubRunner("long-lived", async () => ({
      outcome: "success",
      conversationId: "conv-core",
    }));

    const result = await runSchedulerTick({ now: NOW, runner });

    expect(result.started?.id).toBe(task.id);
    expect(result.deferred).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.occurrence).toBe(
      "2026-10-28T14:05|UTC|2026-10-28T14:05:00.000Z",
    );

    const fresh = getTask(task.id);
    expect(fresh).toMatchObject({
      fire_count: 1,
      last_consumed_occurrence: "2026-10-28T14:05|UTC|2026-10-28T14:05:00.000Z",
      consecutive_failures: 0,
      status: "active",
      lease: null,
    });
    expect(fresh?.last_run_at).not.toBe(NOW.toISOString());
    expect(Date.parse(fresh?.last_run_at ?? "")).toBeGreaterThanOrEqual(
      NOW.getTime(),
    );
    expect(fresh?.last_outcome_v2).toBe("success");

    const entries = runLog(task.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      status: "ok",
      runOutcome: "success",
      host: "long-lived",
      conversationId: "conv-core",
    });
    expect(entries[0]?.runId).toBeTruthy();
    expect(entries[0]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(entries[0]?.runAtMs).toBeLessThanOrEqual(entries[0]?.ts ?? 0);

    expect(events.map((event) => event.kind)).toEqual([
      "run-started",
      "run-finished",
    ]);
    expect(events[1]).toMatchObject({
      outcome: "success",
      conversationId: "conv-core",
    });
  });

  test("does not rerun an occurrence that was already consumed", async () => {
    const task = addRecord();
    const { runner, calls } = stubRunner();

    await runSchedulerTick({ now: NOW, runner });
    const second = await runSchedulerTick({ now: NOW, runner });

    expect(second.started).toBeNull();
    expect(calls).toHaveLength(1);
    expect(getTask(task.id)?.fire_count).toBe(1);
    expect(runLog(task.id)).toHaveLength(1);
  });

  test("starts at most one task per tick and leaves the others deferred", async () => {
    const first = addRecord({ name: "First" });
    const second = addRecord({ name: "Second" });
    const { runner, calls } = stubRunner();

    const tickOne = await runSchedulerTick({ now: NOW, runner });
    expect(tickOne.started).not.toBeNull();
    expect(tickOne.deferred).toBe(1);
    expect(calls).toHaveLength(1);

    const startedIds = [
      getTask(first.id)?.fire_count,
      getTask(second.id)?.fire_count,
    ];
    expect(startedIds.filter((count) => count === 1)).toHaveLength(1);

    const tickTwo = await runSchedulerTick({ now: NOW, runner });
    expect(tickTwo.started).not.toBeNull();
    expect(calls).toHaveLength(2);
    const after = [
      getTask(first.id)?.fire_count,
      getTask(second.id)?.fire_count,
    ];
    expect(after).toEqual([1, 1]);
  });

  test("marks a successful one-shot as fired", async () => {
    const task = addRecord({
      recurring: false,
      scheduled_for: new Date(NOW.getTime() - 30_000),
      cron: "0 0 1 1 *",
    });
    const { runner } = stubRunner();

    await runSchedulerTick({ now: NOW, runner });

    const fresh = getTask(task.id);
    expect(fresh?.status).toBe("fired");
    expect(Date.parse(fresh?.fired_at ?? "")).toBeGreaterThanOrEqual(
      NOW.getTime(),
    );
    expect(fresh?.last_consumed_occurrence).toBe(
      task.scheduled_for ?? undefined,
    );
  });
});

// ── Failure classification ──────────────────────────────────────────

describe("failure classification", () => {
  test("F1: a non-whitelisted command fails before dispatch and is not retried for that slot", async () => {
    const task = addRecord({
      type: "command",
      payload: "/rm -rf everything",
      prompt: "/rm -rf everything",
      // A command task must target an existing conversation (R-5.5.1).
      conversation_id: "conv-existing-f1",
    });
    const { runner, calls } = stubRunner();

    const result = await runSchedulerTick({ now: NOW, runner });

    expect(result.started).toBeNull();
    expect(calls).toHaveLength(0);
    const fresh = getTask(task.id);
    expect(fresh?.consecutive_failures).toBe(1);
    expect(fresh?.failed_count).toBe(1);
    expect(fresh?.last_run_error).toContain("not allowed for unattended runs");
    expect(fresh?.last_outcome_v2).toBe("failed");
    // M1 #10: nothing was dispatched, so the fire counters stay untouched.
    expect(fresh?.fire_count).toBe(0);
    expect(fresh?.last_fired_at).toBeNull();
    expect(fresh?.last_consumed_occurrence).toBe(
      "2026-10-28T14:05|UTC|2026-10-28T14:05:00.000Z",
    );
    expect(runLog(task.id)).toHaveLength(1);
    expect(events.map((event) => event.kind)).not.toContain("run-started");
  });

  test("F2: three consecutive failures pause the task with a task-paused event", async () => {
    const task = addRecord();
    const { runner } = stubRunner("long-lived", async () => ({
      outcome: "failed",
      error: "model exploded",
    }));

    for (let minute = 0; minute < 3; minute += 1) {
      await runSchedulerTick({
        now: new Date(NOW.getTime() + minute * 60_000),
        runner,
      });
    }

    const fresh = getTask(task.id);
    expect(fresh).toMatchObject({
      status: "paused",
      paused_reason: "auto_failures",
      consecutive_failures: 3,
      failed_count: 3,
    });
    const paused = events.filter((event) => event.kind === "task-paused");
    expect(paused).toHaveLength(1);
    expect(paused[0]?.pausedReason).toBe("auto_failures");
    expect(runLog(task.id)).toHaveLength(3);
  });

  test("a success clears the failure streak", async () => {
    const task = addRecord();
    let fail = true;
    const { runner } = stubRunner("long-lived", async () =>
      fail
        ? { outcome: "failed" as const, error: "boom" }
        : { outcome: "success" as const },
    );

    await runSchedulerTick({ now: NOW, runner });
    await runSchedulerTick({ now: new Date(NOW.getTime() + 60_000), runner });
    expect(getTask(task.id)?.consecutive_failures).toBe(2);

    fail = false;
    await runSchedulerTick({ now: new Date(NOW.getTime() + 120_000), runner });
    expect(getTask(task.id)?.consecutive_failures).toBe(0);
    expect(getTask(task.id)?.status).toBe("active");
  });

  test("F3: a skipped run counts in neither direction", async () => {
    const task = addRecord();
    const { runner } = stubRunner("long-lived", async () => ({
      outcome: "skipped",
      error: "target conversation stayed busy",
    }));

    const result = await runSchedulerTick({ now: NOW, runner });

    expect(result.started?.id).toBe(task.id);
    const fresh = getTask(task.id);
    expect(fresh).toMatchObject({
      status: "active",
      consecutive_failures: 0,
      failed_count: 0,
      last_consumed_occurrence: "2026-10-28T14:05|UTC|2026-10-28T14:05:00.000Z",
    });
    expect(runLog(task.id)[0]?.status).toBe("skipped");
  });

  test("a lease held by another live run skips the tick without a record", async () => {
    const task = addRecord();
    setTask(task.id, (record) => {
      record.lease = {
        runId: "run-other-host",
        host: "short-lived",
        pid: process.pid,
        token: "other-token",
        occurrence: null,
        startedAt: NOW.toISOString(),
        heartbeatAt: NOW.toISOString(),
        expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
      };
    });
    const { runner, calls } = stubRunner();

    const result = await runSchedulerTick({ now: NOW, runner });

    expect(result.started).toBeNull();
    expect(result.skipped).toBe(1);
    expect(calls).toHaveLength(0);
    expect(runLog(task.id)).toHaveLength(0);
    const fresh = getTask(task.id);
    expect(fresh?.consecutive_failures).toBe(0);
    expect(fresh?.last_consumed_occurrence).toBeNull();
  });

  test("an expired lease is recorded as F2/lease_expired once and never reruns", async () => {
    const task = addRecord();
    setTask(task.id, (record) => {
      record.lease = {
        runId: "run-dead-host",
        host: "long-lived",
        pid: process.pid,
        token: "dead-token",
        // The crashed run held 14:05; recovery must consume it (P0-4).
        occurrence: "2026-10-28T14:05|UTC|2026-10-28T14:05:00.000Z",
        startedAt: "2026-10-28T13:00:00.000Z",
        heartbeatAt: "2026-10-28T13:00:00.000Z",
        expiresAt: "2026-10-28T13:01:00.000Z",
      };
    });
    const { runner, calls } = stubRunner();

    const first = await runSchedulerTick({ now: NOW, runner });
    expect(first.started).toBeNull();
    expect(calls).toHaveLength(0);

    const fresh = getTask(task.id);
    expect(fresh?.lease).toBeNull();
    expect(fresh?.consecutive_failures).toBe(1);
    expect(fresh?.last_consumed_occurrence).toBe(
      "2026-10-28T14:05|UTC|2026-10-28T14:05:00.000Z",
    );
    const entries = runLog(task.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      status: "error",
      error: "lease_expired",
      runId: "run-dead-host",
    });
    expect(
      events.filter((event) => event.kind === "run-finished"),
    ).toHaveLength(1);

    await runSchedulerTick({ now: new Date(NOW.getTime() + 60_000), runner });
    const expired = runLog(task.id).filter(
      (entry) => entry.error === "lease_expired",
    );
    expect(expired).toHaveLength(1);
  });
});

// ── Catch-up ────────────────────────────────────────────────────────

describe("catch-up", () => {
  test("catch_up=true replays only the newest missed slot, with its original intended time", async () => {
    const task = addRecord({ cron: "0 * * * *", catch_up: true });
    setTask(task.id, (record) => {
      record.last_consumed_occurrence =
        "2026-10-28T12:00|UTC|2026-10-28T12:00:00.000Z";
    });
    const { runner, calls } = stubRunner();

    const result = await runSchedulerTick({ now: NOW, runner });

    expect(result.started?.id).toBe(task.id);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.occurrence).toBe(
      "2026-10-28T14:00|UTC|2026-10-28T14:00:00.000Z",
    );
    const fresh = getTask(task.id);
    expect(fresh?.last_consumed_occurrence).toBe(
      "2026-10-28T14:00|UTC|2026-10-28T14:00:00.000Z",
    );
    expect(fresh?.missed_count).toBe(0);
    expect(fresh?.fire_count).toBe(1);
  });

  test("catch_up=false records every missed slot without running", async () => {
    const task = addRecord({ cron: "0 * * * *", catch_up: false });
    setTask(task.id, (record) => {
      record.last_consumed_occurrence =
        "2026-10-28T12:00|UTC|2026-10-28T12:00:00.000Z";
    });
    const { runner, calls } = stubRunner();

    const result = await runSchedulerTick({ now: NOW, runner });

    expect(result.started).toBeNull();
    expect(result.missed).toBe(1);
    expect(calls).toHaveLength(0);
    const fresh = getTask(task.id);
    // 13:00 and 14:00 were skipped; the occurrence cursor moved to the newest.
    expect(fresh?.missed_count).toBe(2);
    expect(fresh?.last_consumed_occurrence).toBe(
      "2026-10-28T14:00|UTC|2026-10-28T14:00:00.000Z",
    );
    expect(fresh?.status).toBe("active");
    const entries = runLog(task.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      status: "skipped",
      outcome: "missed",
      missedCount: 2,
    });
    expect(events.filter((event) => event.kind === "task-missed")).toHaveLength(
      1,
    );
  });

  test("an overdue one-shot with catch_up=false becomes missed", async () => {
    const scheduledFor = new Date(NOW.getTime() - 10 * 60_000);
    const task = addRecord({
      recurring: false,
      scheduled_for: scheduledFor,
      cron: "0 0 1 1 *",
      catch_up: false,
    });
    const { runner, calls } = stubRunner();

    await runSchedulerTick({ now: NOW, runner });

    expect(calls).toHaveLength(0);
    const fresh = getTask(task.id);
    expect(fresh?.status).toBe("missed");
    expect(fresh?.missed_count).toBe(1);
    expect(runLog(task.id)[0]).toMatchObject({
      status: "skipped",
      outcome: "missed",
    });
  });
});

// ── Manual run ──────────────────────────────────────────────────────

describe("runScheduledTaskNow", () => {
  test("runs a paused task without consuming its occurrence", async () => {
    const task = setTask(addRecord().id, (record) => {
      record.status = "paused";
      record.paused_reason = "manual";
    });
    const { runner, calls } = stubRunner("short-lived");

    const result = await runScheduledTaskNow({
      taskId: task.id,
      runner,
      now: NOW,
    });

    expect(result.started).toBe(true);
    expect(result.outcome).toBe("success");
    expect(calls).toHaveLength(1);
    const fresh = getTask(task.id);
    expect(fresh?.last_consumed_occurrence).toBeNull();
    expect(fresh?.status).toBe("paused");
    expect(fresh?.fire_count).toBe(1);
  });

  test("refuses a finished task and a missing one", async () => {
    const task = setTask(addRecord().id, (record) => {
      record.status = "fired";
    });
    const { runner } = stubRunner();
    expect(
      await runScheduledTaskNow({ taskId: task.id, runner, now: NOW }),
    ).toMatchObject({
      started: false,
      error: "Completed schedules cannot run again",
    });
    expect(
      await runScheduledTaskNow({ taskId: "missing", runner, now: NOW }),
    ).toMatchObject({ started: false, error: "Schedule not found" });
  });
});

// ── M1 #3: real finish time and duration ────────────────────────────

describe("M1 #3: real finish timestamps", () => {
  test("a slow run reports a finish after its start and a positive duration", async () => {
    addRecord();
    const { runner } = stubRunner("long-lived", async () => {
      await Bun.sleep(35);
      return { outcome: "success" };
    });

    await runSchedulerTick({ now: NOW, runner });

    const started = events.find((event) => event.kind === "run-started");
    const finished = events.find((event) => event.kind === "run-finished");
    expect(started?.at).toBeTruthy();
    expect(finished?.at).toBeTruthy();
    expect(Date.parse(finished?.at ?? "")).toBeGreaterThan(
      Date.parse(started?.at ?? ""),
    );
    const entry = runLog(events[0]?.taskId ?? "")[0];
    expect(entry?.durationMs ?? 0).toBeGreaterThanOrEqual(30);
    expect(entry?.firedAt).toBe(finished?.at);
  });
});

// ── M1 #5: a skipped one-shot is not a zombie ───────────────────────

describe("M1 #5: one-shot F3", () => {
  test("a skipped one-shot retries inside the grace window and then becomes missed", async () => {
    const scheduledFor = new Date(NOW.getTime() - 30_000);
    const task = addRecord({
      recurring: false,
      scheduled_for: scheduledFor,
      cron: "0 0 1 1 *",
      catch_up: false,
    });
    let skip = true;
    const { runner, calls } = stubRunner("long-lived", async () =>
      skip
        ? { outcome: "skipped" as const, error: "target busy" }
        : { outcome: "success" as const },
    );

    const first = await runSchedulerTick({ now: NOW, runner });
    expect(first.started?.id).toBe(task.id);
    let fresh = getTask(task.id);
    // F3 leaves the occurrence unconsumed so the next wake can retry it.
    expect(fresh?.status).toBe("active");
    expect(fresh?.last_consumed_occurrence).toBeNull();

    // Past the 90s window the retry is over: the task becomes a visible miss.
    skip = false;
    const second = await runSchedulerTick({
      now: new Date(NOW.getTime() + 70_000),
      runner,
    });
    expect(second.started).toBeNull();
    expect(calls).toHaveLength(1);
    fresh = getTask(task.id);
    expect(fresh?.status).toBe("missed");
    expect(fresh?.missed_count).toBe(1);
    expect(fresh?.last_consumed_occurrence).toBe(task.scheduled_for);
    expect(runLog(task.id).some((entry) => entry.outcome === "missed")).toBe(
      true,
    );
  });
});

// ── M1 #6: Q-42 queue delay is not a miss ───────────────────────────

describe("M1 #6: queue delay", () => {
  test("tasks queued behind another run are not recorded as missed", async () => {
    // A 5-minute cron keeps the *same* slot pending across the ticks below, so
    // the third task's slot is already older than the 90s grace when its turn
    // comes — the Q-42 shape the review probed.
    const first = addRecord({ name: "First", cron: "*/5 * * * *" });
    const second = addRecord({ name: "Second", cron: "*/5 * * * *" });
    const third = addRecord({ name: "Third", cron: "*/5 * * * *" });
    const { runner } = stubRunner();

    const tickOne = await runSchedulerTick({ now: NOW, runner });
    expect(tickOne.started).not.toBeNull();
    expect(tickOne.missed).toBe(0);
    expect(tickOne.deferred).toBe(2);

    const tickTwo = await runSchedulerTick({
      now: new Date(NOW.getTime() + 60_000),
      runner,
    });
    expect(tickTwo.missed).toBe(0);
    const tickThree = await runSchedulerTick({
      now: new Date(NOW.getTime() + 120_000),
      runner,
    });
    expect(tickThree.missed).toBe(0);

    for (const task of [first, second, third]) {
      const fresh = getTask(task.id);
      expect(fresh?.missed_count).toBe(0);
      expect(fresh?.fire_count).toBe(1);
    }
    for (const task of [first, second, third]) {
      expect(runLog(task.id).some((entry) => entry.outcome === "missed")).toBe(
        false,
      );
    }
  });

  test("a slot nobody was there for is still a miss", async () => {
    const task = addRecord({ cron: "0 * * * *", catch_up: false });
    setTask(task.id, (record) => {
      record.last_consumed_occurrence =
        "2026-10-28T12:00|UTC|2026-10-28T12:00:00.000Z";
    });
    const { runner } = stubRunner();

    const result = await runSchedulerTick({ now: NOW, runner });
    expect(result.missed).toBe(1);
    expect(getTask(task.id)?.missed_count).toBe(2);
  });
});

// ── M1 #12: missing runner is deduped and can pause ─────────────────

describe("M1 #12: recordMissingScheduleRunner", () => {
  test("one line per occurrence, and three consecutive occurrences auto-pause", async () => {
    const task = addRecord({ cron: "* * * * *" });

    expect(recordMissingScheduleRunner({ now: NOW })).toBe(1);
    // Same occurrence again: no duplicate line or counter bump.
    expect(recordMissingScheduleRunner({ now: NOW })).toBe(0);
    expect(recordMissingScheduleRunner({ now: NOW })).toBe(0);

    expect(
      recordMissingScheduleRunner({
        now: new Date(NOW.getTime() + 60_000),
      }),
    ).toBe(1);
    expect(
      recordMissingScheduleRunner({
        now: new Date(NOW.getTime() + 120_000),
      }),
    ).toBe(1);

    const fresh = getTask(task.id);
    expect(fresh?.consecutive_failures).toBe(3);
    expect(fresh?.failed_count).toBe(3);
    expect(fresh?.status).toBe("paused");
    expect(fresh?.paused_reason).toBe("auto_failures");
    expect(fresh?.last_outcome_v2).toBe("failed");
    expect(fresh?.last_run_error).toBe("No host runner is registered");
    expect(
      runLog(task.id).filter((entry) =>
        entry.error?.includes("No host runner"),
      ),
    ).toHaveLength(3);
    expect(events.filter((event) => event.kind === "task-paused")).toHaveLength(
      1,
    );
  });
});

// ── M1 #17: the tick persists source cursors ────────────────────────

describe("M1 #17: signal cursors", () => {
  test("a source cursor is written to signal_state in the same tick", async () => {
    addRecord();
    const source: SignalSource = {
      id: "synthetic-cursor",
      evaluate: () => ({ occurrences: [], nextCursor: "cursor-1" }),
      nextDueAt: () => null,
    };
    registerSignalSource(source);
    try {
      const { runner } = stubRunner();
      await runSchedulerTick({ now: NOW, runner });
      expect(readScheduleFile().signal_state.cursor["synthetic-cursor"]).toBe(
        "cursor-1",
      );
    } finally {
      unregisterSignalSource(source.id);
    }
  });
});

// ── P1-2: canRun defers a task to the owning host ───────────────────

describe("P1-2: runner.canRun delegation", () => {
  test("a task this host cannot run is deferred untouched and another task runs", async () => {
    const first = addRecord({ name: "Cannot run here" });
    const second = addRecord({ name: "Runs here" });
    const runs: string[] = [];
    const runner: TaskRunnerPort = {
      host: "long-lived",
      canRun: (task: ScheduleTaskV2) => task.id !== first.id,
      async run(input) {
        runs.push(input.task.id);
        return { outcome: "success" };
      },
      cancel() {},
    };

    const result = await runSchedulerTick({ now: NOW, runner });

    expect(result.deferredTaskIds).toEqual([first.id]);
    expect(runs).toEqual([second.id]);
    const untouched = getTask(first.id);
    expect(untouched).toMatchObject({
      lease: null,
      last_consumed_occurrence: null,
      fire_count: 0,
      consecutive_failures: 0,
    });
    expect(runLog(first.id)).toHaveLength(0);
    expect(
      events.some(
        (event) => event.taskId === first.id && event.kind === "run-started",
      ),
    ).toBe(false);
  });

  test("canRun=false never claims the task lease", async () => {
    const task = addRecord();
    const runner: TaskRunnerPort = {
      host: "long-lived",
      canRun: () => false,
      async run() {
        throw new Error("must not run");
      },
      cancel() {},
    };
    // A claim attempt would show up as a lease; assert the store stays clean.
    const before = readScheduleFile();
    const stored = before.tasks.find((candidate) => candidate.id === task.id);
    expect(stored?.lease ?? null).toBeNull();

    const result = await runSchedulerTick({ now: NOW, runner });
    expect(result.started).toBeNull();
    expect(result.deferred).toBe(1);
    expect(result.deferredTaskIds).toEqual([task.id]);
    const after = readScheduleFile().tasks.find((c) => c.id === task.id);
    expect(after?.lease ?? null).toBeNull();
    expect(after?.last_consumed_occurrence ?? null).toBeNull();
  });
});
