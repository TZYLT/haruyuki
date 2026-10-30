/**
 * Dream run baseline and one-step rollback (F-06 Q-15 / Q-38 / Q-42).
 *
 * A run is bracketed by a commit so an overrun, a crash or a corrupted run can
 * be undone in one operation:
 *
 * - **baseline** = an empty commit taken after both locks are held and before
 *   the child spawns. The SHA is written into the run record first, so recovery
 *   always has a target even if the process dies immediately afterwards.
 * - **rollback** = `reset --hard <baseline>` plus `clean -fd`, run while the
 *   memory lock is held. It never merges, never re-applies, and never inspects
 *   the content: the requirement explicitly forbids the harness from deciding
 *   which of a timed-out run's edits were "good".
 *
 * The module is deliberately git-only. Lock ordering, child liveness checks and
 * the F1/F2 classification live in the run controller; this module is usable
 * from a bare temp repo in tests.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  getMemoryHeadRevision,
  type MemoryCommitAuthor,
  runGit,
} from "@/agent/memory-git";
import { harnessGitIdentity } from "@/agent/memory-git-identity";

export interface DreamBaselineInput {
  /** Memory repository root (`<agent>/memory`). */
  memoryDir: string;
  /** Whose run this is; used for the commit identity and the message. */
  author: MemoryCommitAuthor;
  /** Run id, put in the commit subject so `git log` explains the marker. */
  runId: string;
}

export interface DreamBaseline {
  /** Commit the run can be rolled back to. */
  sha: string;
  /** HEAD before the baseline commit; `null` for an empty repository. */
  previousHead: string | null;
}

export interface DreamRollbackInput {
  memoryDir: string;
  baselineSha: string;
}

export interface DreamRollbackResult {
  /** HEAD after the rollback (equals the baseline, unless git disagreed). */
  head: string | null;
  /** HEAD before the rollback; `null` for an empty repository. */
  previousHead: string | null;
  /** True when there was anything to undo (commit move or dirty worktree). */
  changed: boolean;
}

function assertMemoryRepo(memoryDir: string): void {
  if (!existsSync(join(memoryDir, ".git"))) {
    throw new Error(`Not a memory repository: ${memoryDir}`);
  }
}

/** Commit identity args, matching the memory-commit path's convention. */
function identityArgs(author: MemoryCommitAuthor): string[] {
  const identity = harnessGitIdentity();
  return [
    "-c",
    `user.name=${author.authorName.trim() || author.agentId}`,
    "-c",
    `user.email=${author.authorEmail ?? identity.email}`,
  ];
}

/**
 * Create the run's baseline commit and return its SHA.
 *
 * `--allow-empty` is load-bearing: a run that starts on an unchanged repo still
 * needs a marker, and a first-ever run on an empty repository needs a first
 * commit before anything can be reset to. `--no-verify` skips memory-content
 * hooks: the baseline carries no content, so running the validator on it would
 * only produce false failures (for example before `MEMORY.md` exists).
 */
export async function createDreamBaseline(
  input: DreamBaselineInput,
): Promise<DreamBaseline> {
  assertMemoryRepo(input.memoryDir);
  const previousHead = await getMemoryHeadRevision(input.memoryDir);
  await runGit(input.memoryDir, [
    ...identityArgs(input.author),
    "commit",
    "--allow-empty",
    "--no-verify",
    "-m",
    `dream: baseline ${input.runId}`,
  ]);
  const sha = await getMemoryHeadRevision(input.memoryDir);
  if (sha === null) {
    throw new Error(
      `Dream baseline commit did not produce a HEAD: ${input.memoryDir}`,
    );
  }
  return { sha, previousHead };
}

async function hasDirtyWorktree(memoryDir: string): Promise<boolean> {
  const { stdout } = await runGit(memoryDir, ["status", "--porcelain"]);
  return stdout.trim().length > 0;
}

/**
 * Roll the memory repository back to the baseline.
 *
 * Idempotent by construction: resetting to the commit HEAD already points at
 * still cleans a dirty worktree, and doing it twice is a no-op. A missing
 * baseline object is an error rather than a silent skip — recovery must keep
 * the working tree and report "needs human repair" instead of pretending the
 * rollback happened.
 */
export async function rollbackDreamBaseline(
  input: DreamRollbackInput,
): Promise<DreamRollbackResult> {
  assertMemoryRepo(input.memoryDir);
  await runGit(input.memoryDir, [
    "cat-file",
    "-e",
    `${input.baselineSha}^{commit}`,
  ]);
  const previousHead = await getMemoryHeadRevision(input.memoryDir);
  const dirty = await hasDirtyWorktree(input.memoryDir);
  await runGit(input.memoryDir, ["reset", "--hard", input.baselineSha]);
  await runGit(input.memoryDir, ["clean", "-fd"]);
  const head = await getMemoryHeadRevision(input.memoryDir);
  if (head !== input.baselineSha) {
    throw new Error(
      `Dream rollback landed on ${head ?? "<none>"} instead of ${input.baselineSha}`,
    );
  }
  return {
    head,
    previousHead,
    changed: previousHead !== input.baselineSha || dirty,
  };
}
