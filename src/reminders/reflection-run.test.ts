import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attachReflectionTask,
  finishReflectionRun,
  resetReflectionRuns,
  startReflectionRun,
} from "@/agent/reflection-run";
import {
  SHARED_REMINDER_CATALOG,
  SHARED_REMINDER_IDS,
} from "@/reminders/catalog";
import { buildSharedReminderParts } from "@/reminders/engine";
import { formatReflectionRunNotice } from "@/reminders/reflection-run";
import {
  createSharedReminderState,
  type SharedReminderState,
  setPendingReflectionRunNotice,
} from "@/reminders/state";

const AGENT_ID = "agent-reflection-reminder-test";
const ENV_KEYS = [
  "HARUYUKI_HOME",
  "HARUYUKI_LOCAL_BACKEND_EXPERIMENTAL",
] as const;

let home: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  home = mkdtempSync(join(tmpdir(), "reflection-reminder-"));
  process.env.HARUYUKI_HOME = home;
  delete process.env.HARUYUKI_LOCAL_BACKEND_EXPERIMENTAL;
});

afterEach(() => {
  resetReflectionRuns();
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

async function buildReminderParts(state: SharedReminderState) {
  return await buildSharedReminderParts({
    mode: "listen",
    agent: { id: AGENT_ID, name: null },
    state,
    systemInfoReminderEnabled: false,
    skillSources: [],
  });
}

function startRun(): string {
  const run = startReflectionRun({
    agentId: AGENT_ID,
    parentConversationId: "conv-parent",
    triggerSource: "user-messages",
    timeoutMinutes: 3,
  });
  attachReflectionTask(run.runId, {
    taskId: `task-${run.runId}`,
    abort: () => {},
  });
  return run.runId;
}

describe("reflection-run reminder catalog entry", () => {
  test("sits between memory-git-sync and recall and is not a subagent reminder", () => {
    const ids = SHARED_REMINDER_IDS;
    const index = ids.indexOf("reflection-run");
    expect(index).toBeGreaterThan(ids.indexOf("memory-git-sync"));
    expect(index).toBeLessThan(ids.indexOf("recall"));
    const entry = SHARED_REMINDER_CATALOG.find(
      (candidate) => candidate.id === "reflection-run",
    );
    expect(entry?.modes).not.toContain("subagent");
    expect(entry?.modes).toContain("interactive");
    expect(entry?.modes).toContain("headless-bidirectional");
    expect(entry?.modes).toContain("listen");
  });
});

describe("formatReflectionRunNotice", () => {
  test("start notice names the run, the memory dir and the remaining time", () => {
    const runId = startRun();
    const text = formatReflectionRunNotice({
      notice: { phase: "start" },
      run: {
        ...startReflectionRun({
          agentId: "agent-format-only",
          parentConversationId: "c",
          triggerSource: "manual",
          timeoutMinutes: 3,
        }),
        runId,
      },
      memoryDir: "/tmp/memory",
    });
    expect(text).toContain("REFLECTION RUNNING");
    expect(text).toContain(runId);
    expect(text).toContain("/tmp/memory");
    expect(text).toContain("file-tool writes are rejected");
    expect(text).toContain("Reading memory files");
  });

  test("end notice reports success without backup coordinates", () => {
    const text = formatReflectionRunNotice({
      notice: { phase: "end" },
      run: { status: "succeeded" } as never,
    });
    expect(text).toContain("REFLECTION FINISHED");
    expect(text).toContain("(completed)");
    expect(text).toContain("allowed again");
    expect(text).not.toContain("backed up");
  });

  test("end notice reports a timeout with its backup coordinates and the advice", () => {
    const text = formatReflectionRunNotice({
      notice: { phase: "end", timedOut: true },
      run: {
        status: "timeout",
        backupRef: "refs/letta-backup/reflection-timeout-x",
        backupPatch: "/tmp/backup.patch",
      } as never,
      memoryDir: "/tmp/memory",
    });
    expect(text).toContain("(timed out)");
    expect(text).toContain("refs/letta-backup/reflection-timeout-x");
    expect(text).toContain("/tmp/backup.patch");
    expect(text).toContain("reflectionTimeoutMinutes");
  });

  test("end notice reports a failure and warns about uncommitted work", () => {
    const text = formatReflectionRunNotice({
      notice: { phase: "end" },
      run: { status: "failed" } as never,
    });
    expect(text).toContain("(failed)");
    expect(text).toContain("Uncommitted work may still be");
  });
});

describe("reflection-run reminder provider", () => {
  test("consumes the notice exactly once and enriches it from the run", async () => {
    const state = createSharedReminderState();
    const runId = startRun();
    setPendingReflectionRunNotice(state, { phase: "start" });

    const first = await buildReminderParts(state);
    const firstText = first.parts.map((part) => part.text).join("\n");
    expect(first.appliedReminderIds).toContain("reflection-run");
    expect(firstText).toContain("REFLECTION RUNNING");
    expect(firstText).toContain(runId);
    expect(state.pendingReflectionRunNotice).toBeNull();

    const second = await buildReminderParts(state);
    expect(second.appliedReminderIds).not.toContain("reflection-run");
    expect(second.parts.map((part) => part.text).join("\n")).not.toContain(
      "REFLECTION RUNNING",
    );
  });

  test("announces an active run once even without an explicit start notice", async () => {
    const state = createSharedReminderState();
    const runId = startRun();

    const first = await buildReminderParts(state);
    const firstText = first.parts.map((part) => part.text).join("\n");
    expect(first.appliedReminderIds).toContain("reflection-run");
    expect(firstText).toContain("REFLECTION RUNNING");
    expect(firstText).toContain(runId);
    expect(state.lastReflectionRunStartNoticeRunId).toBe(runId);

    const second = await buildReminderParts(state);
    expect(second.appliedReminderIds).not.toContain("reflection-run");
  });

  test("renders the end notice with the timeout outcome of the finished run", async () => {
    const runId = startRun();
    await finishReflectionRun(runId, "timeout");
    const state = createSharedReminderState();
    setPendingReflectionRunNotice(state, { phase: "end" });

    const result = await buildReminderParts(state);
    const text = result.parts.map((part) => part.text).join("\n");
    expect(result.appliedReminderIds).toContain("reflection-run");
    expect(text).toContain("REFLECTION FINISHED");
    expect(text).toContain("(timed out)");
    expect(text).toContain(runId);
  });
});
