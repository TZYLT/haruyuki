/**
 * Lightweight preflight for the short-lived host (F-05, R-5.3.2/R-5.3.3).
 *
 * Runs before the backend, the model catalog and the tools are loaded: read the
 * store, ask the registered signals whether anything is due, and let the caller
 * exit when nothing is. No derived cache file (Q-54) — one small JSON parse plus
 * one cron evaluation per active task is the whole cost.
 *
 * Import discipline (C-24): this module may import `cron-store`, the signal
 * registry and the cron signal source only. Nothing here may reach the backend,
 * the providers, the tools or the agent loop; the CLI entry point does that with
 * a dynamic import *after* this returns.
 */

import { readDreamSettings } from "@/dream-settings";
import { ensureCronSignalSourceRegistered } from "./cron-signal";
import { readScheduleFile, toScheduleTaskV2 } from "./cron-store";
import {
  ensureDreamSignalSourceRegistered,
  isDreamRunMarkerActive,
  readDreamSignalState,
} from "./dream-signal";
import { evaluateSignals, nextSignalDueAt } from "./signal";

export interface SchedulePreflightInput {
  now: Date;
}

export interface SchedulePreflightResult {
  /** True when the caller must load the runtime and do a real evaluation. */
  due: boolean;
  /** The next minute anything is due, for diagnostics and the log line. */
  nextDueAt: Date | null;
  /** Store/parse failure. The caller logs it and exits 0 (nothing can run). */
  error?: string;
}

/**
 * Register the dream source for the probe only (F-06 M1, R-5.2.6).
 *
 * Dream deps are deliberately **over-approximated**: pressure is reported at
 * the threshold and silence as satisfied, so this probe answers "a dream run
 * might be due" without importing S3's pressure reader or S2's activity
 * reader — `schedule tick` must stay a light process (C-24). The real
 * evaluation happens inside the runtime the probe decides to start, and the
 * delegated short-lived dream host records `nextEligibleAt` when it declines,
 * so an over-approximation costs at most one child per cooldown window.
 */
function registerDreamSignalSourceForPreflight(): void {
  ensureDreamSignalSourceRegistered({
    readState: (agentId) => readDreamSignalState(agentId),
    readSettings: () => readDreamSettings(),
    readSettingsForAgent: (agentId) => readDreamSettings(agentId),
    readPressure: () => Number.MAX_SAFE_INTEGER,
    readLastActiveAt: () => null,
    // Same age bound as the real deps: a marker left by a killed process must
    // not keep the probe (and therefore the trigger) suppressed forever.
    isRunning: (agentId) =>
      isDreamRunMarkerActive(
        readDreamSignalState(agentId).running,
        readDreamSettings(agentId),
        new Date(),
      ),
    now: () => new Date(),
  });
}

/** Must not import anything that reaches the backend. */
export function runSchedulePreflight(
  input: SchedulePreflightInput,
): SchedulePreflightResult {
  ensureCronSignalSourceRegistered();
  registerDreamSignalSourceForPreflight();
  let tasks: ReturnType<typeof toScheduleTaskV2>[];
  let state: { cursor: Record<string, string> };
  try {
    const data = readScheduleFile();
    tasks = data.tasks.map(toScheduleTaskV2).filter((task) => {
      return task.status === "active";
    });
    state = data.signal_state;
  } catch (error) {
    return {
      due: false,
      nextDueAt: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    const dueNow = evaluateSignals({ now: input.now, tasks, state });
    return {
      due: dueNow.length > 0,
      nextDueAt: nextSignalDueAt({ now: input.now, tasks }),
    };
  } catch (error) {
    return {
      due: false,
      nextDueAt: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
