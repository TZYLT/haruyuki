/**
 * Dream run lease (F-06 M2, route §2.4 / C-24 / C-25).
 *
 * The dream lock answers "may this process start?" while it is held. The lease
 * answers the two questions the lock cannot, across time:
 *
 * - **Is a run still alive?** A crashed host leaves neither a lock (reaped only
 *   when the owner is dead) nor a terminal status; the lease records pid +
 *   process start ticks + boot id so recovery can tell "same pid, different
 *   process" from "the owner is still working".
 * - **What would recovery need?** The lease carries the run id, the task id,
 *   the hidden conversation id and the baseline SHA as soon as they exist, so a
 *   crash at any point after the baseline can be rolled back idempotently
 *   without re-reading a half-written conversation record.
 *
 * The lease is *not* a lock: only the lock serialises runs. A lease is a
 * durable breadcrumb with a heartbeat, and it is deleted in the terminal
 * `finally` of the run controller.
 */

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  captureProcessIdentity,
  isProcessAlive,
} from "@/cron/process-identity";
import { appHomePath } from "@/utils/app-paths";

const LEASE_VERSION = 1;

/** How often a live run refreshes `heartbeatAt`. */
export const DREAM_LEASE_HEARTBEAT_MS = 15_000;

/**
 * A heartbeat older than this no longer proves liveness — the owner process is
 * still the authority (`isDreamLeaseOwnerAlive`), this is only used to describe
 * a lease as "quiet" for diagnostics and `/dream status`.
 */
export const DREAM_LEASE_STALE_MS = 3 * 60_000;

export type DreamLeaseStatus = "running" | "finishing";

export interface DreamRunLease {
  version: 1;
  agentId: string;
  runId: string;
  /** Schedule record this run belongs to; recovery leaves failure counting to
   * the F-05 task-lease recovery, but the id keeps the two joinable. */
  taskId: string | null;
  pid: number;
  /** ISO timestamp for humans; the ticks/boot id pair is the identity. */
  processStartedAt: string | null;
  processStartTicks: string | null;
  bootId: string | null;
  startedAt: number;
  heartbeatAt: number;
  status: DreamLeaseStatus;
  /** Hidden conversation the run writes into, once created. */
  conversationId: string | null;
  /** Baseline commit, once created. Recovery rolls back to it. */
  baselineSha: string | null;
}

export interface CreateDreamLeaseInput {
  agentId: string;
  runId: string;
  taskId?: string | null;
  now?: Date;
}

function leaseFileSegment(agentId: string): string {
  const safe = agentId.replace(/[^A-Za-z0-9._-]/g, "_");
  return safe.length > 0 ? safe : "unknown-agent";
}

/** Directory holding every per-agent lease. */
export function getDreamLeaseDir(): string {
  return appHomePath(["dream", "runs"]);
}

/** `<harness home>/dream/runs/<agent>.lease.json` — never a literal `.haruyuki`. */
export function getDreamLeasePath(agentId: string): string {
  return join(getDreamLeaseDir(), `${leaseFileSegment(agentId)}.lease.json`);
}

