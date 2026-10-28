/**
 * Schedule types (F-05).
 *
 * Two shapes live here on purpose, and they are not interchangeable:
 *
 * - `CronTask` is the **persisted record** written to `schedules.json`. It keeps
 *   the historical snake_case field names so the existing CRUD facade, the CLI,
 *   the `wake` tool and every existing test keep their meaning; the F-05 fields
 *   are appended on top and defaulted by `cron-store`'s normalizer.
 * - `ScheduleTaskV2` is the **frozen in-memory view** the scheduler core, the
 *   task runners and the TUI consume (camelCase, per the F-05 route §2.3).
 *
 * `cron-store` owns the conversion in both directions. Nothing else may
 * hand-roll it — that is the single seam the three P1 tracks share.
 */

// ── Persisted record (v1 names + v2 fields) ─────────────────────────

export type CronTaskStatus =
  | "active"
  | "paused"
  | "fired"
  | "missed"
  | "cancelled";
export type CancelReason = "conversation_not_found" | "expired";
export type CronRunOutcome = "queued" | "missed" | "failed" | "skipped";
export type CronRunReason =
  | "scheduled_time_matched"
  | "one_off_due"
  | "scheduler_inactive"
  | "started_too_late"
  | "queue_full"
  | "runtime_unavailable"
  | "task_cancelled"
  | "invalid_cron"
  | "scheduler_error";

export interface SchedulerOwner {
  pid: number;
  token: string;
  started_at: string; // ISO
  process_start_ticks?: string | null;
  boot_id?: string | null;
}

export type CronSchedulerScope = "all" | "cloud" | "local";

export interface CronTask {
  // Identity
  id: string;
  agent_id: string;
  /**
   * Conversation target for scheduled fires.
   * - "default" (default): enqueue into the agent's default conversation
   * - "new": create a fresh conversation for every fire
   * - any other string: enqueue into that existing conversation id
   */
  conversation_id: string;

  // Metadata
  name: string;
  description: string;

  // Schedule
  cron: string;
  timezone: string; // IANA
  recurring: boolean;

  // Content
  prompt: string;

  // Lifecycle
  status: CronTaskStatus;
  created_at: string; // ISO
  expires_at: string | null; // null for all tasks now (no auto-expiry)
  last_fired_at: string | null;
  fire_count: number;
  cancel_reason: CancelReason | null;
  jitter_offset_ms: number;

  // Last run outcome summary (for table/status display without reading logs)
  last_run_at: string | null;
  last_run_outcome: CronRunOutcome | null;
  last_run_reason: CronRunReason | null;
  last_run_error: string | null;
  last_missed_at: string | null;
  missed_count: number;
  failed_count: number;

  // One-shot specific
  scheduled_for: string | null; // ISO UTC
  fired_at: string | null;
  missed_at: string | null;

  // ── F-05 fields (added by the v2 store; all optional in the record) ──
  /** `prompt` (default) or `command`. */
  type?: TaskType;
  /** Command string for `command` tasks; mirrors `prompt` for `prompt` tasks. */
  payload?: string;
  /** Resolved target; derived from `conversation_id` when absent. */
  target?: TaskTarget;
  /** Execution permission tier (Q-50). Default `unrestricted` (Q-53). */
  permission?: PermissionTier;
  /** Retry the most recent missed occurrence (Q-11). Default false. */
  catch_up?: boolean;
  /** Per-run timeout in minutes; `0` means unlimited (Q-26). Default 30. */
  timeout_minutes?: number;
  /** How long to wait for a busy target conversation (Q-25). Default 10. */
  wait_minutes?: number;
  /** Task-level execution lease (§5.6). Empty when not running. */
  lease?: TaskLease | null;
  /** Last consumed occurrence — the de-dup key (R-5.4.2, R-5.5.2). */
  last_consumed_occurrence?: string | null;
  /** Consecutive F1/F2 failures; F3 does not count (R-5.9.3). */
  consecutive_failures?: number;
  /** Why the task is paused; null while it is not (R-5.5.2). */
  paused_reason?: "manual" | "auto_failures" | null;
}

// ── CRUD input/result (export surface of `cron-file`) ───────────────

export interface AddTaskInput {
  agent_id: string;
  /**
   * Conversation target for scheduled fires.
   * - omitted/"new": fresh conversation per fire
   * - "default": agent default conversation
   * - any other string: existing conversation id
   */
  conversation_id?: string;
  name: string;
  description: string;
  cron: string;
  timezone?: string;
  recurring: boolean;
  prompt: string;
  scheduled_for?: Date; // for one-shots
}

