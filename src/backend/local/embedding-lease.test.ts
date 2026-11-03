import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireEmbeddingLease,
  createEmbeddingLeaseForLock,
  EMBEDDING_LEASE_DEFAULT_TTL_MS,
  type EmbeddingLeaseEnvironment,
  type EmbeddingLeaseRecord,
  embeddingLeasePath,
  evaluateEmbeddingLease,
  heartbeatEmbeddingBuildLockAndLease,
  inspectEmbeddingLease,
  readEmbeddingLease,
  validateEmbeddingLease,
} from "./embedding-lease";
import {
  acquireEmbeddingBuildLock,
  embeddingBuildLockPath,
} from "./embedding-lock";

/**
 * Leases are exercised in OS temp directories only (docs/31 §1.2 A2). Time and
 * pid liveness are injected, so no test sleeps or probes a real process.
 */
const tempDirs: string[] = [];

function makeSpaceDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hryk-w2-a2-lease-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const HOST = "test-host";
const IDENTITY = { agentId: "agent-a", spaceId: "space-a" } as const;

let now = 1_000_000;
const clock = () => now;
const alivePids = new Set<number>();
const isPidAlive = (pid: number) => alivePids.has(pid);

beforeEach(() => {
  now = 1_000_000;
  alivePids.clear();
});

function leaseEnv(
  pid: number,
  overrides: Partial<EmbeddingLeaseEnvironment> = {},
): EmbeddingLeaseEnvironment {
  return { clock, pid, host: HOST, isPidAlive, ...overrides };
}

async function acquireLease(
  spaceDir: string,
  token: string,
  pid: number,
  overrides: Partial<EmbeddingLeaseEnvironment> & { ttlMs?: number } = {},
) {
  return acquireEmbeddingLease(spaceDir, IDENTITY, {
    token,
    ...leaseEnv(pid, overrides),
  });
}

function readLeaseFile(spaceDir: string): EmbeddingLeaseRecord {
  return JSON.parse(readFileSync(embeddingLeasePath(spaceDir), "utf8"));
}

function writeLeaseRecord(
  spaceDir: string,
  record: Partial<EmbeddingLeaseRecord> & { token: string },
): void {
  const full: EmbeddingLeaseRecord = {
    schemaVersion: 1,
    ...IDENTITY,
    pid: 9_000,
    host: HOST,
    ttlMs: EMBEDDING_LEASE_DEFAULT_TTL_MS,
    createdAt: now,
    heartbeatAt: now,
    expiresAt: now + EMBEDDING_LEASE_DEFAULT_TTL_MS,
    ...record,
  };
  writeFileSync(embeddingLeasePath(spaceDir), JSON.stringify(full), "utf8");
}

describe("paths", () => {
  test("lease lives beside the space state and lock", () => {
    const spaceDir = join("root", "agent-a", "space-a");
    expect(embeddingLeasePath(spaceDir)).toBe(join(spaceDir, ".build.lease"));
  });
});

