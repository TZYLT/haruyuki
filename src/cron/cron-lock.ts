/**
 * The `crons.lock` advisory directory lock (F-05).
 *
 * Lives in its own leaf module because both `cron-store` (which migrates v1
 * files under the lock) and `cron-lease` (which owns the leases that ride on the
 * store) need it. Keeping the lock out of either of those is what preserves the
 * acyclic graph: `cron-store` → `cron-lock` ← `cron-lease` → `cron-store`.
 *
 * Acquisition is a single atomic step: the owner file is written into a private
 * staging directory and that directory is renamed into place, so the lock can
 * never exist without its owner. Stealing is a rename too — two processes that
 * both observe a stale lock cannot delete and recreate it under each other
 * (P0-1). The lock is reentrant within the process, keyed by directory.
 */

import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { appHomeRoot } from "@/utils/app-paths";
import { captureProcessIdentity, isProcessAlive } from "./process-identity";

const LOCK_DIR_NAME = "crons.lock";
const LOCK_TOKEN_FILE = "owner.json";
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 50;
const LOCK_STALE_AGE_MS = 30_000;

function getLockDirPath(): string {
  return join(appHomeRoot(), LOCK_DIR_NAME);
}

interface LockOwner {
  pid: number;
  token: string;
  acquired_at: number;
  process_start_ticks?: string | null;
  boot_id?: string | null;
}

function sleepMs(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** The harness root may not exist yet on a fresh machine (F-08). */
function ensureHaruyukiDir(): void {
  const dir = appHomeRoot();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function readLockOwner(lockDir: string): LockOwner | null {
  try {
    const raw = readFileSync(join(lockDir, LOCK_TOKEN_FILE), "utf-8");
    return JSON.parse(raw) as LockOwner;
  } catch {
    return null;
  }
}

function writeLockOwner(dir: string, owner: LockOwner): void {
  writeFileSync(join(dir, LOCK_TOKEN_FILE), JSON.stringify(owner));
}

function isLockStale(lockDir: string): boolean {
  const owner = readLockOwner(lockDir);
  if (!owner) {
    // No owner file → consider stale if the directory exists and is old.
    try {
      const stat = statSync(lockDir);
      return Date.now() - stat.mtimeMs > LOCK_STALE_AGE_MS;
    } catch {
      return true;
    }
  }

  // Steal only if the PID is dead AND the lock is older than the threshold.
  const pidDead = !isProcessAlive(owner.pid, owner);
  const isOld = Date.now() - owner.acquired_at > LOCK_STALE_AGE_MS;
  return pidDead && isOld;
}

/** In-process reentrancy, keyed by lock directory. */
interface HeldLock {
  token: string;
  depth: number;
}
const heldLocks = new Map<string, HeldLock>();

function createOwnedLockDir(lockDir: string, token: string): void {
  const staging = `${lockDir}.acq.${process.pid}.${token}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  writeLockOwner(staging, {
    pid: process.pid,
    token,
    acquired_at: Date.now(),
    ...captureProcessIdentity(process.pid),
  });
  try {
    // One atomic step: the lock directory appears with its owner already in it.
    renameSync(staging, lockDir);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Steal a lock observed as stale. Rename first and then inspect what was
 * actually captured: if the token changed, a live lock was grabbed by mistake
 * and is moved back.
 */
function tryStealLock(lockDir: string, observedToken: string | null): boolean {
  const captured = `${lockDir}.stale.${process.pid}.${randomBytes(4).toString("hex")}`;
  try {
    renameSync(lockDir, captured);
  } catch {
    return false;
  }
  const owner = readLockOwner(captured);
  if ((owner?.token ?? null) !== observedToken) {
    try {
      renameSync(captured, lockDir);
    } catch {
      // Someone acquired in between; never delete a lock we no longer own.
      rmSync(captured, { recursive: true, force: true });
    }
    return false;
  }
  rmSync(captured, { recursive: true, force: true });
  return true;
}

function releaseHeldLock(lockDir: string): void {
  const held = heldLocks.get(lockDir);
  if (!held) return;
  held.depth -= 1;
  if (held.depth > 0) return;
  heldLocks.delete(lockDir);
  try {
    const owner = readLockOwner(lockDir);
    if (owner?.token !== held.token) return;
    const released = `${lockDir}.release.${held.token}`;
    try {
      renameSync(lockDir, released);
    } catch {
      return;
    }
    rmSync(released, { recursive: true, force: true });
  } catch {
    // Best effort: release runs from a finally block and must not throw.
  }
}

export interface LockHandle {
  release(): void;
}

/**
 * Acquire the crons.lock advisory lock. Reentrant within the process (a locked
 * mutation may read the store, and the read migrates under the same lock).
 * Throws if unable to acquire within LOCK_TIMEOUT_MS.
 */
export function acquireLock(): LockHandle {
  const lockDir = getLockDirPath();
  const held = heldLocks.get(lockDir);
  if (held) {
    held.depth += 1;
    return { release: () => releaseHeldLock(lockDir) };
  }

  ensureHaruyukiDir();
  const token = randomBytes(8).toString("hex");
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  for (;;) {
    try {
      createOwnedLockDir(lockDir, token);
      const owner = readLockOwner(lockDir);
      if (owner?.token === token) {
        heldLocks.set(lockDir, { token, depth: 1 });
        return { release: () => releaseHeldLock(lockDir) };
      }
      // Lost the directory to a concurrent stealer between rename and read.
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        code !== "EEXIST" &&
        code !== "ENOTEMPTY" &&
        code !== "EPERM" &&
        code !== "EACCES" &&
        code !== "EBUSY"
      ) {
        throw error; // Unexpected error
      }
      const observedToken = readLockOwner(lockDir)?.token ?? null;
      if (isLockStale(lockDir) && tryStealLock(lockDir, observedToken)) {
        continue; // Retry immediately
      }
    }

    if (Date.now() >= deadline) {
      throw new Error("Failed to acquire crons.lock — timed out after 5s");
    }
    sleepMs(
      Math.min(
        LOCK_RETRY_MS + Math.random() * LOCK_RETRY_MS,
        deadline - Date.now(),
      ),
    );
  }
}

/**
 * Execute a callback while holding the lock. Reentrant within the process;
 * the lock is released in a finally block.
 */
export function withLock<T>(fn: () => T): T {
  const lock = acquireLock();
  try {
    return fn();
  } finally {
    lock.release();
  }
}
