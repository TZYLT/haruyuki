/**
 * Lease for the embedding builder of one `(agentId, spaceId)` space (48-2 §3.1
 * A2, 48-1 §6.8).
 *
 * The lock (`embedding-lock.ts`) is the *mutex*: only one builder may hold it.
 * The lease is the *liveness witness* around that mutex: a short JSON file
 * (`.build.lease`) with `token + heartbeatAt + expiresAt`, refreshed together
 * with the lock heartbeat by the lock holder. Everything that observes a build
 * from outside (status bar, `device_status.embedding`, orphan recovery in A5)
 * can therefore answer "is a builder actually alive?" by reading one small file,
 * without taking the lock and without having to interpret a pid from another
 * host.
 *
 * Why a second file instead of putting `expiresAt` in the lock: the lock's
 * heartbeat is refreshed at the same time, but the two have different recovery
 * semantics. A stale lock is *reaped* (destructive, serialized by the lock's
 * reap marker); a stale lease is merely *observed* as expired and may be taken
 * over by the next lock holder. Keeping them separate means a lease expiry can
 * never delete a lock, and the lease stays readable by observers that must not
 * mutate build ownership.
 *
 * Like the lock, all time and process identity is injected so tests advance a
 * fake clock instead of sleeping.
 *
 * Layer: `backend/local/`. Imports node builtins, `@/utils/process-liveness`
 * and the same-directory lock *type* only; no `cli/`, `websocket/`,
 * `reminders/` or `agent/` import.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { isProcessAlive } from "@/utils/process-liveness";
import type { EmbeddingBuildLockHandle } from "./embedding-lock";

/** File name of the per-space builder lease. */
export const EMBEDDING_LEASE_FILE_NAME = ".build.lease";

/** Default lease lifetime; matches the 120s stale window of 48-2 §4.2. */
export const EMBEDDING_LEASE_DEFAULT_TTL_MS = 120_000;

/** Persisted lease schema; a mismatch is treated as corrupt (discard, rebuild). */
export const EMBEDDING_LEASE_SCHEMA_VERSION = 1;

export interface EmbeddingLeaseIdentity {
  agentId: string;
  spaceId: string;
}

/** The lease file's content. `token` ties it to the owning lock acquisition. */
export interface EmbeddingLeaseRecord extends EmbeddingLeaseIdentity {
  schemaVersion: 1;
  token: string;
  pid: number;
  host: string;
  ttlMs: number;
  createdAt: number;
  heartbeatAt: number;
  expiresAt: number;
}

/** Injectable environment; every field defaults to the real process/clock. */
export interface EmbeddingLeaseEnvironment {
  clock?: () => number;
  pid?: number;
  host?: string;
  /** Liveness probe, injected so tests never touch real pids. */
  isPidAlive?: (pid: number) => boolean;
}

export interface EmbeddingLeaseHandle {
  readonly leasePath: string;
  readonly record: EmbeddingLeaseRecord;
  readonly ttlMs: number;
  /** Extend the lease; `false` when it is no longer ours (released/taken over). */
  renew(): Promise<boolean>;
  /** Remove the lease if (and only if) this handle still owns it. */
  release(): Promise<boolean>;
}

export type EmbeddingLeaseAcquireResult =
  | {
      ok: true;
      handle: EmbeddingLeaseHandle;
      /** True when an expired lease was replaced rather than a fresh one created. */
      takenOver: boolean;
    }
  | {
      ok: false;
      reason: "held";
      /** The live lease that blocked us. */
      record: EmbeddingLeaseRecord;
    };

export type EmbeddingLeaseReadStatus = "missing" | "ok" | "corrupt";

export interface EmbeddingLeaseReadResult {
  record: EmbeddingLeaseRecord | null;
  status: EmbeddingLeaseReadStatus;
}

/** Read-only view for status surfaces: is a builder alive, and for how long. */
export interface EmbeddingLeaseInspection {
  status: "missing" | "live" | "expired" | "corrupt";
  record: EmbeddingLeaseRecord | null;
  /** Negative once expired; `null` when there is no valid record. */
  expiresInMs: number | null;
  heartbeatAgeMs: number | null;
}

export type EmbeddingLeaseValidation =
  | { valid: true }
  | {
      valid: false;
      reason: "invalid_record" | "token_mismatch" | "expired" | "dead_process";
    };

export interface EmbeddingLeaseAcquireOptions
  extends EmbeddingLeaseEnvironment {
  /** Token of the owning lock acquisition; required so observers can correlate. */
  token: string;
  ttlMs?: number;
}

/** Absolute path of the lease file for one space directory. */
export function embeddingLeasePath(spaceDir: string): string {
  return join(spaceDir, EMBEDDING_LEASE_FILE_NAME);
}

