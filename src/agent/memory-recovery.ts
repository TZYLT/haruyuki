/**
 * Crash recovery for the memory repository (F-03 §5.9): reap a dead lock,
 * abort a git operation left half-way, clear stale lock files, back up and drop
 * an uncommitted work tree, and report anything it refuses to guess at.
 *
 * Placement rules from the requirement:
 * - **Never silent**: every action names what it changed and where the backup
 *   went; a state the module cannot judge is reported as a warning and left
 *   alone (§5.9.2, §5.9.4).
 * - **Idempotent and cheap**: the startup hook and the pre-trigger hook call the
 *   same function; a clean repository produces an empty report.
 * - **Never in a subagent**: the reflection child is excluded by
 *   `HARUYUKI_CODE_AGENT_ROLE=subagent` at the startup call site, so a child can
 *   never repair the repository out from under its own parent.
 * - **One writer at a time**: the whole pass runs under the memory-operation
 *   lease. Taking it also reaps a dead holder, which is how the first row of the
 *   requirement's table is satisfied; failing to take it means another live
 *   process owns the checkout, and then nothing is touched.
 *
 * The `clearGitLocks` helper in `cli/subcommands/snapshot/machine-state.ts` does
 * the same file walk for a restore-from-another-machine import, but `agent/`
 * cannot import from `cli/`. It is copied here, deliberately, with a stricter
 * policy: this runs on a live machine, so a lock file younger than
 * {@link DEFAULT_GIT_LOCK_GRACE_MS} is left alone (a git process may have just
 * created it) instead of being removed outright.
 */
import { execFile as execFileCb } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { promisify } from "node:util";
import { reapStaleMemoryRepairAttempt } from "@/agent/memory-conflict-repair";
import {
  MEMORY_FS_AGENTS_DIR,
  MEMORY_FS_MEMORY_DIR,
} from "@/agent/memory-filesystem";
import { getMemoryGitDir } from "@/agent/memory-git-dir";
import {
  claimMemoryOperation,
  getMemoryOperationPath,
} from "@/agent/memory-operation";
import { getActiveReflectionRun } from "@/agent/reflection-run";
import { isLocalBackendEnvEnabled } from "@/backend/local/paths";
import { readReflectionRunMetadata } from "@/types/reflection-run-metadata";
import { APP_SUBDIRS, appHomePath, appHomeRoot } from "@/utils/app-paths";
import { debugLog, debugWarn } from "@/utils/debug";
import { tryAcquireFileLock } from "@/utils/file-lock";
import { getLocalBackendStorageDir } from "@/utils/local-backend-paths";

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
  /**
   * Discard an uncommitted work tree after backing it up. The startup pass sets
   * this; the pre-trigger pass (the reflection launcher's caller) leaves it off,
   * where a dirty tree is more likely the main agent's live edit than crash
   * debris. Either way the tree is reported.
   */
  discardDirtyWorkTree?: boolean;
  /** A lock file younger than this may belong to a live git process. */
  gitLockGraceMs?: number;
}

/** Locks the harness itself manages; the generic sweep must never touch them. */
const HARNESS_LOCK_NAMES = new Set([
  "letta-memory-operation.lock",
  "letta-memory-repair.json.lock",
]);

const DEFAULT_GIT_LOCK_GRACE_MS = 30_000;
const MAX_GIT_WALK_DEPTH = 4;
const MAX_SCANNED_REPOSITORIES = 200;
const GIT_TIMEOUT_MS = 30_000;
const execFile = promisify(execFileCb);

interface GitResult {
  stdout: string;
  stderr: string;
}

/** Local-only git in one checkout; recovery never talks to a remote. */
async function runGit(cwd: string, args: string[]): Promise<GitResult> {
  const result = await execFile(
    "git",
    ["-C", cwd, "-c", "core.quotepath=false", ...args],
    {
      encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      maxBuffer: 10 * 1024 * 1024,
      timeout: GIT_TIMEOUT_MS,
    },
  );
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

async function tryRunGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    return (await runGit(cwd, args)).stdout;
  } catch {
    return null;
  }
}

