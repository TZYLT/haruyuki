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
  acquireEmbeddingBuildLock,
  EMBEDDING_BUILD_LOCK_REAP_MARKER_STALE_MS,
  EMBEDDING_BUILD_LOCK_STALE_MS,
  type EmbeddingBuildLockEnvironment,
  type EmbeddingBuildLockRecord,
  embeddingBuildLockPath,
  embeddingBuildLockReapMarkerPath,
  evaluateEmbeddingBuildLock,
  inspectEmbeddingBuildLock,
} from "./embedding-lock";

/**
 * Locks are exercised in OS temp directories only (docs/31 §1.2 A2). Time and
 * pid liveness are injected, so no test sleeps or probes a real process.
 */
const tempDirs: string[] = [];

function makeSpaceDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hryk-w2-a2-lock-"));
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

function lockEnv(
  pid: number,
  overrides: Partial<EmbeddingBuildLockEnvironment> = {},
): EmbeddingBuildLockEnvironment {
  return { clock, pid, host: HOST, isPidAlive, ...overrides };
}

function readLockFile(spaceDir: string): EmbeddingBuildLockRecord {
  return JSON.parse(readFileSync(embeddingBuildLockPath(spaceDir), "utf8"));
}

function writeLockRecord(
  spaceDir: string,
  record: Partial<EmbeddingBuildLockRecord> & { token: string },
): void {
  const full: EmbeddingBuildLockRecord = {
    schemaVersion: 1,
    ...IDENTITY,
    pid: 5_000,
    host: HOST,
    acquiredAt: now,
    heartbeatAt: now,
    ...record,
  };
  writeFileSync(embeddingBuildLockPath(spaceDir), JSON.stringify(full), "utf8");
}

describe("paths", () => {
  test("lock and reap marker live beside the space state", () => {
    const spaceDir = join("root", "agent-a", "space-a");
    expect(embeddingBuildLockPath(spaceDir)).toBe(
      join(spaceDir, ".build.lock"),
    );
    expect(
      embeddingBuildLockReapMarkerPath(embeddingBuildLockPath(spaceDir)),
    ).toBe(join(spaceDir, ".build.lock.reap"));
  });
});

