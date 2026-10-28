/**
 * Built-in cron signal source (F-05, R-5.4.1).
 *
 * A "due occurrence" is the most recent scheduled slot that has not been
 * consumed yet — not every slot that went by. That single rule gives the whole
 * `catch_up` policy for free (R-5.10): the core sees one pending slot with its
 * original `intendedAt` and either runs it once (catch_up) or records the miss.
 *
 * Occurrence keys are minute strings in the task's own timezone:
 * `2026-10-28T09:00|Asia/Shanghai` for recurring tasks and the stored
 * `scheduled_for` timestamp for one-shots. They are monotonic per task, which is
 * what `last_consumed_occurrence` needs (R-5.4.2, R-5.5.2).
 *
 * Cron semantics are never re-implemented here: the wall-clock projection and
 * the parser-dialect normalization come from `parse-interval`, the module that
 * also owns `cronMatchesTime`, so matching and occurrence enumeration cannot
 * disagree (see `toParserCronExpression` / `toTimezoneWallClockMinute`).
 */

import { CronExpressionParser } from "cron-parser";
import type {
  DueOccurrence,
  ScheduleTaskV2,
  SignalSource,
  SignalState,
} from "./cron-types";
import {
  isValidCron,
  toParserCronExpression,
  toTimezoneWallClockMinute,
} from "./parse-interval";
import { registerSignalSource } from "./signal";

export const CRON_SIGNAL_SOURCE_ID = "cron";

const MS_PER_MINUTE = 60_000;
/** A missed run further back than this is summarized, not enumerated. */
const MAX_MISSED_CYCLES = 100;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function localTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function timezoneOf(task: ScheduleTaskV2): string {
  return task.timezone?.trim() || localTimezone();
}

/** Minute key of a wall-clock minute (a UTC-timeline Date, see parse-interval). */
function wallMinuteKey(wall: Date): string {
  return `${wall.getUTCFullYear()}-${pad(wall.getUTCMonth() + 1)}-${pad(wall.getUTCDate())}T${pad(wall.getUTCHours())}:${pad(wall.getUTCMinutes())}`;
}

function occurrenceKey(wall: Date, timezone: string): string {
  return `${wallMinuteKey(wall)}|${timezone}`;
}

/** Floor an instant to its minute (real timeline). */
function floorMinute(date: Date): Date {
  return new Date(Math.floor(date.getTime() / MS_PER_MINUTE) * MS_PER_MINUTE);
}

type CronIterator = ReturnType<typeof CronExpressionParser.parse>;

/**
 * Iterator whose wall-clock phase matches `cronMatchesTime`.
 *
 * `currentDate` is one millisecond before `wallNow`, so `next()` returns the
 * first slot at or after the current wall minute — exactly the minute the
 * matcher accepts.
 */
function createIterator(cron: string, wallNow: Date): CronIterator | null {
  const expression = toParserCronExpression(cron);
  if (!expression) return null;
  try {
    return CronExpressionParser.parse(expression, {
      currentDate: new Date(wallNow.getTime() - 1),
      tz: "UTC",
    });
  } catch {
    // Invalid expressions are reported by the core's legacy preflight, not here.
    return null;
  }
}

/** Map a wall-clock slot back onto the real timeline. */
function realSlot(wall: Date, wallNow: Date, realNow: Date): Date {
  return new Date(realNow.getTime() + (wall.getTime() - wallNow.getTime()));
}

function isConsumed(task: ScheduleTaskV2, occurrence: string): boolean {
  return (
    task.lastConsumedOccurrence !== null &&
    occurrence <= task.lastConsumedOccurrence
  );
}

/**
 * Slots between `lastConsumedOccurrence` and the found slot (inclusive), capped.
 * Counting backwards is bounded: only a real miss walks more than one step.
 */
function countSlotsSince(
  iterator: CronIterator,
  wall: Date,
  task: ScheduleTaskV2,
  timezone: string,
): number {
  if (!task.lastConsumedOccurrence) return 1;
  let count = 1;
  let previous = wall;
  while (count < MAX_MISSED_CYCLES) {
    let next: Date;
    try {
      next = iterator.prev().toDate();
    } catch {
      break;
    }
    if (next.getTime() >= previous.getTime()) break;
    previous = next;
    if (occurrenceKey(next, timezone) <= task.lastConsumedOccurrence) break;
    count += 1;
  }
  return count;
}

/** One-shot tasks are due once, at `scheduled_for` plus jitter (R-5.10.4). */
function oneShotOccurrence(
  task: ScheduleTaskV2,
  now: Date,
): DueOccurrence | null {
  if (task.status !== "active" || !task.scheduledFor) return null;
  const scheduledMs = Date.parse(task.scheduledFor);
  if (!Number.isFinite(scheduledMs)) return null;
  const occurrence = task.scheduledFor;
  if (isConsumed(task, occurrence)) return null;
  const intendedAt = new Date(scheduledMs + task.jitterOffsetMs);
  if (intendedAt.getTime() > now.getTime()) return null;
  return {
    taskId: task.id,
    occurrence,
    intendedAt: intendedAt.toISOString(),
    missedCycles: 1,
  };
}

