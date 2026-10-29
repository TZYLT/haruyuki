/**
 * Signal-source registry (F-05, R-5.4.1/R-5.4.3).
 *
 * The schedule core asks the registry "what is due now?" and must never grow a
 * special case for a concrete feature: a future threshold/cursor signal source
 * registers here exactly like the built-in cron one. That is the whole contract
 * — this module knows nothing about tasks beyond their id and occurrence.
 *
 * Every source also returns its own opaque cursor (R-5.4.2). The core persists
 * the returned cursors into `signal_state` itself, so a source never touches the
 * store; `evaluateSignals` keeps the occurrence-only shape for preflight.
 *
 * M0 ships the registry; M1 adds the built-in cron source (`cron-signal.ts`).
 */

import type {
  DueOccurrence,
  ScheduleTaskV2,
  SignalEvaluation,
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

export interface EvaluateSignalsInput {
  now: Date;
  tasks: ScheduleTaskV2[];
  state: SignalState;
}

export interface EvaluateSignalsResult {
  occurrences: DueOccurrence[];
  /** New source-level cursors (`source id → cursor`) to persist, if any. */
  cursors: Record<string, string>;
}

/**
 * Ask every registered source what is due, collecting both the occurrences and
 * the cursors the sources advanced to (R-5.4.1/R-5.4.2).
 *
 * Sources evaluate independently; the core is responsible for de-dup, lease and
 * dispatch order. A source that returns no `nextCursor` leaves its row alone.
 */
export function evaluateSignalsWithCursors(
  input: EvaluateSignalsInput,
): EvaluateSignalsResult {
  const occurrences: DueOccurrence[] = [];
  const cursors: Record<string, string> = {};
  for (const source of listSignalSources()) {
    const evaluation: SignalEvaluation = source.evaluate(input);
    occurrences.push(...evaluation.occurrences);
    if (evaluation.nextCursor !== null && evaluation.nextCursor !== undefined) {
      cursors[source.id] = evaluation.nextCursor;
    }
  }
  return { occurrences, cursors };
}

/**
 * Occurrence-only projection (the preflight and every legacy caller use this).
 * Cursor bookkeeping is deliberately not done here — the tick owns the store.
 */
export function evaluateSignals(input: EvaluateSignalsInput): DueOccurrence[] {
  return evaluateSignalsWithCursors(input).occurrences;
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
