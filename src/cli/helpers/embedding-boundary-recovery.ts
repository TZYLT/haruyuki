/**
 * Boundary hardening for the embedding build (48-2 §3.1 A5, 48-1 §6.8/S-04).
 *
 * **Orphan recovery.** A builder records ownership in A2's `.build.lock` /
 * `.build.lease` (and, for a detached child, in A4's host state). When the
 * owner is provably gone — same-host pid dead, pid reused (start token moved),
 * or a lease expired with a stale lock — the leftovers are collected and a
 * `running`/`cancelling` `state.json` is marked with the closest terminal phase
 * A2 has (`cancelled`, resume-from-checkpoint semantics; A2 has no `interrupted`
 * phase). This module never signals or kills a process: an alive pid is never
 * touched, and a pid that cannot be disproved is treated as live.
 *
 * **Re-used pid.** The recorded pid alone is not identity: a same-host pid is
 * confirmed with the OS start token ({@link getProcessStartTime}), and a
 * mismatch means the recorded ownership is orphaned, not that the new process
 * may be killed.
 *
 * **Antivirus / Windows temp-file locks.** Deletion and state writes retry
 * exactly once on `EPERM`/`EBUSY`/`EACCES`, then report a typed, actionable
 * error instead of a retry storm or a "cleanup succeeded" lie.
 *
 * Preview and removal are separate calls (docs/31 §2 B1/B2): the preview only
 * reads and lists paths plus the state plan; apply deletes only what it listed
 * and re-validates that every path stays inside the space directory.
 *
 * Layer: `cli/helpers/`. Imports A2's public readers/writers and node builtins.
 */

import type { Dirent } from "node:fs";
import { readdir, readFile, rm, stat, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, join, resolve, sep } from "node:path";

import {
  createEmptyEmbeddingBuildState,
  EMBEDDING_BUILD_STATE_FILE_NAME,
  type EmbeddingBuildIdentity,
  type EmbeddingBuildStateReadResult,
  type EmbeddingBuildStateReadStatus,
  embeddingBuildStatePath,
  readEmbeddingBuildState,
  updateEmbeddingBuildState,
} from "@/backend/local/embedding-build-state";
import {
  EMBEDDING_LEASE_FILE_NAME,
  type EmbeddingLeaseInspection,
  inspectEmbeddingLease,
} from "@/backend/local/embedding-lease";
import {
  EMBEDDING_BUILD_LOCK_FILE_NAME,
  EMBEDDING_BUILD_LOCK_STALE_MS,
  type EmbeddingBuildLockInspection,
  inspectEmbeddingBuildLock,
} from "@/backend/local/embedding-lock";
import type { EmbeddingBuildState } from "@/types/embedding-protocol";
import { getProcessStartTime, isProcessAlive } from "@/utils/process-liveness";

/** A retryable Windows lock error is waited out once, briefly. */
export const EMBEDDING_RECOVERY_RETRY_DELAY_MS = 50;

/** Residue age required when no owner witness exists at all. */
export const EMBEDDING_RECOVERY_MIN_RESIDUE_AGE_MS = 600_000;

/** Upper bound on directory entries inspected in one preview. */
export const EMBEDDING_RECOVERY_MAX_ENTRIES = 2_000;

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Errno codes Windows antivirus/indexer locks surface as. */
const RETRYABLE_FS_CODES: readonly string[] = ["EPERM", "EBUSY", "EACCES"];

const STATE_TEMP_PATTERN = new RegExp(
  `^${EMBEDDING_BUILD_STATE_FILE_NAME.replace(/\./g, "\\.")}\\.(\\d+)\\.[^.]+\\.tmp$`,
);
const LOCK_TEMP_PATTERN = new RegExp(
  `^${EMBEDDING_BUILD_LOCK_FILE_NAME.replace(/\./g, "\\.")}\\.(\\d+)\\.[^.]+\\.tmp$`,
);
const LEASE_TEMP_PATTERN = new RegExp(
  `^${EMBEDDING_LEASE_FILE_NAME.replace(/\./g, "\\.")}\\.(\\d+)\\.[^.]+\\.tmp$`,
);
const REAP_MARKER_NAME = `${EMBEDDING_BUILD_LOCK_FILE_NAME}.reap`;
const STAGING_PREFIX = ".tmp-";
const POINTER_TEMP_PREFIX = ".current-";

