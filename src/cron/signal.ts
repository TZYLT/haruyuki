/**
 * Signal-source registry (F-05, R-5.4.1/R-5.4.3).
 *
 * The schedule core asks the registry "what is due now?" and must never grow a
 * special case for a concrete feature: a future dream/reflection signal source
 * registers here exactly like the built-in cron one. That is the whole contract
 * — this module knows nothing about tasks beyond their id and occurrence.
 *
 * M0 ships the registry; M1 adds the built-in cron source (`cron-signal.ts`).
 */

import type {
  DueOccurrence,
  ScheduleTaskV2,
  SignalSource,
  SignalState,
} from "./cron-types";

const sources = new Map<string, SignalSource>();

/** Register (or replace) one source. Same id replaces, never duplicates. */
export function registerSignalSource(source: SignalSource): void {
  sources.set(source.id, source);
}

export function unregisterSignalSource(id: string): void {
  sources.delete(id);
}

/** Registered sources in registration order. */
export function listSignalSources(): SignalSource[] {
  return [...sources.values()];
}

/** Test helper: drop every registration. */
export function clearSignalSources(): void {
  sources.clear();
}

/**
 * Ask every registered source what is due. Sources evaluate independently; the
 * core is responsible for de-dup, lease and dispatch order.
 */
export function evaluateSignals(input: {
  now: Date;
  tasks: ScheduleTaskV2[];
  state: SignalState;
}): DueOccurrence[] {
  return listSignalSources().flatMap((source) => source.evaluate(input));
}

/** Earliest due time across every registered source, for the preflight. */
export function nextSignalDueAt(input: {
  now: Date;
  tasks: ScheduleTaskV2[];
}): Date | null {
  let earliest: Date | null = null;
  for (const source of listSignalSources()) {
    const dueAt = source.nextDueAt(input);
    if (!dueAt) continue;
    if (!earliest || dueAt.getTime() < earliest.getTime()) earliest = dueAt;
  }
  return earliest;
}
