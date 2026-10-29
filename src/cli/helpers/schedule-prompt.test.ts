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
  __testResetTuiTurnPermissions,
  assertScheduledTurnPermission,
  createTuiCronRunner,
  mergeTuiTurnPermissions,
  resolveTuiTaskTarget,
  scheduledTurnPermissionState,
  type TuiCronPromptQueueInput,
  type TuiCronRunnerDeps,
  takeTuiTurnPermission,
  turnPermissionForTask,
} from "@/cli/helpers/schedule-prompt";
import type { ScheduleTaskV2 } from "@/cron/cron-types";
import { getCronRunLogPath, readCronRunLogEntries } from "@/cron/run-log";
import { permissionModeForTier } from "@/cron/task-run";
import { checkPermission } from "@/permissions/checker";
import { permissionMode } from "@/permissions/mode";
import type { PermissionRules } from "@/permissions/types";
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
  __testResetTuiTurnPermissions();
  permissionMode.reset();
});

afterAll(() => {
  if (originalHome) process.env.HARUYUKI_HOME = originalHome;
  else delete process.env.HARUYUKI_HOME;
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

const signal = () => new AbortController().signal;

/** The one session this TUI process owns; `task()` targets it by default. */
const ACTIVE = { agentId: "agent-1", conversationId: "conv-1" };

function createRunner(deps: TuiCronRunnerDeps = {}) {
  return createTuiCronRunner({
    getActiveTarget: () => ACTIVE,
    ...deps,
  });
}

const NO_RULES: PermissionRules = { allow: [], deny: [], ask: [] };

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
    expect(createRunner().host).toBe("long-lived");
  });

  test("a prompt run enqueues, then reports the turn's completed ending", async () => {
    const queued: TuiCronPromptQueueInput[] = [];
    const runner = createRunner({
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
    const runner = createRunner({
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
    const runner = createRunner({
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
    const runner = createRunner({
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
    const runner = createRunner({
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
    const runner = createRunner({
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
    const runner = createRunner({
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
    const runner = createRunner({ now: () => 0 });
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
    const runner = createRunner({
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
    const runner = createRunner({
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

// ── P1-2: target routing and delegation ─────────────────────────────

describe("task target routing (P1-2/F2)", () => {
  test("a task targeting the live session's conversation runs in place", () => {
    expect(resolveTuiTaskTarget(task(), ACTIVE)).toEqual({
      kind: "run",
      target: ACTIVE,
    });
  });

  test("a task for another conversation is skipped with that reason", () => {
    const routing = resolveTuiTaskTarget(
      task({ target: { kind: "existing", conversation_id: "conv-2" } }),
      ACTIVE,
    );
    expect(routing.kind).toBe("skip");
    if (routing.kind !== "skip") return;
    expect(routing.conversationId).toBe("conv-2");
    expect(routing.reason).toContain("conv-2");
    expect(routing.reason).toContain("conv-1");
  });

  test("a task for another agent is skipped instead of running here", () => {
    const routing = resolveTuiTaskTarget(task({ agentId: "agent-2" }), ACTIVE);
    expect(routing.kind).toBe("skip");
    if (routing.kind !== "skip") return;
    expect(routing.reason).toContain("agent-2");
  });

  test("new and hidden targets are skipped (the TUI cannot create them)", () => {
    for (const target of [
      { kind: "new", hidden: false } as const,
      { kind: "new", hidden: true } as const,
    ]) {
      const routing = resolveTuiTaskTarget(task({ target }), ACTIVE);
      expect(routing.kind).toBe("skip");
      if (routing.kind !== "skip") continue;
      expect(routing.reason).toContain("新会话");
      expect(routing.conversationId).toBe(target.hidden ? "new-hidden" : "new");
    }
  });

  test("no mounted session is a skip, not a run in the default conversation", () => {
    const routing = resolveTuiTaskTarget(task(), null);
    expect(routing.kind).toBe("skip");
    if (routing.kind !== "skip") return;
    expect(routing.reason).toContain("目标未知");
  });

  test("canRun is exactly the live-session routing, and false without one", () => {
    const runner = createRunner();
    expect(runner.canRun?.(task())).toBe(true);
    expect(
      runner.canRun?.(
        task({ target: { kind: "existing", conversation_id: "x" } }),
      ),
    ).toBe(false);
    expect(runner.canRun?.(task({ agentId: "agent-2" }))).toBe(false);
    expect(
      runner.canRun?.(task({ target: { kind: "new", hidden: false } })),
    ).toBe(false);
    const headless = createRunner({ getActiveTarget: () => null });
    expect(headless.canRun?.(task())).toBe(false);
  });

  test("an unfulfillable due task becomes an F3 skipped run, never an enqueue", async () => {
    const queued: TuiCronPromptQueueInput[] = [];
    const runner = createRunner({
      enqueuePrompt: (input) => {
        queued.push(input);
      },
      now: () => 0,
    });
    const result = await runner.run({
      task: task({ target: { kind: "existing", conversation_id: "conv-2" } }),
      runId: "run-tui-skip",
      occurrence: "2026-10-28T03:00:00.000Z",
      signal: signal(),
    });

    expect(result.outcome).toBe("skipped");
    expect(result.error).toContain("conv-2");
    expect(queued).toHaveLength(0);
    // Nothing was queued, so nothing may wait for a turn either.
    expect(__testScheduledRunWaiterCount()).toBe(0);
    expect(peekScheduledRunContext()).toBeNull();

    const entries = readCronRunLogEntries(getCronRunLogPath("bbbb2222"), {
      jobId: "bbbb2222",
    });
    expect(entries.at(-1)?.runOutcome).toBe("skipped");
    expect(entries.at(-1)?.status).toBe("skipped");
    expect(entries.at(-1)?.error).toContain("conv-2");
  });
});

// ── P1-1: task tier reaches the approval classifier ─────────────────

describe("scheduled-turn permission (P1-1/F9)", () => {
  const TIERS = ["standard", "acceptEdits", "unrestricted"] as const;

  test("every task tier maps onto the classifier's mode", () => {
    for (const tier of TIERS) {
      const permission = turnPermissionForTask(
        task({ permission: tier }),
        `run-${tier}`,
      );
      expect(permission.mode).toBe(permissionModeForTier(tier));
      expect(permission.unattended).toBe(true);
      expect(permission.taskId).toBe("bbbb2222");
    }
  });

  test("the runner registers the tier before enqueueing, and the queue hand-off takes it", async () => {
    let taken: ReturnType<typeof takeTuiTurnPermission> = null;
    const runner = createRunner({
      enqueuePrompt: () => {
        // The AppCoordinator's queue adder does exactly this while enqueueing.
        const runId = peekScheduledRunContext()?.runId;
        taken = runId ? takeTuiTurnPermission(runId) : null;
      },
      now: () => 0,
    });
    const pending = runner.run({
      task: task({ permission: "acceptEdits" }),
      runId: "run-tui-perm",
      occurrence: "2026-10-28T03:00:00.000Z",
      signal: signal(),
    });
    await waitForContext("run-tui-perm");

    expect(taken).toMatchObject({
      mode: "acceptEdits",
      unattended: true,
      taskId: "bbbb2222",
      runId: "run-tui-perm",
    });
    // The hand-off is single-use: a second take cannot lend the tier again.
    expect(takeTuiTurnPermission("run-tui-perm")).toBeNull();

    consumeScheduledRunContext({ outcome: "completed" });
    expect((await pending).outcome).toBe("success");
  });

  test("a merged turn is at least as strict as every task in it", () => {
    const standard = turnPermissionForTask(
      task({ permission: "standard" }),
      "a",
    );
    const unrestricted = turnPermissionForTask(
      task({ permission: "unrestricted" }),
      "b",
    );
    expect(mergeTuiTurnPermissions([unrestricted, standard])?.mode).toBe(
      "standard",
    );
    expect(mergeTuiTurnPermissions([unrestricted])?.mode).toBe("unrestricted");
    expect(mergeTuiTurnPermissions([])).toBeNull();
  });

  test("the classifier sees the task tier, and an unattended ask becomes a denial (not a prompt)", () => {
    const permission = turnPermissionForTask(
      task({ permission: "standard" }),
      "run-cls",
    );
    const state = scheduledTurnPermissionState(permission);
    // The runtime invariant the loop asserts before classifying.
    expect(() =>
      assertScheduledTurnPermission(state, permission),
    ).not.toThrow();
    expect(() =>
      assertScheduledTurnPermission(
        { mode: "unrestricted", unattended: true },
        permission,
      ),
    ).toThrow(/task permission state/);

    // Record the modes the classifier actually reads from the state it was given.
    const seenModes: string[] = [];
    const observedState = {
      get mode() {
        const mode = state.mode;
        seenModes.push(mode);
        return mode;
      },
      get unattended() {
        return state.unattended;
      },
    };

    const result = checkPermission(
      "Bash",
      { command: "curl http://example.com" },
      NO_RULES,
      "/Users/test/project",
      observedState,
    );

    // The mode seen is the task's tier, not the session's default.
    expect(seenModes).toContain(permissionModeForTier("standard"));
    // And the ask was denied (no approval was built to hang on a missing human).
    expect(result.decision).toBe("deny");
    expect(result.reason).toBe("unattended");

    // Under the user's unrestricted selection the same call would be allowed,
    // so it is the task tier that decided this run.
    const asUser = checkPermission(
      "Bash",
      { command: "curl http://example.com" },
      NO_RULES,
      "/Users/test/project",
      { mode: "unrestricted", unattended: true },
    );
    expect(asUser.decision).toBe("allow");
  });
});
