import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimMemoryOperation } from "@/agent/memory-operation";
import {
  listMemoryRepositoryDirs,
  recoverMemoryState,
} from "@/agent/memory-recovery";
import {
  createTempGitRepo,
  type TempGitRepo,
} from "@/test-utils/temp-git-repo";
import { getProcessStartTime } from "@/utils/process-liveness";

const ENV_KEYS = [
  "HARUYUKI_HOME",
  "HARUYUKI_LOCAL_BACKEND_EXPERIMENTAL",
  "LETTA_LOCAL_BACKEND_DIR",
] as const;

let home: string;
let savedEnv: Record<string, string | undefined>;
const repos: TempGitRepo[] = [];

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  home = mkdtempSync(join(tmpdir(), "memory-recovery-"));
  process.env.HARUYUKI_HOME = home;
  delete process.env.HARUYUKI_LOCAL_BACKEND_EXPERIMENTAL;
  delete process.env.LETTA_LOCAL_BACKEND_DIR;
});

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup();
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

/** A memory checkout with one seed commit. */
function checkout(): TempGitRepo {
  const repo = createTempGitRepo("memory-recovery-repo-");
  repos.push(repo);
  writeFileSync(join(repo.dir, "persona.md"), "# persona\nsteady\n", "utf-8");
  repo.git("add", ".");
  repo.git("commit", "-qm", "seed memory");
  return repo;
}

function gitDirOf(repo: TempGitRepo): string {
  return join(repo.dir, ".git");
}

function ageFile(file: string, ageMs: number): void {
  const stamp = new Date(Date.now() - ageMs);
  utimesSync(file, stamp, stamp);
}

async function deadPid(): Promise<number> {
  const child = Bun.spawn(
    [process.execPath, "-e", "console.log(process.pid)"],
    {
      stdout: "pipe",
    },
  );
  const pid = Number(await new Response(child.stdout).text());
  await child.exited;
  return pid;
}

describe("memory recovery on a healthy checkout", () => {
  test("a clean repository produces an empty report", async () => {
    const repo = checkout();
    const report = await recoverMemoryState({
      agentId: "agent-recovery-clean",
      memoryDir: repo.dir,
    });
    expect(report.actions).toEqual([]);
    expect(report.warnings).toEqual([]);
  }, 30_000);

  test("a missing checkout is not an error", async () => {
    const report = await recoverMemoryState({
      agentId: "agent-recovery-missing",
      memoryDir: join(home, "agents", "nobody", "memory"),
    });
    expect(report.actions).toEqual([]);
    expect(report.warnings).toEqual([]);
  }, 30_000);
});

describe("stale lock reaping", () => {
  test("reaps an operation lock whose holder exited", async () => {
    const repo = checkout();
    const pid = await deadPid();
    writeFileSync(
      join(gitDirOf(repo), "letta-memory-operation.lock"),
      JSON.stringify({ pid, started: "1970-01-01", acquiredAt: Date.now() }),
    );
    const report = await recoverMemoryState({
      agentId: "agent-recovery-lock",
      memoryDir: repo.dir,
    });
    expect(report.actions.map((action) => action.kind)).toContain(
      "reaped_operation_lock",
    );
    expect(
      existsSync(join(gitDirOf(repo), "letta-memory-operation.lock")),
    ).toBe(false);
  }, 30_000);

  test("leaves a checkout held by a live process untouched", async () => {
    const repo = checkout();
    writeFileSync(join(repo.dir, "persona.md"), "live edits\n", "utf-8");
    const release = await claimMemoryOperation(repo.dir);
    expect(release).not.toBeNull();
    try {
      const report = await recoverMemoryState({
        agentId: "agent-recovery-live",
        memoryDir: repo.dir,
        discardDirtyWorkTree: true,
      });
      expect(report.actions).toEqual([]);
      expect(report.warnings.join("\n")).toContain(
        "owned by another live process",
      );
      // The dirty work tree is still there: a live owner's work is not ours to drop.
      expect(repo.git("status", "--porcelain")).not.toBe("");
    } finally {
      await release?.();
    }
  }, 30_000);

  test("clears an old index.lock and keeps a fresh one", async () => {
    const repo = checkout();
    const oldLock = join(gitDirOf(repo), "index.lock");
    writeFileSync(oldLock, "", "utf-8");
    ageFile(oldLock, 120_000);
    const report = await recoverMemoryState({
      agentId: "agent-recovery-old-lock",
      memoryDir: repo.dir,
    });
    expect(report.actions.map((action) => action.kind)).toContain(
      "cleared_stale_git_lock",
    );
    expect(existsSync(oldLock)).toBe(false);

    const freshLock = join(gitDirOf(repo), "index.lock");
    writeFileSync(freshLock, "", "utf-8");
    const second = await recoverMemoryState({
      agentId: "agent-recovery-old-lock",
      memoryDir: repo.dir,
    });
    expect(second.actions).toEqual([]);
    expect(second.warnings.join("\n")).toContain("may still hold it");
    expect(existsSync(freshLock)).toBe(true);
  }, 30_000);

  test("reaps a repair attempt left launching by a dead process", async () => {
    const repo = checkout();
    const pid = await deadPid();
    const attemptPath = join(gitDirOf(repo), "letta-memory-repair.json");
    writeFileSync(
      attemptPath,
      JSON.stringify({
        signature: "conflict",
        token: "token-1",
        state: "launching",
        pid,
        started: "1970-01-01",
        attemptedAt: new Date().toISOString(),
      }),
    );
    const report = await recoverMemoryState({
      agentId: "agent-recovery-repair",
      memoryDir: repo.dir,
    });
    expect(report.actions.map((action) => action.detail).join("\n")).toContain(
      "repair attempt",
    );
    expect(existsSync(attemptPath)).toBe(false);
  }, 30_000);
});

