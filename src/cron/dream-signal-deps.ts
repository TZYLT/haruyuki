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
import { readDreamSignalState } from "./dream-signal";

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
    // The run marker lives in the same state file the host writes, so the
    // source needs no cross-process dream lock to answer "is a run active".
    isRunning: (agentId) => readDreamSignalState(agentId).running !== null,
    now: () => new Date(),
    ...overrides,
  };
}