describe("acquire", () => {
  test("creates a live lease owned by the caller's token", async () => {
    const spaceDir = makeSpaceDir();
    const result = await acquireLease(spaceDir, "owner-token", 4_000);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected lease");
    expect(result.takenOver).toBe(false);
    expect(result.handle.ttlMs).toBe(EMBEDDING_LEASE_DEFAULT_TTL_MS);
    expect(existsSync(embeddingLeasePath(spaceDir))).toBe(true);
    expect(readLeaseFile(spaceDir)).toEqual({
      schemaVersion: 1,
      ...IDENTITY,
      token: "owner-token",
      pid: 4_000,
      host: HOST,
      ttlMs: EMBEDDING_LEASE_DEFAULT_TTL_MS,
      createdAt: now,
      heartbeatAt: now,
      expiresAt: now + EMBEDDING_LEASE_DEFAULT_TTL_MS,
    });
  });

  test("refuses to stomp on a live lease with another token", async () => {
    const spaceDir = makeSpaceDir();
    alivePids.add(4_010);
    const first = await acquireLease(spaceDir, "first", 4_010);
    expect(first.ok).toBe(true);

    alivePids.add(4_011);
    const second = await acquireLease(spaceDir, "second", 4_011);
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("expected held");
    expect(second.reason).toBe("held");
    expect(second.record.token).toBe("first");
    expect(readLeaseFile(spaceDir).token).toBe("first");
  });

  test("re-creating with the same token refreshes it and keeps createdAt", async () => {
    const spaceDir = makeSpaceDir();
    const first = await acquireLease(spaceDir, "same", 4_020, {
      ttlMs: 10_000,
    });
    expect(first.ok).toBe(true);
    const createdAt = readLeaseFile(spaceDir).createdAt;

    now += 500;
    const second = await acquireLease(spaceDir, "same", 4_020, {
      ttlMs: 10_000,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("expected lease");
    expect(second.takenOver).toBe(false);
    const record = readLeaseFile(spaceDir);
    expect(record.createdAt).toBe(createdAt);
    expect(record.heartbeatAt).toBe(now);
    expect(record.expiresAt).toBe(now + 10_000);
  });

  test("takes over an expired lease", async () => {
    const spaceDir = makeSpaceDir();
    await acquireLease(spaceDir, "old", 4_030);
    now += EMBEDDING_LEASE_DEFAULT_TTL_MS + 1;

    const result = await acquireLease(spaceDir, "new", 4_031);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected lease");
    expect(result.takenOver).toBe(true);
    const record = readLeaseFile(spaceDir);
    expect(record.token).toBe("new");
    expect(record.createdAt).toBe(now);
  });

  test("takes over a fresh lease whose same-host pid is dead", async () => {
    const spaceDir = makeSpaceDir();
    await acquireLease(spaceDir, "dead", 4_040);

    const result = await acquireLease(spaceDir, "replacement", 4_041);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected lease");
    expect(result.takenOver).toBe(true);
    expect(readLeaseFile(spaceDir).token).toBe("replacement");
  });

  test("does not adopt a live lease from another host", async () => {
    const spaceDir = makeSpaceDir();
    const remote = await acquireLease(spaceDir, "remote", 4_050, {
      host: "other-host",
    });
    expect(remote.ok).toBe(true);

    const local = await acquireLease(spaceDir, "local", 4_051);
    expect(local.ok).toBe(false);
    if (local.ok) throw new Error("expected held");
    expect(local.reason).toBe("held");
    expect(local.record.host).toBe("other-host");
  });

  test("replaces a corrupt lease file", async () => {
    const spaceDir = makeSpaceDir();
    writeFileSync(embeddingLeasePath(spaceDir), "{not json", "utf8");

    const read = await readEmbeddingLease(spaceDir);
    expect(read.status).toBe("corrupt");
    expect(read.record).toBeNull();

    const result = await acquireLease(spaceDir, "recovered", 4_060);
    expect(result.ok).toBe(true);
    expect(readLeaseFile(spaceDir).token).toBe("recovered");
  });
});

describe("renew", () => {
  test("extends heartbeatAt and expiresAt by the ttl", async () => {
    const spaceDir = makeSpaceDir();
    const acquired = await acquireLease(spaceDir, "mine", 4_100, {
      ttlMs: 10_000,
    });
    if (!acquired.ok) throw new Error("expected lease");

    now += 1_000;
    await expect(acquired.handle.renew()).resolves.toBe(true);
    const record = readLeaseFile(spaceDir);
    expect(record.heartbeatAt).toBe(now);
    expect(record.expiresAt).toBe(now + 10_000);
    expect(record.createdAt).toBe(1_000_000);
    expect(acquired.handle.record.expiresAt).toBe(record.expiresAt);
  });

  test("fails when the lease was taken over by another token", async () => {
    const spaceDir = makeSpaceDir();
    const acquired = await acquireLease(spaceDir, "mine", 4_110);
    if (!acquired.ok) throw new Error("expected lease");

    now += 1_000;
    writeLeaseRecord(spaceDir, {
      token: "someone-else",
      heartbeatAt: now,
      expiresAt: now + EMBEDDING_LEASE_DEFAULT_TTL_MS,
    });
    await expect(acquired.handle.renew()).resolves.toBe(false);
    expect(readLeaseFile(spaceDir).token).toBe("someone-else");
  });

  test("fails when the lease file is gone", async () => {
    const spaceDir = makeSpaceDir();
    const acquired = await acquireLease(spaceDir, "mine", 4_120);
    if (!acquired.ok) throw new Error("expected lease");
    rmSync(embeddingLeasePath(spaceDir), { force: true });
    await expect(acquired.handle.renew()).resolves.toBe(false);
  });
});

describe("release", () => {
  test("removes the lease and is idempotent", async () => {
    const spaceDir = makeSpaceDir();
    const acquired = await acquireLease(spaceDir, "mine", 4_200);
    if (!acquired.ok) throw new Error("expected lease");

    await expect(acquired.handle.release()).resolves.toBe(true);
    expect(existsSync(embeddingLeasePath(spaceDir))).toBe(false);
    await expect(acquired.handle.release()).resolves.toBe(false);
  });

  test("refuses to delete a lease owned by another token", async () => {
    const spaceDir = makeSpaceDir();
    const acquired = await acquireLease(spaceDir, "mine", 4_210);
    if (!acquired.ok) throw new Error("expected lease");

    writeLeaseRecord(spaceDir, { token: "someone-else" });
    await expect(acquired.handle.release()).resolves.toBe(false);
    expect(existsSync(embeddingLeasePath(spaceDir))).toBe(true);
    expect(readLeaseFile(spaceDir).token).toBe("someone-else");
  });
});

describe("evaluate / validate", () => {
  function liveRecord(overrides: Partial<EmbeddingLeaseRecord> = {}) {
    return {
      schemaVersion: 1 as const,
      ...IDENTITY,
      token: "t",
      pid: 4_300,
      host: HOST,
      ttlMs: 10_000,
      createdAt: now,
      heartbeatAt: now,
      expiresAt: now + 10_000,
      ...overrides,
    };
  }

  test("a fresh lease on a live pid is live", () => {
    alivePids.add(4_300);
    expect(evaluateEmbeddingLease(liveRecord(), leaseEnv(4_301))).toBe("live");
  });

  test("expiry is driven by expiresAt", () => {
    alivePids.add(4_300);
    const record = liveRecord();
    now += 10_000;
    expect(evaluateEmbeddingLease(record, leaseEnv(4_301))).toBe("expired");
  });

  test("a dead same-host pid expires a fresh lease", () => {
    expect(evaluateEmbeddingLease(liveRecord(), leaseEnv(4_301))).toBe(
      "expired",
    );
  });

  test("another host is judged only by expiry", () => {
    const record = liveRecord({ host: "other-host" });
    expect(evaluateEmbeddingLease(record, leaseEnv(4_301))).toBe("live");
    now += 10_000;
    expect(evaluateEmbeddingLease(record, leaseEnv(4_301))).toBe("expired");
  });

  test("validate distinguishes the failure reasons", () => {
    alivePids.add(4_300);
    const record = liveRecord();
    expect(validateEmbeddingLease(record, leaseEnv(4_301))).toEqual({
      valid: true,
    });
    expect(
      validateEmbeddingLease(record, { ...leaseEnv(4_301), token: "other" }),
    ).toEqual({ valid: false, reason: "token_mismatch" });
    expect(validateEmbeddingLease(null)).toEqual({
      valid: false,
      reason: "invalid_record",
    });
    const beforeExpiry = liveRecord();
    now += 10_000;
    expect(validateEmbeddingLease(beforeExpiry, leaseEnv(4_301))).toEqual({
      valid: false,
      reason: "expired",
    });
    alivePids.delete(4_300);
    expect(validateEmbeddingLease(liveRecord(), leaseEnv(4_301))).toEqual({
      valid: false,
      reason: "dead_process",
    });
  });

  test("inspect reports live/expired with remaining time", async () => {
    const spaceDir = makeSpaceDir();
    alivePids.add(4_310);
    const acquired = await acquireLease(spaceDir, "mine", 4_310, {
      ttlMs: 10_000,
    });
    expect(acquired.ok).toBe(true);

    now += 1_000;
    const live = await inspectEmbeddingLease(spaceDir, leaseEnv(4_311));
    expect(live.status).toBe("live");
    expect(live.expiresInMs).toBe(9_000);
    expect(live.heartbeatAgeMs).toBe(1_000);

    now += 9_000;
    const expired = await inspectEmbeddingLease(spaceDir, leaseEnv(4_311));
    expect(expired.status).toBe("expired");
    expect(expired.expiresInMs).toBe(0);
  });

  test("inspect reports missing and corrupt without throwing", async () => {
    const spaceDir = makeSpaceDir();
    expect((await inspectEmbeddingLease(spaceDir)).status).toBe("missing");
    writeFileSync(embeddingLeasePath(spaceDir), "not json", "utf8");
    expect((await inspectEmbeddingLease(spaceDir)).status).toBe("corrupt");
  });
});

describe("lock composition", () => {
  test("the lease inherits the lock token and both heartbeats refresh together", async () => {
    const spaceDir = makeSpaceDir();
    alivePids.add(4_500);
    const lock = await acquireEmbeddingBuildLock(spaceDir, IDENTITY, {
      clock,
      pid: 4_500,
      host: HOST,
      token: "shared-token",
      isPidAlive,
    });
    if (!lock.ok) throw new Error("expected lock");

    const leaseResult = await createEmbeddingLeaseForLock(lock.handle, {
      clock,
      isPidAlive,
    });
    expect(leaseResult.ok).toBe(true);
    if (!leaseResult.ok) throw new Error("expected lease");
    expect(leaseResult.handle.record.token).toBe("shared-token");
    expect(leaseResult.handle.record.pid).toBe(4_500);
    expect(leaseResult.handle.record.host).toBe(HOST);

    now += 1_000;
    await expect(
      heartbeatEmbeddingBuildLockAndLease(lock.handle, leaseResult.handle),
    ).resolves.toBe(true);
    const lockRecord = JSON.parse(
      readFileSync(embeddingBuildLockPath(spaceDir), "utf8"),
    );
    expect(lockRecord.heartbeatAt).toBe(now);
    expect(readLeaseFile(spaceDir).heartbeatAt).toBe(now);
  });

  test("a lost lock stops the lease heartbeat", async () => {
    const spaceDir = makeSpaceDir();
    alivePids.add(4_510);
    const lock = await acquireEmbeddingBuildLock(spaceDir, IDENTITY, {
      clock,
      pid: 4_510,
      host: HOST,
      token: "mine",
      isPidAlive,
    });
    if (!lock.ok) throw new Error("expected lock");
    const leaseResult = await createEmbeddingLeaseForLock(lock.handle, {
      clock,
      isPidAlive,
    });
    if (!leaseResult.ok) throw new Error("expected lease");

    const stolenLock = {
      ...JSON.parse(readFileSync(embeddingBuildLockPath(spaceDir), "utf8")),
      token: "stolen",
    };
    writeFileSync(
      embeddingBuildLockPath(spaceDir),
      JSON.stringify(stolenLock),
      "utf8",
    );
    const leaseHeartbeatBefore = readLeaseFile(spaceDir).heartbeatAt;

    now += 1_000;
    await expect(
      heartbeatEmbeddingBuildLockAndLease(lock.handle, leaseResult.handle),
    ).resolves.toBe(false);
    expect(readLeaseFile(spaceDir).heartbeatAt).toBe(leaseHeartbeatBefore);
  });

  test("a live lease held by another token blocks taking the lease for a lock", async () => {
    const spaceDir = makeSpaceDir();
    alivePids.add(4_520);
    const foreign = await acquireLease(spaceDir, "foreign-token", 4_520);
    expect(foreign.ok).toBe(true);

    alivePids.add(4_521);
    const lock = await acquireEmbeddingBuildLock(spaceDir, IDENTITY, {
      clock,
      pid: 4_521,
      host: HOST,
      token: "lock-token",
      isPidAlive,
    });
    if (!lock.ok) throw new Error("expected lock");

    const leaseResult = await createEmbeddingLeaseForLock(lock.handle, {
      clock,
      isPidAlive,
    });
    expect(leaseResult.ok).toBe(false);
    if (leaseResult.ok) throw new Error("expected held");
    expect(leaseResult.reason).toBe("held");
    expect(leaseResult.record.token).toBe("foreign-token");
  });
});
