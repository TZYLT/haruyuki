import { afterEach, describe, expect, test } from "bun:test";
import {
  ScheduleOverlay,
  ScheduleOverlayRoute,
} from "@/cli/components/ScheduleOverlay";
import {
  autostartViewFor,
  groupRunsByRunId,
  type RunUsageRow,
  refreshScheduleTasks,
  resetScheduleStore,
  type ScheduleRunGroup,
  type ScheduleSource,
  setScheduleClockForTests,
  setScheduleOverlayTarget,
  setScheduleSourceForTests,
} from "@/cli/helpers/schedule-store";
import type { ScheduleTaskV2 } from "@/cron";
import type { CronRunLogEntry } from "@/cron/run-log";
import { mountInkTty, resetInkTtyState } from "@/test-utils/ink-tty";

/**
 * The `/schedule` faces, judged on the frame (`src/cli/AGENTS.md`: a face can be
 * wired perfectly and paint nothing). The list has to carry the facts
 * R-5.12.4 names, the detail has to make an auto-paused task's reason obvious,
 * and the run history has to be one row per `runId` — those are the three things
 * the requirement asks of this face.
 */

const NOW = new Date("2026-11-01T10:00:00.000Z");

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
    catchUp: true,
    permission: "acceptEdits",
    timeoutMinutes: 30,
    waitMinutes: 10,
    status: "active",
    pausedReason: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    lastFiredAt: null,
    fireCount: 0,
    lastRunAt: "2026-10-31T01:00:00.000Z",
    lastOutcome: "success",
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

function source(tasks: readonly ScheduleTaskV2[]): ScheduleSource {
  return {
    listTasks: () => [...tasks],
    nextDueAt: (item) =>
      item.status === "active" ? new Date("2026-11-01T11:30:00.000Z") : null,
    readRuns: () => [],
  };
}

const AUTOSTART_LINE = {
  registered: false,
  label: "自启 未注册（M4 未接入）",
};

/**
 * The frame after the mount's own effects have landed.
 *
 * Two of this face's facts are read asynchronously on mount (the autostart
 * status, and the run log when the face opens on it), so the first painted frame
 * legitimately shows the pending copy. The harness already waits one tick; this
 * gives the promise chain one more before the frame is judged.
 */
async function settle(tty: { text(): Promise<string> }): Promise<string> {
  await Bun.sleep(60);
  return tty.text();
}

/**
 * The store as the app hands it to the face: already read (the submit layer
 * calls `ensureScheduleTasksLoaded` before it opens the panel, and the rail
 * keeps it fresh afterwards). Reading here is what makes the first painted
 * frame the data instead of the loading row.
 */
function primeStore(tasks: readonly ScheduleTaskV2[], now = NOW): void {
  setScheduleClockForTests(() => now);
  setScheduleSourceForTests(source(tasks));
  refreshScheduleTasks(now);
}

afterEach(() => {
  resetScheduleStore();
  setScheduleOverlayTarget({ view: "list" });
  resetInkTtyState();
});

describe("the list face", () => {
  test("paints name, type, next run, last result, status and permission", async () => {
    primeStore([
      task(),
      task({
        id: "b2c3d4e5",
        name: "周报",
        type: "command",
        payload: "/compact 3",
        status: "paused",
        pausedReason: "auto_failures",
        consecutiveFailures: 3,
        lastOutcome: "failed",
      }),
    ]);
    const tty = mountInkTty(
      <ScheduleOverlay
        agentId="agent-1"
        onClose={() => {}}
        readAutostart={async () => AUTOSTART_LINE}
        readRuns={() => []}
      />,
      { columns: 120, rows: 30 },
    );
    try {
      const painted = await settle(tty);
      expect(painted).toContain("/schedule list");
      expect(painted).toContain("计划任务");
      expect(painted).toContain("晨报");
      expect(painted).toContain("今天 11:30");
      expect(painted).toContain("上次成功");
      expect(painted).toContain("可编辑");
      // M3 #14: the row names the target as well.
      expect(painted).toContain("新会话");
      // The auto-paused row says why, in the same row as the task.
      expect(painted).toContain("周报");
      expect(painted).toContain("paused · auto");
      expect(painted).toContain("连续失败 3 次后暂停");
      expect(painted).toContain("共 2 个");
      expect(painted).toContain("自启 未注册");
    } finally {
      tty.stop();
    }
  });

  test("an empty store says so, and still names the autostart state", async () => {
    primeStore([]);
    const tty = mountInkTty(
      <ScheduleOverlay
        agentId="agent-1"
        onClose={() => {}}
        readAutostart={async () => AUTOSTART_LINE}
        readRuns={() => []}
      />,
      { columns: 100, rows: 24 },
    );
    try {
      const painted = await settle(tty);
      expect(painted).toContain("当前 agent 还没有计划任务");
      expect(painted).toContain("/schedule add");
      expect(painted).toContain("自启 未注册");
    } finally {
      tty.stop();
    }
  });

  test("agents other than the current one are not listed", async () => {
    primeStore([task({ id: "other", name: "别人的任务", agentId: "agent-2" })]);
    const tty = mountInkTty(
      <ScheduleOverlay
        agentId="agent-1"
        onClose={() => {}}
        readAutostart={async () => AUTOSTART_LINE}
        readRuns={() => []}
      />,
      { columns: 100, rows: 24 },
    );
    try {
      expect(await settle(tty)).not.toContain("别人的任务");
    } finally {
      tty.stop();
    }
  });

  test("Enter opens the row's detail without remounting the face", async () => {
    primeStore([task()]);
    const tty = mountInkTty(
      <ScheduleOverlay
        agentId="agent-1"
        onClose={() => {}}
        readAutostart={async () => AUTOSTART_LINE}
        readRuns={() => []}
      />,
      { columns: 120, rows: 30 },
    );
    try {
      expect(await settle(tty)).toContain("/schedule list");
      await tty.press("\r");
      const painted = await settle(tty);
      expect(painted).toContain("/schedule show a1b2c3d4");
      expect(painted).toContain("权限      可编辑");
    } finally {
      tty.stop();
    }
  });
});

