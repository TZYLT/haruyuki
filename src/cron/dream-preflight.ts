/**
 * Lightweight dream-source registration for the short-lived schedule probe
 * (F-06 M1, R-5.2.6).
 *
 * `cron/preflight.ts` must stay feature-agnostic (M-1: the signal core has no
 * concrete feature source), so the dream source is registered by the caller
 * (`haruyuki schedule tick`) immediately before the probe runs. Keeping the
 * code here rather than in the core also preserves C-24: this module imports
 * only the dream signal state/settings readers, never S2/S3 (the activity and
 * pressure readers live in the agent layer).
 *
 * Deps are deliberately **over-approximated**: pressure is reported at the
 * threshold and silence as satisfied, so the probe answers "a dream run might
 * be due" without importing the ledger or memFS. The real evaluation happens
 * inside the runtime the probe decides to start, and the delegated short-lived
 * dream host records `nextEligibleAt` when it declines, so an over-
 * approximation costs at most one child per cooldown window.
 */

import { readDreamSettings } from "@/dream-settings";
import {
  ensureDreamSignalSourceRegistered,
  isDreamRunMarkerActive,
  readDreamSignalState,
} from "./dream-signal";

/** Register the over-approximating dream source for the preflight probe only. */
export function ensureDreamPreflightSignalSource(): void {
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
