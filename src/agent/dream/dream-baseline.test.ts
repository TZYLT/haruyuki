/**
 * Dream baseline and one-step rollback (F-06 Q-15 / Q-38 / Q-42).
 *
 * These run on throwaway git repositories: no agent home, no real data. The
 * contract under test is narrow and absolute — after a rollback the working
 * tree is exactly the baseline commit, including deletion of untracked files,
 * and running it twice changes nothing.
 *
 * Git costs seconds per process on Windows, and each case runs several, so
 * every test carries its own budget (not `setDefaultTimeout`, which would leak
 * into other files sharing the worker).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createDreamBaseline,
  rollbackDreamBaseline,
} from "@/agent/dream/dream-baseline";
import {
  getMemoryHeadRevision,
  type MemoryCommitAuthor,
} from "@/agent/memory-git";
import {
  createTempGitRepo,
  type TempGitRepo,
} from "@/test-utils/temp-git-repo";

const AUTHOR: MemoryCommitAuthor = {
  agentId: "agent-dream-baseline",
  authorName: "Dream Test",
  authorEmail: "dream-test@haruyuki.local",
};
const TEST_TIMEOUT_MS = 30_000;

const repos: TempGitRepo[] = [];

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup();
});

function repository(): TempGitRepo {
  const repo = createTempGitRepo("haruyuki-dream-baseline-");
  repos.push(repo);
  return repo;
}

function commitAll(repo: TempGitRepo, message: string): void {
  repo.git("add", "-A");
  repo.git("commit", "--no-verify", "-m", message);
}

describe("createDreamBaseline", () => {
  test(
    "records HEAD before an empty marker commit",
    async () => {
      const repo = repository();
      writeFileSync(join(repo.dir, "MEMORY.md"), "# Memory\n");
      commitAll(repo, "initial");
      const before = await getMemoryHeadRevision(repo.dir);

      const baseline = await createDreamBaseline({
        memoryDir: repo.dir,
        author: AUTHOR,
        runId: "run-1",
      });

      expect(baseline.previousHead).toBe(before);
      expect(baseline.sha).not.toBe(before);
      expect(await getMemoryHeadRevision(repo.dir)).toBe(baseline.sha);
      expect(repo.git("log", "-1", "--pretty=%s")).toBe(
        "dream: baseline run-1",
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "creates the first commit on an empty repository",
    async () => {
      const repo = repository();
      const baseline = await createDreamBaseline({
        memoryDir: repo.dir,
        author: AUTHOR,
        runId: "run-empty",
      });
      expect(baseline.previousHead).toBeNull();
      expect(await getMemoryHeadRevision(repo.dir)).toBe(baseline.sha);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "rejects a directory that is not a git repository",
    async () => {
      const repo = repository();
      // A directory with no `.git`; the temp repo is only used for cleanup.
      const bare = join(repo.dir, "not-a-repo");
      mkdirSync(bare);
      await expect(
        createDreamBaseline({
          memoryDir: bare,
          author: AUTHOR,
          runId: "run-1",
        }),
      ).rejects.toThrow("Not a memory repository");
    },
    TEST_TIMEOUT_MS,
  );
});

describe("rollbackDreamBaseline", () => {
  test(
    "resets commits and removes the run's changes",
    async () => {
      const repo = repository();
      writeFileSync(join(repo.dir, "MEMORY.md"), "# Memory\n");
      commitAll(repo, "initial");
      const baseline = await createDreamBaseline({
        memoryDir: repo.dir,
        author: AUTHOR,
        runId: "run-1",
      });

      // The dream agent's work: a content change, a new file and a new subtree.
      writeFileSync(join(repo.dir, "MEMORY.md"), "# Memory\nrewritten\n");
      writeFileSync(join(repo.dir, "notes.md"), "new note\n");
      mkdirSync(join(repo.dir, "maintenance"));
      writeFileSync(join(repo.dir, "maintenance", "report.md"), "report\n");
      commitAll(repo, "dream work");

      const result = await rollbackDreamBaseline({
        memoryDir: repo.dir,
        baselineSha: baseline.sha,
      });

      expect(result.changed).toBe(true);
      expect(result.head).toBe(baseline.sha);
      expect(await getMemoryHeadRevision(repo.dir)).toBe(baseline.sha);
      expect(readFileSync(join(repo.dir, "MEMORY.md"), "utf8")).toBe(
        "# Memory\n",
      );
      expect(existsSync(join(repo.dir, "notes.md"))).toBe(false);
      expect(existsSync(join(repo.dir, "maintenance"))).toBe(false);
      expect(repo.git("status", "--porcelain")).toBe("");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "cleans a dirty worktree that was never committed",
    async () => {
      const repo = repository();
      writeFileSync(join(repo.dir, "MEMORY.md"), "# Memory\n");
      commitAll(repo, "initial");
      const baseline = await createDreamBaseline({
        memoryDir: repo.dir,
        author: AUTHOR,
        runId: "run-1",
      });

      writeFileSync(join(repo.dir, "MEMORY.md"), "# Memory\nrewritten\n");
      writeFileSync(join(repo.dir, "scratch.txt"), "scratch\n");

      const result = await rollbackDreamBaseline({
        memoryDir: repo.dir,
        baselineSha: baseline.sha,
      });
      expect(result.changed).toBe(true);
      expect(readFileSync(join(repo.dir, "MEMORY.md"), "utf8")).toBe(
        "# Memory\n",
      );
      expect(existsSync(join(repo.dir, "scratch.txt"))).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "is idempotent",
    async () => {
      const repo = repository();
      writeFileSync(join(repo.dir, "MEMORY.md"), "# Memory\n");
      commitAll(repo, "initial");
      const baseline = await createDreamBaseline({
        memoryDir: repo.dir,
        author: AUTHOR,
        runId: "run-1",
      });
      writeFileSync(join(repo.dir, "dirty.md"), "x\n");
      commitAll(repo, "dream work");

      const first = await rollbackDreamBaseline({
        memoryDir: repo.dir,
        baselineSha: baseline.sha,
      });
      const second = await rollbackDreamBaseline({
        memoryDir: repo.dir,
        baselineSha: baseline.sha,
      });

      expect(first.changed).toBe(true);
      expect(second.changed).toBe(false);
      expect(second.head).toBe(baseline.sha);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "an unknown baseline is an error, not a silent no-op",
    async () => {
      const repo = repository();
      writeFileSync(join(repo.dir, "MEMORY.md"), "# Memory\n");
      commitAll(repo, "initial");

      await expect(
        rollbackDreamBaseline({
          memoryDir: repo.dir,
          baselineSha: "0000000000000000000000000000000000000000",
        }),
      ).rejects.toThrow();
    },
    TEST_TIMEOUT_MS,
  );
});
