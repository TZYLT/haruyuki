import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { createDreamLease, deleteDreamLease } from "@/agent/dream/dream-lease";
import {
  type DreamRunCommandOptions,
  dreamRunCommand,
  ensureDreamTask,
  findDreamTask,
  startDreamRun,
} from "@/cli/helpers/dream-launcher";
import {
  DREAM_PLACEHOLDER_CRON,
  listTasks,
  markDreamRunActive,
  parseDreamTaskPayload,
  readDreamSignalState,
  updateTask,
} from "@/cron";
import { settingsManager } from "@/settings-manager";

const TEST_DIR = path.join(import.meta.dir, "__dream_launcher_test_tmp__");
const origHome = process.env.HARUYUKI_HOME;

interface SpawnCall {
  taskId: string;
  options: DreamRunCommandOptions;
}

function spawnRecorder(calls: SpawnCall[], fail = false) {
  return (
    taskId: string,
    options: DreamRunCommandOptions = {},
  ): { pid?: number } | null => {
    calls.push({ taskId, options });
    return fail ? null : { pid: 1234 };
  };
}

beforeEach(async () => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.HARUYUKI_HOME = TEST_DIR;
  await settingsManager.reset();
  await settingsManager.initialize();
});

afterEach(async () => {
  await settingsManager.reset();
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  if (origHome) process.env.HARUYUKI_HOME = origHome;
  else delete process.env.HARUYUKI_HOME;
});

describe("S5 startDreamRun (route §2.3.5)", () => {
  test("refuses to start before explicit configuration (R-5.9.4)", async () => {
    const calls: SpawnCall[] = [];
    const result = await startDreamRun(
      { agentId: "agent-1" },
      spawnRecorder(calls),
    );
    expect(result.started).toBe(false);
    expect(result.runId).toBeNull();
    expect(result.reason).toContain("not enabled");
    expect(calls).toEqual([]);
    expect(listTasks()).toEqual([]);
  });

  test("refuses while a run is already active", async () => {
    settingsManager.updateSettings({ dreamEnabled: true });
    // A live run = fresh marker AND a lease whose owner process is alive
    // (Lead fix: the marker alone is not proof of liveness).
    markDreamRunActive("agent-1", "run-live", new Date());
    createDreamLease({ agentId: "agent-1", runId: "run-live", taskId: null });
    const calls: SpawnCall[] = [];
    const result = await startDreamRun(
      { agentId: "agent-1" },
      spawnRecorder(calls),
    );
    expect(result.started).toBe(false);
    expect(result.reason).toContain("already in progress");
    expect(calls).toEqual([]);
    expect(readDreamSignalState("agent-1").running?.runId).toBe("run-live");
    deleteDreamLease("agent-1");
  });

  test("prepares the dream task and spawns a detached manual child", async () => {
    settingsManager.updateSettings({ dreamEnabled: true });
    const calls: SpawnCall[] = [];
    const result = await startDreamRun(
      { agentId: "agent-1", budgetOverrideTokens: 5_000 },
      spawnRecorder(calls),
    );
    expect(result.started).toBe(true);
    expect(result.runId).toBeTruthy();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.options).toMatchObject({
      manual: true,
      budgetOverrideTokens: 5_000,
      runId: result.runId,
    });

    const task = findDreamTask("agent-1");
    expect(task?.type).toBe("dream");
    expect(task?.timeout_minutes).toBe(0);
    expect(task?.recurring).toBe(true);
    expect(task?.cron).toBe(DREAM_PLACEHOLDER_CRON);
    expect(task?.target).toEqual({ kind: "new", hidden: true });
    expect(parseDreamTaskPayload(task?.payload)?.version).toBe(1);
    expect(calls[0]?.taskId).toBe(task?.id);
  });

  test("a second manual run reuses the same dream task", async () => {
    settingsManager.updateSettings({ dreamEnabled: true });
    const calls: SpawnCall[] = [];
    await startDreamRun({ agentId: "agent-1" }, spawnRecorder(calls));
    await startDreamRun({ agentId: "agent-1" }, spawnRecorder(calls));
    expect(listTasks().filter((task) => task.type === "dream")).toHaveLength(1);
    expect(calls[0]?.taskId).toBe(calls[1]?.taskId);
  });

  test("a spawn failure is reported instead of a fake start", async () => {
    settingsManager.updateSettings({ dreamEnabled: true });
    const result = await startDreamRun(
      { agentId: "agent-1" },
      spawnRecorder([], true),
    );
    expect(result.started).toBe(false);
    expect(result.reason).toContain("spawn");
  });
});

describe("dream task provisioning", () => {
  test("findDreamTask also accepts a paused task instead of creating a second", () => {
    const task = ensureDreamTask("agent-1");
    updateTask(task.id, (record) => {
      record.status = "paused";
      record.paused_reason = "auto_failures";
    });
    expect(findDreamTask("agent-1")?.id).toBe(task.id);
    expect(ensureDreamTask("agent-1").id).toBe(task.id);
  });
});

describe("dreamRunCommand", () => {
  test("builds the short-lived host command line", () => {
    const plain = dreamRunCommand("abc123");
    expect(plain.args).toContain("dream");
    expect(plain.args).toContain("run");
    expect(plain.args).toContain("--task");
    expect(plain.args).toContain("abc123");
    expect(plain.args).not.toContain("--manual");

    const manual = dreamRunCommand("abc123", {
      manual: true,
      budgetOverrideTokens: 4_200,
      runId: "launch-1",
    });
    expect(manual.args).toContain("--manual");
    expect(manual.args).toContain("--budget");
    expect(manual.args).toContain("4200");
    expect(manual.args).toContain("--run-id");
    expect(manual.args).toContain("launch-1");
    // The budget is only passed when it is a positive integer.
    const zero = dreamRunCommand("abc123", { budgetOverrideTokens: 0 });
    expect(zero.args).not.toContain("--budget");
  });
});

// ── Lead fix: S5 uses real run liveness, not the bare marker ────────

describe("S5 liveness (crash remnant must not block /dream run)", () => {
  test("a marker without a live lease no longer refuses the launch", async () => {
    settingsManager.updateSettings({ dreamEnabled: true });
    // A killed run's remnant: the signal marker stayed, no lease file exists.
    markDreamRunActive("agent-1", "dead-run", new Date());
    expect(readDreamSignalState("agent-1").running?.runId).toBe("dead-run");

    const calls: SpawnCall[] = [];
    const result = await startDreamRun(
      { agentId: "agent-1" },
      spawnRecorder(calls),
    );
    expect(result.started).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test("a live lease with a fresh marker still refuses (single run)", async () => {
    settingsManager.updateSettings({ dreamEnabled: true });
    markDreamRunActive("agent-1", "live-run", new Date());
    createDreamLease({ agentId: "agent-1", runId: "live-run", taskId: null });

    const calls: SpawnCall[] = [];
    const result = await startDreamRun(
      { agentId: "agent-1" },
      spawnRecorder(calls),
    );
    expect(result.started).toBe(false);
    expect(result.reason).toContain("already in progress");
    expect(calls).toEqual([]);
    deleteDreamLease("agent-1");
  });
});
