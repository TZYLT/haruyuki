/**
 * Machine-specific state cleanup after an import has landed.
 *
 * Everything here runs on data that is already in place, and a failure is
 * reported rather than rolled back: the data itself is complete, only
 * scheduler/git plumbing may need a retry (requirement doc §5.10.6).
 *
 * `src/cron` owns `crons.json`, but its lock (`withLock`) and path
 * (`getCronFilePath`) are hard-wired to `appHomeRoot()` and `writeCronFile` is
 * private, so an explicit `appHome` cannot use them. The lock below speaks the
 * same on-disk protocol (a `crons.lock` directory plus `owner.json`, five-second
 * deadline, 30-second stale-steal) so it is interoperable with the scheduler's
 * own lock, and the whole-file read-modify-write is atomic.
 */

import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { installMemoryGitHooks } from "@/agent/memory-git-hooks";
import { isProcessAlive } from "@/cron/process-identity";
import { snapshotError } from "./types";

export interface CronLeaseResult {
  cleared: boolean;
  /** Set when the lease could not be cleared (lock timeout); import continues. */
  warning?: string;
}

export interface HookReinstallResult {
  ok: number;
  /** Absolute repo paths whose hook reinstall failed. */
  failed: string[];
}

const CRON_FILE_NAME = "crons.json";
const CRON_LOCK_DIR_NAME = "crons.lock";
const CRON_LOCK_OWNER_FILE = "owner.json";
const CRON_LOCK_TIMEOUT_MS = 5_000;
const CRON_LOCK_RETRY_MS = 50;
const CRON_LOCK_STALE_AGE_MS = 30_000;

/** Prefix of the credential helper written next to the memory repo. */
const HELPER_FILE_PREFIX = "letta-credential-helper";

const MAX_GIT_WALK_DEPTH = 32;

interface CronLockOwner {
  pid: number;
  token: string;
  acquired_at: number;
  process_start_ticks?: string | null;
  boot_id?: string | null;
}

let cronLockTimeoutOverrideForTests: number | null = null;

/** Test-only: shorten the five-second lock deadline. */
export function __setCronLockTimeoutForTests(timeoutMs: number | null): void {
  cronLockTimeoutOverrideForTests = timeoutMs;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" ? code : undefined;
}

function sleepBlocking(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ── cron lease ──────────────────────────────────────────────────────

function readLockOwner(lockDir: string): CronLockOwner | null {
  try {
    const raw = readFileSync(join(lockDir, CRON_LOCK_OWNER_FILE), "utf-8");
    const parsed = JSON.parse(raw) as Partial<CronLockOwner> | null;
    if (!parsed || typeof parsed.pid !== "number") return null;
    return {
      pid: parsed.pid,
      token: typeof parsed.token === "string" ? parsed.token : "",
      acquired_at:
        typeof parsed.acquired_at === "number" ? parsed.acquired_at : 0,
      process_start_ticks: parsed.process_start_ticks ?? null,
      boot_id: parsed.boot_id ?? null,
    };
  } catch {
    return null;
  }
}

function isLockStale(lockDir: string): boolean {
  const owner = readLockOwner(lockDir);
  if (!owner) {
    try {
      return Date.now() - statSync(lockDir).mtimeMs > CRON_LOCK_STALE_AGE_MS;
    } catch {
      return true;
    }
  }
  const pidDead = !isProcessAlive(owner.pid, owner);
  const aged = Date.now() - owner.acquired_at > CRON_LOCK_STALE_AGE_MS;
  return pidDead && aged;
}

function stealLock(lockDir: string): void {
  try {
    rmSync(lockDir, { recursive: true, force: true });
  } catch {
    // Best effort, same as the scheduler's own steal path.
  }
}

/** Acquire the crons.lock counterpart; `null` means "could not acquire in time". */
function acquireCronLock(appHome: string): { release(): void } | null {
  const lockDir = join(appHome, CRON_LOCK_DIR_NAME);
  const timeoutMs = cronLockTimeoutOverrideForTests ?? CRON_LOCK_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const token = randomUUID();

  while (true) {
    try {
      mkdirSync(lockDir, { recursive: false });
      const owner: CronLockOwner = {
        pid: process.pid,
        token,
        acquired_at: Date.now(),
      };
      writeFileSync(join(lockDir, CRON_LOCK_OWNER_FILE), JSON.stringify(owner));
      return {
        release() {
          try {
            if (readLockOwner(lockDir)?.token === token) {
              rmSync(lockDir, { recursive: true, force: true });
            }
          } catch {
            // Best effort release.
          }
        },
      };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") return null;
    }

    if (isLockStale(lockDir)) {
      stealLock(lockDir);
      continue;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    sleepBlocking(Math.min(CRON_LOCK_RETRY_MS, remaining));
  }
}

/** tmp + fsync + rename: a failed write leaves the previous file intact. */
function writeJsonAtomic(path: string, value: unknown): void {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporaryPath, "wx", 0o600);
  try {
    try {
      writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporaryPath, path);
  } finally {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // Usually already renamed. Cleanup must not mask a failed write/rename.
    }
  }
}

