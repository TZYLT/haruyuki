/**
 * F-06 M2 · dream run lease (route §2.4 / C-24 / C-25).
 *
 * The lease is the crash-recovery breadcrumb: run id, baseline SHA, hidden
 * conversation, owner identity and a heartbeat. The tests pin the round-trip,
 * the owner-liveness answer (dead pid = recoverable, own pid = live) and the
 * heartbeat/status updates the run controller writes as it progresses.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDreamLease,
  deleteDreamLease,
  getDreamLeasePath,
  heartbeatDreamLease,
  isDreamLeaseHeartbeatStale,
  isDreamLeaseOwnerAlive,
  listDreamLeases,
  readDreamLease,
  updateDreamLease,
} from "@/agent/dream/dream-lease";

const previousHaruyukiHome = process.env.HARUYUKI_HOME;
const root = mkdtempSync(join(tmpdir(), "hryk-dream-lease-"));
process.env.HARUYUKI_HOME = root;

afterAll(() => {
  if (previousHaruyukiHome === undefined) delete process.env.HARUYUKI_HOME;
  else process.env.HARUYUKI_HOME = previousHaruyukiHome;
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(join(root, "dream"), { recursive: true, force: true });
});

describe("dream lease", () => {
  test("create then read round-trips the run identity", () => {
    const now = new Date(1_700_000_000_000);
    const created = createDreamLease({
      agentId: "agent-a",
      runId: "run-1",
      taskId: "task-1",
      now,
    });
    expect(created.status).toBe("running");
    const read = readDreamLease("agent-a");
    expect(read).toMatchObject({
      agentId: "agent-a",
      runId: "run-1",
      taskId: "task-1",
      pid: process.pid,
      startedAt: now.getTime(),
      heartbeatAt: now.getTime(),
      conversationId: null,
      baselineSha: null,
    });
  });

  test("baseline and conversation are recorded as they appear", () => {
    createDreamLease({ agentId: "agent-a", runId: "run-1" });
    updateDreamLease("agent-a", { baselineSha: "abc123" });
    updateDreamLease("agent-a", {
      conversationId: "local-conv-1",
      status: "finishing",
    });
    const lease = readDreamLease("agent-a");
    expect(lease?.baselineSha).toBe("abc123");
    expect(lease?.conversationId).toBe("local-conv-1");
    expect(lease?.status).toBe("finishing");
  });

  test("heartbeat advances the stamp without touching identity", () => {
    createDreamLease({ agentId: "agent-a", runId: "run-1" });
    heartbeatDreamLease("agent-a", 9_999);
    const lease = readDreamLease("agent-a");
    expect(lease?.heartbeatAt).toBe(9_999);
    expect(lease?.runId).toBe("run-1");
    expect(lease?.status).toBe("running");
  });

  test("owner liveness: this process is alive, a dead pid is not", () => {
    createDreamLease({ agentId: "agent-a", runId: "run-1" });
    const lease = readDreamLease("agent-a");
    expect(lease).not.toBeNull();
    if (!lease) return;
    expect(isDreamLeaseOwnerAlive(lease)).toBe(true);
    expect(isDreamLeaseOwnerAlive({ ...lease, pid: 2_147_483_000 })).toBe(
      false,
    );
  });

  test("a stale heartbeat is detectable without claiming the owner is dead", () => {
    createDreamLease({ agentId: "agent-a", runId: "run-1", now: new Date(0) });
    const lease = readDreamLease("agent-a");
    expect(lease).not.toBeNull();
    if (!lease) return;
    expect(isDreamLeaseHeartbeatStale(lease, 10 * 60_000)).toBe(true);
    expect(isDreamLeaseOwnerAlive(lease)).toBe(true);
  });

  test("list returns every readable lease sorted by agent, delete removes one", () => {
    createDreamLease({ agentId: "agent-b", runId: "run-b" });
    createDreamLease({ agentId: "agent-a", runId: "run-a" });
    expect(listDreamLeases().map((lease) => lease.agentId)).toEqual([
      "agent-a",
      "agent-b",
    ]);
    deleteDreamLease("agent-a");
    expect(listDreamLeases().map((lease) => lease.agentId)).toEqual([
      "agent-b",
    ]);
    expect(readDreamLease("agent-a")).toBeNull();
  });

  test("updates to a missing lease are a no-op", () => {
    expect(
      updateDreamLease("agent-missing", { status: "finishing" }),
    ).toBeNull();
    expect(readDreamLease("agent-missing")).toBeNull();
  });

  test("the lease path stays inside the configured harness home", () => {
    expect(getDreamLeasePath("agent-a")).toContain(join(root, "dream", "runs"));
  });
});