/**
 * The newest scheduled slot that is still pending for this task, jitter applied.
 *
 * "Pending" means scheduled, eligible (not before creation) and not consumed; it
 * says nothing about whether the jitter has elapsed yet — the caller decides
 * that, because `nextDueAt` must report a jitter-pending slot as the next wake.
 */
function recurringCandidate(
  task: ScheduleTaskV2,
  now: Date,
): { occurrence: string; intendedAt: Date; missedCycles: number } | null {
  if (task.status !== "active" || !task.recurring) return null;
  if (!isValidCron(task.cron)) return null;

  const timezone = timezoneOf(task);
  const wallNow = toTimezoneWallClockMinute(now, timezone);
  const iterator = createIterator(task.cron, wallNow);
  if (!iterator) return null;

  let firstAfter: Date;
  try {
    firstAfter = iterator.next().toDate();
  } catch {
    return null;
  }

  // `firstAfter` is the slot at or after the current minute. When it is later
  // than now, the pending slot is the one before it.
  let wall: Date;
  if (firstAfter.getTime() <= wallNow.getTime()) {
    wall = firstAfter;
  } else {
    try {
      wall = iterator.prev().toDate();
    } catch {
      return null;
    }
  }

  const slotAt = realSlot(wall, wallNow, floorMinute(now));
  const occurrence = occurrenceKey(wall, timezone);
  if (isConsumed(task, occurrence)) return null;

  // Never consume history for a task that has no cursor yet: its first run is
  // the first slot at or after creation, never a backfill of legacy tasks.
  if (!task.lastConsumedOccurrence) {
    const createdAt = Date.parse(task.createdAt);
    if (Number.isFinite(createdAt) && slotAt.getTime() < createdAt) return null;
  }

  return {
    occurrence,
    intendedAt: new Date(slotAt.getTime() + task.jitterOffsetMs),
    missedCycles: countSlotsSince(iterator, wall, task, timezone),
  };
}

/** The pending slot once its jitter has elapsed (what `evaluate` may run). */
function recurringOccurrence(
  task: ScheduleTaskV2,
  now: Date,
): DueOccurrence | null {
  const candidate = recurringCandidate(task, now);
  if (!candidate) return null;
  if (candidate.intendedAt.getTime() > now.getTime()) return null;
  return {
    taskId: task.id,
    occurrence: candidate.occurrence,
    intendedAt: candidate.intendedAt.toISOString(),
    missedCycles: candidate.missedCycles,
  };
}

/** When the task next wants the core's attention (jitter included). */
function nextActionAt(task: ScheduleTaskV2, now: Date): Date | null {
  if (task.status !== "active") return null;

  if (!task.recurring) {
    if (!task.scheduledFor) return null;
    const scheduledMs = Date.parse(task.scheduledFor);
    if (!Number.isFinite(scheduledMs)) return null;
    if (isConsumed(task, task.scheduledFor)) return null;
    return new Date(scheduledMs + task.jitterOffsetMs);
  }

  // A pending slot wins even before its jitter elapses: that instant is the next
  // wake, and after it the slot is either run (catch_up) or recorded as missed.
  const pending = recurringCandidate(task, now);
  if (pending) return pending.intendedAt;

  const timezone = timezoneOf(task);
  const wallNow = toTimezoneWallClockMinute(now, timezone);
  const iterator = createIterator(task.cron, wallNow);
  if (!iterator) return null;

  let firstAfter: Date;
  try {
    firstAfter = iterator.next().toDate();
  } catch {
    return null;
  }
  let wall = firstAfter;
  if (firstAfter.getTime() <= wallNow.getTime()) {
    // Current minute matches but is consumed; the next slot is one step later.
    try {
      wall = iterator.next().toDate();
    } catch {
      return null;
    }
  }
  return new Date(
    realSlot(wall, wallNow, floorMinute(now)).getTime() + task.jitterOffsetMs,
  );
}

/**
 * Built-in cron source. A factory (not a shared instance) so a tick documents
 * its own clock without mutating module state.
 */
export function createCronSignalSource(): SignalSource {
  return {
    id: CRON_SIGNAL_SOURCE_ID,
    evaluate(input: {
      now: Date;
      tasks: ScheduleTaskV2[];
      state: SignalState;
    }): DueOccurrence[] {
      // The per-task `last_consumed_occurrence` is the cursor, so the shared
      // signal state carries nothing the cron source needs (R-5.4.2).
      void input.state;
      const occurrences: DueOccurrence[] = [];
      for (const task of input.tasks) {
        const occurrence = task.recurring
          ? recurringOccurrence(task, input.now)
          : oneShotOccurrence(task, input.now);
        if (occurrence) occurrences.push(occurrence);
      }
      return occurrences;
    },
    nextDueAt(input: { now: Date; tasks: ScheduleTaskV2[] }): Date | null {
      let earliest: Date | null = null;
      for (const task of input.tasks) {
        const dueAt = nextActionAt(task, input.now);
        if (!dueAt) continue;
        if (!earliest || dueAt.getTime() < earliest.getTime()) earliest = dueAt;
      }
      return earliest;
    },
  };
}

/**
 * Register the built-in source idempotently. Every entry point that evaluates
 * signals calls this, so the registry never depends on start-up order.
 */
export function ensureCronSignalSourceRegistered(): void {
  registerSignalSource(createCronSignalSource());
}