export interface AddTaskResult {
  task: CronTask;
  warning?: string;
}

// ── Frozen F-05 interface (M0 freeze; changes go through the Lead) ──

/** Execution permission tier (Q-50). Maps onto the existing `PermissionMode`. */
export type PermissionTier = "standard" | "acceptEdits" | "unrestricted";

export type TaskType = "prompt" | "command";

export type RunOutcome =
  | "success"
  | "failed"
  | "skipped"
  | "timeout"
  | "cancelled";

/** F1 = pre-start failure, F2 = mid-run failure, null = not counted. */
export type FailureClass = "F1" | "F2" | null;

export type TaskTarget =
  | { kind: "new"; hidden: boolean }
  | { kind: "existing"; conversation_id: string }; // must be non-hidden

export interface TaskLease {
  runId: string;
  host: "long-lived" | "short-lived";
  pid: number;
  token: string;
  startedAt: string;
  heartbeatAt: string;
  expiresAt: string;
}

export interface ScheduleTaskV2 {
  id: string;
  agentId: string;
  name: string;
  description: string;
  type: TaskType;
  target: TaskTarget;
  payload: string;
  cron: string;
  timezone: string;
  recurring: boolean;
  scheduledFor: string | null;
  catchUp: boolean;
  permission: PermissionTier;
  timeoutMinutes: number;
  waitMinutes: number;
  status: CronTaskStatus;
  pausedReason: "manual" | "auto_failures" | null;
  createdAt: string;
  lastFiredAt: string | null;
  fireCount: number;
  lastRunAt: string | null;
  lastOutcome: RunOutcome | null;
  lastReason: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  missedCount: number;
  failedCount: number;
  lastConsumedOccurrence: string | null;
  lease: TaskLease | null;
  jitterOffsetMs: number;
  firedAt: string | null;
  missedAt: string | null;
}

// ── Signal sources ─────────────────────────────────────────────────

export interface DueOccurrence {
  taskId: string;
  occurrence: string;
  intendedAt: string;
}

/** Per-signal-source cursor, persisted alongside the tasks. */
export interface SignalState {
  /** signal source id → opaque cursor owned by that source. */
  cursor: Record<string, string>;
}

export interface SignalSource {
  id: string;
  evaluate(input: {
    now: Date;
    tasks: ScheduleTaskV2[];
    state: SignalState;
  }): DueOccurrence[];
  nextDueAt(input: { now: Date; tasks: ScheduleTaskV2[] }): Date | null;
}

// ── Host seam ──────────────────────────────────────────────────────

/** The only seam between the scheduler core and a host (M1↔M2). */
export interface TaskRunnerPort {
  host: "long-lived" | "short-lived";
  run(input: {
    task: ScheduleTaskV2;
    runId: string;
    occurrence: string;
    signal: AbortSignal;
  }): Promise<{
    outcome: RunOutcome;
    conversationId?: string;
    error?: string;
  }>;
  cancel(runId: string): void;
}

export interface AutostartStatus {
  registered: boolean;
  platform: "win32" | "darwin" | "linux";
  method: "schtasks" | "launchd" | "systemd-user" | "crontab" | null;
  launcherPath?: string;
  error?: string;
}

// ── Persisted file shape ───────────────────────────────────────────

export const SCHEDULE_FILE_VERSION = 2;

export interface ScheduleFileData {
  version: typeof SCHEDULE_FILE_VERSION;
  scheduler_owner: SchedulerOwner | null;
  scheduler_owners: Partial<
    Record<Exclude<CronSchedulerScope, "all">, SchedulerOwner>
  >;
  signal_state: SignalState;
  tasks: CronTask[];
}

// ── Defaults ───────────────────────────────────────────────────────

/** Legacy and `wake`-created tasks keep the old behaviour (Q-53). */
export const DEFAULT_PERMISSION_TIER: PermissionTier = "unrestricted";
/** R-5.5.2 default, `0` means unlimited. */
export const DEFAULT_TIMEOUT_MINUTES = 30;
/** R-5.7.3 default wait for a busy target conversation. */
export const DEFAULT_WAIT_MINUTES = 10;
/** Task lease heartbeat / expiry (R-5.6.1). */
export const TASK_LEASE_HEARTBEAT_MS = 30_000;
export const TASK_LEASE_TTL_MS = 90_000;
