/**
 * Cron/schedule leases (F-05).
 *
 * Two kinds of lease live here and they answer different questions:
 *
 * - **Scheduler lease** (pre-existing) — "which process may run schedules at
 *   all?" Keyed by scope (`all` / `local` / `cloud`), with a mixed-version
 *   tombstone so an older writer cannot strip a scoped row.
 * - **Task lease** (new, §5.6) — "which run owns this one task right now?"
 *   Recorded on the task, so a short-lived host and a long-lived host cannot
 *   execute the same occurrence twice.
 *
 * The advisory `crons.lock` directory and its steal rules also live here; they
 * are what makes both leases atomic. `cron-store` deliberately does no locking,
 * so the import graph stays acyclic: `cron-lease` → `cron-store`.
 */

import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { appHomeRoot } from "@/utils/app-paths";
import { readScheduleFile, writeScheduleFile } from "./cron-store";
import {
  type CronSchedulerScope,
  type ScheduleFileData,
  type SchedulerOwner,
  TASK_LEASE_TTL_MS,
  type TaskLease,
} from "./cron-types";
import { captureProcessIdentity, isProcessAlive } from "./process-identity";

// ── Locking ─────────────────────────────────────────────────────────

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

function readLockOwner(lockDir: string): LockOwner | null {
  try {
    const raw = readFileSync(join(lockDir, LOCK_TOKEN_FILE), "utf-8");
    return JSON.parse(raw) as LockOwner;
  } catch {
    return null;
  }
}

function writeLockOwner(lockDir: string, owner: LockOwner): void {
  writeFileSync(join(lockDir, LOCK_TOKEN_FILE), JSON.stringify(owner));
}

function isLockStale(lockDir: string): boolean {
  const owner = readLockOwner(lockDir);
  if (!owner) {
    // No owner file → consider stale if dir exists and is old
    try {
      const stat = statSync(lockDir);
      return Date.now() - stat.mtimeMs > LOCK_STALE_AGE_MS;
    } catch {
      return true;
    }
  }

  // Steal only if PID is dead AND lock is older than threshold
  const pidDead = !isProcessAlive(owner.pid, owner);
  const isOld = Date.now() - owner.acquired_at > LOCK_STALE_AGE_MS;
  return pidDead && isOld;
}

function stealLock(lockDir: string): void {
  try {
    rmSync(lockDir, { recursive: true, force: true });
  } catch {
    // Best effort
  }
}

export interface LockHandle {
  release(): void;
}

/**
 * Acquire the crons.lock advisory lock.
 * Throws if unable to acquire within LOCK_TIMEOUT_MS.
 */
export function acquireLock(): LockHandle {
  const lockDir = getLockDirPath();
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  const token = randomBytes(4).toString("hex");

  while (Date.now() < deadline) {
    try {
      mkdirSync(lockDir, { recursive: false });
      // Success — we own the lock
      const owner: LockOwner = {
        pid: process.pid,
        token,
        acquired_at: Date.now(),
        ...captureProcessIdentity(process.pid),
      };
      writeLockOwner(lockDir, owner);
      return {
        release() {
          try {
            // Verify we still own it before releasing
            const current = readLockOwner(lockDir);
            if (current && current.token === token) {
              rmSync(lockDir, { recursive: true, force: true });
            }
          } catch {
            // Best effort
          }
        },
      };
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        // Lock held — check if stale
        if (isLockStale(lockDir)) {
          stealLock(lockDir);
          continue; // Retry immediately
        }
        // Wait and retry
        const sleepMs = Math.min(
          LOCK_RETRY_MS + Math.random() * LOCK_RETRY_MS,
          deadline - Date.now(),
        );
        if (sleepMs > 0) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sleepMs);
        }
        continue;
      }
      throw err; // Unexpected error
    }
  }

  throw new Error("Failed to acquire crons.lock — timed out after 5s");
}

/**
 * Execute a callback while holding the lock.
 * Lock is released in a finally block.
 */
export function withLock<T>(fn: () => T): T {
  const lock = acquireLock();
  try {
    return fn();
  } finally {
    lock.release();
  }
}

// ── Scheduler lease ─────────────────────────────────────────────────

function isLiveOwner(
  owner: SchedulerOwner | null | undefined,
): owner is SchedulerOwner {
  return Boolean(owner && isProcessAlive(owner.pid, owner));
}

function liveScopedOwners(data: ScheduleFileData): SchedulerOwner[] {
  return Object.values(data.scheduler_owners).filter(isLiveOwner);
}

function createSchedulerOwner(token: string): SchedulerOwner {
  return {
    pid: process.pid,
    token,
    started_at: new Date().toISOString(),
    ...captureProcessIdentity(process.pid),
  };
}

