import type {
  CronPauseCommand,
  CronResumeCommand,
  CronTriggerCommand,
} from "@/types/schedule-protocol";

export function isCronTriggerCommand(
  value: unknown,
): value is CronTriggerCommand {
  if (!value || typeof value !== "object") return false;
  const command = value as {
    type?: unknown;
    request_id?: unknown;
    task_id?: unknown;
  };
  return (
    command.type === "cron_trigger" &&
    typeof command.request_id === "string" &&
    typeof command.task_id === "string"
  );
}

export function isCronPauseCommand(value: unknown): value is CronPauseCommand {
  if (!value || typeof value !== "object") return false;
  const command = value as {
    type?: unknown;
    request_id?: unknown;
    task_id?: unknown;
  };
  return (
    command.type === "cron_pause" &&
    typeof command.request_id === "string" &&
    typeof command.task_id === "string"
  );
}

export function isCronResumeCommand(
  value: unknown,
): value is CronResumeCommand {
  if (!value || typeof value !== "object") return false;
  const command = value as {
    type?: unknown;
    request_id?: unknown;
    task_id?: unknown;
    scheduled_for?: unknown;
  };
  return (
    command.type === "cron_resume" &&
    typeof command.request_id === "string" &&
    typeof command.task_id === "string" &&
    (command.scheduled_for === undefined ||
      typeof command.scheduled_for === "string")
  );
}

/**
 * F-05 additive field validation, shared by `cron_add` and `cron_update`.
 *
 * These live here rather than inline in `protocol-inbound.ts` (a pinned file)
 * so the two command validators cannot drift, and so the ratchet only grows by
 * the fields actually added.
 */
export function isCronTaskType(value: unknown): boolean {
  return (
    value === undefined ||
    value === "prompt" ||
    value === "command" ||
    value === "dream"
  );
}

export function isCronPermissionTier(value: unknown): boolean {
  return (
    value === undefined ||
    value === "standard" ||
    value === "acceptEdits" ||
    value === "unrestricted"
  );
}

export function isNonNegativeIntegerField(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "number" && Number.isInteger(value) && value >= 0)
  );
}

export function isCronTarget(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object") return false;
  const target = value as {
    kind?: unknown;
    hidden?: unknown;
    conversation_id?: unknown;
  };
  if (target.kind === "new") return typeof target.hidden === "boolean";
  if (target.kind === "existing") {
    return typeof target.conversation_id === "string";
  }
  return false;
}
