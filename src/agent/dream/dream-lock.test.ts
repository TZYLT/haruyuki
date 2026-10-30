/**
 * F-06 M2 · per-agent dream lock (route §2.4, C-24, R-5.1.5).
 *
 * The tests run against the real file lock (that is the point: the cross-process
 * guarantee lives there) in a throwaway `HARUYUKI_HOME`, and cover the three
 * behaviours the run controller depends on: one holder at a time, release makes
 * it available again, and a dead owner's lock is reaped rather than waited on.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  getDreamLockPath,
  readDreamLockOwner,
  tryAcquireDreamLock,
} from "@/agent/dream/dream-lock";

const previousHaruyukiHome = process.env.HARUYUKI_HOME;
const root = mkdtempSync(join(tmpdir(), "hryk-dream-lock-"));
process.env.HARUYUKI_HOME = root;

afterAll(() => {
  if (previousHaruyukiHome === undefined) delete process.env.HARUYUKI_HOME;
  else process.env.HARUYUKI_HOME = previousHaruyukiHome;
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(join(root, "dream"), { recursive: true, force: true });
});

function writeDeadOwnerLock(agentId: string): void {
  const path = getDreamLockPath(agentId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      pid: 2_147_483_000,
      started: null,
      acquiredAt: Date.now() - 60_000,
      token: "dead-owner-token",
    }),
  );
  // Old enough that an age-based reaper would also take it; the test asserts the
  // dead-owner path, which is what production uses.
  const old = new Date(Date.now() - 10 * 60_000);
  utimesSync(path, old, old);
}

describe("dream lock", () => {
  test("a free agent lock can be taken and released", async () => {
    const release = await tryAcquireDreamLock("agent-a");
    expect(release).not.toBeNull();
    expect(readDreamLockOwner("agent-a")?.pid).toBe(process.pid);
    await release?.();
    expect(readDreamLockOwner("agent-a")).toBeNull();
    // Reacquiring after release is the "next run" path.
    const again = await tryAcquireDreamLock("agent-a");
    expect(again).not.toBeNull();
    await again?.();
  });

  test("a live holder blocks a second run (F3 skip, not a failure)", async () => {
    const release = await tryAcquireDreamLock("agent-a");
    expect(release).not.toBeNull();
    const second = await tryAcquireDreamLock("agent-a");
    expect(second).toBeNull();
    await release?.();
  });

  test("a dead owner's lock is reaped and taken", async () => {
    writeDeadOwnerLock("agent-a");
    expect(readDreamLockOwner("agent-a")?.pid).toBe(2_147_483_000);
    const release = await tryAcquireDreamLock("agent-a");
    expect(release).not.toBeNull();
    expect(readDreamLockOwner("agent-a")?.pid).toBe(process.pid);
    await release?.();
  });

  test("different agents do not share a lock", async () => {
    const releaseA = await tryAcquireDreamLock("agent-a");
    const releaseB = await tryAcquireDreamLock("agent-b");
    expect(releaseA).not.toBeNull();
    expect(releaseB).not.toBeNull();
    await releaseA?.();
    await releaseB?.();
  });

  test("the lock path stays inside the configured harness home", () => {
    expect(getDreamLockPath("agent-a")).toContain(join(root, "dream", "locks"));
  });
});
