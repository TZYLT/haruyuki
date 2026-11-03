/**
 * Cross-process build lock for one `(agentId, spaceId)` vector space (48-2
 * §3.1 A2, 48-1 §6.8 "同一空间同一时刻只有一个 builder").
 *
 * The lock is a single `.build.lock` file in the space directory carrying
 * `pid + host + heartbeat + token`. It is deliberately *not* a mutex that waits:
 * the builder tries once and decides (it either owns the space or leaves it to
 * the process that does), so a second builder never queues behind a stuck one.
 *
 * Correctness notes, because a lock file is easy to get subtly wrong:
 *
 * - **Published, never half-written.** The record is written to a private temp
 *   file and published with `link`, which fails with `EEXIST` if a lock already
 *   exists. A reader therefore never sees an empty/partial lock, and a process
 *   paused across an acquisition cannot overwrite a lock someone else now holds.
 * - **Stale reaping is serialized.** A lock is stale after
 *   `EMBEDDING_BUILD_LOCK_STALE_MS` without heartbeat (120s, 48-2 §4.2), or when
 *   the same host reports its pid dead. Deleting a stale lock and re-acquiring a
 *   new one must not interleave between two contenders, or the second contender
 *   could delete the fresh lock the first one just published. Every mutation of
 *   the lock file (reap, heartbeat, release) therefore runs under a short-lived
 *   `.build.lock.reap` marker; a marker left by a crashed contender expires on
 *   its own.
 * - **No same-process re-entry.** A second acquisition from the same host + pid
 *   is reported as `held_by_self` while the lock is live: a live process still
 *   owns its bytes, and letting a second builder into the same space is the
 *   exact failure this lock exists to prevent. A lock whose heartbeat went stale
 *   is reclaimed like any other (including one carrying our own pid), so a
 *   crashed predecessor whose pid got reused cannot block the space forever; the
 *   staleness bound makes that recovery bounded rather than permanent.
 * - **Clock and pid are injected.** All timestamps come from the injected clock
 *   and liveness from the injected probe, so tests advance time instead of
 *   sleeping and never depend on real pids.
 *
 * Layer: `backend/local/`. Imports node builtins and `@/utils/process-liveness`
 * only; no `cli/`, `websocket/`, `reminders/` or `agent/` import.
 */

import { randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { isProcessAlive } from "@/utils/process-liveness";
import { sleep } from "@/utils/sleep";

/** File name of the per-space builder lock. */
export const EMBEDDING_BUILD_LOCK_FILE_NAME = ".build.lock";

/** A lock without a heartbeat for this long is reclaimable (48-2 §4.2: 120s). */
export const EMBEDDING_BUILD_LOCK_STALE_MS = 120_000;

/** A reap marker older than this was left by a crashed contender. */
export const EMBEDDING_BUILD_LOCK_REAP_MARKER_STALE_MS = 10_000;

/** Short retry when the reap marker is held by a live (but brief) reaper. */
const REAP_MARKER_RETRY_MS = 2;

/** Upper bound on acquire attempts (publish → lose → reap → publish). */
const ACQUIRE_ATTEMPTS = 3;

export interface EmbeddingBuildLockIdentity {
  agentId: string;
  spaceId: string;
}

/** The lock file's content. */
export interface EmbeddingBuildLockRecord extends EmbeddingBuildLockIdentity {
  schemaVersion: 1;
  pid: number;
  host: string;
  token: string;
  acquiredAt: number;
  heartbeatAt: number;
}

/** Injectable environment; every field defaults to the real process/clock. */
export interface EmbeddingBuildLockEnvironment {
  clock?: () => number;
  pid?: number;
  host?: string;
  /** The acquiring token; normally generated, exposed for deterministic tests. */
  token?: string;
  staleMs?: number;
  reapMarkerStaleMs?: number;
  /** Liveness probe, injected so tests never touch real pids. */
  isPidAlive?: (pid: number) => boolean;
}

export interface EmbeddingBuildLockHandle {
  readonly lockPath: string;
  readonly spaceDir: string;
  readonly record: EmbeddingBuildLockRecord;
  /** Refresh the heartbeat; `false` when the lock is no longer ours. */
  heartbeat(): Promise<boolean>;
  /** Remove the lock if (and only if) this handle still owns it. */
  release(): Promise<boolean>;
}

export type EmbeddingBuildLockAcquireResult =
  | { ok: true; handle: EmbeddingBuildLockHandle }
  | {
      ok: false;
      reason: "held" | "held_by_self" | "busy";
      /** The record that blocked us; `null` when only the reap marker was busy. */
      record: EmbeddingBuildLockRecord | null;
    };

/** Snapshot of the lock file for the status surfaces. */
export interface EmbeddingBuildLockInspection {
  status: "missing" | "live" | "stale" | "corrupt";
  record: EmbeddingBuildLockRecord | null;
  heartbeatAgeMs: number | null;
}

/** Absolute path of the lock file for one space directory. */
export function embeddingBuildLockPath(spaceDir: string): string {
  return join(spaceDir, EMBEDDING_BUILD_LOCK_FILE_NAME);
}

/** Absolute path of the reap marker protecting `lockPath`. */
export function embeddingBuildLockReapMarkerPath(lockPath: string): string {
  return `${lockPath}.reap`;
}

/**
 * Evaluate a lock record as `live` or `stale` without touching the filesystem.
 *
 * Age wins over pid liveness: a heartbeat older than `staleMs` is stale even if
 * the recorded pid is alive (a paused process must not block the space forever,
 * and the heartbeat is the cross-host signal). Fresh + same host + dead pid is
 * stale as well; a fresh record from another host is live because its pid cannot
 * be probed here.
 */
export function evaluateEmbeddingBuildLock(
  record: EmbeddingBuildLockRecord,
  environment?: EmbeddingBuildLockEnvironment,
): "live" | "stale" {
  const now = clockOf(environment?.clock)();
  const staleMs = environment?.staleMs ?? EMBEDDING_BUILD_LOCK_STALE_MS;
  const heartbeatAge = now - record.heartbeatAt;
  if (!Number.isFinite(heartbeatAge) || heartbeatAge > staleMs) return "stale";
  const host = environment?.host ?? hostname();
  if (record.host === host) {
    const pidAlive = environment?.isPidAlive ?? isProcessAlive;
    if (!pidAlive(record.pid)) return "stale";
  }
  return "live";
}

/** Inspect the lock file without acquiring it. Never throws. */
export async function inspectEmbeddingBuildLock(
  spaceDir: string,
  environment?: EmbeddingBuildLockEnvironment,
): Promise<EmbeddingBuildLockInspection> {
  const lockPath = embeddingBuildLockPath(spaceDir);
  const raw = await readOptionalFile(lockPath);
  if (raw === null) {
    return { status: "missing", record: null, heartbeatAgeMs: null };
  }
  const record = parseLockRecord(raw);
  if (!record) {
    return { status: "corrupt", record: null, heartbeatAgeMs: null };
  }
  const now = clockOf(environment?.clock)();
  return {
    status: evaluateEmbeddingBuildLock(record, environment),
    record,
    heartbeatAgeMs: now - record.heartbeatAt,
  };
}

/**
 * Try to take the space lock.
 *
 * Returns a handle on success. `held` means another live owner exists;
 * `held_by_self` means this same process already owns the lock (no re-entry);
 * `busy` means a contender is mid-reap and the caller should retry later. Never
 * waits on the lock itself.
 */
export async function acquireEmbeddingBuildLock(
  spaceDir: string,
  identity: EmbeddingBuildLockIdentity,
  environment?: EmbeddingBuildLockEnvironment,
): Promise<EmbeddingBuildLockAcquireResult> {
  const lockPath = embeddingBuildLockPath(spaceDir);
  const clock = clockOf(environment?.clock);
  const pid = environment?.pid ?? process.pid;
  const host = environment?.host ?? hostname();
  const token = environment?.token ?? randomUUID();
  const staleMs = environment?.staleMs ?? EMBEDDING_BUILD_LOCK_STALE_MS;
  const isPidAlive = environment?.isPidAlive ?? isProcessAlive;

  await mkdir(spaceDir, { recursive: true });

  let lastRecord: EmbeddingBuildLockRecord | null = null;
  for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt += 1) {
    const now = clock();
    const record: EmbeddingBuildLockRecord = {
      schemaVersion: 1,
      agentId: identity.agentId,
      spaceId: identity.spaceId,
      pid,
      host,
      token,
      acquiredAt: now,
      heartbeatAt: now,
    };
    const payload = JSON.stringify(record);
    if (await publishExclusive(lockPath, payload)) {
      return {
        ok: true,
        handle: createLockHandle(spaceDir, lockPath, record, {
          clock,
          staleMs,
          isPidAlive,
          reapMarkerStaleMs:
            environment?.reapMarkerStaleMs ??
            EMBEDDING_BUILD_LOCK_REAP_MARKER_STALE_MS,
          host,
        }),
      };
    }

    const raw = await readOptionalFile(lockPath);
    if (raw === null) continue; // vanished between EEXIST and read: retry
    const existing = parseLockRecord(raw);
    if (existing) {
      lastRecord = existing;
      const evaluation = evaluateEmbeddingBuildLock(existing, {
        clock,
        host,
        isPidAlive,
        staleMs,
      });
      if (evaluation === "live") {
        return existing.host === host && existing.pid === pid
          ? { ok: false, reason: "held_by_self", record: existing }
          : { ok: false, reason: "held", record: existing };
      }
    }
    const reaped = await withReapMarker(lockPath, environment, async () => {
      const current = await readOptionalFile(lockPath);
      if (current !== raw) return false;
      await unlink(lockPath).catch(() => undefined);
      return true;
    });
    if (reaped === null) {
      return { ok: false, reason: "busy", record: lastRecord };
    }
  }
  return { ok: false, reason: "busy", record: lastRecord };
}

