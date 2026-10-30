/**
 * F-06 failure accounting split (Lead ruling, T1 M1): a crashed dream run's F2 is
 * counted by the F-05 **task-lease** recovery (`cron/scheduler-recovery`), not by
 * M2's `agent/dream/dream-recovery` (which only repairs the dream-specific
 * state: rollback, `unfinished`, report, lease deletion). Both sides agree on
 * "exactly once", and this file pins the scheduler half for a dream task so a
 * later refactor cannot silently double-count or drop it.
 */
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
import { recoverExpiredLeases } from "@/cron/scheduler-recovery";

const TEST_DIR = path.join(import.meta.dir, "__dream_f2_test_tmp__");
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

/** Simulate a dream child that died mid-run: its task lease is simply left. */
function leaveCrashedLease(taskId: string, now: Date, attempt = 1): void {
  const startedAt = new Date(now.getTime() - 5 * 60_000).toISOString();
  const expiredAt = new Date(now.getTime() - 60_000).toISOString();
  updateTask(taskId, (task) => {
    task.lease = {
      runId: `crashed-dream-run-${attempt}`,
      host: "short-lived",
      // A dead PID is not required: an expired lease is already not live.
      pid: 999_999,
      token: `crashed-token-${attempt}`,
      occurrence: `dream:crashed-${attempt}`,
      startedAt,
      heartbeatAt: startedAt,
      expiresAt: expiredAt,
    };
  });
}

describe("a crashed dream run is one F2, counted by task-lease recovery", () => {
  test("the expired dream lease becomes exactly one F2 and consumes the occurrence", () => {
    const taskId = addDreamTask();
    const now = new Date();
    leaveCrashedLease(taskId, now);

    const view = getScheduleTask(taskId);
    if (!view) throw new Error("task missing");
    const recovered = recoverExpiredLeases([view], now);
    expect(recovered).toBe(1);

    const after = getScheduleTask(taskId);
    expect(after?.lease).toBeNull();
    expect(after?.failedCount).toBe(1);
    expect(after?.consecutiveFailures).toBe(1);
    expect(after?.lastOutcome).toBe("failed");
    expect(after?.lastReason).toBe("scheduler_error");
    expect(after?.lastError).toBe("lease_expired");
    // The occurrence the dead run held is consumed: it must never be replayed.
    expect(after?.lastConsumedOccurrence).toBe("dream:crashed-1");
  });

  test("a second recovery pass does not count the same crash twice", () => {
    const taskId = addDreamTask();
    const now = new Date();
    leaveCrashedLease(taskId, now);
    const first = getScheduleTask(taskId);
    if (!first) throw new Error("task missing");
    recoverExpiredLeases([first], now);

    const second = getScheduleTask(taskId);
    if (!second) throw new Error("task missing");
    expect(
      recoverExpiredLeases([second], new Date(now.getTime() + 1_000)),
    ).toBe(0);
    const after = getScheduleTask(taskId);
    expect(after?.failedCount).toBe(1);
    expect(after?.consecutiveFailures).toBe(1);
  });

  test("three crashed dream runs pause the task (the normal F2 streak)", () => {
    const taskId = addDreamTask();
    const now = new Date();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const at = new Date(now.getTime() + attempt * 1_000);
      leaveCrashedLease(taskId, at, attempt + 1);
      const view = getScheduleTask(taskId);
      if (!view) throw new Error("task missing");
      recoverExpiredLeases([view], at);
    }
    const after = getScheduleTask(taskId);
    expect(after?.failedCount).toBe(3);
    expect(after?.status).toBe("paused");
    expect(after?.pausedReason).toBe("auto_failures");
  });
});