/** What a filesystem failure means for the user; `retryable` never exceeds one retry. */
export interface EmbeddingRecoveryFsErrorInfo {
  /** Original errno code when the platform supplied one. */
  code: string | null;
  retryable: boolean;
  message: string;
  /** Copy-pasteable remedy; never suggests force-deleting anything. */
  action: string;
}

/** Classify a deletion/write failure into the retry-once policy. */
export function classifyEmbeddingRecoveryFsError(
  error: unknown,
): EmbeddingRecoveryFsErrorInfo {
  const captured = (error as NodeJS.ErrnoException | null)?.code;
  const code = typeof captured === "string" ? captured : null;
  const retryable = code !== null && RETRYABLE_FS_CODES.includes(code);
  if (!retryable) {
    return {
      code,
      retryable: false,
      message:
        code === null
          ? "The cleanup operation failed before it could report an error code."
          : `The cleanup operation failed (${code}).`,
      action:
        code === "ENOENT"
          ? "The path was already gone; nothing else to do."
          : "Nothing was force-deleted. Inspect the path and retry manually.",
    };
  }
  return {
    code,
    retryable: true,
    message: `The file is temporarily locked (${code}) — usually an antivirus scanner or the Windows indexer holding it for a moment.`,
    action:
      "Retry once it is released, or exclude the harness recall-vectors directory from real-time scanning. Nothing was force-deleted.",
  };
}

export type EmbeddingRecoveryAttempt<T> =
  | { ok: true; value: T; attempts: number }
  | { ok: false; error: EmbeddingRecoveryFsErrorInfo; attempts: number };

/** Timer seam for the retry wait; injected so tests do not sleep. */
export type EmbeddingRecoverySleep = (ms: number) => Promise<void>;

const defaultSleep: EmbeddingRecoverySleep = (ms) =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

/** Run one destructive operation, retrying exactly once for a retryable lock error. */
export async function withEmbeddingRecoveryRetry<T>(
  operation: () => Promise<T>,
  options: { sleep?: EmbeddingRecoverySleep; delayMs?: number } = {},
): Promise<EmbeddingRecoveryAttempt<T>> {
  const sleep = options.sleep ?? defaultSleep;
  const delayMs = options.delayMs ?? EMBEDDING_RECOVERY_RETRY_DELAY_MS;
  let attempts = 0;
  let lastError: EmbeddingRecoveryFsErrorInfo | null = null;
  while (attempts < 2) {
    attempts += 1;
    try {
      return { ok: true, value: await operation(), attempts };
    } catch (error) {
      lastError = classifyEmbeddingRecoveryFsError(error);
      if (!lastError.retryable) {
        return { ok: false, error: lastError, attempts };
      }
      if (attempts === 1) await sleep(delayMs);
    }
  }
  return {
    ok: false,
    error: lastError ?? {
      code: null,
      retryable: false,
      message: "The cleanup operation did not run.",
      action: "Nothing was force-deleted.",
    },
    attempts,
  };
}

/** Where one owner record came from (all three are A2/A4 public records). */
export type EmbeddingRecoveryOwnerSource = "lock" | "lease" | "detached";

/** One persisted ownership claim for a space. */
export interface EmbeddingRecoveryOwnerRecord {
  source: EmbeddingRecoveryOwnerSource;
  pid: number;
  host: string;
  /**
   * OS-reported process start token for the pid. Only A4's detached host state
   * can supply this today; without it liveness alone decides.
   */
  startedAt?: string | null;
  token?: string | null;
  heartbeatAt?: number | null;
  expiresAt?: number | null;
}