function createLockHandle(
  spaceDir: string,
  lockPath: string,
  record: EmbeddingBuildLockRecord,
  environment: Required<
    Pick<
      EmbeddingBuildLockEnvironment,
      "clock" | "staleMs" | "isPidAlive" | "reapMarkerStaleMs" | "host"
    >
  >,
): EmbeddingBuildLockHandle {
  const clock = environment.clock;
  const ownsCurrentLock = async (): Promise<boolean> => {
    const raw = await readOptionalFile(lockPath);
    const current = raw === null ? null : parseLockRecord(raw);
    return current !== null && current.token === record.token;
  };

  return {
    lockPath,
    spaceDir,
    record,
    async heartbeat(): Promise<boolean> {
      const refreshed = await withReapMarker(
        lockPath,
        environment,
        async () => {
          const raw = await readOptionalFile(lockPath);
          const current = raw === null ? null : parseLockRecord(raw);
          if (!current || current.token !== record.token) return false;
          const next: EmbeddingBuildLockRecord = {
            ...current,
            heartbeatAt: clock(),
          };
          await replaceFileAtomically(lockPath, JSON.stringify(next));
          record.heartbeatAt = next.heartbeatAt;
          return true;
        },
      );
      return refreshed === true;
    },
    async release(): Promise<boolean> {
      if (!(await ownsCurrentLock())) return false;
      const released = await withReapMarker(lockPath, environment, async () => {
        const raw = await readOptionalFile(lockPath);
        const current = raw === null ? null : parseLockRecord(raw);
        if (!current || current.token !== record.token) return false;
        await unlink(lockPath).catch(() => undefined);
        return true;
      });
      return released === true;
    },
  };
}

/**
 * Run `fn` while holding the `.reap` marker. Every mutation of the lock file
 * goes through here so a reaper can never delete a lock that was just re-taken
 * by another contender. Returns `null` when the marker could not be obtained
 * (a live contender is mid-reap); the caller turns that into `busy`.
 */
