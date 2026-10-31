import type {
  PermissionTier,
  RunOutcome,
  TaskTarget,
  TaskType,
} from "@/cron/cron-types";

export type CronTaskStatus =
  | "active"
  | "paused"
  | "fired"
  | "missed"
  | "cancelled";
export type CronCancelReason = "conversation_not_found" | "expired";
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

export interface CronListCommand {
  type: "cron_list";
  request_id: string;
  agent_id?: string;
  conversation_id?: string;
}

export interface CronAddCommand {
  type: "cron_add";
  request_id: string;
  agent_id: string;
  conversation_id?: string;
  name: string;
  description: string;
  cron: string;
  timezone?: string;
  recurring: boolean;
  prompt: string;
  scheduled_for?: string | null;
  /**
   * Task body kind (F-05 R-5.5.1). Spelled `task_type` on the wire because the
   * command's own `type` is the protocol discriminant; the response's `CronTask`
   * keeps the F-05 field name `type`.
   */
  task_type?: TaskType;
  /** Command string for `command` tasks; mirrors `prompt` for `prompt` tasks. */
  payload?: string;
  /** Explicit target (R-5.5.5); derived from `conversation_id` when omitted. */
  target?: TaskTarget;
  /** Execution permission tier (Q-50). Default `unrestricted` (Q-53). */
  permission?: PermissionTier;
  /** Retry the most recent missed occurrence (Q-11). Default false. */
  catch_up?: boolean;
  /** Per-run timeout in minutes; `0` means unlimited (Q-26). Default 30. */
  timeout_minutes?: number;
  /** How long to wait for a busy target conversation (Q-25). Default 10. */
  wait_minutes?: number;
}

export interface CronGetCommand {
  type: "cron_get";
  request_id: string;
  task_id: string;
}

export interface CronRunsCommand {
  type: "cron_runs";
  request_id: string;
  task_id: string;
  limit?: number;
  offset?: number;
  run_id?: string;
}

export interface CronTriggerCommand {
  type: "cron_trigger";
  request_id: string;
  task_id: string;
}

export interface CronPauseCommand {
  type: "cron_pause";
  request_id: string;
  task_id: string;
}

export interface CronResumeCommand {
  type: "cron_resume";
  request_id: string;
  task_id: string;
  /** Required when resuming an overdue one-off schedule. */
  scheduled_for?: string;
}

export interface CronUpdateCommand {
  type: "cron_update";
  request_id: string;
  task_id: string;
  name?: string;
  description?: string;
  conversation_id?: string;
  cron?: string;
  timezone?: string;
  recurring?: boolean;
  prompt?: string;
  scheduled_for?: string | null;
  /** Task body kind; see `CronAddCommand.task_type` for the wire name. */
  task_type?: TaskType;
  /** Command string for `command` tasks; mirrors `prompt` for `prompt` tasks. */
  payload?: string;
  /** Explicit target; kept coherent with `conversation_id` by the handler. */
  target?: TaskTarget;
  /** Execution permission tier (Q-50). */
  permission?: PermissionTier;
  /** Retry the most recent missed occurrence (Q-11). */
  catch_up?: boolean;
  /** Per-run timeout in minutes; `0` means unlimited (Q-26). */
  timeout_minutes?: number;
  /** How long to wait for a busy target conversation (Q-25). */
  wait_minutes?: number;
}

export interface CronDeleteCommand {
  type: "cron_delete";
  request_id: string;
  task_id: string;
}

export interface CronDeleteAllCommand {
  type: "cron_delete_all";
  request_id: string;
  agent_id: string;
}

export type CronProtocolCommand =
  | CronListCommand
  | CronAddCommand
  | CronGetCommand
  | CronRunsCommand
  | CronTriggerCommand
  | CronPauseCommand
  | CronResumeCommand
  | CronUpdateCommand
  | CronDeleteCommand
  | CronDeleteAllCommand;