export type EmbeddingRecoveryVerdict =
  | { kind: "no_build"; evidence: readonly string[] }
  | {
      kind: "live_owner";
      owner: EmbeddingRecoveryOwnerRecord;
      evidence: readonly string[];
    }
  | {
      kind: "orphan";
      owner: EmbeddingRecoveryOwnerRecord | null;
      evidence: readonly string[];
    };

/** What kind of leftover a preview item is. */
export type EmbeddingRecoveryItemKind =
  | "state_temp"
  | "lock_temp"
  | "lease_temp"
  | "reap_marker"
  | "staging_dir"
  | "pointer_temp"
  | "part_file"
  | "lock_file"
  | "lease_file";

export interface EmbeddingRecoveryItem {
  kind: EmbeddingRecoveryItemKind;
  /** Absolute path inside the space directory. */
  path: string;
  type: "file" | "directory";
  reason: string;
}

/** The state correction a preview proposes; applied only by `apply`. */
export interface EmbeddingRecoveryStatePlan {
  statePath: string;
  readStatus: EmbeddingBuildStateReadStatus;
  phase: EmbeddingBuildState;
  /** `cancelled` only for a running/cancelling state with an orphaned owner. */
  nextPhase: "cancelled" | null;
}

/** Read-only recovery plan. Nothing on disk has changed yet. */
export interface EmbeddingRecoveryPreview {
  spaceDir: string;
  agentId: string;
  spaceId: string;
  verdict: EmbeddingRecoveryVerdict;
  items: readonly EmbeddingRecoveryItem[];
  /** Paths deliberately left alone, with the reason (live pid, young file, ...). */
  skipped: readonly { path: string; reason: string }[];
  /** True when the entry cap stopped the scan early. */
  truncated: boolean;
  state: EmbeddingRecoveryStatePlan;
}

export interface EmbeddingRecoveryFailure {
  path: string;
  code: string | null;
  message: string;
  action: string;
}

export interface EmbeddingRecoveryReport {
  spaceDir: string;
  verdict: EmbeddingRecoveryVerdict;
  removed: readonly string[];
  failures: readonly EmbeddingRecoveryFailure[];
  /** The state plan was applied (`running`/`cancelling` → `cancelled`). */
  markedInterrupted: boolean;
  /** The state changed since the preview; the plan was skipped. */
  stateSkipped: boolean;
  hints: readonly string[];
}

/** Seams and identity for one recovery pass. */
export interface EmbeddingBoundaryRecoveryOptions {
  /** The `(agentId, spaceId)` space directory. */
  spaceDir: string;
  agentId?: string;
  spaceId?: string;
  clock?: () => number;
  /** This process's pid/host (injected so tests never probe real pids). */
  pid?: number;
  host?: string;
  /** A4 host state's detached pid, if the caller has one. */
  detachedPid?: number | null;
  /** OS start token recorded next to `detachedPid`, for pid-reuse defence. */
  detachedStartedAt?: string | null;
  isPidAlive?: (pid: number) => boolean;
  getProcessStartTime?: (pid: number) => Promise<string | null>;
  sleep?: EmbeddingRecoverySleep;
  /** Override the remove primitive (filesystem-lock tests). */
  removePath?: (path: string, type: "file" | "directory") => Promise<void>;
  /** Override the residue-age threshold. */
  minResidueAgeMs?: number;
  /** Override the entry cap. */
  maxEntries?: number;
}

interface Environment {
  clock: () => number;
  pid: number;
  host: string;
  isPidAlive: (pid: number) => boolean;
  getProcessStartTime: (pid: number) => Promise<string | null>;
  sleep: EmbeddingRecoverySleep;
  removePath: (path: string, type: "file" | "directory") => Promise<void>;
  minResidueAgeMs: number;
  maxEntries: number;
}

function environmentOf(options: EmbeddingBoundaryRecoveryOptions): Environment {
  return {
    clock: options.clock ?? Date.now,
    pid: options.pid ?? process.pid,
    host: options.host ?? hostname(),
    isPidAlive: options.isPidAlive ?? isProcessAlive,
    getProcessStartTime: options.getProcessStartTime ?? getProcessStartTime,
    sleep: options.sleep ?? defaultSleep,
    removePath: options.removePath ?? defaultRemovePath,
    minResidueAgeMs:
      options.minResidueAgeMs ?? EMBEDDING_RECOVERY_MIN_RESIDUE_AGE_MS,
    maxEntries: options.maxEntries ?? EMBEDDING_RECOVERY_MAX_ENTRIES,
  };
}

