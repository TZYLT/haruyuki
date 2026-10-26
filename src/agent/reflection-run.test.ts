import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getScopedMemoryFilesystemRoot } from "@/agent/memory-filesystem";
import {
  attachReflectionFork,
  attachReflectionTask,
  finishReflectionRun,
  getReflectionRun,
  getReflectionRunTimerStateForTests,
  isReflectionRunActive,
  type ReflectionRunFinishedEvent,
  resetReflectionRuns,
  setReflectionRunTimingForTests,
  startReflectionRun,
  subscribeReflectionRunFinished,
} from "@/agent/reflection-run";
import { initGitRepo, type TempGitRepo } from "@/test-utils/temp-git-repo";

const AGENT_ID = "agent-reflection-run-test";
const ENV_KEYS = [
  "HARUYUKI_HOME",
  "HARUYUKI_LOCAL_BACKEND_EXPERIMENTAL",
  "LETTA_LOCAL_BACKEND_DIR",
] as const;

let home: string;
let savedEnv: Record<string, string | undefined>;
let repo: TempGitRepo | undefined;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  home = mkdtempSync(join(tmpdir(), "reflection-run-"));
  process.env.HARUYUKI_HOME = home;
  delete process.env.HARUYUKI_LOCAL_BACKEND_EXPERIMENTAL;
  delete process.env.LETTA_LOCAL_BACKEND_DIR;
});

