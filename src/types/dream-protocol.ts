import type { PermissionTier } from "@/cron/cron-types";
import type {
  DreamRunStatus,
  DreamTier,
  DreamTriggerSource,
} from "./dream-run-metadata";
import type { AgentRuntimeScope } from "./runtime-scope";

/**
 * F-06 dream commands and responses (M5-A).
 *
 * Kept in their own module so the pinned `protocol_v2.ts` only grows by the
 * union entries: every shape here is additive and local-first (the dream
 * subsystem has no hosted counterpart).
 */

/**
 * The dream summary `device_status` carries, so a client that renders the
 * status bar does not need a second round-trip for `dream_status`.
 */
export interface DreamDeviceSummary {
  enabled: boolean;
  /** The live run's id, or `null` when nothing is running for this agent. */
  runningRunId: string | null;
}

/** One running run, as the hidden-session header and `/dream status` show it. */
export interface DreamRunningRunSnapshot {
  runId: string;
  /** ms since epoch, written before the child process spawned. */
  startedAt: number;
  /** Tokens accounted so far (parent-side stream accounting). */
  spentTokens: number;
  /** `min(pressure * factor, maxPerRun)` for this run. */
  budgetTokens: number;
  /** Highest tier reached so far; `null` before the first tier completes. */
  tier: DreamTier | null;
}

/** The last finished run, for a client that does not read conversation rows. */
export interface DreamLastRunSnapshot {
  runId: string;
  status: DreamRunStatus;
  triggerSource: DreamTriggerSource;
  startedAt: number;
  endedAt: number | null;
}

export interface DreamStatusSnapshot {
  /** Master switch, resolved from global + per-agent settings. */
  enabled: boolean;
  /** `null` when no run is live for this agent. */
  running: DreamRunningRunSnapshot | null;
  /**
   * Earliest next automatic evaluation, ISO. `null` means no window/cooldown
   * pushed it; the signal source may still start a run on the next tick.
   */
  nextEligibleAt: string | null;
  lastRun: DreamLastRunSnapshot | null;
}

export interface DreamStatusCommand {
  type: "dream_status";
  request_id: string;
  runtime: AgentRuntimeScope;
}
export interface DreamStatusResponseMessage {
  type: "dream_status_response";
  request_id: string;
  success: boolean;
  status: DreamStatusSnapshot | null;
  error?: string;
}

export interface DreamRunCommand {
  type: "dream_run";
  request_id: string;
  runtime: AgentRuntimeScope;
  /** Only manual triggers are accepted over the wire (idle/scheduled own runs). */
  trigger?: "manual";
}
export interface DreamRunResponseMessage {
  type: "dream_run_response";
  request_id: string;
  success: boolean;
  /** `false` with a `reason` when the launcher declined (lock, settings, ...). */
  started: boolean;
  runId?: string;
  reason?: string;
  error?: string;
}

/** Every knob resolved (see `ResolvedDreamSettings`), plus the agent id. */
export interface DreamSettingsSnapshot {
  agent_id: string;
  enabled: boolean;
  permissionMode: PermissionTier;
  idleWindows: Array<{ start: string; end: string }>;
  silenceMinutes: number;
  pressureThreshold: number;
  budgetFactor: number;
  maxPerRun: number;
  maxPerDay: number | null;
  timeLimitMinutes: number | null;
  tiers: Record<DreamTier, boolean>;
  autoTrigger: boolean;
  overBudgetApprovals: number;
}

export interface GetDreamSettingsCommand {
  type: "get_dream_settings";
  request_id: string;
  runtime: AgentRuntimeScope;
}
export interface GetDreamSettingsResponseMessage {
  type: "get_dream_settings_response";
  request_id: string;
  success: boolean;
  settings: DreamSettingsSnapshot | null;
  error?: string;
}

/**
 * Patch shape: omitted keys keep their current resolved value. `enabled` and
 * the tier booleans are the two groups a desktop settings page writes; the
 * budget knobs stay patchable for completeness.
 */
export interface DreamSettingsPatch {
  enabled?: boolean;
  permissionMode?: PermissionTier;
  idleWindows?: Array<{ start: string; end: string }>;
  silenceMinutes?: number;
  pressureThreshold?: number;
  budgetFactor?: number;
  maxPerRun?: number;
  maxPerDay?: number | null;
  timeLimitMinutes?: number | null;
  tiers?: Partial<Record<DreamTier, boolean>>;
  autoTrigger?: boolean;
  overBudgetApprovals?: number;
}

export interface SetDreamSettingsCommand {
  type: "set_dream_settings";
  request_id: string;
  runtime: AgentRuntimeScope;
  settings: DreamSettingsPatch;
  /**
   * Which storage layer the patch writes. Dream has exactly two — the global
   * defaults (`dreamEnabled` / `dreamTiers` / ...) and this agent's override
   * map (`dreamSettingsByAgent`) — so the vocabulary is `global | agent`;
   * there is no project-local dream layer to name. Omitted = `global`, which
   * is what the TUI's `/dream on` and settings page write.
   */
  scope?: "global" | "agent";
}
export interface SetDreamSettingsResponseMessage {
  type: "set_dream_settings_response";
  request_id: string;
  success: boolean;
  settings: DreamSettingsSnapshot | null;
  error?: string;
}
