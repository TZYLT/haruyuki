import { existsSync } from "node:fs";
import { join } from "node:path";
import { getAuthToken } from "@/agent/memory-auth";
import { invalidPendingMemory } from "@/agent/memory-constraints-audit";
import { getScopedMemoryFilesystemRoot } from "@/agent/memory-filesystem";
import {
  getMemoryAheadBehind,
  getMemoryConflictSummary,
  isNonFastForwardPushError,
  type MemoryPostTurnSyncResult,
  prepareMemoryRepoForGitOps,
  runGit,
  runGitWithRetry,
} from "@/agent/memory-git";

/**
 * Publish memory commits that a turn left unpushed, and refuse to publish a
 * tree that fails the memory constraints.
 *
 * Lives outside `memory-git.ts` only because that file sits at its size ratchet:
 * it may shrink, never grow.
 */
export async function syncPendingMemoryCommitsAfterTurn(
  agentId: string,
  options: { memoryDir?: string } = {},
): Promise<MemoryPostTurnSyncResult> {
  const memoryDir = options.memoryDir ?? getScopedMemoryFilesystemRoot(agentId);
  // The repo itself decides whether there is anywhere to push. This used to be
  // `capabilities.localMemfs && !capabilities.remoteMemfs`; `remoteMemfs` was
  // removed when the local backend became the only backend, so the predicate
  // became a constant and this function stopped pushing for *every* run —
  // including the Desktop-proxied and self-hosted memory repos that do have a
  // remote, whose pending commits were then never published.
  const initialized = existsSync(join(memoryDir, ".git"));
  const hasRemote = initialized && (await hasMemoryRemote(memoryDir));
  const localOnly = !hasRemote;

  if (!initialized) {
    return {
      status: "skipped",
      summary: "Memory repo is not initialized.",
      memoryDir,
      localOnly,
    };
  }

  const { stdout: statusOut } = await runGit(memoryDir, [
    "status",
    "--porcelain",
  ]);
  const conflictSummary = await getMemoryConflictSummary(memoryDir, statusOut);
  if (conflictSummary) {
    return {
      status: "conflict",
      summary: conflictSummary,
      memoryDir,
      localOnly,
    };
  }

  if (statusOut.trim().length > 0) {
    const changedCount = statusOut
      .split("\n")
      .filter((line) => line.trim().length > 0).length;
    return {
      status: "dirty",
      summary: `${changedCount} uncommitted memory change(s).`,
      memoryDir,
      localOnly,
    };
  }

  if (!hasRemote) {
    return {
      status: "skipped",
      summary: "Local backend MemFS has no Letta remote to push.",
      memoryDir,
      localOnly,
    };
  }

  const token = await getAuthToken();
  await prepareMemoryRepoForGitOps(memoryDir, agentId, token);
  const divergence = await getMemoryAheadBehind(memoryDir);
  if (!divergence || divergence.ahead <= 0) {
    return {
      status: "clean",
      summary: "Memory repo is clean and has no pending commits to push.",
      memoryDir,
      localOnly,
    };
  }

  const initialValidation = invalidPendingMemory(memoryDir, localOnly);
  if (initialValidation) return initialValidation;

  try {
    await runGitWithRetry(memoryDir, ["push", "-u", "origin", "main"], token, {
      operation: "post-turn push pending memory commits",
    });
    return {
      status: "pushed",
      summary: `Pushed ${divergence.ahead} pending memory commit(s).`,
      memoryDir,
      localOnly,
    };
  } catch (pushError) {
    if (!isNonFastForwardPushError(pushError)) {
      return {
        status: "push_failed",
        summary:
          pushError instanceof Error ? pushError.message : String(pushError),
        memoryDir,
        localOnly,
      };
    }

    try {
      await runGitWithRetry(memoryDir, ["pull", "--rebase"], token, {
        operation: "post-turn rebase memory before push",
      });
      const postRebaseConflictSummary =
        await getMemoryConflictSummary(memoryDir);
      if (postRebaseConflictSummary) {
        return {
          status: "conflict",
          summary: postRebaseConflictSummary,
          memoryDir,
          localOnly,
        };
      }
      const rebasedValidation = invalidPendingMemory(memoryDir, localOnly);
      if (rebasedValidation) return rebasedValidation;
      await runGitWithRetry(
        memoryDir,
        ["push", "-u", "origin", "main"],
        token,
        {
          operation: "post-turn push rebased memory commits",
        },
      );
      return {
        status: "pushed",
        summary: `Rebased and pushed ${divergence.ahead} pending memory commit(s).`,
        memoryDir,
        localOnly,
      };
    } catch (rebaseOrPushError) {
      const postFailureConflictSummary =
        await getMemoryConflictSummary(memoryDir);
      if (postFailureConflictSummary) {
        // A resolvable conflict stays in place for the repair worker; aborting
        // here would throw away the only state it can repair.
        return {
          status: "conflict",
          summary: postFailureConflictSummary,
          memoryDir,
          localOnly,
        };
      }
      // F-03 §5.9.5 (X-3): a rebase that died without leaving a resolvable
      // conflict must not leave the checkout half-way. Abort it and report the
      // original failure; the next turn retries from a clean state.
      await runGit(memoryDir, ["rebase", "--abort"]).catch(() => undefined);
      return {
        status: "push_failed",
        summary:
          rebaseOrPushError instanceof Error
            ? rebaseOrPushError.message
            : String(rebaseOrPushError),
        memoryDir,
        localOnly,
      };
    }
  }
}

/** Whether the memory checkout has an `origin` to push pending commits to. */
async function hasMemoryRemote(memoryDir: string): Promise<boolean> {
  try {
    const { stdout } = await runGit(memoryDir, ["remote", "get-url", "origin"]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}