export interface CronTask {
  id: string;
  agent_id: string;
  conversation_id: string;
  name: string;
  description: string;
  cron: string;
  timezone: string;
  recurring: boolean;
  prompt: string;
  status: CronTaskStatus;
  created_at: string;
  expires_at: string | null;
  last_fired_at: string | null;
  fire_count: number;
  cancel_reason: CronCancelReason | null;
  jitter_offset_ms: number;
  last_run_at: string | null;
  last_run_outcome: CronRunOutcome | null;
  last_run_reason: CronRunReason | null;
  last_run_error: string | null;
  last_missed_at: string | null;
  missed_count: number;
  failed_count: number;
  scheduled_for: string | null;
  fired_at: string | null;
  missed_at: string | null;
  // ── F-05 fields (optional on the wire; shapes mirror `cron-types.CronTask`) ──
  /** `prompt` (default), `command`, or `dream` (F-06). */
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
  /** Why the task is paused; null while it is not (R-5.5.2). */
  paused_reason?: "manual" | "auto_failures" | null;
  /** F-05 terminal outcome beside the legacy enum (F-18). */
  last_outcome_v2?: RunOutcome | null;
  /** F-05 terminal reason for `last_outcome_v2`; free-form by design. */
  last_run_reason_v2?: string | null;
}

export interface CronListResponseMessage {
  type: "cron_list_response";
  request_id: string;
  tasks: CronTask[];
  success: boolean;
  error?: string;
}

export interface CronAddResponseMessage {
  type: "cron_add_response";
  request_id: string;
  success: boolean;
  task?: CronTask;
  warning?: string;
  error?: string;
}

export interface CronGetResponseMessage {
  type: "cron_get_response";
  request_id: string;
  success: boolean;
  found: boolean;
  task: CronTask | null;
  error?: string;
}

export interface CronRunsResponseMessage {
  type: "cron_runs_response";
  request_id: string;
  success: boolean;
  page?: CronRunLogPage;
  error?: string;
}

export interface CronTriggerResponseMessage {
  type: "cron_trigger_response";
  request_id: string;
  success: boolean;
  found: boolean;
  task?: CronTask;
  error?: string;
}

export interface CronUpdateResponseMessage {
  type: "cron_update_response";
  request_id: string;
  success: boolean;
  task?: CronTask;
  error?: string;
}

export interface CronPauseResponseMessage {
  type: "cron_pause_response";
  request_id: string;
  success: boolean;
  found: boolean;
  task?: CronTask;
  error?: string;
}

export interface CronResumeResponseMessage {
  type: "cron_resume_response";
  request_id: string;
  success: boolean;
  found: boolean;
  task?: CronTask;
  error?: string;
}

export interface CronDeleteResponseMessage {
  type: "cron_delete_response";
  request_id: string;
  success: boolean;
  found: boolean;
  error?: string;
}

export interface CronDeleteAllResponseMessage {
  type: "cron_delete_all_response";
  request_id: string;
  success: boolean;
  agent_id: string;
  deleted: number;
  error?: string;
}

export type CronProtocolResponseMessage =
  | CronListResponseMessage
  | CronAddResponseMessage
  | CronGetResponseMessage
  | CronRunsResponseMessage
  | CronTriggerResponseMessage
  | CronPauseResponseMessage
  | CronResumeResponseMessage
  | CronUpdateResponseMessage
  | CronDeleteResponseMessage
  | CronDeleteAllResponseMessage;

export type CronRunLogStatus = "ok" | "error" | "skipped";

export interface CronRunLogEntry {
  ts: number;
  jobId: string;
  action: "finished";
  status?: CronRunLogStatus;
  outcome?: CronRunOutcome;
  reason?: CronRunReason;
  error?: string;
  summary?: string;
  agentId?: string;
  conversationId?: string;
  runId?: string;
  runAtMs?: number;
  queueItemId?: string;
  scheduledFor?: string | null;
  firedAt?: string;
}

export interface CronRunLogPage {
  entries: CronRunLogEntry[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  nextOffset: number | null;
}
