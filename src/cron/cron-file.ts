/**
 * Cron/schedule task creation and lifecycle (the CRUD facade).
 *
 * Storage lives in `cron-store` (file shape, migration, v2 view), locking and
 * leases in `cron-lease`, and the task types in `cron-types`. This module only
 * answers "what is on the schedule, and how does a task change state" — it must
 * stay a facade so the F-05 tracks can grow the core without touching it.
 */

import { randomBytes } from "node:crypto";
import { isLocalAgentId } from "@/agent/agent-id";
import { computeJitter } from "./cron-jitter";
import { hasLiveSchedulerOwner, withLock } from "./cron-lease";
import {
  getScheduleFileMtime,
  normalizeScheduleTask,
  readScheduleFile,
  writeScheduleFile,
} from "./cron-store";
import type {
  AddTaskInput,
  AddTaskResult,
  CronRunOutcome,
  CronTask,
  CronTaskStatus,
  RunOutcome,
  ScheduleFileData,
  TaskTarget,
  TaskType,
} from "./cron-types";
import { isValidCron } from "./parse-interval";

// ── Constants ───────────────────────────────────────────────────────

const MAX_ACTIVE_TASKS_PER_AGENT = 50;
const TASK_ID_BYTES = 4; // 8 hex chars
// Recurring tasks no longer auto-expire. They remain active until explicitly
// cancelled. GC still removes terminal tasks (fired, missed, cancelled) after 24h.
// One-shot tasks already use null for expires_at and are handled separately.
const GC_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

const TERMINAL_TASK_STATUSES = new Set<CronTaskStatus>([
  "fired",
  "missed",
  "cancelled",
]);

// ── Task ID ─────────────────────────────────────────────────────────

function generateTaskId(): string {
  return randomBytes(TASK_ID_BYTES).toString("hex");
}

function assertValidCronForPersistence(cron: string): void {
  if (!isValidCron(cron)) {
    throw new Error(
      `Invalid cron expression "${cron}". Schedule was not saved.`,
    );
  }
}

// ── CRUD ────────────────────────────────────────────────────────────

/**
 * Add a new cron task. Acquires the lock internally.
 */
