/**
 * Per-agent dream lock (F-06 M2, route C-24 / R-5.1.5).
 *
 * The F-05 scheduler serialises *tasks*, not agents (route C-10: "同 agent 串行"
 * is not implemented in the core), so a dream run needs its own single-flight
 * gate: at most one run per agent across every host process. This is the "dream"
 * half of the fixed lock order; the memory checkout lock is always taken second
 * (route §2.4) and released first.
 *
 * Reuse of `@/utils/file-lock` is deliberate — it already publishes lock records
 * atomically (write + hard link), records the holder's pid *and* process start
 * time, and supports `reapOnlyDeadOwner`, which is exactly the semantics a
 * paused holder needs: age never steals a live run's lock.
 */

import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { appHomePath } from "@/utils/app-paths";
import { type FileLockOptions, tryAcquireFileLock } from "@/utils/file-lock";

/** The owner record written by `@/utils/file-lock`. */
export interface DreamLockOwner {
  pid: number;
  /** Process start time (from `@/utils/process-liveness`), when available. */
  started: string | null;
  acquiredAt: number;
  token?: string;
}

function lockFileSegment(agentId: string): string {
  const safe = agentId.replace(/[^A-Za-z0-9._-]/g, "_");
  return safe.length > 0 ? safe : "unknown-agent";
}

/** `<harness home>/dream/locks/<agent>.lock` — never a literal `.haruyuki`. */
export function getDreamLockPath(agentId: string): string {
  return appHomePath(["dream", "locks", `${lockFileSegment(agentId)}.lock`]);
}

/** Options a caller may relax in tests; production passes none. */
export interface AcquireDreamLockOptions {
  /**
   * How long to wait for a held lock. The default is `0`: a run that finds a
   * live owner must degrade to F3 (skip, not failure) rather than queue behind
   * a run that may last 45 minutes.
   */
  timeoutMs?: number;
  signal?: AbortSignal;
  retryMs?: number;
}

const LEASE_OPTIONS: Omit<FileLockOptions, "timeoutMs" | "signal"> = {
  // Never steal a lock because it is old: a paused or slow holder owns it.
  reapOnlyDeadOwner: true,
  retryMs: 100,
};

/**
 * Take the agent's dream lock. Returns the release function, or `null` when a
 * live process already holds it (F3: skip this trigger, count no failure).
 */
export async function tryAcquireDreamLock(
  agentId: string,
  options: AcquireDreamLockOptions = {},
): Promise<(() => Promise<void>) | null> {
  const lockPath = getDreamLockPath(agentId);
  // `tryAcquireFileLock` requires the parent directory to exist.
  mkdirSync(dirname(lockPath), { recursive: true });
  return tryAcquireFileLock(lockPath, {
    ...LEASE_OPTIONS,
    timeoutMs: options.timeoutMs ?? 0,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.retryMs !== undefined ? { retryMs: options.retryMs } : {}),
  });
}

/**
 * Read the current owner record without acquiring the lock. Returns `null` when
 * the lock is free or the record is unreadable/corrupt (both mean "nobody we
 * can name holds it"; acquisition is the authority, not this reader).
 */
export function readDreamLockOwner(agentId: string): DreamLockOwner | null {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(getDreamLockPath(agentId), "utf-8"),
    );
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.pid !== "number" || !Number.isFinite(record.pid)) {
      return null;
    }
    return {
      pid: record.pid,
      started: typeof record.started === "string" ? record.started : null,
      acquiredAt: typeof record.acquiredAt === "number" ? record.acquiredAt : 0,
      ...(typeof record.token === "string" ? { token: record.token } : {}),
    };
  } catch {
    return null;
  }
}
