import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import {
  autostartViewFor,
  buildRunSummaryLines,
  formatNextDue,
  formatNextDueOrPending,
  formatNextDueShort,
  formatRunCost,
  formatRunCostLabel,
  formatRunGroupLine,
  formatScheduleNotification,
  getScheduleSnapshot,
  groupRunsByRunId,
  readRunUsageCosts,
  refreshScheduleTasks,
  resetScheduleStore,
  resetStartupScheduleSummary,
  type ScheduleSource,
  scheduleTaskRows,
  setScheduleClockForTests,
  setScheduleSourceForTests,
  summarizeRunEntries,
  takeStartupScheduleSummaryLines,
} from "@/cli/helpers/schedule-store";
import {
  addTask,
  appendCronRunLogForTask,
  readPendingRunSummary,
  type ScheduleTaskV2,
} from "@/cron";
import type { CronRunLogEntry } from "@/cron/run-log";
import { getRunSummarySeenPath } from "@/cron/run-summary";
import { appendUsageRecord, buildUsageRecord } from "@/usage/ledger";

/**
 * The schedule view store: the pure copy, the run-log grouping, the startup
 * summary, and the one rule the rail depends on — an unchanged read publishes
 * the same snapshot object, so a 30 s tick repaints nothing.
 */

const TEST_DIR = path.join(import.meta.dir, "__schedule_store_test_tmp__");
const origHome = process.env.HARUYUKI_HOME;

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.HARUYUKI_HOME = TEST_DIR;
  resetScheduleStore();
  resetStartupScheduleSummary();
});

afterEach(() => {
  resetScheduleStore();
  resetStartupScheduleSummary();
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  if (origHome) process.env.HARUYUKI_HOME = origHome;
  else delete process.env.HARUYUKI_HOME;
});