function ownerMatches(
  owner: SchedulerOwner | null | undefined,
  token: string,
): owner is SchedulerOwner {
  return (
    owner !== null &&
    owner !== undefined &&
    owner.pid === process.pid &&
    owner.token === token
  );
}

/**
 * True when a live lease would process schedules for `backend`.
 * A true all-agent owner (live `scheduler_owner`, no live scoped owners)
 * covers every backend. A scoped owner only covers its own lane. A
 * mixed-version tombstone in `scheduler_owner` does not count as all-owner
 * while a scoped row is live.
 */
export function hasLiveSchedulerOwner(
  data: {
    scheduler_owner: SchedulerOwner | null;
    scheduler_owners?: Partial<
      Record<Exclude<CronSchedulerScope, "all">, SchedulerOwner>
    >;
  },
  backend: Exclude<CronSchedulerScope, "all">,
): boolean {
  const scoped = data.scheduler_owners ?? {};
  const hasTrueAllOwner =
    isLiveOwner(data.scheduler_owner) &&
    !isLiveOwner(scoped.local) &&
    !isLiveOwner(scoped.cloud);
  return hasTrueAllOwner || isLiveOwner(scoped[backend]);
}

function throwIfLiveAllLease(
  owner: SchedulerOwner | null | undefined,
  allowSelf: boolean,
): void {
  if (!isLiveOwner(owner)) return;
  if (allowSelf && owner.pid === process.pid) return;
  throw new Error(
    `Scheduler lease held by PID ${owner.pid} (token ${owner.token}). Cannot claim.`,
  );
}

function throwIfLiveScopedLease(
  existingOwner: SchedulerOwner | undefined,
  scope: Exclude<CronSchedulerScope, "all">,
): void {
  if (
    existingOwner &&
    existingOwner.pid !== process.pid &&
    isLiveOwner(existingOwner)
  ) {
    throw new Error(
      `${scope} scheduler lease held by PID ${existingOwner.pid} (token ${existingOwner.token}). Cannot claim.`,
    );
  }
}

/**
 * Claim the scheduler lease. Returns the token on success.
 * Throws if another live process holds the lease.
 *
 * Scoped claims also write a live `scheduler_owner` tombstone so older
 * binaries that only inspect that field refuse `claimSchedulerLease()` and
 * cannot rewrite the file without `scheduler_owners`.
 */
export function claimSchedulerLease(scope: CronSchedulerScope = "all"): string {
  return withLock(() => {
    const data = readScheduleFile();
    const token = randomBytes(4).toString("hex");
    const owner = createSchedulerOwner(token);
    const liveScoped = liveScopedOwners(data);
    const liveLegacy = isLiveOwner(data.scheduler_owner)
      ? data.scheduler_owner
      : null;

    if (scope === "all") {
      for (const existingOwner of liveScoped) {
        throw new Error(
          `Scoped scheduler lease held by PID ${existingOwner.pid}. Cannot claim all schedules.`,
        );
      }
      throwIfLiveAllLease(liveLegacy, true);
      data.scheduler_owners = {};
      data.scheduler_owner = owner;
    } else {
      // A live scheduler_owner with no live scoped owners is a real all-agent
      // lease (or a stale tombstone whose scoped row was stripped). Refuse.
      if (liveScoped.length === 0) {
        throwIfLiveAllLease(liveLegacy, false);
      }
      throwIfLiveScopedLease(data.scheduler_owners[scope], scope);
      data.scheduler_owners[scope] = owner;
      if (!liveLegacy) data.scheduler_owner = owner;
    }
    writeScheduleFile(data);
    return token;
  });
}

/**
 * Verify we still hold the scheduler lease.
 */
export function verifySchedulerLease(
  token: string,
  scope: CronSchedulerScope = "all",
): boolean {
  const data = readScheduleFile();
  const owner =
    scope === "all" ? data.scheduler_owner : data.scheduler_owners[scope];
  return ownerMatches(owner, token);
}

let failNextRefreshSchedulerLease = false;
let throwNextRefreshSchedulerLease = false;

export function __testFailNextRefreshSchedulerLease(fail = true): void {
  failNextRefreshSchedulerLease = fail;
}

export function __testThrowNextRefreshSchedulerLease(shouldThrow = true): void {
  throwNextRefreshSchedulerLease = shouldThrow;
}

/**
 * Confirm we still hold the lease. Scoped holders restore a dead tombstone
 * and a missing row when we own it or it matches `knownTombstoneToken`.
 * A different live all-owner is lease loss. Heartbeat, not only the 60s tick.
 */
