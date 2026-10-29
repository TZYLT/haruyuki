import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { addTask } from "@/cron/cron-file";
import {
  claimTaskLease,
  heartbeatTaskLease,
  isTaskLeaseLive,
  recoverExpiredTaskLease,
  releaseTaskLease,
  withLock,
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
      occurrence: null,
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

// ── P0-1: cross-process lock and claim ──────────────────────────────
//
// These spawn real OS processes: the properties under test (atomic rename
// acquisition, stale steal, one claimant) cannot be exercised inside a single
// process.

const LOCK_PROBE = `
import { withLock } from "@/cron/cron-lock";
import { appendFileSync } from "node:fs";
const out = process.argv[2] as string;
withLock(() => {
  appendFileSync(out, "in" + String.fromCharCode(10));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350);
  appendFileSync(out, "out" + String.fromCharCode(10));
});
`;

const CLAIM_PROBE = `
import { claimTaskLease } from "@/cron/cron-lease";
import { existsSync, writeFileSync } from "node:fs";
const [dir, taskId, runId] = process.argv.slice(2);
const pause = (ms: number) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const waitFor = (file: string): boolean => {
  for (let attempt = 0; attempt < 800; attempt += 1) {
    if (existsSync(file)) return true;
    pause(25);
  }
  return false;
};
writeFileSync(dir + "/ready." + process.pid, "");
if (!waitFor(dir + "/start")) throw new Error("start barrier timed out");
const result = claimTaskLease({
  taskId,
  runId,
  host: "short-lived",
  occurrence: "2026-01-01T09:00",
});
writeFileSync(
  dir + "/result." + process.pid,
  JSON.stringify({
    runId,
    claimed: result.claimed,
    reason: result.claimed ? null : result.reason,
  }),
);
// The winner keeps its live lease until both claims were recorded, so the
// loser must observe "held" instead of taking over a dead holder.
if (result.claimed) waitFor(dir + "/release");
`;

function writeProbe(name: string, source: string): string {
  const file = path.join(TEST_DIR, name);
  writeFileSync(file, source);
  return file;
}

async function spawnProbes(
  script: string,
  argSets: string[][],
): Promise<{ code: number; stdout: string; stderr: string }[]> {
  const children = argSets.map((args) =>
    Bun.spawn([process.execPath, script, ...args], {
      cwd: process.cwd(),
      env: { ...process.env, HARUYUKI_HOME: TEST_DIR },
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  return Promise.all(
    children.map(async (child) => ({
      code: await child.exited,
      stdout: await new Response(child.stdout).text(),
      stderr: await new Response(child.stderr).text(),
    })),
  );
}

describe("P0-1: cross-process locking", () => {
  test("two processes serialize on crons.lock", async () => {
    const script = writeProbe("lock-probe.ts", LOCK_PROBE);
    const log = path.join(TEST_DIR, "lock-log.txt");
    writeFileSync(log, "");

    const results = await spawnProbes(script, [[log], [log]]);

    expect(results.map((result) => result.code)).toEqual([0, 0]);
    const lines = readFileSync(log, "utf-8").trim().split("\n");
    // in/in/out/out would mean two processes held the lock at the same time.
    expect(lines).toEqual(["in", "out", "in", "out"]);
  }, 30_000);

  test("two processes cannot claim the same occurrence", async () => {
    const taskId = createTask();
    const dir = path.join(TEST_DIR, "claim-probe");
    mkdirSync(dir, { recursive: true });
    const script = writeProbe("claim-probe.ts", CLAIM_PROBE);

    const children = ["run-a", "run-b"].map((runId) =>
      Bun.spawn([process.execPath, script, dir, taskId, runId], {
        cwd: process.cwd(),
        env: { ...process.env, HARUYUKI_HOME: TEST_DIR },
        stdout: "pipe",
        stderr: "pipe",
      }),
    );

    const list = (prefix: string) =>
      readdirSync(dir).filter((name) => name.startsWith(prefix));
    const waitForFiles = async (predicate: () => boolean): Promise<void> => {
      for (let attempt = 0; attempt < 800; attempt += 1) {
        if (predicate()) return;
        await Bun.sleep(25);
      }
      throw new Error("barrier timed out");
    };

    // Both children are up before either claims, so the race is real.
    await waitForFiles(() => list("ready.").length === 2);
    writeFileSync(path.join(dir, "start"), "");
    await waitForFiles(() => list("result.").length === 2);
    writeFileSync(path.join(dir, "release"), "");

    expect(await Promise.all(children.map((child) => child.exited))).toEqual([
      0, 0,
    ]);

    const claims = list("result.").map(
      (name) =>
        JSON.parse(readFileSync(path.join(dir, name), "utf-8")) as {
          claimed?: boolean;
          reason?: string | null;
        },
    );
    expect(claims.filter((claim) => claim.claimed)).toHaveLength(1);
    expect(claims.filter((claim) => claim.reason === "held")).toHaveLength(1);
    const lease = getScheduleTask(taskId)?.lease;
    expect(lease?.occurrence).toBe("2026-01-01T09:00");
    expect(["run-a", "run-b"]).toContain(lease?.runId ?? "");
  }, 40_000);

  test("a stale lock is stolen and re-acquired", () => {
    const lockDir = path.join(TEST_DIR, "crons.lock");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      path.join(lockDir, "owner.json"),
      JSON.stringify({
        pid: 999_999_999,
        token: "dead-owner",
        acquired_at: Date.now() - 60_000,
      }),
    );

    expect(withLock(() => "acquired")).toBe("acquired");
    expect(existsSync(lockDir)).toBe(false);
  });
});

// ── Task lease recovery (P0-4) ──────────────────────────────────────

describe("recoverExpiredTaskLease", () => {
  test("clears a dead lease, consumes its occurrence, and records once", () => {
    const taskId = createTask();
    const claim = claimTaskLease({
      taskId,
      runId: "run-dead",
      host: "short-lived",
      occurrence: "2026-01-01T09:00",
    });
    if (!claim.claimed) throw new Error("expected a claim");
    updateScheduleTask(taskId, (task) => {
      if (!task.lease) return;
      task.lease.pid = 999_999_999;
      task.lease.expiresAt = new Date(Date.now() - 60_000).toISOString();
    });

    const seen: string[] = [];
    const recovered = recoverExpiredTaskLease(
      taskId,
      new Date(),
      (view, lease) => {
        seen.push(lease.runId);
        view.consecutiveFailures += 1;
        view.failedCount += 1;
        view.lastError = "lease_expired";
      },
    );

    expect(recovered?.runId).toBe("run-dead");
    const task = getScheduleTask(taskId);
    expect(task?.lease).toBeNull();
    // The crashed run's occurrence is consumed: catch_up cannot replay it.
    expect(task?.lastConsumedOccurrence).toBe("2026-01-01T09:00");
    expect(task?.consecutiveFailures).toBe(1);

    // A second host racing recovery finds nothing to do.
    expect(
      recoverExpiredTaskLease(taskId, new Date(), () => {
        throw new Error("must not recover twice");
      }),
    ).toBeNull();
    expect(seen).toEqual(["run-dead"]);
  });

  test("leaves a live lease alone", () => {
    const taskId = createTask();
    claimTaskLease({ taskId, runId: "run-live", host: "long-lived" });

    expect(
      recoverExpiredTaskLease(taskId, new Date(), () => {
        throw new Error("must not recover a live lease");
      }),
    ).toBeNull();
    expect(getScheduleTask(taskId)?.lease?.runId).toBe("run-live");
  });
});

// ── Claim dedup, heartbeat expiry, fresh home ───────────────────────

describe("lease edge cases", () => {
  test("an expired lease cannot be revived by a heartbeat (M0 F-10)", () => {
    const taskId = createTask();
    const claim = claimTaskLease({
      taskId,
      runId: "run-1",
      host: "long-lived",
    });
    if (!claim.claimed) throw new Error("expected a claim");
    updateScheduleTask(taskId, (task) => {
      if (task.lease) {
        task.lease.expiresAt = new Date(Date.now() - 1_000).toISOString();
      }
    });

    expect(heartbeatTaskLease(taskId, claim.lease.token)).toBe(false);
  });

  test("claims refuse an already-consumed occurrence", () => {
    const taskId = createTask();
    updateScheduleTask(taskId, (task) => {
      task.lastConsumedOccurrence = "2026-01-01T09:05";
    });

    const stale = claimTaskLease({
      taskId,
      runId: "run-1",
      host: "long-lived",
      occurrence: "2026-01-01T09:00",
    });
    expect(stale.claimed).toBe(false);
    if (!stale.claimed) expect(stale.reason).toBe("consumed");

    const next = claimTaskLease({
      taskId,
      runId: "run-2",
      host: "long-lived",
      occurrence: "2026-01-01T09:10",
    });
    expect(next.claimed).toBe(true);
  });

  test("a fresh harness root is created on demand (M0 F-08)", () => {
    const freshHome = path.join(TEST_DIR, "nested", "fresh-home");
    process.env.HARUYUKI_HOME = freshHome;
    expect(existsSync(freshHome)).toBe(false);

    const task = addTask({
      agent_id: "agent-fresh",
      conversation_id: "new",
      name: "Fresh home",
      description: "",
      cron: "0 9 * * *",
      recurring: true,
      prompt: "hello",
    }).task;

    expect(task.id).toBeTruthy();
    expect(existsSync(path.join(freshHome, "schedules.json"))).toBe(true);
  });
});
