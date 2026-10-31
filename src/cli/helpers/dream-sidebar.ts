/**
 * The rail's "Scheduled tasks" row for the dream carrier task (F-06).
 *
 * `ScheduleTaskV2.type === "dream"` carries no `nextDueAt`: a dream is triggered
 * by a signal, not by its placeholder cron, so the generic row mapping painted
 * `—`. The user's ruling (2026-10-31) is that the row shows the live truth or is
 * hidden — never a dash:
 *
 * - a live run → `running`
 * - outside the idle window → the next window start (`22:00`, `11-01`)
 * - inside it, the day's attempts spent → the next window start
 * - inside it, during the cooldown → the cooldown instant
 * - inside it, nothing blocking → `ready`
 * - master switch off / auto-trigger off / every tier off → `null`, so the
 *   caller drops the row entirely
 *
 * The computation is the cheap half of `evaluateDreamEligibility`: idle window,
 * day counter and cooldown only. It deliberately reads **no usage ledger and no
 * pressure score** — the rail is redrawn on every streaming chunk, and a pressure
 * read walks the ledger and the memory tree.
 *
 * **Never call this from a render body.** `ContextSidebarSlot` renders on every
 * chunk, so the reads live in {@link useDreamScheduleRow}: a 30 s low-frequency
 * hook (the same cadence as `SCHEDULE_REFRESH_INTERVAL_MS`) that only starts
 * while this agent actually owns a dream row. The pure function takes its reads
 * as deps so the branches are testable without a harness root.
 */

import { useEffect, useState } from "react";
import { isDreamRunLive } from "@/agent/dream/dream-liveness";
import {
  DREAM_MAX_ATTEMPTS_PER_DAY,
  type DreamSignalState,
  dreamDayKey,
  isWithinDreamIdleWindow,
  nextDreamWindowStart,
  readDreamSignalState,
  rollDreamStateForDay,
} from "@/cron/dream-signal";
import {
  type ResolvedDreamSettings,
  readDreamSettings,
} from "@/dream-settings";

/** One painted dream row: the rail's `when` and `status` columns. */
export interface DreamScheduleRow {
  /** `running`, `ready`, `22:00` today or `11-01` on another day. */
  when: string;
  /** Empty for a healthy dream; the task's own status wins when it is paused. */
  status: string;
}

/** The reads the description needs; injectable so tests need no harness root. */
export interface DreamScheduleDeps {
  readSettings(agentId: string): ResolvedDreamSettings;
  readState(agentId: string): DreamSignalState;
  /** `isDreamRunLive` in production: marker + lease + age bound. */
  isRunning(agentId: string, now: Date): boolean;
}

const DEFAULT_DEPS: DreamScheduleDeps = {
  readSettings: readDreamSettings,
  readState: readDreamSignalState,
  isRunning: isDreamRunLive,
};

/**
 * How often the dream row is re-described. Matches the schedule store's own
 * low-frequency refresh: the state file is small, but the rail is not a place
 * to poll.
 */
export const DREAM_SIDEBAR_REFRESH_MS = 30_000;

function pad2(value: number): string {
  return String(Math.max(0, Math.trunc(value))).padStart(2, "0");
}

/**
 * A future instant the way the rail's `when` column writes it: the clock while
 * it is still today (the row's other dates are `MM-DD`, like the store's
 * `nextShort`).
 */
export function formatDreamScheduleMoment(atMs: number, now: Date): string {
  const at = new Date(atMs);
  if (dreamDayKey(at) === dreamDayKey(now)) {
    return `${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
  }
  return `${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}`;
}

/**
 * The dream row's live state, or `null` when the row should not be shown at all.
 *
 * Order matters, and it mirrors the trigger: the settings gates and the
 * liveness probe come before any state read, so a disabled dream costs one
 * settings lookup and a running dream costs no window arithmetic.
 */
export function describeDreamScheduleRow(
  agentId: string,
  now: Date = new Date(),
  deps: DreamScheduleDeps = DEFAULT_DEPS,
): DreamScheduleRow | null {
  const settings = deps.readSettings(agentId);
  // R-5.9.4 / Q-43: the master switch and auto-trigger are the hard gates, and
  // a run with every tier off has nothing to do. Hidden, not `—`.
  if (!settings.enabled) return null;
  if (!settings.autoTrigger) return null;
  if (!Object.values(settings.tiers).some(Boolean)) return null;

  if (deps.isRunning(agentId, now)) return { when: "running", status: "" };

  const nextWindow = nextDreamWindowStart(settings.idleWindows, now);
  // A configured window always yields a start; the fallback exists only so no
  // branch can ever paint `—` (the settings normalizer guarantees one window).
  const nextWindowWhen =
    nextWindow === null ? "ready" : formatDreamScheduleMoment(nextWindow, now);

  if (!isWithinDreamIdleWindow(settings.idleWindows, now)) {
    return { when: nextWindowWhen, status: "" };
  }
  const state = rollDreamStateForDay(deps.readState(agentId), now);
  if (state.dayCount >= DREAM_MAX_ATTEMPTS_PER_DAY) {
    // R-5.2.5: the day's attempts are spent, so the next one is the next
    // window start (tomorrow, while this window is still open).
    return { when: nextWindowWhen, status: "" };
  }
  if (state.nextEligibleAt !== null && state.nextEligibleAt > now.getTime()) {
    return {
      when: formatDreamScheduleMoment(state.nextEligibleAt, now),
      status: "",
    };
  }
  return { when: "ready", status: "" };
}

/**
 * The dream row as React state, re-read on a 30 s timer.
 *
 * `enabled` is "this agent owns a dream schedule row" — the caller derives it
 * from the schedule snapshot. The effect owns both the first read and the timer,
 * so no file read happens during a render, and the timer is torn down with the
 * row (or the agent switch). Joining the schedule store was considered and
 * rejected: its 30 s refresh only publishes when the rows change, and a dream's
 * row does not change when its cooldown expires.
 */
export function useDreamScheduleRow(
  agentId: string,
  enabled: boolean,
): DreamScheduleRow | null {
  const [row, setRow] = useState<DreamScheduleRow | null>(null);

  useEffect(() => {
    if (!enabled) {
      setRow(null);
      return;
    }
    let cancelled = false;
    // Clear the previous agent's row before the new read lands: a conversation
    // switch must never show another agent's dream state for a frame.
    setRow(null);
    const read = () => {
      let next: DreamScheduleRow | null = null;
      try {
        next = describeDreamScheduleRow(agentId, new Date());
      } catch {
        // Every read in the default deps is documented as never throwing. If
        // one ever does, hide the row: the rail's effect must not take the
        // frame down, and a dash is forbidden (`—` would be a lie anyway).
        next = null;
      }
      if (!cancelled) setRow(next);
    };
    read();
    const timer = setInterval(read, DREAM_SIDEBAR_REFRESH_MS);
    // A timer must not keep the process alive while the TUI is tearing down.
    timer.unref?.();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [agentId, enabled]);

  return enabled ? row : null;
}