async function defaultRemovePath(
  path: string,
  type: "file" | "directory",
): Promise<void> {
  if (type === "directory") {
    await rm(path, { recursive: true, force: true });
    return;
  }
  await unlink(path);
}

function isInside(root: string, candidate: string): boolean {
  const absoluteRoot = resolve(root);
  const absoluteCandidate = resolve(candidate);
  return (
    absoluteCandidate === absoluteRoot ||
    absoluteCandidate.startsWith(`${absoluteRoot}${sep}`)
  );
}

function safeSegment(value: string): boolean {
  return SAFE_SEGMENT.test(value);
}

/** Read the persisted identity when the caller did not pass one. */
async function readPersistedIdentity(
  statePath: string,
): Promise<{ agentId: string | null; spaceId: string | null }> {
  try {
    const raw = await readFile(statePath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      agentId:
        typeof parsed.agentId === "string" && safeSegment(parsed.agentId)
          ? parsed.agentId
          : null,
      spaceId:
        typeof parsed.spaceId === "string" && safeSegment(parsed.spaceId)
          ? parsed.spaceId
          : null,
    };
  } catch {
    return { agentId: null, spaceId: null };
  }
}

interface OwnerEvaluation {
  owner: EmbeddingRecoveryOwnerRecord;
  liveness: "alive" | "dead" | "reused" | "remote_live" | "remote_stale";
  evidence: string;
}

async function evaluateOwner(
  owner: EmbeddingRecoveryOwnerRecord,
  environment: Environment,
  now: number,
): Promise<OwnerEvaluation> {
  if (owner.host !== environment.host) {
    // A pid from another host cannot be probed; the persisted witnesses
    // (lease expiry, lock heartbeat) are the only signals.
    const leaseAlive =
      owner.expiresAt !== null &&
      owner.expiresAt !== undefined &&
      now < owner.expiresAt;
    const lockAlive =
      owner.heartbeatAt !== null &&
      owner.heartbeatAt !== undefined &&
      now - owner.heartbeatAt <= EMBEDDING_BUILD_LOCK_STALE_MS;
    if (leaseAlive || lockAlive) {
      return {
        owner,
        liveness: "remote_live",
        evidence: `${owner.source} from ${owner.host} still has a live witness`,
      };
    }
    return {
      owner,
      liveness: "remote_stale",
      evidence: `${owner.source} from ${owner.host} has no live witness`,
    };
  }

  if (!environment.isPidAlive(owner.pid)) {
    return {
      owner,
      liveness: "dead",
      evidence: `${owner.source} pid ${owner.pid} is not running on ${owner.host}`,
    };
  }
  if (owner.startedAt !== null && owner.startedAt !== undefined) {
    const current = await environment.getProcessStartTime(owner.pid);
    if (current !== null && current !== owner.startedAt) {
      return {
        owner,
        liveness: "reused",
        evidence: `${owner.source} pid ${owner.pid} was reused by another process (start token moved)`,
      };
    }
  }
  return {
    owner,
    liveness: "alive",
    evidence: `${owner.source} pid ${owner.pid} is alive on ${owner.host}`,
  };
}

function ownersFromWitnesses(
  options: EmbeddingBoundaryRecoveryOptions,
  lock: EmbeddingBuildLockInspection,
  lease: EmbeddingLeaseInspection,
  environment: Environment,
): EmbeddingRecoveryOwnerRecord[] {
  const owners: EmbeddingRecoveryOwnerRecord[] = [];
  if (lock.record !== null) {
    owners.push({
      source: "lock",
      pid: lock.record.pid,
      host: lock.record.host,
      token: lock.record.token,
      heartbeatAt: lock.record.heartbeatAt,
    });
  }
  if (lease.record !== null) {
    owners.push({
      source: "lease",
      pid: lease.record.pid,
      host: lease.record.host,
      token: lease.record.token,
      heartbeatAt: lease.record.heartbeatAt,
      expiresAt: lease.record.expiresAt,
    });
  }
  if (options.detachedPid !== null && options.detachedPid !== undefined) {
    owners.push({
      source: "detached",
      pid: options.detachedPid,
      host: options.host ?? environment.host,
      startedAt: options.detachedStartedAt ?? null,
    });
  }
  return owners;
}