describe("interrupted git operations", () => {
  test("backs up and aborts a paused rebase", async () => {
    const repo = checkout();
    writeFileSync(join(repo.dir, "persona.md"), "fork side\n", "utf-8");
    repo.git("checkout", "-q", "-b", "feature");
    writeFileSync(join(repo.dir, "persona.md"), "feature side\n", "utf-8");
    repo.git("commit", "-qam", "feature change");
    repo.git("checkout", "-q", "main");
    writeFileSync(join(repo.dir, "persona.md"), "main side\n", "utf-8");
    repo.git("commit", "-qam", "main change");
    expect(() => repo.git("rebase", "feature")).toThrow();
    expect(existsSync(join(gitDirOf(repo), "rebase-merge"))).toBe(true);

    const report = await recoverMemoryState({
      agentId: "agent-recovery-rebase",
      memoryDir: repo.dir,
    });
    const aborted = report.actions.find(
      (action) => action.kind === "aborted_interrupted_git_operation",
    );
    expect(aborted).toBeDefined();
    expect(aborted?.backupPath).toBeDefined();
    expect(existsSync(aborted?.backupPath as string)).toBe(true);
    expect(existsSync(join(gitDirOf(repo), "rebase-merge"))).toBe(false);
    expect(existsSync(join(gitDirOf(repo), "REBASE_HEAD"))).toBe(false);
  }, 30_000);

  test("reports a detached HEAD instead of guessing a branch", async () => {
    const repo = checkout();
    const head = repo.git("rev-parse", "HEAD");
    repo.git("checkout", "-q", "--detach", head);
    const report = await recoverMemoryState({
      agentId: "agent-recovery-detached",
      memoryDir: repo.dir,
    });
    expect(report.warnings.join("\n")).toContain("detached HEAD");
  }, 30_000);
});

describe("dirty work tree", () => {
  test("startup mode backs up and discards uncommitted work", async () => {
    const repo = checkout();
    const head = repo.git("rev-parse", "HEAD");
    writeFileSync(join(repo.dir, "persona.md"), "crash debris\n", "utf-8");
    writeFileSync(join(repo.dir, "draft.md"), "half written\n", "utf-8");
    const report = await recoverMemoryState({
      agentId: "agent-recovery-dirty",
      memoryDir: repo.dir,
      discardDirtyWorkTree: true,
    });
    expect(report.actions.map((action) => action.kind)).toEqual([
      "backed_up_dirty_work_tree",
      "restored_dirty_work_tree",
    ]);
    const backupDir = report.actions[0]?.backupPath as string;
    expect(existsSync(join(backupDir, "changes.patch"))).toBe(true);
    expect(existsSync(join(backupDir, "state.txt"))).toBe(true);
    expect(repo.git("status", "--porcelain")).toBe("");
    expect(repo.git("rev-parse", "HEAD")).toBe(head);
  }, 30_000);

  test("pre-trigger mode reports the dirty tree and keeps the work", async () => {
    const repo = checkout();
    writeFileSync(join(repo.dir, "persona.md"), "live edit\n", "utf-8");
    const report = await recoverMemoryState({
      agentId: "agent-recovery-pretrigger",
      memoryDir: repo.dir,
    });
    expect(report.actions).toEqual([]);
    expect(report.warnings.join("\n")).toContain("pre-trigger pass");
    expect(repo.git("status", "--porcelain")).not.toBe("");
  }, 30_000);
});

describe("memory repository discovery", () => {
  test("finds agent checkouts under the API-shaped root", () => {
    const agentsRoot = join(home, "agents");
    mkdirSync(join(agentsRoot, "agent-found", "memory", ".git"), {
      recursive: true,
    });
    mkdirSync(join(agentsRoot, "agent-without-memory"), { recursive: true });
    const found = listMemoryRepositoryDirs();
    expect(found).toEqual([
      {
        agentId: "agent-found",
        memoryDir: join(agentsRoot, "agent-found", "memory"),
      },
    ]);
  }, 30_000);

  test("finds agent checkouts under the local-backend root", () => {
    const storage = join(home, "local-backend");
    process.env.HARUYUKI_LOCAL_BACKEND_EXPERIMENTAL = "1";
    process.env.LETTA_LOCAL_BACKEND_DIR = storage;
    mkdirSync(join(storage, "memfs", "agent-local", "memory", ".git"), {
      recursive: true,
    });
    const found = listMemoryRepositoryDirs();
    expect(found).toEqual([
      {
        agentId: "agent-local",
        memoryDir: join(storage, "memfs", "agent-local", "memory"),
      },
    ]);
  }, 30_000);
});

test("the process start time helper is usable in this environment", async () => {
  // Recovery compares pid + start time; a null here would silently weaken every
  // liveness check, so pin that the platform reports one.
  expect(await getProcessStartTime(process.pid)).not.toBeNull();
}, 30_000);