afterEach(() => {
  resetReflectionRuns();
  repo?.cleanup();
  repo = undefined;
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

function memoryRepository(): { dir: string; repo: TempGitRepo } {
  const dir = getScopedMemoryFilesystemRoot(AGENT_ID);
  mkdirSync(dir, { recursive: true });
  const created = initGitRepo(dir);
  repo = created;
  writeFileSync(join(dir, "persona.md"), "# persona\nsteady\n", "utf-8");
  created.git("add", ".");
  created.git("commit", "-qm", "seed memory");
  return { dir, repo: created };
}

/** Leave one modified tracked file, one staged addition and one untracked file. */
function dirtyWorkTree(dir: string, repository: TempGitRepo): void {
  writeFileSync(
    join(dir, "persona.md"),
    "# persona\nrewritten by the child\n",
    "utf-8",
  );
  writeFileSync(join(dir, "new-note.md"), "staged note\n", "utf-8");
  repository.git("add", "new-note.md");
  writeFileSync(join(dir, "draft.md"), "half-written note\n", "utf-8");
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error("condition was not met before the deadline");
}

describe("reflection run deadline", () => {
  test("a timed-out run is marked, aborted, backed up and discarded", async () => {
    const { dir, repo: gitRepo } = memoryRepository();
    const headBefore = gitRepo.git("rev-parse", "HEAD");
    dirtyWorkTree(dir, gitRepo);
    setReflectionRunTimingForTests({ graceMs: 20, abortSettleMs: 200 });

    const run = startReflectionRun({
      agentId: AGENT_ID,
      parentConversationId: "conv-parent",
      triggerSource: "manual",
      timeoutMinutes: 0.002, // 120ms
    });
    attachReflectionFork(run.runId, "conv-fork");
    let aborted = false;
    attachReflectionTask(run.runId, {
      taskId: "task-1",
      abort: () => {
        aborted = true;
      },
    });

    await waitFor(() => getReflectionRun(run.runId)?.status === "timeout");
    await waitFor(() => aborted, 2_000);
    await waitFor(() => !isReflectionRunActive(AGENT_ID), 5_000);

    const finished = getReflectionRun(run.runId);
    expect(finished?.status).toBe("timeout");
    expect(finished?.timedOutAt).toBeNumber();

    // Backup coordinates are readable: the ref resolves to the stash commit and
    // the patch holds the same change.
    expect(finished?.backupRef).toStartWith(
      "refs/letta-backup/reflection-timeout-",
    );
    const stashCommit = gitRepo.git("rev-parse", finished?.backupRef as string);
    expect(stashCommit).toHaveLength(40);
    expect(finished?.backupPatch).toBeDefined();
    const patch = readFileSync(finished?.backupPatch as string, "utf-8");
    expect(patch).toContain("rewritten by the child");
    expect(patch).toContain("new-note.md");
    expect(patch).toContain("draft.md");

    // Uncommitted work is gone, the untracked file was copied first, and the
    // committed history was never touched.
    expect(gitRepo.git("status", "--porcelain")).toBe("");
    expect(gitRepo.git("rev-parse", "HEAD")).toBe(headBefore);
    expect(readFileSync(join(dir, "persona.md"), "utf-8")).toContain("steady");
    const untrackedCopy = join(
      finished?.backupPatch as string,
      "..",
      "untracked",
      "draft.md",
    );
    expect(readFileSync(untrackedCopy, "utf-8")).toBe("half-written note\n");
  }, 30_000);

  test("a child that finishes inside the grace period is not aborted", async () => {
    const { dir, repo: gitRepo } = memoryRepository();
    dirtyWorkTree(dir, gitRepo);
    setReflectionRunTimingForTests({ graceMs: 2_000, abortSettleMs: 1_000 });

    const run = startReflectionRun({
      agentId: AGENT_ID,
      parentConversationId: "conv-parent",
      triggerSource: "compaction",
      timeoutMinutes: 0.001, // 60ms
    });
    let aborted = false;
    attachReflectionTask(run.runId, {
      taskId: "task-2",
      abort: () => {
        aborted = true;
      },
    });

    await waitFor(() => getReflectionRun(run.runId)?.status === "timeout");
    // The launcher reports completion during the grace period.
    await finishReflectionRun(run.runId, "succeeded");

    const finished = getReflectionRun(run.runId);
    // The deadline was missed, so the outcome stays `timeout` (§5.8.8) and the
    // uncommitted work is still backed up and discarded.
    expect(finished?.status).toBe("timeout");
    expect(finished?.backupRef).toStartWith("refs/letta-backup/");
    expect(aborted).toBe(false);
    expect(isReflectionRunActive(AGENT_ID)).toBe(false);
    expect(getReflectionRunTimerStateForTests()).toEqual([]);
    expect(gitRepo.git("status", "--porcelain")).toBe("");
  }, 30_000);

  test("a run that finishes before its deadline writes no backup", async () => {
    const { dir, repo: gitRepo } = memoryRepository();
    writeFileSync(join(dir, "persona.md"), "clean success\n", "utf-8");
    gitRepo.git("commit", "-qam", "the child committed its work");

    const run = startReflectionRun({
      agentId: AGENT_ID,
      parentConversationId: "conv-parent",
      triggerSource: "user-messages",
      timeoutMinutes: 10,
    });
    attachReflectionTask(run.runId, { taskId: "task-3", abort: () => {} });
    await finishReflectionRun(run.runId, "succeeded");

    const finished = getReflectionRun(run.runId);
    expect(finished?.status).toBe("succeeded");
    expect(finished?.backupRef).toBeUndefined();
    expect(finished?.backupPatch).toBeUndefined();
    expect(getReflectionRunTimerStateForTests()).toEqual([]);
    expect(gitRepo.git("status", "--porcelain")).toBe("");
  }, 30_000);

  test("a cancelled run that never spawned leaves the work tree alone", async () => {
    const { dir, repo: gitRepo } = memoryRepository();
    dirtyWorkTree(dir, gitRepo);
    const run = startReflectionRun({
      agentId: AGENT_ID,
      parentConversationId: "conv-parent",
      triggerSource: "compaction",
      timeoutMinutes: 3,
    });
    // Lock-busy / reservation-lost paths finish a run before a child exists; the
    // uncommitted work may belong to another writer, so it must survive.
    await finishReflectionRun(run.runId, "cancelled");
    const finished = getReflectionRun(run.runId);
    expect(finished?.status).toBe("cancelled");
    expect(finished?.backupRef).toBeUndefined();
    expect(gitRepo.git("status", "--porcelain")).not.toBe("");
  }, 30_000);

  test("finishing twice is idempotent", async () => {
    memoryRepository();
    const run = startReflectionRun({
      agentId: AGENT_ID,
      parentConversationId: "conv-parent",
      triggerSource: "manual",
      timeoutMinutes: 10,
    });
    attachReflectionTask(run.runId, { taskId: "task-4", abort: () => {} });
    await Promise.all([
      finishReflectionRun(run.runId, "succeeded"),
      finishReflectionRun(run.runId, "failed"),
    ]);
    expect(isReflectionRunActive(AGENT_ID)).toBe(false);
    expect(getReflectionRun(run.runId)?.status).toBe("succeeded");
  }, 30_000);
});

describe("reflection run completion seam", () => {
  test("notifies subscribers once with the terminal state and backup", async () => {
    const { dir, repo: gitRepo } = memoryRepository();
    dirtyWorkTree(dir, gitRepo);
    const events: ReflectionRunFinishedEvent[] = [];
    const unsubscribe = subscribeReflectionRunFinished((event) => {
      events.push(event);
    });
    try {
      const run = startReflectionRun({
        agentId: AGENT_ID,
        parentConversationId: "conv-parent",
        triggerSource: "compaction",
        timeoutMinutes: 10,
      });
      attachReflectionFork(run.runId, "conv-fork");
      attachReflectionTask(run.runId, { taskId: "task-6", abort: () => {} });
      await finishReflectionRun(run.runId, "timeout");

      expect(events).toHaveLength(1);
      const event = events[0];
      expect(event?.runId).toBe(run.runId);
      expect(event?.status).toBe("timeout");
      expect(event?.timedOut).toBe(true);
      expect(event?.agentId).toBe(AGENT_ID);
      expect(event?.parentConversationId).toBe("conv-parent");
      expect(event?.forkConversationId).toBe("conv-fork");
      expect(event?.backupRef).toStartWith("refs/letta-backup/");
      expect(event?.backupPatch).toBeDefined();
      expect(event?.durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      unsubscribe();
    }
  }, 30_000);

  test("unsubscribing stops delivery", async () => {
    memoryRepository();
    let calls = 0;
    const unsubscribe = subscribeReflectionRunFinished(() => {
      calls += 1;
    });
    unsubscribe();
    const run = startReflectionRun({
      agentId: AGENT_ID,
      parentConversationId: "conv-parent",
      triggerSource: "manual",
      timeoutMinutes: 10,
    });
    attachReflectionTask(run.runId, { taskId: "task-7", abort: () => {} });
    await finishReflectionRun(run.runId, "succeeded");
    expect(calls).toBe(0);
  }, 30_000);
});

describe("reflection run timers", () => {
  test("armed timers do not keep the process alive", () => {
    setReflectionRunTimingForTests(null);
    const run = startReflectionRun({
      agentId: AGENT_ID,
      parentConversationId: "conv-parent",
      triggerSource: "manual",
      timeoutMinutes: 10,
    });
    attachReflectionTask(run.runId, { taskId: "task-5", abort: () => {} });
    const armed = getReflectionRunTimerStateForTests();
    expect(armed.length).toBeGreaterThan(0);
    expect(armed.every((entry) => entry.refed === false)).toBe(true);
  }, 30_000);

  test("a pending deadline lets the process exit", async () => {
    const script = `
      const { startReflectionRun, attachReflectionTask } = await import(${JSON.stringify(join(import.meta.dir, "reflection-run.ts"))});
      const run = startReflectionRun({ agentId: "agent-exit-test", parentConversationId: "c", triggerSource: "manual", timeoutMinutes: 10 });
      attachReflectionTask(run.runId, { taskId: "t", abort: () => {} });
      console.log("armed");
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HARUYUKI_HOME: home },
    });
    const guard = setTimeout(() => child.kill("SIGKILL"), 20_000);
    const exitCode = await child.exited;
    clearTimeout(guard);
    expect(await new Response(child.stdout).text()).toContain("armed");
    expect(exitCode).toBe(0);
  }, 30_000);
});
