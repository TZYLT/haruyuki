import type { DreamNote } from "@/agent/dream/dream-notes";
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

// ── Dream notes: the queue's app-server entrance (F-06 §2.5) ─────────
//
// The queue is per-agent and lives in the harness home, never in the memory
// repository (design §2.2/§2.7), so every command carries the agent's runtime
// scope exactly like `dream_status` — there is no conversation write path and
// no hidden-conversation access here.

/**
 * One queued note. Re-exported from the queue's owner
 * (`agent/dream/dream-notes`) instead of re-declared: the wire carries the
 * stored shape, and a second definition would be a second truth. Type-only, so
 * nothing from the queue module reaches a browser bundle.
 */
export type { DreamNote };

/**
 * `dream_note_append`: leave a note for this agent's next dream run.
 *
 * `author` is always `user` on this path — the desktop is the user's own
 * entrance; the main agent's `DreamNote` tool and a run leaving a note for its
 * next self carry their own author values. The conversation id in `runtime`
 * becomes the note's `source.conversationId`.
 */
export interface DreamNoteAppendCommand {
  type: "dream_note_append";
  request_id: string;
  runtime: AgentRuntimeScope;
  /**
   * 1–2000 characters after trimming. An over-long note is refused with the
   * reason (never truncated) and answered `success: false`.
   */
  text: string;
}
export interface DreamNoteAppendResponseMessage {
  type: "dream_note_append_response";
  request_id: string;
  success: boolean;
  /** The queued note; `null` when the queue refused it (see `error`). */
  note: DreamNote | null;
  error?: string;
}

/** `dream_notes_list`: the agent's queue, oldest first. */
export interface DreamNotesListCommand {
  type: "dream_notes_list";
  request_id: string;
  runtime: AgentRuntimeScope;
}
export interface DreamNotesListResponseMessage {
  type: "dream_notes_list_response";
  request_id: string;
  success: boolean;
  /** Empty when the queue is empty; corrupt queue lines are skipped, not fatal. */
  notes: DreamNote[];
  error?: string;
}

/** `dream_note_remove`: drop one note the user no longer wants. */
export interface DreamNoteRemoveCommand {
  type: "dream_note_remove";
  request_id: string;
  runtime: AgentRuntimeScope;
  note_id: string;
}
export interface DreamNoteRemoveResponseMessage {
  type: "dream_note_remove_response";
  request_id: string;
  success: boolean;
  /**
   * `false` when no queued note has that id — not an error (it is already gone).
   * Named `deleted` rather than the design sketch's `removed` because the
   * outbound router's `RoutableMessage` already reserves `removed` for
   * `update_queue`'s removed-id list; a boolean there breaks frame routing.
   */
  deleted: boolean;
  error?: string;
}
