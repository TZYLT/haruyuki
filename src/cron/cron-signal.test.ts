import { describe, expect, test } from "bun:test";
import {
  createCronSignalSource,
  ensureCronSignalSourceRegistered,
} from "@/cron/cron-signal";
import type { ScheduleTaskV2 } from "@/cron/cron-types";
import { clearSignalSources, listSignalSources } from "@/cron/signal";

const state = { cursor: {} };

/** A frozen-view task with everything the source reads. */
function task(overrides: Partial<ScheduleTaskV2> = {}): ScheduleTaskV2 {
  return {
    id: "task-1",
    agentId: "agent-local-1",
    name: "Cron task",
    description: "",
    type: "prompt",
    target: { kind: "new", hidden: false },
    payload: "hello",
    cron: "* * * * *",
    timezone: "UTC",
    recurring: true,
    scheduledFor: null,
    catchUp: false,
    permission: "unrestricted",
    timeoutMinutes: 30,
    waitMinutes: 10,
    status: "active",
    pausedReason: null,
    createdAt: "2026-10-20T00:00:00.000Z",
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

const NOW = new Date("2026-10-28T14:05:20.000Z");

describe("createCronSignalSource: recurring occurrences", () => {
  test("the occurrence is the timezone-qualified minute key", () => {
    const source = createCronSignalSource();
    const due = source.evaluate({
      now: new Date("2026-10-28T14:05:00.000Z"),
      tasks: [task()],
      state,
    });
    expect(due).toEqual([
      {
        taskId: "task-1",
        occurrence: "2026-10-28T14:05|UTC",
        intendedAt: "2026-10-28T14:05:00.000Z",
        missedCycles: 1,
      },
    ]);
  });

  test("the key follows the task timezone, not the process clock", () => {
    const source = createCronSignalSource();
    const due = source.evaluate({
      now: new Date("2026-10-28T14:05:00.000Z"),
      tasks: [task({ timezone: "Asia/Shanghai" })],
      state,
    });
    expect(due[0]?.occurrence).toBe("2026-10-28T22:05|Asia/Shanghai");
    expect(due[0]?.intendedAt).toBe("2026-10-28T14:05:00.000Z");
  });

  test("a consumed occurrence is not emitted again", () => {
    const source = createCronSignalSource();
    const due = source.evaluate({
      now: new Date("2026-10-28T14:05:00.000Z"),
      tasks: [task({ lastConsumedOccurrence: "2026-10-28T14:05|UTC" })],
      state,
    });
    expect(due).toEqual([]);
  });

  test("without a cursor only the newest slot is emitted, and only once it is due", () => {
    const source = createCronSignalSource();
    // 14:05:20 is inside the 14:05 minute: the slot already started.
    expect(source.evaluate({ now: NOW, tasks: [task()], state })).toHaveLength(
      1,
    );

    const notYetCreated = task({ createdAt: "2026-10-28T14:05:10.000Z" });
    expect(
      source.evaluate({
        now: new Date("2026-10-28T14:05:20.000Z"),
        tasks: [notYetCreated],
        state,
      }),
    ).toEqual([]);
  });

  test("a stale cursor yields one occurrence and counts the skipped slots", () => {
    const source = createCronSignalSource();
    const due = source.evaluate({
      now: NOW,
      tasks: [
        task({
          cron: "*/15 * * * *",
          lastConsumedOccurrence: "2026-10-28T13:00|UTC",
        }),
      ],
      state,
    });
    // Slots 13:15, 13:30, 13:45 and 14:00 = 4 (14:00 is the newest pending).
    expect(due).toHaveLength(1);
    expect(due[0]?.occurrence).toBe("2026-10-28T14:00|UTC");
    expect(due[0]?.missedCycles).toBe(4);
  });

  test("jitter delays intendedAt and the occurrence stays the same", () => {
    const source = createCronSignalSource();
    const jittered = task({ jitterOffsetMs: 30_000 });

    expect(
      source.evaluate({
        now: new Date("2026-10-28T14:05:20.000Z"),
        tasks: [jittered],
        state,
      }),
    ).toEqual([]);

    const due = source.evaluate({
      now: new Date("2026-10-28T14:05:35.000Z"),
      tasks: [jittered],
      state,
    });
    expect(due).toHaveLength(1);
    expect(due[0]?.occurrence).toBe("2026-10-28T14:05|UTC");
    expect(due[0]?.intendedAt).toBe("2026-10-28T14:05:30.000Z");
  });

  test("paused and invalid tasks are never due", () => {
    const source = createCronSignalSource();
    expect(
      source.evaluate({ now: NOW, tasks: [task({ status: "paused" })], state }),
    ).toEqual([]);
    expect(
      source.evaluate({
        now: NOW,
        tasks: [task({ cron: "0-60 * * * *" })],
        state,
      }),
    ).toEqual([]);
  });
});

describe("createCronSignalSource: one-shot occurrences", () => {
  const scheduledFor = "2026-10-28T14:05:00.000Z";

  test("occurrence is scheduled_for and it fires once the jitter has elapsed", () => {
    const source = createCronSignalSource();
    const oneShot = task({
      recurring: false,
      scheduledFor,
      cron: "5 14 28 10 *",
    });

    expect(
      source.evaluate({
        now: new Date("2026-10-28T14:04:59.000Z"),
        tasks: [oneShot],
        state,
      }),
    ).toEqual([]);

    const due = source.evaluate({
      now: new Date("2026-10-28T14:05:10.000Z"),
      tasks: [oneShot],
      state,
    });
    expect(due).toEqual([
      {
        taskId: "task-1",
        occurrence: scheduledFor,
        intendedAt: scheduledFor,
        missedCycles: 1,
      },
    ]);
  });

  test("one-shots keep their early :00/:30 jitter", () => {
    const source = createCronSignalSource();
    const oneShot = task({
      recurring: false,
      scheduledFor,
      jitterOffsetMs: -60_000,
      cron: "5 14 28 10 *",
    });
    expect(
      source.evaluate({
        now: new Date("2026-10-28T14:04:30.000Z"),
        tasks: [oneShot],
        state,
      }),
    ).toHaveLength(1);
  });
});

describe("createCronSignalSource: nextDueAt", () => {
  test("reports the next slot after a consumed one", () => {
    const source = createCronSignalSource();
    const next = source.nextDueAt({
      now: new Date("2026-10-28T14:05:20.000Z"),
      tasks: [task({ lastConsumedOccurrence: "2026-10-28T14:05|UTC" })],
    });
    expect(next).toEqual(new Date("2026-10-28T14:06:00.000Z"));
  });

  test("includes the jitter offset", () => {
    const source = createCronSignalSource();
    const next = source.nextDueAt({
      now: new Date("2026-10-28T14:05:20.000Z"),
      tasks: [task({ jitterOffsetMs: 30_000 })],
    });
    expect(next).toEqual(new Date("2026-10-28T14:05:30.000Z"));
  });

  test("a pending catch-up slot is due now", () => {
    const source = createCronSignalSource();
    const next = source.nextDueAt({
      now: NOW,
      tasks: [
        task({
          cron: "0 * * * *",
          catchUp: true,
          lastConsumedOccurrence: "2026-10-28T13:00|UTC",
        }),
      ],
    });
    expect(next).toEqual(new Date("2026-10-28T14:00:00.000Z"));
  });

  test("finished and paused tasks are not scheduled", () => {
    const source = createCronSignalSource();
    expect(
      source.nextDueAt({ now: NOW, tasks: [task({ status: "fired" })] }),
    ).toBeNull();
    expect(
      source.nextDueAt({ now: NOW, tasks: [task({ status: "paused" })] }),
    ).toBeNull();
  });

  test("a consumed one-shot has no next due time", () => {
    const source = createCronSignalSource();
    const scheduledFor = "2026-10-28T14:05:00.000Z";
    expect(
      source.nextDueAt({
        now: new Date("2026-10-28T14:10:00.000Z"),
        tasks: [
          task({
            recurring: false,
            scheduledFor,
            lastConsumedOccurrence: scheduledFor,
          }),
        ],
      }),
    ).toBeNull();
  });
});

test("ensureCronSignalSourceRegistered registers the built-in source once", () => {
  clearSignalSources();
  ensureCronSignalSourceRegistered();
  ensureCronSignalSourceRegistered();
  const sources = listSignalSources();
  expect(sources).toHaveLength(1);
  expect(sources[0]?.id).toBe("cron");
  clearSignalSources();
});