async function withReapMarker<T>(
  lockPath: string,
  environment: EmbeddingBuildLockEnvironment | undefined,
  fn: () => Promise<T>,
): Promise<T | null> {
  const markerPath = embeddingBuildLockReapMarkerPath(lockPath);
  const clock = clockOf(environment?.clock);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const payload = JSON.stringify({
      pid: environment?.pid ?? process.pid,
      host: environment?.host ?? hostname(),
      token: randomUUID(),
      at: clock(),
    });
    if (await publishExclusive(markerPath, payload)) {
      try {
        return await fn();
      } finally {
        await removeIfUnchanged(markerPath, payload);
      }
    }
    if (!(await clearAbandonedReapMarker(markerPath, environment))) {
      if (attempt === 0) {
        await sleep(REAP_MARKER_RETRY_MS);
        continue;
      }
      return null;
    }
  }
  return null;
}

/** Remove a `.reap` marker whose owner crashed or that is unparsable. */
async function clearAbandonedReapMarker(
  markerPath: string,
  environment?: EmbeddingBuildLockEnvironment,
): Promise<boolean> {
  const raw = await readOptionalFile(markerPath);
  if (raw === null) return true;
  const now = clockOf(environment?.clock)();
  const staleMs =
    environment?.reapMarkerStaleMs ?? EMBEDDING_BUILD_LOCK_REAP_MARKER_STALE_MS;
  const host = environment?.host ?? hostname();
  const isPidAlive = environment?.isPidAlive ?? isProcessAlive;
  let marker: { pid?: unknown; host?: unknown; at?: unknown };
  try {
    marker = JSON.parse(raw) as { pid?: unknown; host?: unknown; at?: unknown };
  } catch {
    marker = {};
  }
  const markerAge =
    typeof marker.at === "number" && Number.isFinite(marker.at)
      ? now - marker.at
      : Number.POSITIVE_INFINITY;
  const ownerAlive =
    marker.host === host &&
    typeof marker.pid === "number" &&
    isPidAlive(marker.pid);
  if (ownerAlive && markerAge <= staleMs) return false;
  return removeIfUnchanged(markerPath, raw);
}

/** Publish `payload` at `path` only if `path` does not exist. */
async function publishExclusive(
  path: string,
  payload: string,
): Promise<boolean> {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, payload, "utf-8");
  try {
    await link(temporaryPath, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== "EEXIST") throw error;
    return false;
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

/** Remove `path` only while it still holds `expected` content. */
async function removeIfUnchanged(
  path: string,
  expected: string,
): Promise<boolean> {
  const current = await readOptionalFile(path);
  if (current === null) return true;
  if (current !== expected) return false;
  await unlink(path).catch(() => undefined);
  return true;
}

/** Replacement for a file we already exclusively own (heartbeat refresh). */
async function replaceFileAtomically(
  path: string,
  payload: string,
): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, payload, "utf-8");
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function parseLockRecord(raw: string): EmbeddingBuildLockRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    typeof record.agentId !== "string" ||
    typeof record.spaceId !== "string" ||
    typeof record.pid !== "number" ||
    !Number.isInteger(record.pid) ||
    typeof record.host !== "string" ||
    typeof record.token !== "string" ||
    record.token.length === 0 ||
    typeof record.acquiredAt !== "number" ||
    !Number.isFinite(record.acquiredAt) ||
    typeof record.heartbeatAt !== "number" ||
    !Number.isFinite(record.heartbeatAt)
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    agentId: record.agentId,
    spaceId: record.spaceId,
    pid: record.pid,
    host: record.host,
    token: record.token,
    acquiredAt: record.acquiredAt,
    heartbeatAt: record.heartbeatAt,
  };
}

async function readOptionalFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

function clockOf(clock: (() => number) | undefined): () => number {
  return clock ?? Date.now;
}