function countChanges(statusOutput: string): number {
  return statusOutput.split("\n").filter((line) => line.trim().length > 0)
    .length;
}

/** `2026-10-26T18-41-22-123Z` — sortable and filesystem-safe. */
function recoveryStamp(at: number = Date.now()): string {
  return new Date(at).toISOString().replace(/[:.]/g, "-");
}

// ── backup before a destructive repair ──────────────────────────────

interface RecoveryBackup {
  dir: string;
  patchPath: string;
  statePath: string;
}

/**
 * Copy the pre-repair state into the cache directory: the situation (status,
 * operation heads) and the tracked changes as a patch. Called before every
 * action that would discard work, so `git rebase --abort` and `git restore` are
 * never the only remaining copy (§5.9.4).
 */
async function backupBeforeRepair(
  memoryDir: string,
  agentId: string,
  label: string,
): Promise<RecoveryBackup | null> {
  try {
    const dir = appHomePath([
      APP_SUBDIRS.cache,
      "memory-recovery",
      agentId,
      `${recoveryStamp()}-${label}`,
    ]);
    mkdirSync(dir, { recursive: true });
    const status = (await runGit(memoryDir, ["status", "--porcelain", "-uall"]))
      .stdout;
    const heads = [
      "MERGE_HEAD",
      "REBASE_HEAD",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
    ]
      .map((name) => {
        const gitDir = join(memoryDir, ".git");
        try {
          return `${name}: ${readFileSync(join(gitDir, name), "utf-8").trim()}`;
        } catch {
          return null;
        }
      })
      .filter((line): line is string => line !== null);
    let patch = await tryRunGit(memoryDir, ["diff", "HEAD", "--binary"]);
    patch ??= (await tryRunGit(memoryDir, ["diff", "--binary"])) ?? "";
    const statePath = join(dir, "state.txt");
    writeFileSync(
      statePath,
      [
        `# memory recovery backup (${label})`,
        `# memory dir: ${memoryDir}`,
        `# taken at: ${new Date().toISOString()}`,
        `# operation heads:`,
        ...(heads.length > 0
          ? heads.map((line) => `#   ${line}`)
          : ["#   (none)"]),
        "",
        status,
      ].join("\n"),
      "utf-8",
    );
    const patchPath = join(dir, "changes.patch");
    writeFileSync(patchPath, patch, "utf-8");
    return { dir, patchPath, statePath };
  } catch (error) {
    debugWarn(
      "memory-recovery",
      `could not back up the memory checkout before repairing it: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

// ── stale git lock files ────────────────────────────────────────────

function isUnderRefs(gitDir: string, path: string): boolean {
  return path.startsWith(`${join(gitDir, "refs")}${sep}`);
}

function collectStaleGitLocks(gitDir: string): string[] {
  const found: string[] = [];
  walk(gitDir, 0);
  return found;

  function walk(directory: string, depth: number): void {
    if (depth > MAX_GIT_WALK_DEPTH) return;
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      return;
    }
    for (const name of entries) {
      const path = join(directory, name);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        // Object files never hold a repository lock and there are many of them.
        if (name === "objects" || name === "lfs") continue;
        walk(path, depth + 1);
        continue;
      }
      if (!stat.isFile()) continue;
      if (HARNESS_LOCK_NAMES.has(name)) continue;
      const isRootLock =
        directory === gitDir &&
        (name === "index.lock" || name === "config.lock");
      const isRefLock = name.endsWith(".lock") && isUnderRefs(gitDir, path);
      const isInProgress = name.endsWith(".inprogress");
      if (isRootLock || isRefLock || isInProgress) found.push(path);
    }
  }
}

interface ClearedLocks {
  cleared: string[];
  kept: string[];
}

/**
 * Remove git's own lock files only when no live process can be holding them:
 * the checkout lease is ours (no other harness writer), and a file younger than
 * the grace period is treated as possibly live. A file that cannot be unlinked
 * is kept and reported.
 */
function clearStaleGitLocks(
  gitDir: string,
  graceMs: number,
  report: MemoryRecoveryReport,
): ClearedLocks {
  const result: ClearedLocks = { cleared: [], kept: [] };
  for (const lockPath of collectStaleGitLocks(gitDir)) {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(lockPath).mtimeMs;
    } catch {
      continue;
    }
    if (Date.now() - mtimeMs < graceMs) {
      result.kept.push(lockPath);
      continue;
    }
    try {
      unlinkSync(lockPath);
      result.cleared.push(lockPath);
    } catch (error) {
      result.kept.push(lockPath);
      report.warnings.push(
        `could not remove the stale lock ${lockPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return result;
}

// ── interrupted git operations ──────────────────────────────────────

type InterruptedOperation = "merge" | "rebase" | "cherry-pick" | "revert";

function detectInterruptedOperation(
  gitDir: string,
): InterruptedOperation | null {
  if (
    existsSync(join(gitDir, "rebase-merge")) ||
    existsSync(join(gitDir, "rebase-apply"))
  ) {
    return "rebase";
  }
  if (existsSync(join(gitDir, "MERGE_HEAD"))) return "merge";
  if (existsSync(join(gitDir, "CHERRY_PICK_HEAD"))) return "cherry-pick";
  if (existsSync(join(gitDir, "REVERT_HEAD"))) return "revert";
  return null;
}

async function abortInterruptedOperation(
  memoryDir: string,
  operation: InterruptedOperation,
): Promise<boolean> {
  const args =
    operation === "merge"
      ? ["merge", "--abort"]
      : operation === "rebase"
        ? ["rebase", "--abort"]
        : operation === "cherry-pick"
          ? ["cherry-pick", "--abort"]
          : ["revert", "--abort"];
  try {
    await runGit(memoryDir, args);
    return true;
  } catch (error) {
    debugWarn(
      "memory-recovery",
      `git ${args.join(" ")} failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

// ── the recovery pass ───────────────────────────────────────────────

/**
 * Run every recovery check once. Safe to call on a healthy repository: it then
 * returns an empty report and performs no write.
 */
export async function recoverMemoryState(
  options: MemoryRecoveryOptions,
): Promise<MemoryRecoveryReport> {
  const { agentId, memoryDir } = options;
  const graceMs = options.gitLockGraceMs ?? DEFAULT_GIT_LOCK_GRACE_MS;
  const report: MemoryRecoveryReport = {
    agentId,
    memoryDir,
    actions: [],
    warnings: [],
  };
  if (!existsSync(join(memoryDir, ".git"))) return report;

  let gitDir: string;
  try {
    gitDir = await getMemoryGitDir(memoryDir);
  } catch (error) {
    report.warnings.push(
      `cannot resolve the git directory of ${memoryDir}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return report;
  }

  // Taking the lease both excludes other harness writers and reaps a dead
  // holder; failure means a live process owns the checkout, so hands off.
  const operationLockPath = await getMemoryOperationPath(memoryDir).catch(
    () => null,
  );
  const hadOperationLock =
    operationLockPath !== null && existsSync(operationLockPath);
  const lease = await claimMemoryOperation(memoryDir, { wait: false }).catch(
    () => null,
  );
  if (!lease) {
    report.warnings.push(
      "the memory checkout is owned by another live process; left untouched",
    );
    return report;
  }

  try {
    if (hadOperationLock && operationLockPath) {
      report.actions.push({
        kind: "reaped_operation_lock",
        detail: `removed a memory-operation lock whose holder process was gone (${operationLockPath})`,
      });
    }

    await reapRepairAttempt(memoryDir, gitDir, report);

    const operation = detectInterruptedOperation(gitDir);
    if (operation) {
      const backup = await backupBeforeRepair(
        memoryDir,
        agentId,
        `abort-${operation}`,
      );
      if (backup === null) {
        report.warnings.push(
          `the checkout is in the middle of a ${operation} but it could not be backed up; left in place`,
        );
      } else {
        let aborted = await abortInterruptedOperation(memoryDir, operation);
        if (!aborted) {
          // A stale lock can be exactly why `--abort` failed: clear first, retry once.
          const retried = clearStaleGitLocks(gitDir, graceMs, report);
          reportLocks(retried, report);
          aborted = await abortInterruptedOperation(memoryDir, operation);
        }
        if (aborted) {
          report.actions.push({
            kind: "aborted_interrupted_git_operation",
            detail: `aborted an interrupted git ${operation}`,
            backupPath: backup.dir,
          });
        } else {
          report.warnings.push(
            `the checkout is in the middle of a ${operation} and \`git ${operation} --abort\` failed; backup at ${backup.dir}`,
          );
        }
      }
    }

    reportLocks(clearStaleGitLocks(gitDir, graceMs, report), report);

    if ((await tryRunGit(memoryDir, ["symbolic-ref", "-q", "HEAD"])) === null) {
      report.warnings.push(
        "the memory checkout has a detached HEAD; not guessing the branch",
      );
    }
    reportLegacyWorktrees(memoryDir, report);

    await handleDirtyWorkTree(options, report);
  } finally {
    await lease().catch(() => undefined);
  }

  if (report.actions.length > 0 || report.warnings.length > 0) {
    debugLog(
      "memory-recovery",
      `agent ${agentId}: ${report.actions.length} action(s), ${report.warnings.length} warning(s)`,
    );
  }
  return report;
}

function reportLocks(locks: ClearedLocks, report: MemoryRecoveryReport): void {
  for (const lockPath of locks.cleared) {
    report.actions.push({
      kind: "cleared_stale_git_lock",
      detail: `removed the stale git lock ${lockPath}`,
    });
  }
  for (const lockPath of locks.kept) {
    report.warnings.push(
      `left the recent git lock ${lockPath} alone: a git process may still hold it`,
    );
  }
}

/** `.git/letta-memory-repair.json` left in `launching` by a dead process. */
async function reapRepairAttempt(
  memoryDir: string,
  gitDir: string,
  report: MemoryRecoveryReport,
): Promise<void> {
  const attemptPath = join(gitDir, "letta-memory-repair.json");
  const lockPath = `${attemptPath}.lock`;
  if (existsSync(lockPath)) {
    const release = await tryAcquireFileLock(lockPath, {
      reapOnlyDeadOwner: true,
      timeoutMs: 0,
    }).catch(() => null);
    if (release) {
      report.actions.push({
        kind: "cleared_stale_git_lock",
        detail: `removed the repair-marker lock ${lockPath} whose holder was gone`,
      });
      await release();
    } else {
      report.warnings.push(
        `the repair-marker lock ${lockPath} is held by a live process`,
      );
    }
  }
  if (!existsSync(attemptPath)) return;
  const outcome = await reapStaleMemoryRepairAttempt(memoryDir).catch(
    (error) => ({
      reaped: false,
      noteworthy: true,
      detail: `could not inspect the repair attempt: ${
        error instanceof Error ? error.message : String(error)
      }`,
    }),
  );
  if (outcome.reaped) {
    report.actions.push({
      kind: "cleared_stale_git_lock",
      detail: outcome.detail,
    });
  } else if (outcome.noteworthy) {
    report.warnings.push(outcome.detail);
  }
}

/** Legacy reflection worktrees are reported, never deleted (Q-26). */
function reportLegacyWorktrees(
  memoryDir: string,
  report: MemoryRecoveryReport,
): void {
  const worktreeRoot = join(dirname(memoryDir), "memory-worktrees");
  try {
    const entries = readdirSync(worktreeRoot);
    if (entries.length === 0) return;
    report.warnings.push(
      `legacy memory worktree(s) left in place (no cleanup command): ${entries.slice(0, 5).join(", ")}${entries.length > 5 ? `, and ${entries.length - 5} more` : ""}`,
    );
  } catch {
    // No legacy worktree directory: the normal case.
  }
}

async function handleDirtyWorkTree(
  options: MemoryRecoveryOptions,
  report: MemoryRecoveryReport,
): Promise<void> {
  const { memoryDir, agentId } = options;
  const status = await tryRunGit(memoryDir, ["status", "--porcelain", "-uall"]);
  if (status === null) {
    report.warnings.push("cannot read the memory work tree status");
    return;
  }
  if (status.trim().length === 0) return;
  const changed = countChanges(status);
  if (!options.discardDirtyWorkTree) {
    report.warnings.push(
      `${changed} uncommitted memory change(s) left in place: the pre-trigger pass does not discard work`,
    );
    return;
  }

  const backup = await backupBeforeRepair(memoryDir, agentId, "dirty-worktree");
  if (backup === null) {
    report.warnings.push(
      `${changed} uncommitted memory change(s) left in place: they could not be backed up`,
    );
    return;
  }
  report.actions.push({
    kind: "backed_up_dirty_work_tree",
    detail: `backed up ${changed} uncommitted memory change(s) before discarding them`,
    backupPath: backup.dir,
  });
  try {
    // `git restore .` reads the index, so staged work has to be unstaged first.
    await runGit(memoryDir, ["restore", "--staged", "."]).catch(
      () => undefined,
    );
    await runGit(memoryDir, ["restore", "."]);
    // No `-x`: ignored files belong to the user, not to the abandoned work.
    await runGit(memoryDir, ["clean", "-fd"]);
  } catch (error) {
    report.warnings.push(
      `could not discard the uncommitted memory changes: ${
        error instanceof Error ? error.message : String(error)
      } (backup at ${backup.dir})`,
    );
    return;
  }
  const remaining = await tryRunGit(memoryDir, [
    "status",
    "--porcelain",
    "-uall",
  ]);
  if (remaining !== null && remaining.trim().length > 0) {
    report.warnings.push(
      `the memory work tree is still dirty after the discard (backup at ${backup.dir})`,
    );
    return;
  }
  report.actions.push({
    kind: "restored_dirty_work_tree",
    detail: `discarded ${changed} uncommitted memory change(s)`,
    backupPath: backup.dir,
  });
}

// ── startup / pre-trigger entry points ──────────────────────────────

export interface MemoryRepositoryLocation {
  agentId: string;
  memoryDir: string;
}

/**
 * Every agent memory checkout this process would use, newest layout only:
 * `<root>/<agentId>/memory` under either the local backend's `memfs` tree or the
 * API-shaped `agents` tree.
 */
export function listMemoryRepositoryDirs(
  env: NodeJS.ProcessEnv = process.env,
): MemoryRepositoryLocation[] {
  const agentsRoot = isLocalBackendEnvEnabled(env)
    ? join(getLocalBackendStorageDir(undefined, env), "memfs")
    : join(appHomeRoot(homedir(), env), MEMORY_FS_AGENTS_DIR);
  let entries: string[];
  try {
    entries = readdirSync(agentsRoot).slice(0, MAX_SCANNED_REPOSITORIES);
  } catch {
    return [];
  }
  const repositories: MemoryRepositoryLocation[] = [];
  for (const agentId of entries) {
    const memoryDir = join(agentsRoot, agentId, MEMORY_FS_MEMORY_DIR);
    if (!existsSync(join(memoryDir, ".git"))) continue;
    repositories.push({ agentId, memoryDir });
  }
  return repositories;
}

/**
 * One pass over every checkout, for the startup hook. Failures are per-agent so
 * one damaged repository cannot skip the others.
 */
export async function recoverAllMemoryRepositories(
  options: { discardDirtyWorkTree?: boolean } = {},
): Promise<MemoryRecoveryReport[]> {
  const reports: MemoryRecoveryReport[] = [];
  const locations = listMemoryRepositoryDirs();
  const agentIds = new Set(locations.map((location) => location.agentId));
  for (const { agentId, memoryDir } of locations) {
    try {
      reports.push(
        await recoverMemoryState({
          agentId,
          memoryDir,
          discardDirtyWorkTree: options.discardDirtyWorkTree ?? true,
        }),
      );
    } catch (error) {
      debugWarn(
        "memory-recovery",
        `recovery failed for agent ${agentId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  // A reflection session a crash abandoned has no in-process run to finish it
  // (§5.9.3). Annotation needs the conversation record, so it runs only here —
  // the pre-trigger pass stays a local-only, cheap check.
  for (const agentId of agentIds) {
    const report = reports.find((candidate) => candidate.agentId === agentId);
    if (report) await annotateUnfinishedReflectionSessions(agentId, report);
  }
  if (reports.length > 0) {
    const actions = reports.reduce(
      (total, report) => total + report.actions.length,
      0,
    );
    if (actions > 0) {
      debugLog(
        "memory-recovery",
        `startup recovery repaired ${actions} memory repository state(s) across ${reports.length} checkout(s)`,
      );
    }
  }
  return reports;
}

/**
 * Mark the fork conversations whose durable run record still says `running`
 * but whose run is not live in this process: the process that owned them is
 * gone. The session is kept (F-03 §5.9.3 — never delete a crashed run); only
 * the status is corrected so the maintenance viewer stops claiming it runs.
 */
async function annotateUnfinishedReflectionSessions(
  agentId: string,
  report: MemoryRecoveryReport,
): Promise<void> {
  let listed: unknown;
  try {
    const { getBackend } = await import("@/backend");
    listed = await getBackend().listConversations({ agent_id: agentId });
  } catch (error) {
    debugWarn(
      "memory-recovery",
      `cannot list conversations for agent ${agentId} while annotating unfinished reflections: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return;
  }
  const items = Array.isArray(listed)
    ? listed
    : ((listed as { items?: unknown[] } | null)?.items ?? []);
  if (items.length === 0) return;
  for (const item of items) {
    const record = item as { id?: unknown; reflection?: unknown };
    const conversationId =
      typeof record.id === "string" ? record.id : undefined;
    if (!conversationId) continue;
    const metadata = readReflectionRunMetadata(record.reflection);
    if (!metadata || metadata.status !== "running") continue;
    if (getActiveReflectionRun(agentId)?.runId === metadata.runId) continue;
    try {
      const { writeReflectionRunMetadata } = await import(
        "@/agent/reflection-run-metadata"
      );
      await writeReflectionRunMetadata({
        conversationId,
        metadata: { ...metadata, status: "unfinished" },
      });
      report.actions.push({
        kind: "annotated_unfinished_reflection",
        detail: `marked the reflection session ${conversationId} (run ${metadata.runId}) unfinished: the process that owned it is gone`,
      });
    } catch (error) {
      report.warnings.push(
        `could not mark the reflection session ${conversationId} unfinished: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

/**
 * Fire-and-forget startup pass (requirement §5.9.1). Never runs inside a
 * subagent: the reflection child shares its parent's checkouts and must not try
 * to repair them while the parent may be writing. Never blocks startup and
 * never throws into it.
 */
export function scheduleStartupMemoryRecovery(): void {
  if (process.env.HARUYUKI_CODE_AGENT_ROLE === "subagent") return;
  void recoverAllMemoryRepositories().catch((error) => {
    debugWarn(
      "memory-recovery",
      `startup recovery failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
}
