/**
 * Production wiring for the dream signal source (F-06 M1, T1).
 *
 * The source itself (`dream-signal.ts`) has no static dependency on settings,
 * the usage ledger or memFS pressure — those arrive through `DreamSignalDeps`.
 * Keeping the real deps in a separate module is what lets the preflight probe
 * (`cron/preflight.ts`) register a deliberately lightweight source: it must not
 * pull the backend or the agent loop into `haruyuki schedule tick` (route C-24).
 *
 * S2 (`readDreamActivity`) and S3 (`readDreamPressure`) are L0 stubs until M2;
 * the wiring is live already, so M2 only has to fill the stubs in.
 */
import { readDreamActivity } from "@/agent/dream/dream-activity";
import { readDreamPressure } from "@/agent/dream/dream-pressure";
import { readDreamSettings } from "@/dream-settings";
import type { DreamSignalDeps } from "./dream-signal";
import { isDreamRunMarkerActive, readDreamSignalState } from "./dream-signal";

/** Overrides are for tests and for hosts that need a frozen clock. */
export function createDefaultDreamSignalDeps(
  overrides: Partial<DreamSignalDeps> = {},
): DreamSignalDeps {
  return {
    readState: (agentId) => readDreamSignalState(agentId),
    readSettings: () => readDreamSettings(),
    readSettingsForAgent: (agentId) => readDreamSettings(agentId),
    readPressure: (agentId) => readDreamPressure(agentId),
    readLastActiveAt: (agentId) => readDreamActivity(agentId),
    // The run marker lives in the same state file the host writes, but a marker
    // left by a killed process must not suppress the trigger forever (Lead
    // fix): it is authoritative only while it is younger than the run's own
    // time limit (+grace). T2's `isDreamRunLive` does the lease-owner check at
    // the S5/startup call sites; this cron-side predicate stays cheap.
    isRunning: (agentId) => {
      const settings = readDreamSettings(agentId);
      return isDreamRunMarkerActive(
        readDreamSignalState(agentId).running,
        settings,
        new Date(),
      );
    },
    now: () => new Date(),
    ...overrides,
  };
}