describe("the detail face", () => {
  test("shows the fields the panel promises, and the pause reason", async () => {
    primeStore([
      task({
        status: "paused",
        pausedReason: "auto_failures",
        consecutiveFailures: 3,
      }),
    ]);
    const tty = mountInkTty(
      <ScheduleOverlay
        view="detail"
        taskId="a1b2c3d4"
        agentId="agent-1"
        onClose={() => {}}
        readAutostart={async () => AUTOSTART_LINE}
        readRuns={() => []}
      />,
      { columns: 120, rows: 30 },
    );
    try {
      const painted = await settle(tty);
      expect(painted).toContain("晨报");
      expect(painted).toContain("类型      prompt");
      expect(painted).toContain("目标      新会话");
      expect(painted).toContain("状态      paused（连续失败）");
      expect(painted).toContain("补跑      是");
      expect(painted).toContain("连续失败  3 次");
      expect(painted).toContain("l 运行记录");
    } finally {
      tty.stop();
    }
  });
});

describe("the run history", () => {
  const groups: ScheduleRunGroup[] = groupRunsByRunId([
    entry(),
    entry({ ts: Date.parse("2026-10-31T09:00:05.000Z"), runId: "run-0" }),
  ]);

  test("paints one row per run, with the result and the conversation", async () => {
    primeStore([task()]);
    const tty = mountInkTty(
      <ScheduleOverlay
        view="logs"
        taskId="a1b2c3d4"
        agentId="agent-1"
        onClose={() => {}}
        readAutostart={async () => AUTOSTART_LINE}
        readRuns={() => groups}
      />,
      { columns: 120, rows: 30 },
    );
    try {
      const painted = await settle(tty);
      expect(painted).toContain("/schedule logs a1b2c3d4");
      expect(painted).toContain("运行记录");
      expect(painted).toContain("共 2 次");
      expect(painted).toContain("成功");
      expect(painted).toContain("12s");
      expect(painted).toContain("会话 conv-1");
    } finally {
      tty.stop();
    }
  });

  test("a task that never ran says so instead of painting an empty list", async () => {
    primeStore([task()]);
    const tty = mountInkTty(
      <ScheduleOverlay
        view="logs"
        taskId="a1b2c3d4"
        agentId="agent-1"
        onClose={() => {}}
        readAutostart={async () => AUTOSTART_LINE}
        readRuns={() => []}
      />,
      { columns: 100, rows: 24 },
    );
    try {
      const painted = await settle(tty);
      expect(painted).toContain("这个任务还没有跑过");
      expect(painted).toContain("Esc 返回");
    } finally {
      tty.stop();
    }
  });

  test("each run's cost is shown from the ledger, — when it has no row (M3 #9)", async () => {
    primeStore([task()]);
    // `run-1` has a priced row; `run-0` has none (usage read returns no entry).
    const usage = new Map<string, RunUsageRow>([
      ["run-1", { turns: 1, cost: 0.0042 }],
    ]);
    const tty = mountInkTty(
      <ScheduleOverlay
        view="logs"
        taskId="a1b2c3d4"
        agentId="agent-1"
        onClose={() => {}}
        readAutostart={async () => AUTOSTART_LINE}
        readRuns={() =>
          groupRunsByRunId([
            entry(),
            entry({
              ts: Date.parse("2026-10-31T09:00:05.000Z"),
              runId: "run-0",
            }),
          ])
        }
        readRunUsage={async () => usage}
      />,
      { columns: 140, rows: 30 },
    );
    try {
      const painted = await settle(tty);
      expect(painted).toContain("$ 0.00420");
      expect(painted).toContain("费用 —");
    } finally {
      tty.stop();
    }
  });
});

