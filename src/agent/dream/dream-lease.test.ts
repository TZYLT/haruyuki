/**
 * F-06 M2 · dream run lease (route §2.4 / C-24 / C-25).
 *
 * The lease is the crash-recovery breadcrumb: run id, baseline SHA, hidden
 * conversation, owner identity and a heartbeat. The tests pin the round-trip,
 * the owner-liveness answer (dead pid = recoverable, own pid = live) and the
 * heartbeat/status updates the run controller writes as it progresses.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

  // ── T-01 (47-2 G-1): the status fields are optional add-ons, not a version ──
  test("T-01 fields round-trip through the lease without a version bump", () => {
    createDreamLease({ agentId: "agent-a", runId: "run-1" });
    updateDreamLease("agent-a", {
      tier: "think",
      spentTokens: 504,
      budgetTokens: 1200,
    });
    expect(readDreamLease("agent-a")).toMatchObject({
      version: 1,
      tier: "think",
      spentTokens: 504,
      budgetTokens: 1200,
    });
  });

  test("a lease written before T-01 still reads: absent fields stay undefined", () => {
    // The exact pre-T-01 key set (plus a future key the reader must ignore):
    // read side must not throw or invent a default tier.
    const legacy = {
      version: 1,
      agentId: "agent-legacy",
      runId: "run-legacy",
      taskId: null,
      pid: process.pid,
      processStartedAt: null,
      processStartTicks: null,
      bootId: null,
      startedAt: 1_700_000_000_000,
      heartbeatAt: 1_700_000_000_000,
      status: "running",
      conversationId: null,
      baselineSha: null,
      someFutureField: "ignored",
    };
    mkdirSync(join(root, "dream", "runs"), { recursive: true });
    writeFileSync(
      getDreamLeasePath("agent-legacy"),
      `${JSON.stringify(legacy, null, 2)}\n`,
    );
    const read = readDreamLease("agent-legacy");
    expect(read).not.toBeNull();
    expect(read?.runId).toBe("run-legacy");
    expect(read?.version).toBe(1);
    expect(read?.tier).toBeUndefined();
    expect(read?.spentTokens).toBeUndefined();
    expect(read?.budgetTokens).toBeUndefined();
  });

  test("an explicit null means 'known absent'; a wrong type degrades to undefined", () => {
    createDreamLease({ agentId: "agent-a", runId: "run-1" });
    updateDreamLease("agent-a", {
      tier: null,
      spentTokens: null,
      budgetTokens: null,
    });
    expect(readDreamLease("agent-a")).toMatchObject({
      tier: null,
      spentTokens: null,
      budgetTokens: null,
    });

    // A corrupt/older variant: strings where numbers belong must not throw.
    const raw = JSON.parse(
      readFileSync(getDreamLeasePath("agent-a"), "utf-8"),
    ) as Record<string, unknown>;
    writeFileSync(
      getDreamLeasePath("agent-a"),
      `${JSON.stringify(
        {
          ...raw,
          tier: "not-a-tier",
          spentTokens: "many",
          budgetTokens: "lots",
        },
        null,
        2,
      )}\n`,
    );
    const degraded = readDreamLease("agent-a");
    expect(degraded).not.toBeNull();
    expect(degraded?.tier).toBeUndefined();
    expect(degraded?.spentTokens).toBeUndefined();
    expect(degraded?.budgetTokens).toBeUndefined();
  });
});