async function decideVerdict(
  owners: readonly EmbeddingRecoveryOwnerRecord[],
  statePhase: EmbeddingBuildState,
  stateStatus: EmbeddingBuildStateReadStatus,
  environment: Environment,
  now: number,
): Promise<EmbeddingRecoveryVerdict> {
  const evaluations = await Promise.all(
    owners.map((owner) => evaluateOwner(owner, environment, now)),
  );
  const evidence = evaluations.map((entry) => entry.evidence);

  const live = evaluations.find(
    (entry) => entry.liveness === "alive" || entry.liveness === "remote_live",
  );
  if (live !== undefined) {
    return { kind: "live_owner", owner: live.owner, evidence };
  }

  const reused = evaluations.find((entry) => entry.liveness === "reused");
  if (reused !== undefined) {
    return { kind: "orphan", owner: reused.owner, evidence };
  }

  if (evaluations.length > 0) {
    return { kind: "orphan", owner: evaluations[0]?.owner ?? null, evidence };
  }

  // No ownership record at all. `state.json` says a build was working, so the
  // builder crashed after its lock/lease was already reaped (or it never
  // published one); that is still an orphan and must not stay "running"
  // forever. An idle/terminal state with no witnesses has nothing to recover.
  if (statePhase === "running" || statePhase === "cancelling") {
    return {
      kind: "orphan",
      owner: null,
      evidence: [
        `state.json is ${statePhase} but no lock/lease owner exists`,
        stateStatus === "ok"
          ? "state read as ok"
          : `state read as ${stateStatus}`,
      ],
    };
  }
  return { kind: "no_build", evidence };
}

interface ScannedResidue {
  item: EmbeddingRecoveryItem;
  embeddedPid: number | null;
  mtimeMs: number | null;
}

function residueItem(
  kind: EmbeddingRecoveryItemKind,
  path: string,
  type: "file" | "directory",
  reason: string,
): EmbeddingRecoveryItem {
  return { kind, path, type, reason };
}

function embeddedPidFrom(name: string, pattern: RegExp): number | null {
  const match = pattern.exec(name);
  if (match === null) return null;
  const pid = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(pid) ? pid : null;
}

function reapMarkerOwner(raw: string): {
  pid: number | null;
  at: number | null;
} {
  try {
    const parsed = JSON.parse(raw) as { pid?: unknown; at?: unknown };
    return {
      pid:
        typeof parsed.pid === "number" && Number.isInteger(parsed.pid)
          ? parsed.pid
          : null,
      at:
        typeof parsed.at === "number" && Number.isFinite(parsed.at)
          ? parsed.at
          : null,
    };
  } catch {
    return { pid: null, at: null };
  }
}