/** Read the lease file. Never throws; an unusable file is reported as corrupt. */
export async function readEmbeddingLease(
  spaceDir: string,
): Promise<EmbeddingLeaseReadResult> {
  const raw = await readOptionalFile(embeddingLeasePath(spaceDir));
  if (raw === null) return { record: null, status: "missing" };
  const record = parseLeaseRecord(raw);
  if (!record) return { record: null, status: "corrupt" };
  return { record, status: "ok" };
}

/**
 * Evaluate a lease as `live` or `expired`.
 *
 * Expiry is wall-clock (`expiresAt`), plus a same-host pid probe so a crashed
 * builder is detected before its TTL runs out. A record from another host can
 * only be judged by its expiry: its pid is not probeable here.
 */
export function evaluateEmbeddingLease(
  record: EmbeddingLeaseRecord,
  environment?: EmbeddingLeaseEnvironment,
): "live" | "expired" {
  const now = clockOf(environment?.clock)();
  if (!Number.isFinite(record.expiresAt) || now >= record.expiresAt) {
    return "expired";
  }
  const host = environment?.host ?? hostname();
  if (record.host === host) {
    const pidAlive = environment?.isPidAlive ?? isProcessAlive;
    if (!pidAlive(record.pid)) return "expired";
  }
  return "live";
}

/**
 * Validate a lease record for a consumer that wants a typed reason rather than
 * just live/expired (status surfaces render the reason; renew uses the token
 * rule). Token is checked before expiry so a stolen lease is reported as such.
 */
export function validateEmbeddingLease(
  record: EmbeddingLeaseRecord | null,
  options?: EmbeddingLeaseEnvironment & { token?: string },
): EmbeddingLeaseValidation {
  if (!record) return { valid: false, reason: "invalid_record" };
  if (options?.token !== undefined && record.token !== options.token) {
    return { valid: false, reason: "token_mismatch" };
  }
  const now = clockOf(options?.clock)();
  if (!Number.isFinite(record.expiresAt) || now >= record.expiresAt) {
    return { valid: false, reason: "expired" };
  }
  const host = options?.host ?? hostname();
  if (record.host === host) {
    const pidAlive = options?.isPidAlive ?? isProcessAlive;
    if (!pidAlive(record.pid)) return { valid: false, reason: "dead_process" };
  }
  return { valid: true };
}

/** Inspect the lease without taking anything; used by status projections. */
export async function inspectEmbeddingLease(
  spaceDir: string,
  environment?: EmbeddingLeaseEnvironment,
): Promise<EmbeddingLeaseInspection> {
  const read = await readEmbeddingLease(spaceDir);
  if (read.status !== "ok" || !read.record) {
    return {
      status: read.status === "missing" ? "missing" : "corrupt",
      record: null,
      expiresInMs: null,
      heartbeatAgeMs: null,
    };
  }
  const now = clockOf(environment?.clock)();
  return {
    status: evaluateEmbeddingLease(read.record, environment),
    record: read.record,
    expiresInMs: read.record.expiresAt - now,
    heartbeatAgeMs: now - read.record.heartbeatAt,
  };
}

/**
 * Create (or take over) the lease for a space.
 *
 * The lock is the mutex, so this is not required to be race-free between two
 * prospective builders: it refuses a *live* lease owned by another token (so a
 * caller cannot stomp on a running build by mistake) and replaces an expired one
 * (`takenOver: true`). Re-creating with the same token is allowed and returns the
 * existing handle after refreshing it, which is what a restart of the same
 * builder wants.
 */
export async function acquireEmbeddingLease(
  spaceDir: string,
  identity: EmbeddingLeaseIdentity,
  options: EmbeddingLeaseAcquireOptions,
): Promise<EmbeddingLeaseAcquireResult> {
  const clock = clockOf(options?.clock);
  const leasePath = embeddingLeasePath(spaceDir);
  const pid = options.pid ?? process.pid;
  const host = options.host ?? hostname();
  const ttlMs = options.ttlMs ?? EMBEDDING_LEASE_DEFAULT_TTL_MS;
  const now = clock();

  const read = await readEmbeddingLease(spaceDir);
  let takenOver = false;
  if (read.status === "ok" && read.record) {
    if (read.record.token !== options.token) {
      if (evaluateEmbeddingLease(read.record, options) === "live") {
        return { ok: false, reason: "held", record: read.record };
      }
      takenOver = true;
    }
  }

  const record: EmbeddingLeaseRecord = {
    schemaVersion: EMBEDDING_LEASE_SCHEMA_VERSION,
    agentId: identity.agentId,
    spaceId: identity.spaceId,
    token: options.token,
    pid,
    host,
    ttlMs,
    createdAt:
      read.record?.token === options.token ? read.record.createdAt : now,
    heartbeatAt: now,
    expiresAt: now + ttlMs,
  };
  await mkdir(spaceDir, { recursive: true });
  await replaceFileAtomically(leasePath, JSON.stringify(record));
  return {
    ok: true,
    handle: createLeaseHandle(leasePath, record, { clock, ttlMs }),
    takenOver,
  };
}

