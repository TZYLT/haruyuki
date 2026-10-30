import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ScheduleTaskV2 } from "@/cron/cron-types";
import {
  createDreamSignalSource,
  DREAM_ATTEMPT_COOLDOWN_MINUTES,
  DREAM_MAX_ATTEMPTS_PER_DAY,
  DREAM_PLACEHOLDER_CRON,
  DREAM_SIGNAL_SOURCE_ID,
  type DreamSignalDeps,
  type DreamSignalState,
  deferDreamSignal,
  dreamDayKey,
  EMPTY_DREAM_SIGNAL_STATE,
  evaluateDreamEligibility,
  getDreamSignalStatePath,
  isWithinDreamIdleWindow,
  markDreamAttempt,
  markDreamRunActive,
  markDreamRunFinished,
  nextDreamWindowStart,
  parseDreamWindowMinute,
  readDreamSignalState,
  rollDreamStateForDay,
  validateDreamTaskForRun,
  writeDreamSignalState,
} from "@/cron/dream-signal";
import {
  DREAM_SETTINGS_DEFAULTS,
  type ResolvedDreamSettings,
} from "@/dream-settings";

const TEST_DIR = path.join(import.meta.dir, "__dream_signal_test_tmp__");
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

// ── Fixtures ────────────────────────────────────────────────────────

const ALL_TIERS = {
  tidy: true,
  think: true,
  task: true,
  wander: true,
} as const;

function settings(
  overrides: Partial<ResolvedDreamSettings> = {},
): ResolvedDreamSettings {
  return {
    ...DREAM_SETTINGS_DEFAULTS,
    enabled: true,
    autoTrigger: true,
    tiers: { ...ALL_TIERS },
    idleWindows: [{ start: "22:00", end: "07:00" }],
    ...overrides,
  };
}

function emptyState(
  overrides: Partial<DreamSignalState> = {},
): DreamSignalState {
  return { ...EMPTY_DREAM_SIGNAL_STATE, ...overrides };
}

/** A local-time Date, so the window assertions do not depend on the host TZ. */
function local(
  year: number,
  month: number,
  day: number,
  hours: number,
  minutes: number,
): Date {
  return new Date(year, month - 1, day, hours, minutes, 0, 0);
}