/** A complete frozen view; only the fields a test cares about are overridden. */
function task(overrides: Partial<ScheduleTaskV2> = {}): ScheduleTaskV2 {
  return {
    id: "a1b2c3d4",
    agentId: "agent-1",
    name: "晨报",
    description: "summarise yesterday",
    type: "prompt",
    target: { kind: "new", hidden: false },
    payload: "summarise yesterday",
    cron: "0 9 * * *",
    timezone: "Asia/Shanghai",
    recurring: true,
    scheduledFor: null,
    catchUp: false,
    permission: "acceptEdits",
    timeoutMinutes: 30,
    waitMinutes: 10,
    status: "active",
    pausedReason: null,
    createdAt: "2026-10-01T00:00:00.000Z",
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

function source(
  tasks: readonly ScheduleTaskV2[],
  options: {
    nextDue?: (task: ScheduleTaskV2, now: Date) => Date | null;
    runs?: (taskId: string) => CronRunLogEntry[];
  } = {},
): ScheduleSource {
  return {
    listTasks: () => [...tasks],
    nextDueAt:
      options.nextDue ??
      ((item) =>
        item.status === "active" ? new Date("2026-11-02T01:00:00.000Z") : null),
    readRuns: options.runs ?? (() => []),
  };
}

const NOW = new Date("2026-11-01T10:00:00.000Z");

describe("the row model", () => {
  test("orders by next due and names every fact the requirement lists", () => {
    const rows = scheduleTaskRows(
      [
        task({
          id: "later",
          name: "周报",
          target: { kind: "existing", conversation_id: "conv-later-1234" },
        }),
        task({ id: "sooner", name: "晨报" }),
        task({
          id: "paused",
          name: "暂停的",
          status: "paused",
          pausedReason: "manual",
        }),
      ],
      NOW,
      (item) =>
        item.id === "sooner"
          ? new Date("2026-11-01T10:05:00.000Z")
          : item.id === "later"
            ? new Date("2026-11-01T12:00:00.000Z")
            : null,
    );
    expect(rows.map((row) => row.id)).toEqual(["sooner", "later", "paused"]);
    const sooner = rows[0];
    expect(sooner?.listLine).toContain("晨报");
    expect(sooner?.listLine).toContain("prompt");
    // M3 #14: the list row names the target, not just the detail view.
    expect(sooner?.listLine).toContain("新会话");
    expect(rows[1]?.listLine).toContain("会话 conv-lat");
    expect(sooner?.listLine).toContain("上次—");
    expect(sooner?.listLine).toContain("可编辑");
    expect(rows[2]?.statusLabel).toBe("paused");
    expect(rows[2]?.nextLabel).toBe("—");
  });

  test("an auto-paused task shows the reason and the streak, not just 'paused'", () => {
    const [row] = scheduleTaskRows(
      [
        task({
          status: "paused",
          pausedReason: "auto_failures",
          consecutiveFailures: 3,
          lastOutcome: "failed",
        }),
      ],
      NOW,
      () => null,
    );
    expect(row?.statusLabel).toBe("paused · auto");
    expect(row?.failureNote).toBe("连续失败 3 次后暂停");
    expect(row?.listLine).toContain("连续失败 3 次后暂停");
    expect(row?.listLine).toContain("上次失败");
  });

  test("today keeps the clock, a later day keeps the date", () => {
    const laterToday = new Date(NOW);
    laterToday.setHours(NOW.getHours() + 1, 30, 0, 0);
    expect(formatNextDue(laterToday, NOW)).toBe("今天 11:30");
    expect(formatNextDueShort(laterToday, NOW)).toBe("11:30");
    const tomorrow = new Date(NOW);
    tomorrow.setDate(tomorrow.getDate() + 1);
    expect(formatNextDue(tomorrow, NOW)).toContain("明天");
    const later = new Date("2026-12-24T09:00:00.000Z");
    expect(formatNextDueShort(later, NOW)).toMatch(/^12-2[45]$/);
    expect(formatNextDue(null, NOW)).toBe("—");
  });

  test("a slot the core still has to act on reads as due, not as a future run", () => {
    // T1's contract: `nextDueAt` is the next instant the core must act on, so a
    // past value is a pending occurrence (a late slot or a catch-up).
    const overdue = new Date(NOW.getTime() - 30 * 60 * 1000);
    expect(formatNextDueOrPending(overdue, NOW)).toContain("已到期");
    expect(formatNextDueShort(overdue, NOW)).toBe("已到期");
    expect(formatNextDueOrPending(null, NOW)).toBe("—");
    expect(
      formatNextDueOrPending(new Date(NOW.getTime() + 60_000), NOW),
    ).not.toContain("已到期");
  });
});

describe("the run history", () => {
  function entry(overrides: Partial<CronRunLogEntry> = {}): CronRunLogEntry {
    return {
      ts: Date.parse("2026-11-01T09:00:12.000Z"),
      jobId: "a1b2c3d4",
      action: "finished",
      status: "ok",
      runAtMs: Date.parse("2026-11-01T09:00:00.000Z"),
      runId: "run-1",
      conversationId: "conv-1",
      ...overrides,
    };
  }

  test("two entries of one run are one row, and a legacy entry stands alone", () => {
    const groups = groupRunsByRunId([
      entry({ ts: Date.parse("2026-11-01T09:00:12.000Z") }),
      entry({
        ts: Date.parse("2026-11-01T09:00:02.000Z"),
        status: "error",
        error: "model refused",
      }),
      entry({ ts: Date.parse("2026-10-31T09:00:00.000Z"), runId: undefined }),
    ]);
    expect(groups).toHaveLength(2);
    const run = groups[0];
    expect(run?.runId).toBe("run-1");
    expect(run?.entries).toHaveLength(2);
    expect(run?.outcome).toBe("success");
    expect(run?.durationMs).toBe(12_000);
    expect(run?.conversationId).toBe("conv-1");
    expect(groups[1]?.runId).toBeNull();
  });

  test("the line carries the time, result, duration and conversation", () => {
    const [group] = groupRunsByRunId([entry()]);
    const line = formatRunGroupLine(group as never, NOW);
    expect(line).toContain("成功");
    expect(line).toContain("12s");
    expect(line).toContain("会话 conv-1");
  });

  test("a v2 outcome spelled in the summary is not reported as failure", () => {
    const [timeoutGroup] = groupRunsByRunId([
      entry({ status: "error", summary: "timeout" }),
    ]);
    expect(timeoutGroup?.outcome).toBe("timeout");
    const [cancelledGroup] = groupRunsByRunId([
      entry({ status: "error", summary: "cancelled" }),
    ]);
    expect(cancelledGroup?.outcome).toBe("cancelled");
  });
});

describe("the startup summary", () => {
  const entries = [
    {
      runId: "r1",
      taskId: "a1",
      taskName: "晨报",
      outcome: "success" as const,
      startedAt: "2026-11-01T01:00:00.000Z",
      finishedAt: "2026-11-01T01:00:10.000Z",
    },
    {
      runId: "r2",
      taskId: "a2",
      taskName: "周报",
      outcome: "failed" as const,
      startedAt: "2026-11-01T02:00:00.000Z",
      finishedAt: "2026-11-01T02:00:10.000Z",
    },
    {
      runId: "r3",
      taskId: "a3",
      taskName: "抓取",
      outcome: "skipped" as const,
      startedAt: "2026-11-01T03:00:00.000Z",
      finishedAt: "2026-11-01T03:00:10.000Z",
    },
  ];

  test("counts into the three buckets the requirement names", () => {
    expect(summarizeRunEntries(entries)).toEqual({
      total: 3,
      success: 1,
      failed: 1,
      skipped: 1,
    });
  });

  test("the block is one count line plus one line per run", () => {
    const lines = buildRunSummaryLines(entries, NOW);
    expect(lines[0]).toBe("离开期间后台执行 3 条（成功 1／失败 1／跳过 1）");
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain("晨报");
    expect(lines[2]).toContain("失败");
    expect(lines[3]).toContain("跳过");
  });

  test("every pending run gets its own line — no cap, nothing summarized away", () => {
    const template = entries[0] as (typeof entries)[number];
    const many = Array.from({ length: 9 }, (_, index) => ({
      ...template,
      runId: `r-${index}`,
      taskName: `任务${index}`,
    }));
    const lines = buildRunSummaryLines(many, NOW);
    expect(lines).toHaveLength(10);
    for (let index = 0; index < 9; index += 1) {
      expect(lines[index + 1]).toContain(`任务${index}`);
    }
    expect(lines.join("\\n")).not.toContain("其余");
  });

  test("nothing pending means no block at all", () => {
    expect(buildRunSummaryLines([], NOW)).toEqual([]);
  });

  test("the log is read once, marked once, and not repeated", () => {
    // A real record, through the real store, under a temp harness root.
    const created = addTask({
      agent_id: "agent-1",
      name: "晨报",
      description: "d",
      cron: "0 9 * * *",
      recurring: true,
      prompt: "p",
    }).task;
    appendCronRunLogForTask(created, {
      status: "ok",
      runId: "run-1",
      runAtMs: Date.now() - 5_000,
    });
    expect(readPendingRunSummary()).toHaveLength(1);

    const lines = takeStartupScheduleSummaryLines(NOW);
    expect(lines[0]).toContain("后台执行 1 条");
    expect(existsSync(getRunSummarySeenPath())).toBe(true);

    // The second caller in the same process gets the cached block; a new
    // process (cache reset) sees the watermark and prints nothing.
    expect(takeStartupScheduleSummaryLines(NOW)).toEqual(lines);
    resetStartupScheduleSummary();
    expect(takeStartupScheduleSummaryLines(NOW)).toEqual([]);
  });
});

describe("per-run cost (M3 #9)", () => {
  test("a priced run prints its cost, an unpriced or unrun one prints —", () => {
    expect(formatRunCost(0.0042)).toBe("$ 0.00420");
    expect(formatRunCost(null)).toBe("—");
    expect(formatRunCost(undefined)).toBe("—");
    expect(formatRunCostLabel({ turns: 1, cost: 0.0042 })).toContain(
      "$ 0.00420",
    );
    expect(formatRunCostLabel({ turns: 1, cost: null })).toBe("费用 —");
    expect(formatRunCostLabel(undefined)).toBe("费用 —");
  });

  test("reads the ledger by runId, and separates priced from unpriced", async () => {
    const record = async (
      runId: string,
      total: number | undefined,
      at: Date,
    ): Promise<void> => {
      await appendUsageRecord(
        buildUsageRecord({
          at,
          agentId: "agent-1",
          model: "test-model",
          prompt: 10,
          cachedInput: 0,
          cacheWrite: 0,
          completion: 5,
          steps: 1,
          wallMs: 10,
          apiMs: 5,
          source: "cron",
          outcome: "completed",
          runId,
          ...(total === undefined
            ? {}
            : {
                cost: {
                  input: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  output: 0,
                  total,
                },
              }),
        }),
      );
    };
    await record("run-1", 0.0021, new Date("2026-11-01T01:00:00.000Z"));
    await record("run-1", 0.0021, new Date("2026-11-01T01:00:05.000Z"));
    // A run the provider did not price: turns exist, the price is unknown.
    await record("run-2", undefined, new Date("2026-11-01T02:00:00.000Z"));
    // Give the two appends a beat to land before the read.
    await Bun.sleep(20);

    const usage = await readRunUsageCosts(["run-1", "run-2", "run-none"]);
    expect(usage.get("run-1")?.turns).toBe(2);
    expect(usage.get("run-1")?.cost).toBeCloseTo(0.0042, 6);
    expect(usage.get("run-2")).toEqual({ turns: 1, cost: null });
    expect(usage.get("run-none")).toEqual({ turns: 0, cost: null });
  });
});

describe("run notifications", () => {
  test("a finished run names the task, the result, the clock and the session", () => {
    const line = formatScheduleNotification(
      {
        kind: "run-finished",
        at: "2026-11-01T09:00:12.000Z",
        taskId: "a1b2c3d4",
        taskName: "晨报",
        agentId: "agent-1",
        runId: "run-1",
        outcome: "success",
        conversationId: "conv-1",
        durationMs: 12_000,
      },
      NOW,
    );
    expect(line).toContain("晨报");
    expect(line).toContain("成功");
    expect(line).toContain("12s");
    expect(line).toContain("会话 conv-1");
  });

  test("a failure carries a truncated error and a skip still notifies", () => {
    const failed = formatScheduleNotification(
      {
        kind: "run-finished",
        at: "2026-11-01T09:00:12.000Z",
        taskId: "a1",
        taskName: "晨报",
        agentId: "agent-1",
        outcome: "failed",
        error: `model refused ${"x".repeat(120)}`,
      },
      NOW,
    );
    expect(failed).toContain("失败");
    expect(failed?.length).toBeLessThan(160);
    const skipped = formatScheduleNotification(
      {
        kind: "run-finished",
        at: "2026-11-01T09:00:12.000Z",
        taskId: "a1",
        taskName: "晨报",
        agentId: "agent-1",
        outcome: "skipped",
      },
      NOW,
    );
    expect(skipped).toContain("跳过");
  });

  test("a paused task is its own notification; run-started is not one", () => {
    expect(
      formatScheduleNotification({
        kind: "task-paused",
        at: "2026-11-01T09:00:12.000Z",
        taskId: "a1",
        taskName: "晨报",
        agentId: "agent-1",
        pausedReason: "auto_failures",
      }),
    ).toContain("连续失败");
    expect(
      formatScheduleNotification({
        kind: "run-started",
        at: "2026-11-01T09:00:00.000Z",
        taskId: "a1",
        taskName: "晨报",
        agentId: "agent-1",
      }),
    ).toBeNull();
  });
});

describe("the autostart panel line (M4 #11)", () => {
  test("a registered-but-stale entry says it needs re-registering", () => {
    const stale = autostartViewFor({
      registered: true,
      platform: "win32",
      method: "schtasks",
      stale: true,
      registeredLauncherPath: "C:/old/haruyuki-launch.cmd",
    });
    expect(stale.registered).toBe(true);
    expect(stale.stale).toBe(true);
    expect(stale.label).toContain("需重新注册");

    const fresh = autostartViewFor({
      registered: true,
      platform: "win32",
      method: "schtasks",
    });
    expect(fresh.label).toContain("已注册");
    expect(fresh.label).not.toContain("需重新注册");

    const missing = autostartViewFor({
      registered: false,
      platform: "win32",
      method: null,
      error: "crontab 不可读",
    });
    expect(missing.label).toContain("未注册");
    expect(missing.label).toContain("crontab 不可读");
  });
});

describe("the store", () => {
  test("an unchanged read publishes the same snapshot object", () => {
    setScheduleClockForTests(() => NOW);
    setScheduleSourceForTests(source([task()]));
    const first = refreshScheduleTasks(NOW);
    expect(first.loaded).toBe(true);
    expect(first.rows).toHaveLength(1);
    const second = refreshScheduleTasks(NOW);
    expect(second).toBe(first);
    expect(getScheduleSnapshot()).toBe(first);
  });

  test("a changed field publishes a new snapshot", () => {
    setScheduleClockForTests(() => NOW);
    let tasks = [task()];
    setScheduleSourceForTests({
      listTasks: () => tasks,
      nextDueAt: () => null,
      readRuns: () => [],
    });
    const first = refreshScheduleTasks(NOW);
    tasks = [task({ status: "paused", pausedReason: "manual" })];
    const second = refreshScheduleTasks(NOW);
    expect(second).not.toBe(first);
    expect(second.revision).toBe(first.revision + 1);
    expect(second.rows[0]?.statusLabel).toBe("paused");
  });

  test("a read failure is reported instead of throwing at the rail", () => {
    setScheduleSourceForTests({
      listTasks: () => {
        throw new Error("schedules.json has version 99");
      },
      nextDueAt: () => null,
      readRuns: () => [],
    });
    const snapshot = refreshScheduleTasks(NOW);
    expect(snapshot.error).toContain("version 99");
    expect(snapshot.rows).toEqual([]);
  });

  test("the default source reads the real store under HARUYUKI_HOME", () => {
    addTask({
      agent_id: "agent-1",
      name: "晨报",
      description: "d",
      cron: "0 9 * * *",
      recurring: true,
      prompt: "p",
    });
    setScheduleSourceForTests(null);
    const snapshot = refreshScheduleTasks(NOW);
    expect(snapshot.rows.map((row) => row.name)).toEqual(["晨报"]);
    expect(snapshot.rows[0]?.agentId).toBe("agent-1");
  });
});