/** Walk the space directory (depth 3, bounded entries) for naming-contract residues. */
async function scanResidues(
  spaceDir: string,
  environment: Environment,
): Promise<{ residues: ScannedResidue[]; truncated: boolean }> {
  const residues: ScannedResidue[] = [];
  let scanned = 0;
  let truncated = false;

  async function pushFile(
    path: string,
    kind: EmbeddingRecoveryItemKind,
    reason: string,
    embeddedPid: number | null,
  ): Promise<void> {
    residues.push({
      item: residueItem(kind, path, "file", reason),
      embeddedPid,
      mtimeMs: (await statOrNull(path))?.mtimeMs ?? null,
    });
  }

  async function scanDirectory(
    directory: string,
    depth: number,
  ): Promise<void> {
    if (depth > 3 || truncated) return;
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      scanned += 1;
      if (scanned > environment.maxEntries) {
        truncated = true;
        return;
      }
      const path = join(directory, entry.name);
      if (entry.isFile()) {
        if (entry.name === REAP_MARKER_NAME) {
          const owner = reapMarkerOwner(await readOptionalText(path));
          residues.push({
            item: residueItem(
              "reap_marker",
              path,
              "file",
              "abandoned lock-reap marker",
            ),
            embeddedPid: owner.pid,
            mtimeMs: (await statOrNull(path))?.mtimeMs ?? owner.at,
          });
        } else if (STATE_TEMP_PATTERN.test(entry.name)) {
          await pushFile(
            path,
            "state_temp",
            "leftover state.json atomic-write temp file",
            embeddedPidFrom(entry.name, STATE_TEMP_PATTERN),
          );
        } else if (LOCK_TEMP_PATTERN.test(entry.name)) {
          await pushFile(
            path,
            "lock_temp",
            "leftover lock atomic-write temp file",
            embeddedPidFrom(entry.name, LOCK_TEMP_PATTERN),
          );
        } else if (LEASE_TEMP_PATTERN.test(entry.name)) {
          await pushFile(
            path,
            "lease_temp",
            "leftover lease atomic-write temp file",
            embeddedPidFrom(entry.name, LEASE_TEMP_PATTERN),
          );
        } else if (entry.name.endsWith(".part")) {
          await pushFile(
            path,
            "part_file",
            "leftover .part download file",
            null,
          );
        } else if (entry.name.startsWith(POINTER_TEMP_PREFIX)) {
          await pushFile(
            path,
            "pointer_temp",
            "leftover current.json atomic-write temp file",
            null,
          );
        }
        continue;
      }
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(STAGING_PREFIX)) {
        residues.push({
          item: residueItem(
            "staging_dir",
            path,
            "directory",
            "abandoned generation staging directory",
          ),
          embeddedPid: null,
          mtimeMs: (await statOrNull(path))?.mtimeMs ?? null,
        });
        continue;
      }
      // Unit (or `memory` container) directory: recurse one level, depth-capped.
      await scanDirectory(path, depth + 1);
    }
  }

  await scanDirectory(spaceDir, 0);
  return { residues, truncated };
}

async function readOptionalText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return "";
  }
}