function writeLeaseFile(lease: DreamRunLease): void {
  const path = getDreamLeasePath(lease.agentId);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(lease, null, 2)}\n`);
  // Atomic rename: a recovery scan never sees a half-written lease.
  renameSync(temp, path);
}

function normalizeLease(value: unknown): DreamRunLease | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.agentId !== "string" || record.agentId.length === 0) {
    return undefined;
  }
  if (typeof record.runId !== "string" || record.runId.length === 0) {
    return undefined;
  }
  if (typeof record.pid !== "number" || !Number.isFinite(record.pid)) {
    return undefined;
  }
  const started = (key: string): number =>
    typeof record[key] === "number" && Number.isFinite(record[key])
      ? (record[key] as number)
      : 0;
  return {
    version: LEASE_VERSION,
    agentId: record.agentId,
    runId: record.runId,
    taskId: typeof record.taskId === "string" ? record.taskId : null,
    pid: record.pid,
    processStartedAt:
      typeof record.processStartedAt === "string"
        ? record.processStartedAt
        : null,
    processStartTicks:
      typeof record.processStartTicks === "string"
        ? record.processStartTicks
        : null,
    bootId: typeof record.bootId === "string" ? record.bootId : null,
    startedAt: started("startedAt"),
    heartbeatAt: started("heartbeatAt"),
    status: record.status === "finishing" ? "finishing" : "running",
    conversationId:
      typeof record.conversationId === "string" ? record.conversationId : null,
    baselineSha:
      typeof record.baselineSha === "string" ? record.baselineSha : null,
  };
}

/** Create (or replace) this process's lease for an agent. */
export function createDreamLease(input: CreateDreamLeaseInput): DreamRunLease {
  const now = input.now ?? new Date();
  const identity = captureProcessIdentity(process.pid);
  const lease: DreamRunLease = {
    version: LEASE_VERSION,
    agentId: input.agentId,
    runId: input.runId,
    taskId: input.taskId ?? null,
    pid: process.pid,
    processStartedAt: now.toISOString(),
    processStartTicks: identity.process_start_ticks,
    bootId: identity.boot_id,
    startedAt: now.getTime(),
    heartbeatAt: now.getTime(),
    status: "running",
    conversationId: null,
    baselineSha: null,
  };
  writeLeaseFile(lease);
  return lease;
}

/** Read one agent's lease; `null` when absent or unreadable. */
export function readDreamLease(agentId: string): DreamRunLease | null {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(getDreamLeasePath(agentId), "utf-8"),
    );
    return normalizeLease(parsed) ?? null;
  } catch {
    return null;
  }
}

/** Every readable lease, sorted by agent id (deterministic for tests). */
export function listDreamLeases(): DreamRunLease[] {
  let entries: string[];
  try {
    entries = readdirSync(getDreamLeaseDir());
  } catch {
    return [];
  }
  const leases: DreamRunLease[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".lease.json")) continue;
    try {
      const parsed: unknown = JSON.parse(
        readFileSync(join(getDreamLeaseDir(), entry), "utf-8"),
      );
      const lease = normalizeLease(parsed);
      if (lease) leases.push(lease);
    } catch {
      // A corrupt lease cannot name a run to recover; ignore it.
    }
  }
  return leases.sort((a, b) => a.agentId.localeCompare(b.agentId));
}

/**
 * Patch a live lease. Read-modify-write in-process only: one run per agent per
 * host means there is no competing writer for this file.
 * Returns the updated lease, or `null` when the lease disappeared (terminal
 * path already ran) — callers treat that as best effort.
 */
export function updateDreamLease(
  agentId: string,
  patch: Partial<
    Pick<
      DreamRunLease,
      "conversationId" | "baselineSha" | "status" | "heartbeatAt"
    >
  >,
): DreamRunLease | null {
  const existing = readDreamLease(agentId);
  if (!existing) return null;
  const next: DreamRunLease = { ...existing, ...patch };
  writeLeaseFile(next);
  return next;
}

/** Refresh the lease heartbeat. Never throws (a heartbeat must not kill a run). */
export function heartbeatDreamLease(
  agentId: string,
  at: number = Date.now(),
): void {
  try {
    updateDreamLease(agentId, { heartbeatAt: at });
  } catch {
    // Best effort: a failed heartbeat is visible as staleness, not as a crash.
  }
}

/**
 * Start the interval that refreshes the heartbeat; returns the stop function.
 * `unref()` keeps the timer from holding the host process open on shutdown.
 */
export function startDreamLeaseHeartbeat(
  agentId: string,
  intervalMs: number = DREAM_LEASE_HEARTBEAT_MS,
): () => void {
  const timer = setInterval(() => {
    heartbeatDreamLease(agentId);
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Delete the lease (terminal `finally`). Never throws. */
export function deleteDreamLease(agentId: string): void {
  try {
    rmSync(getDreamLeasePath(agentId), { force: true });
  } catch {
    // Best effort: a leftover lease is recovery's business, not a run failure.
  }
}

/**
 * True when the process that wrote the lease is still alive. Uses the persisted
 * start ticks / boot id when the platform provides them, so a recycled pid is
 * not mistaken for the original owner.
 */
export function isDreamLeaseOwnerAlive(
  lease: Pick<DreamRunLease, "pid" | "processStartTicks" | "bootId">,
): boolean {
  return isProcessAlive(lease.pid, {
    process_start_ticks: lease.processStartTicks,
    boot_id: lease.bootId,
  });
}

/** True when the heartbeat has not advanced for longer than the stale window. */
export function isDreamLeaseHeartbeatStale(
  lease: Pick<DreamRunLease, "heartbeatAt">,
  now: number = Date.now(),
  staleMs: number = DREAM_LEASE_STALE_MS,
): boolean {
  return now - lease.heartbeatAt > staleMs;
}
