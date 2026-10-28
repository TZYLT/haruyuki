/**
 * TUI host runner tests (M2): the prompt is enqueued through the TUI queue, the
 * run's outcome is the turn's real ending (R-5.9), the wait/timeout envelope
 * applies, and cancellation works.
 *
 * No TUI process: `enqueuePrompt` is the seam T3 wires to `addToMessageQueue`,
 * and the turn writer's `consumeScheduledRunContext({ outcome })` is simulated
 * here exactly the way `usage-record.ts` calls it.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import {
  createTuiCronRunner,
  type TuiCronPromptQueueInput,
} from "@/cli/helpers/schedule-prompt";
import type { ScheduleTaskV2 } from "@/cron/cron-types";
import { getCronRunLogPath, readCronRunLogEntries } from "@/cron/run-log";
import {
  __testResetScheduledRunContext,
  __testScheduledRunWaiterCount,
  clearScheduledRunContext,
  consumeScheduledRunContext,
  peekScheduledRunContext,
} from "@/usage/scheduled-run-context";

const TEST_DIR = path.join(import.meta.dir, "__tui_schedule_prompt_tmp__");
const originalHome = process.env.HARUYUKI_HOME;

function task(overrides: Partial<ScheduleTaskV2> = {}): ScheduleTaskV2 {
  return {
    id: "bbbb2222",
    agentId: "agent-1",
    name: "TUI task",
    description: "desc",
    type: "prompt",
    target: { kind: "existing", conversation_id: "conv-1" },
    payload: "say hello",
    cron: "0 3 * * *",
    timezone: "UTC",
    recurring: true,
    scheduledFor: null,
    catchUp: false,
    permission: "standard",
    timeoutMinutes: 30,
    waitMinutes: 10,
    status: "active",
    pausedReason: null,
    createdAt: "2026-10-28T00:00:00.000Z",
    lastFiredAt: null,
    fireCount: 0,
    lastRunAt: null,
    lastOutcome: null,
    lastReason: null,
    lastError: null,
    consecutiveFailures: 0,
    missedCount: 0,
    failedCount: 0,
    lastConsumedOccurrence: null,
    lease: null,
    jitterOffsetMs: 0,
    firedAt: null,
    missedAt: null,
    ...overrides,
  };
}

beforeAll(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.HARUYUKI_HOME = TEST_DIR;
});

afterEach(() => {
  __testResetScheduledRunContext();
});

afterAll(() => {
  if (originalHome) process.env.HARUYUKI_HOME = originalHome;
  else delete process.env.HARUYUKI_HOME;
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

const signal = () => new AbortController().signal;

/** The runner enqueues on a microtask; wait for the context it leaves behind. */
async function waitForContext(runId: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (peekScheduledRunContext()?.runId === runId) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`scheduled run context for ${runId} never appeared`);
}

