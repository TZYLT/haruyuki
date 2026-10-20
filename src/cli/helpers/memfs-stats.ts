// src/cli/helpers/memfs-stats.ts

import { execFile } from "node:child_process";
import { type Dirent, promises as fs } from "node:fs";
import { join } from "node:path";
import { getActiveMemoryDirectory } from "@/agent/memory-runtime";

/**
 * What the rail's `MemFS` section shows: seven days of memory commits, the lines
 * they changed, and how much memory is on disk right now.
 *
 * Memory is a git repository (that is what memfs *is*), so the activity numbers
 * are read with `git log` rather than computed by a second tally: the commits are
 * the ones reflection actually made, and a line count of our own would drift from
 * them the first time a commit rewrote a file.
 *
 * **It never throws and never blocks a frame.** The rail is decoration: a missing
 * checkout, a directory that is not a repo, or a `git` that is not installed all
 * answer `null`, and the section keeps saying `—`. The command is bounded by a
 * timeout because a hung git on a network memory repo would otherwise hold a
 * pending promise for the rest of the session — nothing awaits it, but a leaked
 * process is still a leak.
 */

export type MemfsStats = {
  commits7d: number;
  changedLines7d: number;
  totalBytes: number;
};

/** A git call that cannot outlive a frame's worth of patience. */
const GIT_TIMEOUT_MS = 5_000;

/** `git log` over a big memory repo can be long; this is the cap, then `null`. */
const GIT_MAX_BUFFER = 8 * 1024 * 1024;

function runGit(memoryDir: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", memoryDir, ...args],
      {
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        windowsHide: true,
      },
      (error, stdout) => {
        resolve(error ? null : stdout.toString());
      },
    );
  });
}

/**
 * Parse `git log --numstat --format=%H` output.
 *
 * One line per commit hash, then one `added\tdeleted\tpath` per changed file.
 * Binary files report `-` instead of a number and contribute nothing; merge
 * commits report no files at all. Both are normal, not errors.
 */
export function parseGitNumstatLog(stdout: string): {
  commits: number;
  changedLines: number;
} {
  let commits = 0;
  let changedLines = 0;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (/^[0-9a-f]{7,40}$/i.test(trimmed)) {
      commits += 1;
      continue;
    }
    const [added, deleted] = trimmed.split("\t");
    const addedCount = Number.parseInt(added ?? "", 10);
    const deletedCount = Number.parseInt(deleted ?? "", 10);
    if (Number.isFinite(addedCount)) changedLines += addedCount;
    if (Number.isFinite(deletedCount)) changedLines += deletedCount;
  }
  return { commits, changedLines };
}

/**
 * Bytes of every file under `memoryDir`, `.git` excluded.
 *
 * `.git` is the repository's own bookkeeping — counting it would make the number
 * grow with history rather than with memory, and history is what
 * `changedLines7d` is for.
 */
export async function memoryBytes(memoryDir: string): Promise<number> {
  let total = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        try {
          const stat = await fs.stat(path);
          total += stat.size;
        } catch {
          // A file that vanished between readdir and stat contributes nothing.
        }
      }
    }
  };
  await walk(memoryDir);
  return total;
}

/** Stats for one memory checkout; `null` when it is not a usable repository. */
export async function readMemfsStatsForDir(
  memoryDir: string,
): Promise<MemfsStats | null> {
  try {
    const stat = await fs.stat(memoryDir);
    if (!stat.isDirectory()) return null;
  } catch {
    return null;
  }
  const [log, totalBytes] = await Promise.all([
    runGit(memoryDir, [
      "log",
      "--since=7 days ago",
      "--numstat",
      "--format=%H",
    ]),
    memoryBytes(memoryDir),
  ]);
  // A directory that is not a repository still has bytes; the activity numbers
  // are what is missing, and "no commits in seven days" is a lie we refuse to
  // print. `null` keeps the section on `—`.
  if (log === null) return null;
  const { commits, changedLines } = parseGitNumstatLog(log);
  return { commits7d: commits, changedLines7d: changedLines, totalBytes };
}

/**
 * Stats for the agent's active memory checkout.
 *
 * `getActiveMemoryDirectory` is the one resolver: it answers `undefined` when the
 * agent has no memfs checkout (a non-memfs agent, or a stateless headless run),
 * and the rail then has nothing to say about memory — the same `—` as a failed
 * read, because "there is no memory" and "memory has no activity" are both true
 * statements about a section that has no data source.
 */
export async function readMemfsStats(
  agentId: string,
): Promise<MemfsStats | null> {
  const memoryDir = getActiveMemoryDirectory(agentId);
  if (!memoryDir) return null;
  return readMemfsStatsForDir(memoryDir);
}