describe("the route (M3 #2)", () => {
  test("a name opens the task's detail", async () => {
    primeStore([task({ id: "a1b2c3d4e5f6", name: "晨报" })]);
    setScheduleOverlayTarget({ view: "detail", taskId: "晨报" });
    const tty = mountInkTty(
      <ScheduleOverlayRoute
        overlay="schedule-detail"
        agentId="agent-1"
        onClose={() => {}}
        readAutostart={async () => AUTOSTART_LINE}
        readRuns={() => []}
      />,
      { columns: 120, rows: 30 },
    );
    try {
      const painted = await settle(tty);
      expect(painted).toContain("/schedule show a1b2c3d4");
      expect(painted).toContain("权限      可编辑");
    } finally {
      tty.stop();
    }
  });

  test("the short id a row prints opens its run history", async () => {
    primeStore([task({ id: "a1b2c3d4e5f6", name: "晨报" })]);
    setScheduleOverlayTarget({ view: "logs", taskId: "a1b2c3d4" });
    const tty = mountInkTty(
      <ScheduleOverlayRoute
        overlay="schedule-logs"
        agentId="agent-1"
        onClose={() => {}}
        readAutostart={async () => AUTOSTART_LINE}
        readRuns={() => []}
      />,
      { columns: 120, rows: 30 },
    );
    try {
      const painted = await settle(tty);
      expect(painted).toContain("/schedule logs a1b2c3d4");
      expect(painted).toContain("运行记录");
    } finally {
      tty.stop();
    }
  });

  test("an unknown reference says 'not found' instead of painting the list", async () => {
    primeStore([task()]);
    setScheduleOverlayTarget({ view: "detail", taskId: "不存在" });
    const tty = mountInkTty(
      <ScheduleOverlayRoute
        overlay="schedule-detail"
        agentId="agent-1"
        onClose={() => {}}
        readAutostart={async () => AUTOSTART_LINE}
        readRuns={() => []}
      />,
      { columns: 120, rows: 30 },
    );
    try {
      const painted = await settle(tty);
      expect(painted).toContain("找不到任务");
      expect(painted).not.toContain("Enter 详情");
    } finally {
      tty.stop();
    }
  });

  test("another agent's task is not shown (M3 #19 agent scope)", async () => {
    primeStore([task({ id: "other-1", agentId: "agent-2", name: "别人的" })]);
    setScheduleOverlayTarget({ view: "detail", taskId: "别人的" });
    const tty = mountInkTty(
      <ScheduleOverlayRoute
        overlay="schedule-detail"
        agentId="agent-1"
        onClose={() => {}}
        readAutostart={async () => AUTOSTART_LINE}
        readRuns={() => []}
      />,
      { columns: 120, rows: 30 },
    );
    try {
      expect(await settle(tty)).toContain("找不到任务");
    } finally {
      tty.stop();
    }
  });
});

describe("autostart state in the panel", () => {
  test("a stale registration says it needs re-registering (M4 #11)", async () => {
    primeStore([]);
    const tty = mountInkTty(
      <ScheduleOverlay
        agentId="agent-1"
        onClose={() => {}}
        readAutostart={async () =>
          autostartViewFor({
            registered: true,
            platform: "win32",
            method: "schtasks",
            stale: true,
          })
        }
        readRuns={() => []}
      />,
      { columns: 100, rows: 24 },
    );
    try {
      expect(await settle(tty)).toContain("需重新注册");
    } finally {
      tty.stop();
    }
  });

  test("the state is re-read when the face changes view (M3 #16)", async () => {
    primeStore([task()]);
    let reads = 0;
    const readAutostart = async () => {
      reads += 1;
      return { registered: true, label: "自启 已注册（schtasks）" };
    };
    const tty = mountInkTty(
      <ScheduleOverlay
        agentId="agent-1"
        onClose={() => {}}
        readAutostart={readAutostart}
        readRuns={() => []}
      />,
      { columns: 100, rows: 24 },
    );
    try {
      await settle(tty);
      expect(reads).toBe(1);
      // Enter opens the detail view: the OS fact is re-asked, so an entry that
      // was removed behind the panel's back cannot keep reading "registered".
      await tty.press("\r");
      await settle(tty);
      expect(reads).toBeGreaterThanOrEqual(2);
    } finally {
      tty.stop();
    }
  });
});