async function statOrNull(path: string): Promise<{ mtimeMs: number } | null> {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

/**
 * Whether a scanned residue is safe to remove. Live owner: nothing is touched.
 * Orphan: every residue except one whose embedded pid is somehow still alive.
 * No owner: only old residues with a dead (or absent) embedded pid.
 */
function residueDecision(
  residue: ScannedResidue,
  verdict: EmbeddingRecoveryVerdict,
  environment: Environment,
  now: number,
): { collect: boolean; reason: string } {
  if (verdict.kind === "live_owner") {
    return { collect: false, reason: "a live builder owns this space" };
  }
  if (
    residue.embeddedPid !== null &&
    environment.isPidAlive(residue.embeddedPid)
  ) {
    return {
      collect: false,
      reason: `pid ${residue.embeddedPid} that wrote this file is still alive`,
    };
  }
  if (verdict.kind === "orphan") {
    return {
      collect: true,
      reason:
        residue.embeddedPid === null
          ? "no live builder owns this space"
          : "writer pid is dead",
    };
  }
  const age = residue.mtimeMs === null ? null : now - residue.mtimeMs;
  if (age !== null && age >= environment.minResidueAgeMs) {
    return { collect: true, reason: "residue is older than the stale window" };
  }
  return {
    collect: false,
    reason:
      "no dead owner and the residue is younger than the stale window; left for the next run",
  };
}

/** Resolve identity for a space and validate the directory is a leaf space. */
async function resolveIdentity(
  options: EmbeddingBoundaryRecoveryOptions,
): Promise<{ agentId: string; spaceId: string; statePath: string }> {
  const spaceDir = resolve(options.spaceDir);
  const statePath = embeddingBuildStatePath(spaceDir);
  const persisted = await readPersistedIdentity(statePath);
  const agentId = options.agentId ?? persisted.agentId ?? "";
  const spaceId = options.spaceId ?? persisted.spaceId ?? basename(spaceDir);
  if (options.agentId !== undefined && !safeSegment(options.agentId)) {
    throw new Error("agentId is not a safe path segment");
  }
  if (options.spaceId !== undefined && !safeSegment(options.spaceId)) {
    throw new Error("spaceId is not a safe path segment");
  }
  return { agentId, spaceId, statePath };
}

/** Build the read-only recovery plan: no deletion, no write. */
export async function previewEmbeddingBoundaryRecovery(
  options: EmbeddingBoundaryRecoveryOptions,
): Promise<EmbeddingRecoveryPreview> {
  const environment = environmentOf(options);
  const identity = await resolveIdentity(options);
  const spaceDir = resolve(options.spaceDir);
  const now = environment.clock();

  let state: EmbeddingBuildStateReadResult;
  if (identity.agentId === "") {
    // No identity anywhere: treat as a missing state rather than guessing.
    state = {
      state: createEmptyEmbeddingBuildState(
        { agentId: "unknown", spaceId: identity.spaceId },
        { clock: environment.clock },
      ),
      status: "missing",
      discarded: false,
    };
  } else {
    state = await readEmbeddingBuildState(identity.statePath, {
      agentId: identity.agentId,
      spaceId: identity.spaceId,
      clock: environment.clock,
    });
  }

  const lockEnvironment = {
    clock: environment.clock,
    pid: environment.pid,
    host: environment.host,
    isPidAlive: environment.isPidAlive,
  };
  const [lock, lease] = await Promise.all([
    inspectEmbeddingBuildLock(spaceDir, lockEnvironment),
    inspectEmbeddingLease(spaceDir, lockEnvironment),
  ]);
  const owners = ownersFromWitnesses(options, lock, lease, environment);
  const verdict = await decideVerdict(
    owners,
    state.state.phase,
    state.status,
    environment,
    now,
  );

  const { residues, truncated } = await scanResidues(spaceDir, environment);
  const items: EmbeddingRecoveryItem[] = [];
  const skipped: { path: string; reason: string }[] = [];
  for (const residue of residues) {
    const decision = residueDecision(residue, verdict, environment, now);
    if (decision.collect) {
      items.push({ ...residue.item, reason: decision.reason });
    } else {
      skipped.push({ path: residue.item.path, reason: decision.reason });
    }
  }

  // An orphan's stale ownership files are the thing that blocks the next build,
  // so they are removed together with the staging remnants.
  if (verdict.kind === "orphan") {
    if (lock.status !== "missing") {
      items.push(
        residueItem(
          "lock_file",
          join(spaceDir, EMBEDDING_BUILD_LOCK_FILE_NAME),
          "file",
          "stale .build.lock belongs to an orphaned build",
        ),
      );
    }
    if (lease.status !== "missing") {
      items.push(
        residueItem(
          "lease_file",
          join(spaceDir, EMBEDDING_LEASE_FILE_NAME),
          "file",
          "stale .build.lease belongs to an orphaned build",
        ),
      );
    }
  }

  const phase = state.state.phase;
  const nextPhase =
    verdict.kind === "orphan" && (phase === "running" || phase === "cancelling")
      ? "cancelled"
      : null;

  return {
    spaceDir,
    agentId: identity.agentId,
    spaceId: identity.spaceId,
    verdict,
    items,
    skipped,
    truncated,
    state: {
      statePath: identity.statePath,
      readStatus: state.status,
      phase,
      nextPhase,
    },
  };
}

async function markStateInterrupted(
  preview: EmbeddingRecoveryPreview,
  environment: Environment,
): Promise<{
  applied: boolean;
  skipped: boolean;
  failure: EmbeddingRecoveryFailure | null;
}> {
  if (preview.state.nextPhase === null) {
    return { applied: false, skipped: false, failure: null };
  }
  if (!isInside(preview.spaceDir, preview.state.statePath)) {
    return {
      applied: false,
      skipped: true,
      failure: {
        path: preview.state.statePath,
        code: null,
        message: "The state path escaped the space directory.",
        action: "The preview was altered; no state was written.",
      },
    };
  }
  if (preview.agentId === "") {
    return {
      applied: false,
      skipped: true,
      failure: {
        path: preview.state.statePath,
        code: null,
        message: "No agent identity was available for the state write.",
        action: "Pass agentId/spaceId to the recovery call.",
      },
    };
  }
  const identity: EmbeddingBuildIdentity = {
    agentId: preview.agentId,
    spaceId: preview.spaceId,
  };
  let skipped = false;
  const attempt = await withEmbeddingRecoveryRetry(
    async () => {
      const current = await readEmbeddingBuildState(preview.state.statePath, {
        ...identity,
        clock: environment.clock,
      });
      if (
        current.state.phase !== "running" &&
        current.state.phase !== "cancelling"
      ) {
        skipped = true;
        return;
      }
      await updateEmbeddingBuildState(
        preview.state.statePath,
        { ...identity, clock: environment.clock },
        { phase: "cancelled" },
        { clock: environment.clock },
      );
    },
    { sleep: environment.sleep },
  );
  if (attempt.ok) return { applied: !skipped, skipped, failure: null };
  return {
    applied: false,
    skipped: false,
    failure: {
      path: preview.state.statePath,
      code: attempt.error.code,
      message: attempt.error.message,
      action: attempt.error.action,
    },
  };
}

/**
 * Apply a preview: delete exactly the listed items and apply its state plan.
 * Every path is re-validated against the space directory first, and a retryable
 * Windows lock error retries once, then is reported (docs/31 §2 B6).
 */
export async function applyEmbeddingBoundaryRecovery(
  preview: EmbeddingRecoveryPreview,
  options: EmbeddingBoundaryRecoveryOptions,
): Promise<EmbeddingRecoveryReport> {
  const environment = environmentOf(options);
  const removed: string[] = [];
  const failures: EmbeddingRecoveryFailure[] = [];

  for (const item of preview.items) {
    if (!isInside(preview.spaceDir, item.path)) {
      failures.push({
        path: item.path,
        code: null,
        message: "The preview listed a path outside the space directory.",
        action: "Nothing was deleted for this item; re-run the preview.",
      });
      continue;
    }
    const attempt = await withEmbeddingRecoveryRetry(
      () => environment.removePath(item.path, item.type),
      { sleep: environment.sleep },
    );
    if (attempt.ok) {
      removed.push(item.path);
      continue;
    }
    if (attempt.error.code === "ENOENT") {
      // Already gone is the desired end state, not a failure.
      removed.push(item.path);
      continue;
    }
    failures.push({
      path: item.path,
      code: attempt.error.code,
      message: attempt.error.message,
      action: attempt.error.action,
    });
  }

  const stateResult = await markStateInterrupted(preview, environment);
  if (stateResult.failure !== null) failures.push(stateResult.failure);

  const hints: string[] = [];
  for (const failure of failures) {
    if (!hints.includes(failure.action)) hints.push(failure.action);
  }
  if (preview.truncated) {
    hints.push(
      "The residue scan hit its entry cap; re-run recovery after the listed items are gone to see the rest.",
    );
  }
  if (preview.verdict.kind === "live_owner") {
    hints.push(
      "Nothing was changed: a live builder owns this space. Wait for it to finish or cancel it.",
    );
  }

  return {
    spaceDir: preview.spaceDir,
    verdict: preview.verdict,
    removed,
    failures,
    markedInterrupted: stateResult.applied,
    stateSkipped: stateResult.skipped,
    hints,
  };
}

/** Host-start convenience: preview, then apply (a background host has no user to ask). */
export async function recoverEmbeddingBoundary(
  options: EmbeddingBoundaryRecoveryOptions,
): Promise<EmbeddingRecoveryReport> {
  const preview = await previewEmbeddingBoundaryRecovery(options);
  return applyEmbeddingBoundaryRecovery(preview, options);
}
