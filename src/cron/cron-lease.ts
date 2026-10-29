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
 * The advisory `crons.lock` directory lock and its steal rules live in the
 * leaf module `cron-lock`, which both this module and `cron-store` import: the
 * store migrates v1 files under that lock, and the lock makes both leases
 * atomic. The graph stays acyclic — `cron-store` → `cron-lock` ← `cron-lease`
 * → `cron-store`.
 */

import { randomBytes } from "node:crypto";
import { withLock } from "./cron-lock";
import {
  applyScheduleTaskV2,
  readScheduleFile,
  toScheduleTaskV2,
  writeScheduleFile,
} from "./cron-store";
import {
  type CronSchedulerScope,
  type ScheduleFileData,
  type SchedulerOwner,
  type ScheduleTaskV2,
  TASK_LEASE_TTL_MS,
  type TaskLease,
} from "./cron-types";
import { captureProcessIdentity, isProcessAlive } from "./process-identity";

// ── Locking
//
// The advisory lock lives in `cron-lock` — a leaf module that both this module
// and `cron-store` import, which keeps the graph acyclic — and is re-exported
// here for the historical call sites.
export { acquireLock, type LockHandle, withLock } from "./cron-lock";

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
  /** Scheduled occurrence this run owns; null/omitted for manual runs. */
  occurrence?: string | null;
}

export type TaskLeaseClaimResult =
  | { claimed: true; lease: TaskLease }
  | {
      claimed: false;
      reason: "missing" | "held" | "consumed";
      holder?: TaskLease;
    };

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
  return isProcessAlive(lease.pid, lease);
}

/**
 * Take the task lease for one run.
 *
 * Refuses while another *live* lease is on the task (R-5.6.2): that run either
 * finishes or expires; neither this call nor a retry may start a second one.
 * Also refuses an occurrence that is already consumed: the check runs under the
 * same lock as the claim, so two hosts cannot both win (R-5.1.3). An expired
 * lease is taken over — recovery records F2 for the occurrence it held (Q-58).
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

    const occurrence = input.occurrence ?? null;
    if (
      occurrence !== null &&
      task.last_consumed_occurrence !== null &&
      task.last_consumed_occurrence !== undefined &&
      occurrence <= task.last_consumed_occurrence
    ) {
      return { claimed: false, reason: "consumed" };
    }

    const lease: TaskLease = {
      runId: input.runId,
      host: input.host,
      pid: process.pid,
      token: newLeaseToken(),
      occurrence,
      startedAt: now.toISOString(),
      heartbeatAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + TASK_LEASE_TTL_MS).toISOString(),
      ...captureProcessIdentity(process.pid),
    };
    task.lease = lease;
    writeScheduleFile(data);
    return { claimed: true, lease };
  });
}

/**
 * Refresh the heartbeat of a lease we own. Returns false when the lease is gone,
 * belongs to somebody else, or has already expired — an expired lease cannot be
 * revived (F-10): the caller must treat its run as lost.
 */
export function heartbeatTaskLease(
  taskId: string,
  token: string,
  now = new Date(),
): boolean {
  return withLock(() => {
    const data = readScheduleFile();
    const task = data.tasks.find((candidate) => candidate.id === taskId);
    const lease = task?.lease;
    if (!lease || lease.token !== token) return false;
    const expiresAt = Date.parse(lease.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) return false;
    lease.heartbeatAt = now.toISOString();
    lease.expiresAt = new Date(now.getTime() + TASK_LEASE_TTL_MS).toISOString();
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

/**
 * Clear a dead task lease and hand the frozen view to the caller for
 * accounting, all inside one lock (P0-4).
 *
 * The leased occurrence is consumed here, before the caller's write, so a
 * crashed run is never replayed — not even when the task has `catch_up`
 * enabled. Two hosts racing recovery see the lease only once, so the F2 line
 * is recorded once (M1 #9 goes through the same failure accounting helper).
 *
 * `apply` may read the run log to decide whether the run already recorded a
 * terminal line; returning early from it still consumes and clears.
 */
export function recoverExpiredTaskLease(
  taskId: string,
  now: Date,
  apply: (view: ScheduleTaskV2, lease: TaskLease) => void,
): TaskLease | null {
  return withLock(() => {
    const data = readScheduleFile();
    const index = data.tasks.findIndex((task) => task.id === taskId);
    const task = index === -1 ? null : data.tasks[index];
    const lease = task?.lease ?? null;
    if (!task || !lease || isTaskLeaseLive(lease, now)) return null;

    const view = toScheduleTaskV2(task);
    if (lease.occurrence !== null) {
      const consumed = view.lastConsumedOccurrence;
      if (consumed === null || lease.occurrence > consumed) {
        view.lastConsumedOccurrence = lease.occurrence;
      }
    }
    apply(view, lease);
    view.lease = null;
    data.tasks[index] = applyScheduleTaskV2(task, view);
    writeScheduleFile(data);
    return lease;
  });
}
