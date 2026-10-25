/**
 * Machine-specific state cleanup after an import has landed.
 *
 * M0 holds the shape only; M3 fills the bodies. Everything here runs on data
 * that is already in place, and a failure is reported rather than rolled back:
 * the data itself is complete, only scheduler/git plumbing may need a retry
 * (requirement doc §5.10.6).
 */

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

/**
 * Clear the scheduler lease in `crons.json` (`scheduler_owner` -> null,
 * `scheduler_owners` -> {}), keeping tasks and status untouched.
 *
 * Runs inside the cron lock on a read-modify-atomic-write of the whole file. A
 * corrupt file is an error, never silently treated as empty; a lock timeout is
 * a warning because a stale lease only means another scheduler may race for it.
 */
export async function clearCronLease(
  appHome: string,
): Promise<CronLeaseResult> {
  void appHome;
  throw new Error("snapshot/machine-state.clearCronLease: implemented at M3");
}

/**
 * Delete git lock files left by another machine's process
 * (`.git/index.lock`, any `*.lock` under `.git/`, `*.inprogress`). Their
 * recorded pid is meaningless here, so they are removed outright.
 */
export async function clearGitLocks(
  memoryRepoDirs: ReadonlyArray<string>,
): Promise<number> {
  void memoryRepoDirs;
  throw new Error("snapshot/machine-state.clearGitLocks: implemented at M3");
}

/** Remove platform-specific credential helpers whose paths no longer exist. */
export async function removePlatformHelpers(
  memoryRepoDirs: ReadonlyArray<string>,
): Promise<number> {
  void memoryRepoDirs;
  throw new Error(
    "snapshot/machine-state.removePlatformHelpers: implemented at M3",
  );
}

/** Idempotently reinstall memory git hooks; per-repo failures are collected. */
export async function reinstallHooks(
  memoryRepoDirs: ReadonlyArray<string>,
): Promise<HookReinstallResult> {
  void memoryRepoDirs;
  throw new Error("snapshot/machine-state.reinstallHooks: implemented at M3");
}

/**
 * Enumerate every memory repository that may need cleanup: one `memory` child
 * under each agent directory of both `memfs` and `agents`.
 */
export function listMemoryRepoDirs(storageDir: string): string[] {
  void storageDir;
  throw new Error(
    "snapshot/machine-state.listMemoryRepoDirs: implemented at M3",
  );
}
