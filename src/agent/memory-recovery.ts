/**
 * Crash recovery for the memory repository (F-03 §5.9): reap a dead lock,
 * abort a git operation left half-way, clear stale lock files, back up and drop
 * an uncommitted work tree, and annotate the reflection sessions a crash left
 * unfinished.
 *
 * Placement rules from the requirement:
 * - **Never silent**: every action names what it changed and where the backup
 *   went; a state the module cannot judge is reported as a warning and left
 *   alone (§5.9.2, §5.9.4).
 * - **Idempotent and cheap**: the startup hook and the pre-trigger hook call the
 *   same function; a clean repository must produce an empty report.
 * - **Never in a subagent**: the reflection child is excluded by
 *   `HARUYUKI_CODE_AGENT_ROLE=subagent` at the startup call site, so a child can
 *   never repair the repository out from under its own parent.
 *
 * M0 ships the seam only: the function throws, so the startup hook cannot be
 * wired against a stub that reports a clean repository. The recovery work item
 * implements the checks in the requirement's table order and this interface
 * stays the contract it returns.
 */
export type MemoryRecoveryActionKind =
  | "reaped_operation_lock"
  | "aborted_interrupted_git_operation"
  | "cleared_stale_git_lock"
  | "backed_up_dirty_work_tree"
  | "restored_dirty_work_tree"
  | "annotated_unfinished_reflection";

export interface MemoryRecoveryAction {
  kind: MemoryRecoveryActionKind;
  /** Human-readable coordinate: which file/state was found and what happened. */
  detail: string;
  /** Present when the action produced a backup the user may want to inspect. */
  backupPath?: string;
}

export interface MemoryRecoveryReport {
  agentId: string;
  memoryDir: string;
  actions: MemoryRecoveryAction[];
  /**
   * States that were detected but deliberately not changed (detached HEAD,
   * leftover worktree, a lock whose holder cannot be proven dead). Reporting
   * instead of guessing is the requirement's rule.
   */
  warnings: string[];
}

export interface MemoryRecoveryOptions {
  agentId: string;
  /** The agent's memory checkout (`memfs/<agentId>/memory`); resolved by the caller. */
  memoryDir: string;
}

/**
 * Run every recovery check once. Safe to call on a healthy repository: it then
 * returns an empty report and performs no write.
 */
export async function recoverMemoryState(
  options: MemoryRecoveryOptions,
): Promise<MemoryRecoveryReport> {
  void options;
  // Throwing keeps the startup hook from silently reporting "clean" before the
  // recovery work item lands; it must not be wired earlier.
  throw new Error("memory-recovery.recoverMemoryState: implemented at M1e");
}