describe("createTuiCronRunner", () => {
  test("it is a long-lived host port", () => {
    expect(createTuiCronRunner().host).toBe("long-lived");
  });

  test("a prompt run enqueues, then reports the turn's completed ending", async () => {
    const queued: TuiCronPromptQueueInput[] = [];
    const runner = createTuiCronRunner({
      enqueuePrompt: (input) => {
        queued.push(input);
      },
      now: () => Date.parse("2026-10-28T03:00:00.000Z"),
    });

    const pending = runner.run({
      task: task(),
      runId: "run-tui-1",
      occurrence: "2026-10-28T03:00:00.000Z",
      signal: signal(),
    });

    await waitForContext("run-tui-1");
    // Only now is there a turn to end; the writer consumes and reports it.
    expect(peekScheduledRunContext()).toMatchObject({
      runId: "run-tui-1",
      taskId: "bbbb2222",
      source: "cron",
    });
    consumeScheduledRunContext({ outcome: "completed" });

    const result = await pending;
    expect(result.outcome).toBe("success");
    expect(result.conversationId).toBe("conv-1");
    expect(queued).toHaveLength(1);
    expect(queued[0]?.runId).toBe("run-tui-1");
    // The prompt is the shared scheduled-task wrapper, not the raw payload.
    expect(queued[0]?.text).toContain('Scheduled task "TUI task" is firing.');
    expect(queued[0]?.text).toContain("say hello");

    const entries = readCronRunLogEntries(getCronRunLogPath("bbbb2222"), {
      jobId: "bbbb2222",
    });
    expect(entries.at(-1)?.runId).toBe("run-tui-1");
    expect(entries.at(-1)?.runOutcome).toBe("success");
    expect(entries.at(-1)?.status).toBe("ok");
  });

  test("a prompt run whose turn fails is a failed run (not success on enqueue)", async () => {
    const runner = createTuiCronRunner({
      enqueuePrompt: () => {},
      now: () => 0,
    });
    const pending = runner.run({
      task: task(),
      runId: "run-tui-failed",
      occurrence: "2026-10-28T03:00:00.000Z",
      signal: signal(),
    });
    await waitForContext("run-tui-failed");
    consumeScheduledRunContext({ outcome: "failed" });

    const result = await pending;
    expect(result.outcome).toBe("failed");
    expect(result.error).toContain("failed");
    const entries = readCronRunLogEntries(getCronRunLogPath("bbbb2222"), {
      jobId: "bbbb2222",
    });
    expect(entries.at(-1)?.runOutcome).toBe("failed");
    expect(entries.at(-1)?.status).toBe("error");
  });

  test("clearing the context settles the run as cancelled", async () => {
    const runner = createTuiCronRunner({
      enqueuePrompt: () => {},
      now: () => 0,
    });
    const pending = runner.run({
      task: task(),
      runId: "run-tui-cleared",
      occurrence: "2026-10-28T03:00:00.000Z",
      signal: signal(),
    });
    await waitForContext("run-tui-cleared");
    clearScheduledRunContext();

    expect((await pending).outcome).toBe("cancelled");
  });

  test("aborting while the turn is pending settles the run as cancelled", async () => {
    const controller = new AbortController();
    const runner = createTuiCronRunner({
      enqueuePrompt: () => {},
      now: () => 0,
    });
    const pending = runner.run({
      task: task(),
      runId: "run-tui-abort-while-waiting",
      occurrence: "2026-10-28T03:00:00.000Z",
      signal: controller.signal,
    });
    await waitForContext("run-tui-abort-while-waiting");
    controller.abort();

    expect((await pending).outcome).toBe("cancelled");
    // The wait is over and nothing is left registered.
    expect(__testScheduledRunWaiterCount()).toBe(0);
  });

  test("the run's own timeout ends a turn that never settles", async () => {
    const runner = createTuiCronRunner({
      enqueuePrompt: () => {},
      now: () => 0,
    });
    // 0.001 min ≈ 60ms: the policy aborts the wait, which is the only timer.
    const result = await runner.run({
      task: task({ timeoutMinutes: 0.001 }),
      runId: "run-tui-timeout",
      occurrence: "2026-10-28T03:00:00.000Z",
      signal: signal(),
    });

    expect(result.outcome).toBe("timeout");
    expect(__testScheduledRunWaiterCount()).toBe(0);
    // A stale context would tag the next, unrelated turn as scheduler-triggered.
    expect(peekScheduledRunContext()).toBeNull();
  });

  test("a busy TUI past wait_minutes is skipped without enqueueing", async () => {
    const queued: TuiCronPromptQueueInput[] = [];
    const runner = createTuiCronRunner({
      enqueuePrompt: (input) => {
        queued.push(input);
      },
      isConversationBusy: () => true,
      pollIntervalMs: 10,
      // 0.001 min ≈ 60ms, so the policy reaches its deadline with the real clock.
    });

    const result = await runner.run({
      task: task({ waitMinutes: 0.001 }),
      runId: "run-tui-busy",
      occurrence: "2026-10-28T03:00:00.000Z",
      signal: signal(),
    });

    expect(result.outcome).toBe("skipped");
    expect(queued).toHaveLength(0);
  });

  test("an already-aborted run never records a scheduled context", async () => {
    const controller = new AbortController();
    controller.abort();
    const runner = createTuiCronRunner({
      enqueuePrompt: () => {},
      now: () => 0,
    });

    const result = await runner.run({
      task: task(),
      runId: "run-tui-abort",
      occurrence: "2026-10-28T03:00:00.000Z",
      signal: controller.signal,
    });

    expect(result.outcome).toBe("cancelled");
    expect(peekScheduledRunContext()).toBeNull();
    expect(__testScheduledRunWaiterCount()).toBe(0);
  });

  test("a command task runs the shared body and writes the run log", async () => {
    const runner = createTuiCronRunner({ now: () => 0 });
    const result = await runner.run({
      task: task({ type: "command", payload: "/reflect" }),
      runId: "run-tui-command",
      occurrence: "2026-10-28T03:00:00.000Z",
      signal: signal(),
    });

    // No reflection launcher is wired here, so the body reports the skip; the
    // point under test is that command tasks never touch the TUI queue.
    expect(result.outcome).toBe("failed");
    const entries = readCronRunLogEntries(getCronRunLogPath("bbbb2222"), {
      jobId: "bbbb2222",
    });
    expect(entries.at(-1)?.runId).toBe("run-tui-command");
    expect(entries.at(-1)?.host).toBe("long-lived");
  });

  test("the run log records the deps host (short-lived tick)", async () => {
    const runner = createTuiCronRunner({
      enqueuePrompt: () => {},
      now: () => 0,
      host: "short-lived",
    });
    const pending = runner.run({
      task: task(),
      runId: "run-tui-short",
      occurrence: "2026-10-28T03:00:00.000Z",
      signal: signal(),
    });
    await waitForContext("run-tui-short");
    consumeScheduledRunContext({ outcome: "completed" });
    expect((await pending).outcome).toBe("success");

    const entries = readCronRunLogEntries(getCronRunLogPath("bbbb2222"), {
      jobId: "bbbb2222",
    });
    expect(entries.at(-1)?.host).toBe("short-lived");
  });

  test("an enqueue that throws is a thrown F1 preflight failure", async () => {
    const runner = createTuiCronRunner({
      enqueuePrompt: () => {
        throw new Error("message queue bridge is not mounted");
      },
      now: () => 0,
    });
    const attempt = runner.run({
      task: task(),
      runId: "run-tui-enqueue-fail",
      occurrence: "2026-10-28T03:00:00.000Z",
      signal: signal(),
    });
    await expect(attempt).rejects.toMatchObject({
      name: "ScheduledTaskPreflightError",
    });
    await expect(attempt).rejects.toThrow("not mounted");
    expect(__testScheduledRunWaiterCount()).toBe(0);
  });
});
