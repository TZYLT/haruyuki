// src/cli/helpers/dream-sidebar.test.ts

import { describe, expect, test } from "bun:test";
import {
  DREAM_MAX_ATTEMPTS_PER_DAY,
  type DreamSignalState,
  dreamDayKey,
  EMPTY_DREAM_SIGNAL_STATE,
} from "@/cron/dream-signal";
import {
  DREAM_SETTINGS_DEFAULTS,
  type ResolvedDreamSettings,
} from "@/dream-settings";
import {
  DREAM_SIDEBAR_REFRESH_MS,
  type DreamScheduleDeps,
  describeDreamScheduleRow,
  formatDreamScheduleMoment,
} from "./dream-sidebar";

const AGENT = "agent-dream";

/** The defaults, with the master switch on so the gates are not what is tested. */
function settings(
  overrides: Partial<ResolvedDreamSettings> = {},
): ResolvedDreamSettings {
  return {
    ...DREAM_SETTINGS_DEFAULTS,
    enabled: true,
    autoTrigger: true,
    tiers: { tidy: true, think: true, task: true, wander: true },
    ...overrides,
  };
}

function deps(
  input: {
    settings?: Partial<ResolvedDreamSettings>;
    state?: Partial<DreamSignalState>;
    running?: boolean;
  } = {},
): DreamScheduleDeps {
  return {
    readSettings: () => settings(input.settings),
    readState: () => ({ ...EMPTY_DREAM_SIGNAL_STATE, ...input.state }),
    isRunning: () => input.running ?? false,
  };
}

/** Local time, so the window arithmetic is the user's own clock. */
function at(hour: number, minute = 0, day = 31): Date {
  return new Date(2026, 9, day, hour, minute, 0, 0);
}

describe("describeDreamScheduleRow", () => {
  test("a live run says running", () => {
    expect(
      describeDreamScheduleRow(AGENT, at(23, 30), deps({ running: true })),
    ).toEqual({ when: "running", status: "" });
  });

  test("outside the window: the next start, still today", () => {
    // Default window is 22:00–07:00; at 21:05 the next start is 22:00 today.
    expect(describeDreamScheduleRow(AGENT, at(21, 5), deps())).toEqual({
      when: "22:00",
      status: "",
    });
  });

  test("outside the window with the next start tomorrow: the date", () => {
    const row = describeDreamScheduleRow(
      AGENT,
      at(11),
      deps({ settings: { idleWindows: [{ start: "09:00", end: "10:00" }] } }),
    );
    // 2026-10-31 11:00 → next start 2026-11-01 09:00.
    expect(row).toEqual({ when: "11-01", status: "" });
  });

  test("inside the window, during cooldown: the cooldown instant", () => {
    const now = at(23);
    const row = describeDreamScheduleRow(
      AGENT,
      now,
      deps({
        state: {
          dayKey: dreamDayKey(now),
          dayCount: 2,
          nextEligibleAt: now.getTime() + 10 * 60_000,
        },
      }),
    );
    expect(row).toEqual({ when: "23:10", status: "" });
  });

  test("a cooldown that crosses midnight shows the date", () => {
    const now = at(23, 50);
    const row = describeDreamScheduleRow(
      AGENT,
      now,
      deps({
        state: {
          dayKey: dreamDayKey(now),
          dayCount: 1,
          // 2026-10-31 23:50 → 2026-11-01 00:30.
          nextEligibleAt: at(0, 30, 32).getTime(),
        },
      }),
    );
    expect(row).toEqual({ when: "11-01", status: "" });
  });

  test("the day's attempts spent: the next window start", () => {
    const now = at(23, 30);
    const row = describeDreamScheduleRow(
      AGENT,
      now,
      deps({
        state: {
          dayKey: dreamDayKey(now),
          dayCount: DREAM_MAX_ATTEMPTS_PER_DAY,
        },
      }),
    );
    // Still inside 22:00–07:00, so the next start is tomorrow at 22:00.
    expect(row).toEqual({ when: "11-01", status: "" });
  });

  test("inside the window, nothing blocking: ready", () => {
    const now = at(2);
    const row = describeDreamScheduleRow(
      AGENT,
      now,
      deps({
        state: {
          dayKey: dreamDayKey(now),
          dayCount: 1,
          nextEligibleAt: now.getTime() - 60_000,
        },
      }),
    );
    expect(row).toEqual({ when: "ready", status: "" });
  });

  test("yesterday's spent attempts roll over, so the row is ready again", () => {
    const now = at(2);
    const row = describeDreamScheduleRow(
      AGENT,
      now,
      deps({
        state: {
          dayKey: "2000-01-01",
          dayCount: DREAM_MAX_ATTEMPTS_PER_DAY,
        },
      }),
    );
    expect(row).toEqual({ when: "ready", status: "" });
  });

  test("a disabled dream hides the row", () => {
    expect(
      describeDreamScheduleRow(
        AGENT,
        at(23),
        deps({ settings: { enabled: false } }),
      ),
    ).toBeNull();
  });

  test("auto-trigger off hides the row", () => {
    expect(
      describeDreamScheduleRow(
        AGENT,
        at(23),
        deps({ settings: { autoTrigger: false } }),
      ),
    ).toBeNull();
  });

  test("every tier off hides the row", () => {
    expect(
      describeDreamScheduleRow(
        AGENT,
        at(23),
        deps({
          settings: {
            tiers: { tidy: false, think: false, task: false, wander: false },
          },
        }),
      ),
    ).toBeNull();
  });

  test("a hidden row is decided before the expensive liveness read", () => {
    let probed = false;
    const row = describeDreamScheduleRow(AGENT, at(23), {
      ...deps({ settings: { enabled: false } }),
      isRunning: () => {
        probed = true;
        return true;
      },
    });
    expect(row).toBeNull();
    expect(probed).toBe(false);
  });

  test("no branch ever falls back to a dash", () => {
    const now = at(23);
    const cases: Array<DreamScheduleDeps> = [
      deps(),
      deps({ running: true }),
      deps({
        state: {
          dayKey: dreamDayKey(now),
          dayCount: DREAM_MAX_ATTEMPTS_PER_DAY,
        },
      }),
      deps({
        state: {
          dayKey: dreamDayKey(now),
          nextEligibleAt: now.getTime() + 60_000,
        },
      }),
    ];
    for (const input of cases) {
      const row = describeDreamScheduleRow(AGENT, now, input);
      expect(row).not.toBeNull();
      expect(row?.when).not.toBe("—");
      expect(row?.when.length).toBeGreaterThan(0);
    }
  });
});

describe("formatDreamScheduleMoment", () => {
  test("keeps two digits on the clock", () => {
    expect(formatDreamScheduleMoment(at(9, 5).getTime(), at(20))).toBe("09:05");
  });

  test("another day is the same `MM-DD` form the store's rows use", () => {
    expect(formatDreamScheduleMoment(at(9, 0, 32).getTime(), at(20))).toBe(
      "11-01",
    );
  });
});

describe("the refresh cadence", () => {
  test("matches the schedule store's low-frequency refresh", () => {
    expect(DREAM_SIDEBAR_REFRESH_MS).toBe(30_000);
  });
});
