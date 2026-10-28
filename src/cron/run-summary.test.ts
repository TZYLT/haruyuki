import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { addTask } from "@/cron/cron-file";
import { appendCronRunLog, getCronRunLogPath } from "@/cron/run-log";
import {
  appendRunSummaryEntry,
  getRunSummarySeenPath,
  markRunSummarySeen,
  readPendingRunSummary,
} from "@/cron/run-summary";

const TEST_DIR = path.join(import.meta.dir, "__run_summary_test_tmp__");
const origHome = process.env.HARUYUKI_HOME;

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.HARUYUKI_HOME = TEST_DIR;
});

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  if (origHome) process.env.HARUYUKI_HOME = origHome;
  else delete process.env.HARUYUKI_HOME;
});

function addRecord(taskId: string, name: string) {
  addTask({
    agent_id: "agent-local-summary",
    name,
    description: "",
    cron: "* * * * *",
    timezone: "UTC",
    recurring: true,
    prompt: "hello",
  });
  // addTask generates its own id; the summary reader only needs the name map,
  // so rewrite the store with the id the log lines use.
  const store = path.join(TEST_DIR, "schedules.json");
  const raw = JSON.parse(require("node:fs").readFileSync(store, "utf-8")) as {
    tasks: Array<{ id: string }>;
  };
  const lastTask = raw.tasks[raw.tasks.length - 1];
  if (lastTask) lastTask.id = taskId;
  require("node:fs").writeFileSync(store, JSON.stringify(raw));
}

function writeRun(
  taskId: string,
  entry: Partial<Parameters<typeof appendCronRunLog>[1]> & { ts: number },
) {
  appendCronRunLog(getCronRunLogPath(taskId), {
    jobId: taskId,
    action: "finished",
    ...entry,
  });
}

describe("run summary", () => {
  test("derives the summary from the run log, oldest first", () => {
    addRecord("task-aaaa", "Morning report");
    writeRun("task-aaaa", {
      ts: 1_000,
      status: "ok",
      runOutcome: "success",
      runId: "run-1",
      runAtMs: 900,
      conversationId: "conv-1",
    });
    writeRun("task-aaaa", {
      ts: 2_000,
      status: "error",
      runOutcome: "failed",
      runId: "run-2",
      runAtMs: 1_900,
      error: "boom",
    });

    const pending = readPendingRunSummary();
    expect(pending).toHaveLength(2);
    expect(pending.map((entry) => entry.runId)).toEqual(["run-1", "run-2"]);
    expect(pending[0]).toMatchObject({
      taskId: "task-aaaa",
      taskName: "Morning report",
      outcome: "success",
      conversationId: "conv-1",
    });
    expect(pending[1]?.outcome).toBe("failed");
  });

  test("queue-time and legacy entries are not runs", () => {
    writeRun("task-bbbb", { ts: 1_000, status: "ok", outcome: "queued" });
    writeRun("task-bbbb", {
      ts: 2_000,
      status: "skipped",
      outcome: "missed",
      summary: "missed",
      missedCount: 2,
    });

    const pending = readPendingRunSummary();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      outcome: "skipped",
      taskId: "task-bbbb",
    });
  });

  test("a deleted task falls back to its id", () => {
    writeRun("task-gone", { ts: 5_000, status: "ok", runOutcome: "success" });
    expect(readPendingRunSummary()[0]).toMatchObject({
      taskId: "task-gone",
      taskName: "task-gone",
    });
  });

  test("marking it seen clears it, and later runs show up once", () => {
    writeRun("task-cccc", {
      ts: Date.now(),
      status: "ok",
      runOutcome: "success",
    });
    expect(readPendingRunSummary()).toHaveLength(1);

    markRunSummarySeen();
    expect(readPendingRunSummary()).toEqual([]);
    expect(existsSync(getRunSummarySeenPath())).toBe(true);

    writeRun("task-cccc", {
      ts: Date.now() + 1_000,
      status: "ok",
      runOutcome: "success",
      runId: "run-later",
    });
    const pending = readPendingRunSummary();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.runId).toBe("run-later");
  });

  test("show-once survives repeated reads", () => {
    writeRun("task-dddd", {
      ts: Date.now(),
      status: "ok",
      runOutcome: "success",
    });
    const first = readPendingRunSummary();
    markRunSummarySeen();
    expect(first).toHaveLength(1);
    expect(readPendingRunSummary()).toEqual([]);
    expect(readPendingRunSummary()).toEqual([]);
  });

  test("appendRunSummaryEntry does not create a second ledger", () => {
    addRecord("task-eeee", "Ledger check");
    const runsDir = path.join(TEST_DIR, "runs");
    appendRunSummaryEntry({
      runId: "run-1",
      taskId: "task-eeee",
      taskName: "Ledger check",
      outcome: "success",
      startedAt: new Date(1_000).toISOString(),
      finishedAt: new Date(2_000).toISOString(),
    });

    // No file of its own: the summary is derived from `runs/*.jsonl` alone.
    expect(existsSync(runsDir)).toBe(false);
    expect(readdirSync(TEST_DIR).sort()).toEqual(["schedules.json"]);
    expect(readPendingRunSummary()).toEqual([]);
  });
});
