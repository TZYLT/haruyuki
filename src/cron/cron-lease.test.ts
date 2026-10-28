import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { addTask } from "@/cron/cron-file";
import {
  claimTaskLease,
  heartbeatTaskLease,
  isTaskLeaseLive,
  releaseTaskLease,
} from "@/cron/cron-lease";
import { getScheduleTask, updateScheduleTask } from "@/cron/cron-store";

// ── Test setup ──────────────────────────────────────────────────────

const TEST_DIR = path.join(import.meta.dir, "__cron_lease_test_tmp__");
const origHome = process.env.HARUYUKI_HOME;

beforeEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.HARUYUKI_HOME = TEST_DIR;
});

afterEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
  if (origHome) process.env.HARUYUKI_HOME = origHome;
  else delete process.env.HARUYUKI_HOME;
});

function createTask(): string {
  return addTask({
    agent_id: "agent-lease-test",
    conversation_id: "new",
    name: "Lease test",
    description: "",
    cron: "0 9 * * *",
    recurring: true,
    prompt: "hello",
  }).task.id;
}

function expireLease(taskId: string): void {
  updateScheduleTask(taskId, (task) => {
    if (task.lease) {
      task.lease.expiresAt = new Date(Date.now() - 1_000).toISOString();
    }
  });
}

// ── Claim ───────────────────────────────────────────────────────────

describe("claimTaskLease", () => {
  test("a second claim is refused while the first lease is live", () => {
    const taskId = createTask();

    const first = claimTaskLease({
      taskId,
      runId: "run-1",
      host: "long-lived",
    });
    expect(first.claimed).toBe(true);
    if (!first.claimed) throw new Error("expected the first claim to win");

    const second = claimTaskLease({
      taskId,
      runId: "run-2",
      host: "short-lived",
    });
    expect(second.claimed).toBe(false);
    if (second.claimed) throw new Error("expected the second claim to lose");
    expect(second.reason).toBe("held");
    expect(second.holder?.runId).toBe("run-1");

    // The lease is on the task, not in memory.
    expect(getScheduleTask(taskId)?.lease?.runId).toBe("run-1");
  });

  test("an unknown task cannot be claimed", () => {
    expect(
      claimTaskLease({ taskId: "missing", runId: "run-1", host: "long-lived" }),
    ).toEqual({ claimed: false, reason: "missing" });
  });

  test("an expired lease can be taken over (Q-58 decides what to record)", () => {
    const taskId = createTask();
    claimTaskLease({ taskId, runId: "run-1", host: "long-lived" });
    expireLease(taskId);

    const next = claimTaskLease({
      taskId,
      runId: "run-2",
      host: "short-lived",
    });

    expect(next.claimed).toBe(true);
    if (!next.claimed)
      throw new Error("expected the expired lease to be taken");
    expect(next.lease.runId).toBe("run-2");
    expect(getScheduleTask(taskId)?.lease?.runId).toBe("run-2");
  });

  test("a lease whose holder process is gone is not live", () => {
    const taskId = createTask();
    claimTaskLease({ taskId, runId: "run-1", host: "short-lived" });
    updateScheduleTask(taskId, (task) => {
      if (task.lease) task.lease.pid = 999_999_999;
    });

    const next = claimTaskLease({
      taskId,
      runId: "run-2",
      host: "long-lived",
    });

    expect(next.claimed).toBe(true);
  });

  test("isTaskLeaseLive reads expiry, not just presence", () => {
    const live = {
      runId: "run-1",
      host: "long-lived" as const,
      pid: process.pid,
      token: "tok",
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };

    expect(isTaskLeaseLive(live)).toBe(true);
    expect(isTaskLeaseLive({ ...live, expiresAt: "not a date" })).toBe(false);
    expect(
      isTaskLeaseLive({
        ...live,
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    ).toBe(false);
    expect(isTaskLeaseLive(null)).toBe(false);
  });
});

// ── Heartbeat and release ───────────────────────────────────────────

describe("heartbeat and release", () => {
  test("only the token holder can heartbeat, and it extends the expiry", () => {
    const taskId = createTask();
    const claim = claimTaskLease({
      taskId,
      runId: "run-1",
      host: "long-lived",
    });
    if (!claim.claimed) throw new Error("expected a claim");

    const before = getScheduleTask(taskId)?.lease?.expiresAt;
    expect(heartbeatTaskLease(taskId, "someone-else")).toBe(false);

    const heartbeatAt = new Date(Date.now() + 5_000);
    expect(heartbeatTaskLease(taskId, claim.lease.token, heartbeatAt)).toBe(
      true,
    );
    const after = getScheduleTask(taskId)?.lease;
    expect(after?.heartbeatAt).toBe(heartbeatAt.toISOString());
    expect(after?.expiresAt).not.toBe(before);
  });

  test("only the token holder can release, and releasing clears the lease", () => {
    const taskId = createTask();
    const claim = claimTaskLease({
      taskId,
      runId: "run-1",
      host: "long-lived",
    });
    if (!claim.claimed) throw new Error("expected a claim");

    expect(releaseTaskLease(taskId, "someone-else")).toBe(false);
    expect(getScheduleTask(taskId)?.lease).not.toBeNull();

    expect(releaseTaskLease(taskId, claim.lease.token)).toBe(true);
    expect(getScheduleTask(taskId)?.lease).toBeNull();

    // Released means claimable again.
    expect(
      claimTaskLease({ taskId, runId: "run-2", host: "short-lived" }).claimed,
    ).toBe(true);
  });
});