export function refreshSchedulerLease(
  token: string,
  scope: CronSchedulerScope = "all",
  knownTombstoneToken?: string,
): boolean {
  return withLock(() => {
    if (throwNextRefreshSchedulerLease) {
      throwNextRefreshSchedulerLease = false;
      throw new Error("Failed to acquire crons.lock — timed out after 5s");
    }
    if (failNextRefreshSchedulerLease) {
      failNextRefreshSchedulerLease = false;
      return false;
    }
    const data = readScheduleFile();
    if (scope === "all") {
      return ownerMatches(data.scheduler_owner, token);
    }
    const owner = data.scheduler_owners[scope];
    if (ownerMatches(owner, token)) {
      if (!isLiveOwner(data.scheduler_owner)) {
        data.scheduler_owner = owner;
        writeScheduleFile(data);
      }
      return true;
    }
    if (isLiveOwner(owner)) return false;
    const tombstone = data.scheduler_owner;
    if (
      isLiveOwner(tombstone) &&
      tombstone.token !== knownTombstoneToken &&
      !ownerMatches(tombstone, token)
    ) {
      return false;
    }
    const restored = createSchedulerOwner(token);
    data.scheduler_owners[scope] = restored;
    if (!isLiveOwner(data.scheduler_owner)) {
      data.scheduler_owner = restored;
    }
    writeScheduleFile(data);
    return true;
  });
}

/**
 * Release the scheduler lease.
 */
export function releaseSchedulerLease(
  token: string,
  scope: CronSchedulerScope = "all",
): void {
  withLock(() => {
    const data = readScheduleFile();
    const owner =
      scope === "all" ? data.scheduler_owner : data.scheduler_owners[scope];
    if (!ownerMatches(owner, token)) return;
    if (scope === "all") {
      data.scheduler_owner = null;
    } else {
      delete data.scheduler_owners[scope];
      if (ownerMatches(data.scheduler_owner, token)) {
        data.scheduler_owner = liveScopedOwners(data)[0] ?? null;
      }
    }
    writeScheduleFile(data);
  });
}

// ── Task-level lease (§5.6) ─────────────────────────────────────────

export interface TaskLeaseClaimInput {
  taskId: string;
  runId: string;
  host: TaskLease["host"];
  now?: Date;
}

export type TaskLeaseClaimResult =
  | { claimed: true; lease: TaskLease }
  | { claimed: false; reason: "missing" | "held"; holder?: TaskLease };

function newLeaseToken(): string {
  return randomBytes(4).toString("hex");
}

/** A lease is live while it has not expired and its holder process exists. */
export function isTaskLeaseLive(
  lease: TaskLease | null | undefined,
  now = new Date(),
): boolean {
  if (!lease) return false;
  const expiresAt = Date.parse(lease.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) return false;
  return isProcessAlive(lease.pid);
}

/**
 * Take the task lease for one run.
 *
 * Refuses while another *live* lease is on the task (R-5.6.2): that run either
 * finishes or expires; neither this call nor a retry may start a second one.
 * An expired lease is taken over — the core decides what to record for the
 * occurrence it was holding (Q-58: recorded as F2/`lease_expired`, not rerun).
 */
export function claimTaskLease(
  input: TaskLeaseClaimInput,
): TaskLeaseClaimResult {
  const now = input.now ?? new Date();
  return withLock(() => {
    const data = readScheduleFile();
    const task = data.tasks.find((candidate) => candidate.id === input.taskId);
    if (!task) return { claimed: false, reason: "missing" };

    const current = task.lease ?? null;
    if (current && isTaskLeaseLive(current, now)) {
      return { claimed: false, reason: "held", holder: current };
    }

    const lease: TaskLease = {
      runId: input.runId,
      host: input.host,
      pid: process.pid,
      token: newLeaseToken(),
      startedAt: now.toISOString(),
      heartbeatAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + TASK_LEASE_TTL_MS).toISOString(),
    };
    task.lease = lease;
    writeScheduleFile(data);
    return { claimed: true, lease };
  });
}

/**
 * Refresh the heartbeat of a lease we own. Returns false when the lease is gone
 * or belongs to somebody else — the caller must treat its run as lost.
 */
export function heartbeatTaskLease(
  taskId: string,
  token: string,
  now = new Date(),
): boolean {
  return withLock(() => {
    const data = readScheduleFile();
    const task = data.tasks.find((candidate) => candidate.id === taskId);
    if (!task?.lease || task.lease.token !== token) return false;
    task.lease.heartbeatAt = now.toISOString();
    task.lease.expiresAt = new Date(
      now.getTime() + TASK_LEASE_TTL_MS,
    ).toISOString();
    writeScheduleFile(data);
    return true;
  });
}

/** Release the lease. Only the token holder may release it. */
export function releaseTaskLease(taskId: string, token: string): boolean {
  return withLock(() => {
    const data = readScheduleFile();
    const task = data.tasks.find((candidate) => candidate.id === taskId);
    if (!task?.lease || task.lease.token !== token) return false;
    task.lease = null;
    writeScheduleFile(data);
    return true;
  });
}