export function addTask(input: AddTaskInput): AddTaskResult {
  return withLock(() => {
    const data = readScheduleFile();
    const agentId = input.agent_id;
    const taskType: TaskType = input.type ?? "prompt";
    // R-5.5.5: `target` is the explicit answer; `conversation_id` is the legacy
    // shape. Derive the missing one instead of always storing "new" (M0 F-09).
    const target: TaskTarget =
      input.target ??
      (input.conversation_id && input.conversation_id !== "new"
        ? { kind: "existing", conversation_id: input.conversation_id }
        : { kind: "new", hidden: false });
    const conversationId =
      target.kind === "new" ? "new" : target.conversation_id;
    if (input.target && input.conversation_id !== undefined) {
      const derived =
        input.target.kind === "new" ? "new" : input.target.conversation_id;
      if (derived !== input.conversation_id) {
        throw new Error(
          `target and conversation_id disagree: target resolves to "${derived}", conversation_id is "${input.conversation_id}".`,
        );
      }
    }
    // R-5.5.1: a `command` task runs on an existing conversation; it cannot ask
    // the scheduler to create one (M0 F-14).
    if (taskType === "command" && target.kind !== "existing") {
      throw new Error(
        "Command schedules must target an existing conversation: they cannot create a new one (R-5.5.1).",
      );
    }

    // Pausing a task must not let an agent exceed the persisted schedule limit.
    const scheduledCount = data.tasks.filter(
      (task) =>
        task.agent_id === agentId && !TERMINAL_TASK_STATUSES.has(task.status),
    ).length;
    // R-5.5.6 cancelled the hard per-agent cap: exceeding the soft limit is a
    // warning, not a refusal (M0 F-13).
    const capWarning =
      scheduledCount >= MAX_ACTIVE_TASKS_PER_AGENT
        ? `Agent ${agentId} already has ${scheduledCount} active or paused schedules (soft limit ${MAX_ACTIVE_TASKS_PER_AGENT}). Delete unused schedules to keep the list manageable.`
        : undefined;

    assertValidCronForPersistence(input.cron);

    const now = new Date();
    const taskId = generateTaskId();
    const timezone =
      input.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

    const task: CronTask = normalizeScheduleTask({
      id: taskId,
      agent_id: agentId,
      conversation_id: conversationId,
      name: input.name,
      description: input.description,
      cron: input.cron,
      timezone,
      recurring: input.recurring,
      prompt: input.prompt,
      // F-05 v2 fields: `undefined` is left to `normalizeScheduleTask`, which
      // fills every one of them with the documented default (Q-53).
      type: taskType,
      payload: input.payload,
      target,
      permission: input.permission,
      catch_up: input.catch_up,
      timeout_minutes: input.timeout_minutes,
      wait_minutes: input.wait_minutes,
      status: "active",
      created_at: now.toISOString(),
      // Recurring tasks do not auto-expire (expires_at: null)
      // One-shot tasks also use null (handled by scheduled_for)
      expires_at: null,
      last_fired_at: null,
      fire_count: 0,
      cancel_reason: null,
      jitter_offset_ms: computeJitter(
        taskId,
        input.cron,
        input.recurring,
        input.scheduled_for ?? null,
        now,
      ),
      last_run_at: null,
      last_run_outcome: null,
      last_run_reason: null,
      last_run_error: null,
      last_missed_at: null,
      missed_count: 0,
      failed_count: 0,
      scheduled_for: input.scheduled_for?.toISOString() ?? null,
      fired_at: null,
      missed_at: null,
    });

    data.tasks.push(task);
    writeScheduleFile(data);

    // A mixed-version tombstone in scheduler_owner does not count as an
    // all-agent lease — only a real all-lease or the matching scoped owner
    // suppresses the warning. The wording covers both hosts: a live TUI or
    // listener, or the OS-woken short-lived host when autostart is registered.
    const notes: string[] = [];
    if (capWarning) notes.push(capWarning);
    if (
      !hasLiveSchedulerOwner(
        data,
        isLocalAgentId(input.agent_id) ? "local" : "cloud",
      )
    ) {
      notes.push(
        "No schedule host is running right now. This task runs while a TUI or listener is active, or when the OS-woken `haruyuki schedule tick` fires (register it with `/schedule autostart on`).",
      );
    }
    const warning = notes.length > 0 ? notes.join(" ") : undefined;

    return { task, warning };
  });
}

/**
 * List tasks, optionally filtered by agent and/or conversation.
 */
export function listTasks(filters?: {
  agent_id?: string;
  conversation_id?: string;
}): CronTask[] {
  const data = readScheduleFile();
  let tasks = data.tasks;
  if (filters?.agent_id) {
    tasks = tasks.filter((t) => t.agent_id === filters.agent_id);
  }
  if (filters?.conversation_id) {
    tasks = tasks.filter((t) => t.conversation_id === filters.conversation_id);
  }
  return tasks;
}

/**
 * Get a single task by ID.
 */
export function getTask(taskId: string): CronTask | null {
  const data = readScheduleFile();
  return data.tasks.find((t) => t.id === taskId) ?? null;
}

/**
 * Delete a task by ID. Physical removal from the file.
 * Acquires the lock internally.
 * Returns true if found and removed, false if not found.
 */
export function deleteTask(taskId: string): boolean {
  return withLock(() => {
    const data = readScheduleFile();
    const idx = data.tasks.findIndex((t) => t.id === taskId);
    if (idx === -1) return false;
    data.tasks.splice(idx, 1);
    writeScheduleFile(data);
    return true;
  });
}