/**
 * Clear the scheduler lease in `crons.json` (`scheduler_owner` -> null,
 * `scheduler_owners` -> {}), keeping tasks and status untouched.
 *
 * Runs inside the cron lock on a read-modify-atomic-write of the whole file. A
 * corrupt file is an error, never silently treated as empty; a lock timeout is
 * a warning because a stale lease only means another scheduler may race for it.
 * `cleared` reports that a lease was actually present and removed; an already
 * clear file (or no file at all) is a no-op.
 */
export async function clearCronLease(
  appHome: string,
): Promise<CronLeaseResult> {
  const cronPath = join(appHome, CRON_FILE_NAME);
  if (!existsSync(cronPath)) return { cleared: false };

  const lock = acquireCronLock(appHome);
  if (!lock) {
    return {
      cleared: false,
      warning:
        "crons.lock is busy; the scheduler lease was left in place (retry the import later).",
    };
  }

  try {
    if (!existsSync(cronPath)) return { cleared: false };

    let raw: string;
    try {
      raw = readFileSync(cronPath, "utf-8");
    } catch (error) {
      throw snapshotError(
        "io_error",
        `Cannot read ${CRON_FILE_NAME} (${errorCode(error) ?? "read failed"}): ${cronPath}`,
      );
    }

    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      // Deliberately not `readCronFile()`: it swallows broken JSON as an empty
      // file, and writing that back would delete every scheduled task.
      throw snapshotError(
        "io_error",
        `${CRON_FILE_NAME} is not valid JSON; refusing to overwrite it: ${cronPath}`,
      );
    }
    if (!isPlainObject(data)) {
      throw snapshotError(
        "io_error",
        `${CRON_FILE_NAME} is not a JSON object; refusing to overwrite it: ${cronPath}`,
      );
    }

    const owners = isPlainObject(data.scheduler_owners)
      ? data.scheduler_owners
      : {};
    const hadLease =
      (data.scheduler_owner !== null && data.scheduler_owner !== undefined) ||
      Object.keys(owners).length > 0;
    if (!hadLease) return { cleared: false };

    const next = {
      ...data,
      scheduler_owner: null,
      scheduler_owners: {},
    };
    try {
      writeJsonAtomic(cronPath, next);
    } catch (error) {
      throw snapshotError(
        "io_error",
        `Cannot write ${CRON_FILE_NAME} (${errorCode(error) ?? "write failed"}): ${cronPath}`,
      );
    }

    return { cleared: true };
  } finally {
    lock.release();
  }
}

// ── git locks and helpers ───────────────────────────────────────────

function uniqueDirs(dirs: ReadonlyArray<string>): string[] {
  return [...new Set(dirs)];
}