function dreamTask(overrides: Partial<ScheduleTaskV2> = {}): ScheduleTaskV2 {
  return {
    id: "dream-task-1",
    agentId: "agent-1",
    name: "Dream",
    description: "",
    type: "dream",
    target: { kind: "new", hidden: true },
    payload: "",
    cron: DREAM_PLACEHOLDER_CRON,
    timezone: "UTC",
    recurring: true,
    scheduledFor: null,
    catchUp: false,
    permission: "acceptEdits",
    timeoutMinutes: 0,
    waitMinutes: 0,
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

function eligibility(
  overrides: {
    task?: ScheduleTaskV2;
    settings?: ResolvedDreamSettings;
    state?: DreamSignalState;
    now?: Date;
    pressure?: number;
    lastActiveAt?: number | null;
    isRunning?: boolean;
  } = {},
) {
  return evaluateDreamEligibility({
    task: overrides.task ?? dreamTask(),
    settings: overrides.settings ?? settings(),
    state: overrides.state ?? emptyState(),
    now: overrides.now ?? local(2026, 10, 30, 23, 30),
    pressure: overrides.pressure ?? 80_000,
    lastActiveAt: overrides.lastActiveAt ?? null,
    isRunning: overrides.isRunning ?? false,
  });
}

// ── Windows ─────────────────────────────────────────────────────────

describe("idle windows (R-5.2.1)", () => {
  test("parses HH:mm and rejects garbage", () => {
    expect(parseDreamWindowMinute("22:00")).toBe(1320);
    expect(parseDreamWindowMinute("0:05")).toBe(5);
    expect(parseDreamWindowMinute("24:00")).toBeNull();
    expect(parseDreamWindowMinute("22:60")).toBeNull();
    expect(parseDreamWindowMinute("evening")).toBeNull();
  });

  test("a cross-midnight window covers both sides of midnight", () => {
    const windows = [{ start: "22:00", end: "07:00" }];
    expect(isWithinDreamIdleWindow(windows, local(2026, 10, 30, 23, 30))).toBe(
      true,
    );
    expect(isWithinDreamIdleWindow(windows, local(2026, 10, 31, 3, 0))).toBe(
      true,
    );
    expect(isWithinDreamIdleWindow(windows, local(2026, 10, 31, 12, 0))).toBe(
      false,
    );
    // Half-open: start is inside, end is outside.
    expect(isWithinDreamIdleWindow(windows, local(2026, 10, 30, 22, 0))).toBe(
      true,
    );
    expect(isWithinDreamIdleWindow(windows, local(2026, 10, 31, 7, 0))).toBe(
      false,
    );
  });

  test("several windows per day each match independently", () => {
    const windows = [
      { start: "12:30", end: "13:30" },
      { start: "22:00", end: "07:00" },
    ];
    expect(isWithinDreamIdleWindow(windows, local(2026, 10, 30, 13, 0))).toBe(
      true,
    );
    expect(isWithinDreamIdleWindow(windows, local(2026, 10, 30, 15, 0))).toBe(
      false,
    );
    expect(isWithinDreamIdleWindow(windows, local(2026, 10, 30, 23, 0))).toBe(
      true,
    );
    expect(isWithinDreamIdleWindow(windows, local(2026, 10, 31, 6, 0))).toBe(
      true,
    );
  });

  test("next window start moves to tomorrow when today's windows passed", () => {
    const windows = [
      { start: "12:30", end: "13:30" },
      { start: "22:00", end: "07:00" },
    ];
    expect(nextDreamWindowStart(windows, local(2026, 10, 30, 15, 0))).toBe(
      local(2026, 10, 30, 22, 0).getTime(),
    );
    expect(nextDreamWindowStart(windows, local(2026, 10, 30, 23, 0))).toBe(
      local(2026, 10, 31, 12, 30).getTime(),
    );
  });
});

// ── Eligibility matrix (R-5.2.1–R-5.2.9) ────────────────────────────

describe("trigger eligibility", () => {
  test("inside the window, silent, under pressure → eligible", () => {
    expect(eligibility().reason).toBe("eligible");
  });

  test("every gate rejects with its own reason", () => {
    const outside = local(2026, 10, 30, 15, 0);
    expect(eligibility({ now: outside }).reason).toBe("outside_window");
    expect(eligibility({ settings: settings({ enabled: false }) }).reason).toBe(
      "disabled",
    );
    expect(
      eligibility({ settings: settings({ autoTrigger: false }) }).reason,
    ).toBe("auto_trigger_off");
    expect(
      eligibility({
        settings: settings({
          tiers: { tidy: false, think: false, task: false, wander: false },
        }),
      }).reason,
    ).toBe("all_tiers_off");
    expect(
      eligibility({
        state: emptyState({
          nextEligibleAt: local(2026, 10, 30, 23, 40).getTime(),
        }),
      }).reason,
    ).toBe("cooldown");
    expect(eligibility({ isRunning: true }).reason).toBe("already_running");
    expect(
      eligibility({
        state: emptyState({ running: { runId: "r", startedAt: 1 } }),
      }).reason,
    ).toBe("already_running");
    // R-5.2.2: 30 minutes of silence.
    expect(
      eligibility({
        now: local(2026, 10, 30, 23, 30),
        lastActiveAt: local(2026, 10, 30, 23, 10).getTime(),
      }).reason,
    ).toBe("user_active");
    expect(
      eligibility({
        now: local(2026, 10, 30, 23, 30),
        lastActiveAt: local(2026, 10, 30, 22, 50).getTime(),
      }).reason,
    ).toBe("eligible");
    // R-5.2.3: pressure threshold.
    expect(eligibility({ pressure: 74_999 }).reason).toBe("low_pressure");
    expect(eligibility({ pressure: 75_000 }).reason).toBe("eligible");
  });

  test("outside the window reports the next window start", () => {
    const now = local(2026, 10, 30, 15, 0);
    const result = eligibility({ now });
    expect(result.reason).toBe("outside_window");
    expect(result.nextEligibleAt).toBe(local(2026, 10, 30, 22, 0).getTime());
  });

  test("the day counter resets on a new local day (次日顺延)", () => {
    const yesterday = dreamDayKey(local(2026, 10, 29, 23, 0));
    const state = emptyState({
      dayKey: yesterday,
      dayCount: DREAM_MAX_ATTEMPTS_PER_DAY,
    });
    expect(
      eligibility({ state, now: local(2026, 10, 30, 23, 30) }).reason,
    ).toBe("eligible");
    // Same day: the sixth attempt was already spent.
    const today = emptyState({
      dayKey: dreamDayKey(local(2026, 10, 30, 23, 30)),
      dayCount: DREAM_MAX_ATTEMPTS_PER_DAY,
    });
    const limited = eligibility({ state: today });
    expect(limited.reason).toBe("daily_limit");
    // Inside the window, the next window start is tomorrow's 22:00.
    expect(limited.nextEligibleAt).toBe(local(2026, 10, 31, 22, 0).getTime());
  });

  test("rollover helper keeps the running marker", () => {
    const state = emptyState({
      dayKey: "2020-01-01",
      dayCount: 3,
      nextEligibleAt: 123,
      running: { runId: "r1", startedAt: 7 },
    });
    const rolled = rollDreamStateForDay(state, local(2026, 10, 30, 23, 0));
    expect(rolled.dayKey).toBe("2026-10-30");
    expect(rolled.dayCount).toBe(0);
    // An absolute cooldown instant survives the rollover (cross-midnight window).
    expect(rolled.nextEligibleAt).toBe(123);
    expect(rolled.running).toEqual({ runId: "r1", startedAt: 7 });
  });
});

// ── Signal source ───────────────────────────────────────────────────

function deps(overrides: Partial<DreamSignalDeps> = {}): DreamSignalDeps {
  return {
    readState: () => emptyState(),
    readSettings: () => settings(),
    readPressure: () => 80_000,
    readLastActiveAt: () => null,
    isRunning: () => false,
    now: () => local(2026, 10, 30, 23, 30),
    ...overrides,
  };
}

describe("dream signal source", () => {
  test("produces one occurrence for an eligible dream task", () => {
    const source = createDreamSignalSource(deps());
    expect(source.id).toBe(DREAM_SIGNAL_SOURCE_ID);
    const evaluation = source.evaluate({
      now: local(2026, 10, 30, 23, 30),
      tasks: [dreamTask()],
      state: { cursor: {} },
    });
    expect(evaluation.occurrences).toHaveLength(1);
    expect(evaluation.occurrences[0]?.taskId).toBe("dream-task-1");
    expect(evaluation.occurrences[0]?.occurrence).toMatch(/^dream:/);
    // The shared start-of-tick cursor is never touched (route C-18).
    expect(evaluation.nextCursor).toBeUndefined();
  });

  test("ignores non-dream tasks and inactive dream tasks", () => {
    const source = createDreamSignalSource(deps());
    const evaluation = source.evaluate({
      now: local(2026, 10, 30, 23, 30),
      tasks: [
        dreamTask({ id: "p", type: "prompt" }),
        dreamTask({ id: "paused", status: "paused" }),
      ],
      state: { cursor: {} },
    });
    expect(evaluation.occurrences).toEqual([]);
  });

  test("no occurrence when any gate fails", () => {
    const source = createDreamSignalSource(deps({ readPressure: () => 1_000 }));
    expect(
      source.evaluate({
        now: local(2026, 10, 30, 23, 30),
        tasks: [dreamTask()],
        state: { cursor: {} },
      }).occurrences,
    ).toEqual([]);
  });

  test("nextDueAt reports the cooldown / next window, not 'now'", () => {
    const now = local(2026, 10, 30, 23, 30);
    const cooling = createDreamSignalSource(
      deps({
        readState: () =>
          emptyState({
            dayKey: dreamDayKey(now),
            nextEligibleAt: now.getTime() + 5 * 60_000,
          }),
      }),
    );
    expect(cooling.nextDueAt({ now, tasks: [dreamTask()] })?.getTime()).toBe(
      now.getTime() + 5 * 60_000,
    );

    const source = createDreamSignalSource(deps());
    expect(source.nextDueAt({ now, tasks: [dreamTask()] })).toBeNull();

    const outside = createDreamSignalSource(deps());
    expect(
      outside
        .nextDueAt({ now: local(2026, 10, 30, 15, 0), tasks: [dreamTask()] })
        ?.getTime(),
    ).toBe(local(2026, 10, 30, 22, 0).getTime());
  });
});

// ── State file ──────────────────────────────────────────────────────

describe("dream signal state (route C-18)", () => {
  test("lives under the harness home, never a literal .haruyuki path", () => {
    const statePath = getDreamSignalStatePath();
    expect(statePath.startsWith(TEST_DIR)).toBe(true);
    expect(statePath).toContain("dream");
  });

  test("round-trips one agent without touching another", () => {
    writeDreamSignalState("agent-1", emptyState({ dayCount: 2 }));
    markDreamRunActive("agent-1", "run-1", local(2026, 10, 30, 23, 0));
    writeDreamSignalState("agent-2", emptyState({ dayCount: 5 }));
    expect(readDreamSignalState("agent-1").dayCount).toBe(2);
    expect(readDreamSignalState("agent-1").running?.runId).toBe("run-1");
    expect(readDreamSignalState("agent-2").dayCount).toBe(5);
  });

  test("a corrupt file reads as empty instead of crashing a tick", () => {
    const statePath = getDreamSignalStatePath();
    mkdirSync(path.dirname(statePath), { recursive: true });
    writeFileSync(statePath, "{not json");
    expect(readDreamSignalState("agent-1")).toEqual(EMPTY_DREAM_SIGNAL_STATE);
  });

  test("an automatic attempt advances the day counter and cooldown", () => {
    const now = local(2026, 10, 30, 23, 0);
    markDreamAttempt({
      agentId: "agent-1",
      now,
      occurrence: "dream:a",
      manual: false,
    });
    const first = readDreamSignalState("agent-1");
    expect(first.dayKey).toBe(dreamDayKey(now));
    expect(first.dayCount).toBe(1);
    expect(first.nextEligibleAt).toBe(
      now.getTime() + DREAM_ATTEMPT_COOLDOWN_MINUTES * 60_000,
    );

    markDreamAttempt({
      agentId: "agent-1",
      now: local(2026, 10, 30, 23, 59),
      occurrence: "dream:b",
      manual: false,
    });
    expect(readDreamSignalState("agent-1").dayCount).toBe(2);
    // Crossing local midnight resets the counter for the new day.
    markDreamAttempt({
      agentId: "agent-1",
      now: local(2026, 10, 31, 1, 0),
      occurrence: "dream:c",
      manual: false,
    });
    expect(readDreamSignalState("agent-1").dayCount).toBe(1);
    expect(readDreamSignalState("agent-1").dayKey).toBe(
      dreamDayKey(local(2026, 10, 31, 1, 0)),
    );
  });

  test("a manual attempt does not spend the daily budget or throttle", () => {
    const now = local(2026, 10, 30, 23, 0);
    markDreamAttempt({
      agentId: "agent-1",
      now,
      occurrence: "manual:x",
      manual: true,
    });
    const state = readDreamSignalState("agent-1");
    expect(state.dayCount).toBe(0);
    expect(state.nextEligibleAt).toBeNull();
    expect(state.lastAttemptAt).toBe(now.getTime());
  });

  test("a declined delegated child pushes nextEligibleAt (R-5.2.5)", () => {
    const now = local(2026, 10, 30, 23, 0);
    deferDreamSignal({
      agentId: "agent-1",
      now,
      reason: "low_pressure",
      settings: settings(),
    });
    expect(readDreamSignalState("agent-1").nextEligibleAt).toBe(
      now.getTime() + DREAM_ATTEMPT_COOLDOWN_MINUTES * 60_000,
    );
    // A window/day decline points at the next window instead.
    deferDreamSignal({
      agentId: "agent-1",
      now: local(2026, 10, 30, 15, 0),
      reason: "outside_window",
      settings: settings(),
    });
    expect(readDreamSignalState("agent-1").nextEligibleAt).toBe(
      local(2026, 10, 30, 22, 0).getTime(),
    );
  });

  test("finishing a run clears the in-flight marker", () => {
    markDreamRunActive("agent-1", "run-1", new Date());
    markDreamRunFinished("agent-1", "succeeded", new Date());
    const state = readDreamSignalState("agent-1");
    expect(state.running).toBeNull();
    expect(state.lastOutcome).toBe("succeeded");
  });
});

// ── Task shape ──────────────────────────────────────────────────────

describe("dream task validation (route C-17/C-37)", () => {
  test("accepts the documented shape", () => {
    expect(validateDreamTaskForRun(dreamTask())).toBeNull();
  });

  test("rejects each shape violation with a reason", () => {
    expect(validateDreamTaskForRun(dreamTask({ recurring: false }))).toContain(
      "recurring",
    );
    expect(
      validateDreamTaskForRun(
        dreamTask({ target: { kind: "existing", conversation_id: "c" } }),
      ),
    ).toContain("hidden");
    expect(
      validateDreamTaskForRun(
        dreamTask({ target: { kind: "new", hidden: false } }),
      ),
    ).toContain("hidden");
    expect(
      validateDreamTaskForRun(dreamTask({ timeoutMinutes: 30 })),
    ).toContain("timeout_minutes");
    expect(validateDreamTaskForRun(dreamTask({ cron: "0 9 * * *" }))).toContain(
      "placeholder",
    );
    expect(validateDreamTaskForRun(dreamTask({ payload: "{bad" }))).toContain(
      "payload",
    );
  });
});