/**
 * Delete all tasks for a given agent. Physical removal.
 * Acquires the lock internally.
 * Returns the number of tasks removed.
 */
export function deleteAllTasks(agentId: string): number {
  return withLock(() => {
    const data = readScheduleFile();
    const before = data.tasks.length;
    data.tasks = data.tasks.filter((t) => t.agent_id !== agentId);
    const removed = before - data.tasks.length;
    if (removed > 0) writeScheduleFile(data);
    return removed;
  });
}

// ── Task state updates (used by scheduler) ──────────────────────────

/**
 * Update task state atomically. Acquires the lock.
 * Callback receives the task and can mutate it in-place.
 * Returns the updated task, or null if not found.
 */
export function updateTask(
  taskId: string,
  updater: (task: CronTask) => void,
): CronTask | null {
  return withLock(() => {
    const data: ScheduleFileData = readScheduleFile();
    const task = data.tasks.find((t) => t.id === taskId);
    if (!task) return null;
    const originalCron = task.cron;
    updater(task);
    const cronChanged = task.cron !== originalCron;
    if (cronChanged) assertValidCronForPersistence(task.cron);
    if (cronChanged && task.last_run_reason === "invalid_cron") {
      task.last_run_at = null;
      task.last_run_outcome = null;
      task.last_run_reason = null;
      task.last_run_error = null;
    }
    writeScheduleFile(data);
    return { ...task };
  });
}

export function recordTaskQueued(
  taskId: string,
  trigger: "automatic" | "manual",
  queuedAt: Date,
): CronTask | null {
  return updateTask(taskId, (task) => {
    const queuedAtIso = queuedAt.toISOString();
    if (trigger === "automatic" && !task.recurring) {
      task.status = "fired";
      task.fired_at = queuedAtIso;
    }
    task.last_fired_at = queuedAtIso;
    task.fire_count += 1;
    task.last_run_at = queuedAtIso;
    task.last_run_outcome = "queued";
    task.last_run_reason = task.recurring
      ? "scheduled_time_matched"
      : "one_off_due";
    task.last_run_error = null;
  });
}

export interface CronStateChangeResult {
  success: boolean;
  found: boolean;
  task?: CronTask;
  error?: string;
}

/** Pause an active task atomically. Repeated pauses are successful no-ops. */
export function pauseTask(taskId: string): CronStateChangeResult {
  return withLock(() => {
    const data = readScheduleFile();
    const task = data.tasks.find((candidate) => candidate.id === taskId);
    if (!task) {
      return { success: false, found: false, error: "Schedule not found" };
    }
    if (task.status === "paused") {
      return { success: true, found: true, task: { ...task } };
    }
    if (task.status !== "active") {
      return {
        success: false,
        found: true,
        task: { ...task },
        error: "Completed schedules cannot be paused",
      };
    }

    task.status = "paused";
    task.paused_reason = "manual";
    writeScheduleFile(data);
    return { success: true, found: true, task: { ...task } };
  });
}

/**
 * Resume a paused task atomically. An overdue one-off requires a replacement
 * future timestamp in the same operation. Repeated resumes are no-ops.
 */