function isFileEntry(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function collectGitLockFiles(
  directory: string,
  depth: number,
  found: string[],
): void {
  if (depth > MAX_GIT_WALK_DEPTH) return;

  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return;
  }

  for (const name of entries) {
    const path = join(directory, name);
    if (isFileEntry(path)) {
      if (name.endsWith(".lock") || name.endsWith(".inprogress")) {
        found.push(path);
      }
      continue;
    }
    try {
      if (statSync(path).isDirectory()) {
        collectGitLockFiles(path, depth + 1, found);
      }
    } catch {
      // Vanished or unreadable entry: nothing to clean up there.
    }
  }
}

/**
 * Delete git lock files left by another machine's process
 * (`.git/index.lock`, any `*.lock` under `.git/`, `*.inprogress`). Their
 * recorded pid is meaningless here, so they are removed outright.
 *
 * @returns how many lock files were removed.
 */
export async function clearGitLocks(
  memoryRepoDirs: ReadonlyArray<string>,
): Promise<number> {
  let removed = 0;
  for (const repoDir of uniqueDirs(memoryRepoDirs)) {
    const gitDir = join(repoDir, ".git");
    try {
      if (!statSync(gitDir).isDirectory()) continue;
    } catch {
      continue;
    }

    const locks: string[] = [];
    collectGitLockFiles(gitDir, 0, locks);
    for (const lockPath of locks) {
      try {
        unlinkSync(lockPath);
        removed += 1;
      } catch {
        // Best effort: a lock we cannot remove surfaces through the next git
        // operation instead of aborting a completed import.
      }
    }
  }
  return removed;
}

/** Remove platform-specific credential helpers whose paths no longer exist. */
export async function removePlatformHelpers(
  memoryRepoDirs: ReadonlyArray<string>,
): Promise<number> {
  let removed = 0;
  for (const repoDir of uniqueDirs(memoryRepoDirs)) {
    const gitDir = join(repoDir, ".git");
    let entries: string[];
    try {
      if (!statSync(gitDir).isDirectory()) continue;
      entries = readdirSync(gitDir);
    } catch {
      continue;
    }

    for (const name of entries) {
      if (!name.startsWith(HELPER_FILE_PREFIX)) continue;
      const helperPath = join(gitDir, name);
      if (!isFileEntry(helperPath)) continue;
      try {
        unlinkSync(helperPath);
        removed += 1;
      } catch {
        // Best effort, same policy as lock removal.
      }
    }
  }
  return removed;
}

// ── hooks ───────────────────────────────────────────────────────────

/**
 * Idempotently reinstall memory git hooks; per-repo failures are collected.
 *
 * Only directories that actually carry a `.git` directory are candidates: a
 * stray directory without one is not a memory repository, and installing hooks
 * there would fabricate a `.git` tree.
 */
export async function reinstallHooks(
  memoryRepoDirs: ReadonlyArray<string>,
): Promise<HookReinstallResult> {
  const result: HookReinstallResult = { ok: 0, failed: [] };

  for (const repoDir of uniqueDirs(memoryRepoDirs)) {
    try {
      if (!statSync(join(repoDir, ".git")).isDirectory()) continue;
    } catch {
      continue;
    }

    try {
      installMemoryGitHooks(repoDir);
      result.ok += 1;
    } catch {
      // Reported, never rolled back: the imported data is already complete.
      result.failed.push(repoDir);
    }
  }

  return result;
}

// ── repo discovery ──────────────────────────────────────────────────

function memoryChildren(parentDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(parentDir);
  } catch {
    return [];
  }

  const found: string[] = [];
  for (const name of names.sort()) {
    const memoryDir = join(parentDir, name, "memory");
    try {
      if (statSync(memoryDir).isDirectory()) found.push(memoryDir);
    } catch {
      // No memory checkout for this agent directory.
    }
  }
  return found;
}

/**
 * Enumerate every memory repository that may need cleanup: one `memory` child
 * under each agent directory of both `memfs` and `agents`.
 */
export function listMemoryRepoDirs(storageDir: string): string[] {
  if (!storageDir.trim()) return [];
  return [
    ...memoryChildren(join(storageDir, "memfs")),
    ...memoryChildren(join(storageDir, "agents")),
  ];
}