describe("acquire / release", () => {
  test("acquires an absent lock and records pid, host, token and heartbeat", async () => {
    const spaceDir = makeSpaceDir();
    const result = await acquireEmbeddingBuildLock(
      spaceDir,
      IDENTITY,
      lockEnv(4_000, { token: "owner-token" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected lock");
    expect(existsSync(embeddingBuildLockPath(spaceDir))).toBe(true);
    expect(readLockFile(spaceDir)).toEqual({
      schemaVersion: 1,
      ...IDENTITY,
      pid: 4_000,
      host: HOST,
      token: "owner-token",
      acquiredAt: now,
      heartbeatAt: now,
    });
    expect(result.handle.record.token).toBe("owner-token");

    await expect(result.handle.release()).resolves.toBe(true);
    expect(existsSync(embeddingBuildLockPath(spaceDir))).toBe(false);
    await expect(result.handle.release()).resolves.toBe(false);
  });

  test("refuses a live lock held by another pid", async () => {
    const spaceDir = makeSpaceDir();
    alivePids.add(4_001);
    const first = await acquireEmbeddingBuildLock(
      spaceDir,
      IDENTITY,
      lockEnv(4_001, { token: "first" }),
    );
    expect(first.ok).toBe(true);

    const second = await acquireEmbeddingBuildLock(
      spaceDir,
      IDENTITY,
      lockEnv(4_002, { token: "second" }),
    );
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("expected held");
    expect(second.reason).toBe("held");
    expect(second.record?.token).toBe("first");
    expect(readLockFile(spaceDir).token).toBe("first");
  });

  test("refuses same-process re-entry while the lock is live", async () => {
    const spaceDir = makeSpaceDir();
    alivePids.add(4_010);
    const first = await acquireEmbeddingBuildLock(
      spaceDir,
      IDENTITY,
      lockEnv(4_010, { token: "first" }),
    );
    expect(first.ok).toBe(true);

    const second = await acquireEmbeddingBuildLock(
      spaceDir,
      IDENTITY,
      lockEnv(4_010, { token: "second" }),
    );
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("expected held_by_self");
    expect(second.reason).toBe("held_by_self");
    expect(readLockFile(spaceDir).token).toBe("first");
  });

  test("reclaims a stale lock even when the recorded pid is still alive", async () => {
    const spaceDir = makeSpaceDir();
    alivePids.add(4_020);
    const first = await acquireEmbeddingBuildLock(
      spaceDir,
      IDENTITY,
      lockEnv(4_020, { token: "old-owner" }),
    );
    expect(first.ok).toBe(true);

    now += EMBEDDING_BUILD_LOCK_STALE_MS + 1;
    const second = await acquireEmbeddingBuildLock(
      spaceDir,
      IDENTITY,
      lockEnv(4_021, { token: "new-owner" }),
    );
    expect(second.ok).toBe(true);
    expect(readLockFile(spaceDir).token).toBe("new-owner");
    if (!first.ok) throw new Error("expected first lock");
    await expect(first.handle.heartbeat()).resolves.toBe(false);
  });

  test("reclaims a stale lock that carries our own reused pid", async () => {
    const spaceDir = makeSpaceDir();
    alivePids.add(4_030);
    const first = await acquireEmbeddingBuildLock(
      spaceDir,
      IDENTITY,
      lockEnv(4_030, { token: "predecessor" }),
    );
    expect(first.ok).toBe(true);

    // A new process with the same pid (restart / pid reuse): the old record is
    // stale, so the lock is recoverable instead of blocking forever.
    now += EMBEDDING_BUILD_LOCK_STALE_MS + 1;
    const second = await acquireEmbeddingBuildLock(
      spaceDir,
      IDENTITY,
      lockEnv(4_030, { token: "successor" }),
    );
    expect(second.ok).toBe(true);
    expect(readLockFile(spaceDir).token).toBe("successor");
  });

  test("reclaims a fresh lock whose same-host pid is dead", async () => {
    const spaceDir = makeSpaceDir();
    writeLockRecord(spaceDir, { pid: 4_040, token: "dead-owner" });

    const inspection = await inspectEmbeddingBuildLock(
      spaceDir,
      lockEnv(4_041),
    );
    expect(inspection.status).toBe("stale");

    const result = await acquireEmbeddingBuildLock(
      spaceDir,
      IDENTITY,
      lockEnv(4_041, { token: "replacement" }),
    );
    expect(result.ok).toBe(true);
    expect(readLockFile(spaceDir).token).toBe("replacement");
  });

  test("reclaims a corrupt lock file", async () => {
    const spaceDir = makeSpaceDir();
    writeFileSync(embeddingBuildLockPath(spaceDir), "{not json", "utf8");

    const inspection = await inspectEmbeddingBuildLock(
      spaceDir,
      lockEnv(4_050),
    );
    expect(inspection.status).toBe("corrupt");

    const result = await acquireEmbeddingBuildLock(
      spaceDir,
      IDENTITY,
      lockEnv(4_050, { token: "after-corrupt" }),
    );
    expect(result.ok).toBe(true);
    expect(readLockFile(spaceDir).token).toBe("after-corrupt");
  });

  test("does not adopt a live lock from another host", async () => {
    const spaceDir = makeSpaceDir();
    writeLockRecord(spaceDir, {
      pid: 4_060,
      host: "other-host",
      token: "remote-owner",
    });

    const result = await acquireEmbeddingBuildLock(
      spaceDir,
      IDENTITY,
      lockEnv(4_061, { token: "local" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected held");
    expect(result.reason).toBe("held");
    expect(result.record?.host).toBe("other-host");
  });

  test("only one of two concurrent acquisitions wins", async () => {
    const spaceDir = makeSpaceDir();
    alivePids.add(4_070);
    alivePids.add(4_071);
    const [first, second] = await Promise.all([
      acquireEmbeddingBuildLock(
        spaceDir,
        IDENTITY,
        lockEnv(4_070, { token: "a" }),
      ),
      acquireEmbeddingBuildLock(
        spaceDir,
        IDENTITY,
        lockEnv(4_071, { token: "b" }),
      ),
    ]);
    const winners = [first, second].filter((result) => result.ok);
    expect(winners).toHaveLength(1);
    const winnerToken = readLockFile(spaceDir).token;
    expect(["a", "b"]).toContain(winnerToken);
  });
});

describe("heartbeat", () => {
  test("refreshes heartbeatAt and keeps the lock live past the stale window", async () => {
    const spaceDir = makeSpaceDir();
    alivePids.add(4_100);
    const acquired = await acquireEmbeddingBuildLock(
      spaceDir,
      IDENTITY,
      lockEnv(4_100, { token: "mine" }),
    );
    if (!acquired.ok) throw new Error("expected lock");

    now += 60_000;
    await expect(acquired.handle.heartbeat()).resolves.toBe(true);
    expect(readLockFile(spaceDir).heartbeatAt).toBe(now);

    now += 60_000;
    await expect(acquired.handle.heartbeat()).resolves.toBe(true);
    const inspection = await inspectEmbeddingBuildLock(
      spaceDir,
      lockEnv(4_100),
    );
    expect(inspection.status).toBe("live");
    expect(inspection.heartbeatAgeMs).toBe(0);
  });

  test("refreshes a stale lock that still carries our token", async () => {
    const spaceDir = makeSpaceDir();
    const acquired = await acquireEmbeddingBuildLock(
      spaceDir,
      IDENTITY,
      lockEnv(4_110, { token: "mine" }),
    );
    if (!acquired.ok) throw new Error("expected lock");
    alivePids.add(4_110);

    now += EMBEDDING_BUILD_LOCK_STALE_MS + 5_000;
    expect(
      (await inspectEmbeddingBuildLock(spaceDir, lockEnv(4_110))).status,
    ).toBe("stale");
    await expect(acquired.handle.heartbeat()).resolves.toBe(true);
    expect(
      (await inspectEmbeddingBuildLock(spaceDir, lockEnv(4_110))).status,
    ).toBe("live");
  });

  test("reports failure and refuses release after the lock was taken over", async () => {
    const spaceDir = makeSpaceDir();
    const acquired = await acquireEmbeddingBuildLock(
      spaceDir,
      IDENTITY,
      lockEnv(4_120, { token: "mine" }),
    );
    if (!acquired.ok) throw new Error("expected lock");

    writeLockRecord(spaceDir, {
      pid: 4_121,
      token: "someone-else",
      heartbeatAt: now,
    });
    await expect(acquired.handle.heartbeat()).resolves.toBe(false);
    await expect(acquired.handle.release()).resolves.toBe(false);
    expect(existsSync(embeddingBuildLockPath(spaceDir))).toBe(true);
    expect(readLockFile(spaceDir).token).toBe("someone-else");
  });
});

describe("reap marker serialization", () => {
  test("reports busy while a live contender holds the reap marker", async () => {
    const spaceDir = makeSpaceDir();
    alivePids.add(4_200);
    alivePids.add(4_201);
    const stale = await acquireEmbeddingBuildLock(
      spaceDir,
      IDENTITY,
      lockEnv(4_200, { token: "stale-owner" }),
    );
    expect(stale.ok).toBe(true);
    now += EMBEDDING_BUILD_LOCK_STALE_MS + 1;

    const markerPath = embeddingBuildLockReapMarkerPath(
      embeddingBuildLockPath(spaceDir),
    );
    writeFileSync(
      markerPath,
      JSON.stringify({ pid: 4_201, host: HOST, token: "reaper", at: now }),
      "utf8",
    );

    const blocked = await acquireEmbeddingBuildLock(
      spaceDir,
      IDENTITY,
      lockEnv(4_202, { token: "blocked" }),
    );
    expect(blocked.ok).toBe(false);
    if (blocked.ok) throw new Error("expected busy");
    expect(blocked.reason).toBe("busy");
    expect(readLockFile(spaceDir).token).toBe("stale-owner");

    // Once the crashed contender's marker exceeds its own TTL it is cleared.
    now += EMBEDDING_BUILD_LOCK_REAP_MARKER_STALE_MS + 1;
    const acquired = await acquireEmbeddingBuildLock(
      spaceDir,
      IDENTITY,
      lockEnv(4_203, { token: "after-marker" }),
    );
    expect(acquired.ok).toBe(true);
    expect(readLockFile(spaceDir).token).toBe("after-marker");
  });

  test("clears a marker left by a dead contender", async () => {
    const spaceDir = makeSpaceDir();
    writeFileSync(embeddingBuildLockPath(spaceDir), "{not json", "utf8");
    const markerPath = embeddingBuildLockReapMarkerPath(
      embeddingBuildLockPath(spaceDir),
    );
    writeFileSync(
      markerPath,
      JSON.stringify({ pid: 4_300, host: HOST, token: "reaper", at: now }),
      "utf8",
    );
    const acquired = await acquireEmbeddingBuildLock(
      spaceDir,
      IDENTITY,
      lockEnv(4_301, { token: "winner" }),
    );
    expect(acquired.ok).toBe(true);
    expect(existsSync(markerPath)).toBe(false);
  });
});

describe("evaluateEmbeddingBuildLock", () => {
  const baseRecord: EmbeddingBuildLockRecord = {
    schemaVersion: 1,
    ...IDENTITY,
    pid: 4_400,
    host: HOST,
    token: "t",
    acquiredAt: now,
    heartbeatAt: now,
  };

  test("fresh same-host record is live only while its pid is alive", () => {
    alivePids.add(4_400);
    expect(evaluateEmbeddingBuildLock(baseRecord, lockEnv(4_401))).toBe("live");
    alivePids.delete(4_400);
    expect(evaluateEmbeddingBuildLock(baseRecord, lockEnv(4_401))).toBe(
      "stale",
    );
  });

  test("age beats pid liveness", () => {
    alivePids.add(4_400);
    const old = {
      ...baseRecord,
      heartbeatAt: now - EMBEDDING_BUILD_LOCK_STALE_MS - 1,
    };
    expect(evaluateEmbeddingBuildLock(old, lockEnv(4_401))).toBe("stale");
  });

  test("a fresh record from another host is live; its pid is not probed", () => {
    expect(
      evaluateEmbeddingBuildLock(
        { ...baseRecord, host: "other-host" },
        lockEnv(4_401),
      ),
    ).toBe("live");
  });
});