/**
 * Create the lease that belongs to a held build lock: same token, same pid/host,
 * same space directory. Intended to be called right after a successful
 * {@link acquireEmbeddingBuildLock} and refreshed with
 * {@link heartbeatEmbeddingBuildLockAndLease}.
 */
export async function createEmbeddingLeaseForLock(
  lock: EmbeddingBuildLockHandle,
  options?: {
    ttlMs?: number;
    clock?: () => number;
    isPidAlive?: (pid: number) => boolean;
  },
): Promise<EmbeddingLeaseAcquireResult> {
  const acquireOptions: EmbeddingLeaseAcquireOptions = {
    token: lock.record.token,
    pid: lock.record.pid,
    host: lock.record.host,
    ...(options?.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
    ...(options?.clock !== undefined ? { clock: options.clock } : {}),
    ...(options?.isPidAlive !== undefined
      ? { isPidAlive: options.isPidAlive }
      : {}),
  };
  return acquireEmbeddingLease(
    lock.spaceDir,
    { agentId: lock.record.agentId, spaceId: lock.record.spaceId },
    acquireOptions,
  );
}

/**
 * The lock holder's heartbeat: refresh the lock first, then the lease. If the
 * lock was lost, the lease is deliberately *not* renewed — a lease claiming a
 * builder that no longer owns the space would keep orphan recovery from ever
 * firing.
 */
export async function heartbeatEmbeddingBuildLockAndLease(
  lock: EmbeddingBuildLockHandle,
  lease: EmbeddingLeaseHandle,
): Promise<boolean> {
  const lockAlive = await lock.heartbeat();
  if (!lockAlive) return false;
  return lease.renew();
}

function createLeaseHandle(
  leasePath: string,
  record: EmbeddingLeaseRecord,
  environment: { clock: () => number; ttlMs: number },
): EmbeddingLeaseHandle {
  const { clock, ttlMs } = environment;
  return {
    leasePath,
    record,
    ttlMs,
    async renew(): Promise<boolean> {
      const raw = await readOptionalFile(leasePath);
      const current = raw === null ? null : parseLeaseRecord(raw);
      if (!current || current.token !== record.token) return false;
      const now = clock();
      const next: EmbeddingLeaseRecord = {
        ...current,
        ttlMs,
        heartbeatAt: now,
        expiresAt: now + ttlMs,
      };
      await replaceFileAtomically(leasePath, JSON.stringify(next));
      record.heartbeatAt = next.heartbeatAt;
      record.expiresAt = next.expiresAt;
      record.ttlMs = ttlMs;
      return true;
    },
    async release(): Promise<boolean> {
      const raw = await readOptionalFile(leasePath);
      const current = raw === null ? null : parseLeaseRecord(raw);
      if (!current || current.token !== record.token) return false;
      await unlink(leasePath).catch(() => undefined);
      return true;
    },
  };
}

function parseLeaseRecord(raw: string): EmbeddingLeaseRecord | null {
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
    record.schemaVersion !== EMBEDDING_LEASE_SCHEMA_VERSION ||
    typeof record.agentId !== "string" ||
    typeof record.spaceId !== "string" ||
    typeof record.token !== "string" ||
    record.token.length === 0 ||
    typeof record.pid !== "number" ||
    !Number.isInteger(record.pid) ||
    typeof record.host !== "string" ||
    typeof record.ttlMs !== "number" ||
    !Number.isFinite(record.ttlMs) ||
    record.ttlMs <= 0 ||
    typeof record.createdAt !== "number" ||
    !Number.isFinite(record.createdAt) ||
    typeof record.heartbeatAt !== "number" ||
    !Number.isFinite(record.heartbeatAt) ||
    typeof record.expiresAt !== "number" ||
    !Number.isFinite(record.expiresAt)
  ) {
    return null;
  }
  return {
    schemaVersion: EMBEDDING_LEASE_SCHEMA_VERSION,
    agentId: record.agentId,
    spaceId: record.spaceId,
    token: record.token,
    pid: record.pid,
    host: record.host,
    ttlMs: record.ttlMs,
    createdAt: record.createdAt,
    heartbeatAt: record.heartbeatAt,
    expiresAt: record.expiresAt,
  };
}

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