export function resumeTask(
  taskId: string,
  scheduledFor?: Date,
  now = new Date(),
): CronStateChangeResult {
  return withLock(() => {
    const data = readScheduleFile();
    const task = data.tasks.find((candidate) => candidate.id === taskId);
    if (!task) {
      return { success: false, found: false, error: "Schedule not found" };
    }
    if (task.status === "active") {
      return { success: true, found: true, task: { ...task } };
    }
    if (task.status !== "paused") {
      return {
        success: false,
        found: true,
        task: { ...task },
        error: "Completed schedules cannot be resumed",
      };
    }

    if (!task.recurring) {
      const resumeAt =
        scheduledFor ??
        (task.scheduled_for ? new Date(task.scheduled_for) : null);
      if (!resumeAt || Number.isNaN(resumeAt.getTime())) {
        return {
          success: false,
          found: true,
          task: { ...task },
          error: "A one-off schedule requires a valid scheduled_for timestamp",
        };
      }
      if (resumeAt.getTime() <= now.getTime()) {
        return {
          success: false,
          found: true,
          task: { ...task },
          error:
            "An overdue one-off schedule requires a new future scheduled_for timestamp",
        };
      }
      if (scheduledFor) {
        task.scheduled_for = scheduledFor.toISOString();
        task.jitter_offset_ms = computeJitter(
          task.id,
          task.cron,
          false,
          scheduledFor,
          new Date(task.created_at),
        );
      }
    }

    task.status = "active";
    // R-5.9.4: a manual resume clears the failure streak and the pause reason.
    task.paused_reason = null;
    task.consecutive_failures = 0;
    writeScheduleFile(data);
    return { success: true, found: true, task: { ...task } };
  });
}

// ── Garbage collection ──────────────────────────────────────────────

/**
 * Remove terminal tasks (fired, missed, cancelled) older than 24 hours.
 * Acquires the lock. Returns the number of tasks removed.
 */
export function garbageCollect(): number {
  return withLock(() => {
    const data = readScheduleFile();
    const cutoff = Date.now() - GC_AGE_MS;
    const before = data.tasks.length;

    data.tasks = data.tasks.filter((t) => {
      // Keep active, paused, and status values written by newer versions. Only
      // the known terminal states are eligible for collection.
      if (!TERMINAL_TASK_STATUSES.has(t.status)) return true;
      const createdAt = new Date(t.created_at).getTime();
      // Use the most recent timestamp for GC age
      const terminalAt = Math.max(
        t.last_fired_at ? new Date(t.last_fired_at).getTime() : 0,
        t.fired_at ? new Date(t.fired_at).getTime() : 0,
        t.missed_at ? new Date(t.missed_at).getTime() : 0,
        createdAt,
      );
      return terminalAt > cutoff;
    });

    const removed = before - data.tasks.length;
    if (removed > 0) writeScheduleFile(data);
    return removed;
  });
}

// ── Get active tasks (for scheduler) ────────────────────────────────

/**
 * Read the store and return only active tasks.
 * Does NOT acquire the lock (read-only operation).
 */
export function getActiveTasks(): CronTask[] {
  const data = readScheduleFile();
  return data.tasks.filter((t) => t.status === "active");
}

/** Store mtime, for the scheduler's change detection. */
export { getScheduleFileMtime };

// ── G-4: the persisted outcome vocabulary ───────────────────────────

/**
 * Map an F-05 terminal outcome onto the persisted `last_run_outcome` enum.
 *
 * The old enum predates F-05 and only knows `queued` / `missed` / `failed` /
 * `skipped`, so three of the five v2 outcomes have no truthful legacy value:
 *
 * | v2          | legacy     | why                                        |
 * |-------------|------------|--------------------------------------------|
 * | `success`   | `null`     | the old enum had no success value at all   |
 * | `failed`    | `failed`   | same meaning                               |
 * | `skipped`   | `skipped`  | same meaning (F3)                          |
 * | `timeout`   | `failed`   | a timeout is an F2 failure for the streak  |
 * | `cancelled` | `null`     | neither a failure nor a skip; user did it  |
 *
 * `null` means "write nothing": the run log's `runOutcome` is the authority for
 * these runs, and inventing `failed` for a success would pause healthy tasks
 * after three runs (R-5.9.3). The enum itself is not extended — the existing
 * tests and the CLI's JSON shape pin it (C-3).
 */
export function legacyRunOutcomeFor(
  outcome: RunOutcome,
): CronRunOutcome | null {
  switch (outcome) {
    case "success":
    case "cancelled":
      return null;
    case "failed":
    case "timeout":
      return "failed";
    case "skipped":
      return "skipped";
  }
}
