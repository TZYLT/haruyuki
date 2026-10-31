import type WebSocket from "ws";
import {
  addTask as addCronTask,
  deleteAllTasks as deleteAllCronTasks,
  deleteTask as deleteCronTask,
  getCronRunLogPath,
  getTask as getCronTask,
  listTasks as listCronTasks,
  pauseTask as pauseCronTask,
  readCronRunLogEntriesPage,
  resumeTask as resumeCronTask,
  updateTask as updateCronTask,
} from "@/cron";
import { runCronTaskNow } from "@/cron/scheduler";
import type {
  CronAddCommand,
  CronDeleteAllCommand,
  CronDeleteCommand,
  CronGetCommand,
  CronListCommand,
  CronPauseCommand,
  CronResumeCommand,
  CronRunsCommand,
  CronTriggerCommand,
  CronUpdateCommand,
} from "@/types/protocol_v2";
import {
  isCronPauseCommand,
  isCronResumeCommand,
  isCronTriggerCommand,
} from "@/websocket/listener/cron-protocol-inbound";
import {
  isCronAddCommand,
  isCronDeleteAllCommand,
  isCronDeleteCommand,
  isCronGetCommand,
  isCronListCommand,
  isCronRunsCommand,
  isCronUpdateCommand,
} from "@/websocket/listener/protocol-inbound";
import type { RunDetachedListenerTask, SafeSocketSend } from "./types";

export type CronCommand =
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

type CronCommandContext = {
  socket: WebSocket;
  safeSocketSend: SafeSocketSend;
  runDetachedListenerTask: RunDetachedListenerTask;
};

function emitCronsUpdated(
  socket: WebSocket,
  safeSocketSend: SafeSocketSend,
  scope?: { agent_id?: string; conversation_id?: string | null },
): void {
  safeSocketSend(
    socket,
    {
      type: "crons_updated",
      timestamp: Date.now(),
      ...(scope?.agent_id ? { agent_id: scope.agent_id } : {}),
      ...(scope?.conversation_id !== undefined
        ? { conversation_id: scope.conversation_id }
        : {}),
    },
    "listener_cron_send_failed",
    "listener_cron_command",
  );
}

export async function handleCronCommand(
  parsed: CronCommand,
  socket: WebSocket,
  safeSocketSend: SafeSocketSend,
): Promise<boolean> {
  if (parsed.type === "cron_list") {
    try {
      const tasks = listCronTasks({
        agent_id: parsed.agent_id,
        conversation_id: parsed.conversation_id,
      });
      safeSocketSend(
        socket,
        {
          type: "cron_list_response",
          request_id: parsed.request_id,
          tasks,
          success: true,
        },
        "listener_cron_send_failed",
        "listener_cron_command",
      );
    } catch (err) {
      safeSocketSend(
        socket,
        {
          type: "cron_list_response",
          request_id: parsed.request_id,
          tasks: [],
          success: false,
          error: err instanceof Error ? err.message : "Failed to list crons",
        },
        "listener_cron_send_failed",
        "listener_cron_command",
      );
    }
    return true;
  }

  if (parsed.type === "cron_add") {
    try {
      const scheduledFor = parsed.scheduled_for
        ? new Date(parsed.scheduled_for)
        : undefined;
      if (scheduledFor && Number.isNaN(scheduledFor.getTime())) {
        throw new Error("Invalid scheduled_for timestamp");
      }
      const result = addCronTask({
        agent_id: parsed.agent_id,
        conversation_id: parsed.conversation_id,
        name: parsed.name,
        description: parsed.description,
        cron: parsed.cron,
        timezone: parsed.timezone,
        recurring: parsed.recurring,
        prompt: parsed.prompt,
        scheduled_for: scheduledFor,
        // F-05 additive fields: `undefined` keeps the store defaults, so a
        // prompt-only client still creates exactly the task it did before.
        type: parsed.task_type,
        payload: parsed.payload,
        target: parsed.target,
        permission: parsed.permission,
        catch_up: parsed.catch_up,
        timeout_minutes: parsed.timeout_minutes,
        wait_minutes: parsed.wait_minutes,
      });
      safeSocketSend(
        socket,
        {
          type: "cron_add_response",
          request_id: parsed.request_id,
          success: true,
          task: result.task,
          ...(result.warning ? { warning: result.warning } : {}),
        },
        "listener_cron_send_failed",
        "listener_cron_command",
      );
      emitCronsUpdated(socket, safeSocketSend, {
        agent_id: result.task.agent_id,
        conversation_id: result.task.conversation_id,
      });
    } catch (err) {
      safeSocketSend(
        socket,
        {
          type: "cron_add_response",
          request_id: parsed.request_id,
          success: false,
          error: err instanceof Error ? err.message : "Failed to add cron",
        },
        "listener_cron_send_failed",
        "listener_cron_command",
      );
    }
    return true;
  }

  if (parsed.type === "cron_get") {
    try {
      const task = getCronTask(parsed.task_id);
      safeSocketSend(
        socket,
        {
          type: "cron_get_response",
          request_id: parsed.request_id,
          success: true,
          found: task !== null,
          task,
        },
        "listener_cron_send_failed",
        "listener_cron_command",
      );
    } catch (err) {
      safeSocketSend(
        socket,
        {
          type: "cron_get_response",
          request_id: parsed.request_id,
          success: false,
          found: false,
          task: null,
          error: err instanceof Error ? err.message : "Failed to get cron",
        },
        "listener_cron_send_failed",
        "listener_cron_command",
      );
    }
    return true;
  }

  if (parsed.type === "cron_runs") {
    try {
      const page = readCronRunLogEntriesPage(
        getCronRunLogPath(parsed.task_id),
        {
          jobId: parsed.task_id,
          limit: parsed.limit,
          offset: parsed.offset,
          runId: parsed.run_id,
        },
      );
      safeSocketSend(
        socket,
        {
          type: "cron_runs_response",
          request_id: parsed.request_id,
          success: true,
          page,
        },
        "listener_cron_send_failed",
        "listener_cron_command",
      );
    } catch (err) {
      safeSocketSend(
        socket,
        {
          type: "cron_runs_response",
          request_id: parsed.request_id,
          success: false,
          error:
            err instanceof Error
              ? err.message
              : "Failed to list cron run history",
        },
        "listener_cron_send_failed",
        "listener_cron_command",
      );
    }
    return true;
  }

  if (parsed.type === "cron_trigger") {
    try {
      const result = await runCronTaskNow(parsed.task_id);
      safeSocketSend(
        socket,
        {
          type: "cron_trigger_response",
          request_id: parsed.request_id,
          success: result.success,
          found: result.found,
          ...(result.task ? { task: result.task } : {}),
          ...(result.error ? { error: result.error } : {}),
        },
        "listener_cron_send_failed",
        "listener_cron_command",
      );
    } catch (err) {
      safeSocketSend(
        socket,
        {
          type: "cron_trigger_response",
          request_id: parsed.request_id,
          success: false,
          found: false,
          error: err instanceof Error ? err.message : "Failed to trigger cron",
        },
        "listener_cron_send_failed",
        "listener_cron_command",
      );
    }
    return true;
  }

  if (parsed.type === "cron_pause" || parsed.type === "cron_resume") {
    const responseType =
      parsed.type === "cron_pause"
        ? ("cron_pause_response" as const)
        : ("cron_resume_response" as const);
    try {
      let scheduledFor: Date | undefined;
      if (parsed.type === "cron_resume" && parsed.scheduled_for !== undefined) {
        scheduledFor = new Date(parsed.scheduled_for);
        if (Number.isNaN(scheduledFor.getTime())) {
          throw new Error("Invalid scheduled_for timestamp");
        }
      }
      const result =
        parsed.type === "cron_pause"
          ? pauseCronTask(parsed.task_id)
          : resumeCronTask(parsed.task_id, scheduledFor);
      safeSocketSend(
        socket,
        {
          type: responseType,
          request_id: parsed.request_id,
          success: result.success,
          found: result.found,
          ...(result.task ? { task: result.task } : {}),
          ...(result.error ? { error: result.error } : {}),
        },
        "listener_cron_send_failed",
        "listener_cron_command",
      );
      if (result.success && result.task) {
        emitCronsUpdated(socket, safeSocketSend, {
          agent_id: result.task.agent_id,
          conversation_id: result.task.conversation_id,
        });
      }
    } catch (err) {
      safeSocketSend(
        socket,
        {
          type: responseType,
          request_id: parsed.request_id,
          success: false,
          found: getCronTask(parsed.task_id) !== null,
          error:
            err instanceof Error
              ? err.message
              : `Failed to ${parsed.type === "cron_pause" ? "pause" : "resume"} cron`,
        },
        "listener_cron_send_failed",
        "listener_cron_command",
      );
    }
    return true;
  }

  if (parsed.type === "cron_update") {
    try {
      let scheduledForIso: string | null | undefined;
      if (parsed.scheduled_for === null) {
        scheduledForIso = null;
      } else if (parsed.scheduled_for !== undefined) {
        const scheduledFor = new Date(parsed.scheduled_for);
        if (Number.isNaN(scheduledFor.getTime())) {
          throw new Error("Invalid scheduled_for timestamp");
        }
        scheduledForIso = scheduledFor.toISOString();
      }
      const task = updateCronTask(parsed.task_id, (current) => {
        if (parsed.name !== undefined) current.name = parsed.name;
        if (parsed.description !== undefined) {
          current.description = parsed.description;
        }
        if (parsed.conversation_id !== undefined) {
          current.conversation_id = parsed.conversation_id;
        }
        if (parsed.cron !== undefined) current.cron = parsed.cron;
        if (parsed.timezone !== undefined) current.timezone = parsed.timezone;
        if (parsed.recurring !== undefined)
          current.recurring = parsed.recurring;
        // F-06: a dream schedule is the scheduler's signal carrier, not a
        // conversation task. The update path has none of `addTask`'s dream
        // constraints, so it refuses to change the body kind or target of an
        // existing carrier, and refuses to convert a task *into* a carrier
        // (which would skip those constraints). Create carriers through the
        // dream settings path instead.
        if ((current.type ?? "prompt") === "dream") {
          if (
            parsed.task_type !== undefined ||
            parsed.payload !== undefined ||
            parsed.target !== undefined
          ) {
            throw new Error(
              "Dream schedule carriers cannot change task_type, payload, or target (F-06).",
            );
          }
        } else if (parsed.task_type === "dream") {
          throw new Error(
            "A schedule cannot be converted into a dream carrier by cron_update; create it through the dream settings path (F-06).",
          );
        }
        // F-05 additive fields. The wire name is `task_type` because the
        // command's own `type` is the protocol discriminant; the record keeps
        // the F-05 name `type` and every other field maps 1:1 onto `CronTask`.
        if (parsed.task_type !== undefined) current.type = parsed.task_type;
        if (parsed.permission !== undefined) {
          current.permission = parsed.permission;
        }
        if (parsed.catch_up !== undefined) current.catch_up = parsed.catch_up;
        if (parsed.timeout_minutes !== undefined) {
          current.timeout_minutes = parsed.timeout_minutes;
        }
        if (parsed.wait_minutes !== undefined) {
          current.wait_minutes = parsed.wait_minutes;
        }
        // `target` is the F-05 authority, so the legacy `conversation_id` has to
        // follow it or the v2 view and the list filters disagree. An explicit
        // `conversation_id` may not contradict the target (same rule `addTask`
        // applies on creation).
        if (parsed.target !== undefined) {
          const derivedConversationId =
            parsed.target.kind === "new"
              ? "new"
              : parsed.target.conversation_id;
          if (
            parsed.conversation_id !== undefined &&
            parsed.conversation_id !== derivedConversationId
          ) {
            throw new Error(
              `target and conversation_id disagree: target resolves to "${derivedConversationId}", conversation_id is "${parsed.conversation_id}".`,
            );
          }
          current.target = parsed.target;
          current.conversation_id = derivedConversationId;
        } else if (parsed.conversation_id !== undefined) {
          // Legacy clients only send `conversation_id`; derive the target so
          // the F-05 host runners retarget instead of running the old target.
          current.target =
            parsed.conversation_id === "new"
              ? {
                  kind: "new",
                  hidden:
                    current.target?.kind === "new"
                      ? current.target.hidden
                      : false,
                }
              : { kind: "existing", conversation_id: parsed.conversation_id };
        }
        // Merged-state constraint from `addTask` (R-5.5.1): a command task
        // cannot create a conversation, so retyping to `command` or retargeting
        // a command task to a fresh conversation is refused. `prompt` may
        // target a new conversation; converting to `dream` was refused above.
        const resolvedType = current.type ?? "prompt";
        const resolvedTarget =
          current.target ??
          (current.conversation_id === "new"
            ? ({ kind: "new", hidden: false } as const)
            : ({
                kind: "existing",
                conversation_id: current.conversation_id,
              } as const));
        if (resolvedType === "command" && resolvedTarget.kind !== "existing") {
          throw new Error(
            "Command schedules must target an existing conversation: they cannot create a new one (R-5.5.1).",
          );
        }
        // A prompt task's body lives in both `prompt` (legacy readers) and
        // `payload` (the F-05 host runner); keep the pair coherent whichever
        // side the client updated.
        if (parsed.payload !== undefined) {
          current.payload = parsed.payload;
          if ((current.type ?? "prompt") === "prompt") {
            current.prompt = parsed.payload;
          }
        }
        if (parsed.prompt !== undefined) {
          current.prompt = parsed.prompt;
          if (
            parsed.payload === undefined &&
            (current.type ?? "prompt") === "prompt"
          ) {
            current.payload = parsed.prompt;
          }
        }
        if (parsed.scheduled_for !== undefined) {
          current.scheduled_for = scheduledForIso ?? null;
        }
      });
      safeSocketSend(
        socket,
        {
          type: "cron_update_response",
          request_id: parsed.request_id,
          success: task !== null,
          ...(task ? { task } : { error: "Cron task not found" }),
        },
        "listener_cron_send_failed",
        "listener_cron_command",
      );
      if (task) {
        emitCronsUpdated(socket, safeSocketSend, {
          agent_id: task.agent_id,
          conversation_id: task.conversation_id,
        });
      }
    } catch (err) {
      safeSocketSend(
        socket,
        {
          type: "cron_update_response",
          request_id: parsed.request_id,
          success: false,
          error: err instanceof Error ? err.message : "Failed to update cron",
        },
        "listener_cron_send_failed",
        "listener_cron_command",
      );
    }
    return true;
  }

  if (parsed.type === "cron_delete") {
    try {
      const existingTask = getCronTask(parsed.task_id);
      const found = deleteCronTask(parsed.task_id);
      safeSocketSend(
        socket,
        {
          type: "cron_delete_response",
          request_id: parsed.request_id,
          success: true,
          found,
        },
        "listener_cron_send_failed",
        "listener_cron_command",
      );
      if (found) {
        emitCronsUpdated(socket, safeSocketSend, {
          agent_id: existingTask?.agent_id,
          conversation_id: existingTask?.conversation_id,
        });
      }
    } catch (err) {
      safeSocketSend(
        socket,
        {
          type: "cron_delete_response",
          request_id: parsed.request_id,
          success: false,
          found: false,
          error: err instanceof Error ? err.message : "Failed to delete cron",
        },
        "listener_cron_send_failed",
        "listener_cron_command",
      );
    }
    return true;
  }

  try {
    const deleted = deleteAllCronTasks(parsed.agent_id);
    safeSocketSend(
      socket,
      {
        type: "cron_delete_all_response",
        request_id: parsed.request_id,
        success: true,
        agent_id: parsed.agent_id,
        deleted,
      },
      "listener_cron_send_failed",
      "listener_cron_command",
    );
    if (deleted > 0) {
      emitCronsUpdated(socket, safeSocketSend, {
        agent_id: parsed.agent_id,
      });
    }
  } catch (err) {
    safeSocketSend(
      socket,
      {
        type: "cron_delete_all_response",
        request_id: parsed.request_id,
        success: false,
        agent_id: parsed.agent_id,
        deleted: 0,
        error: err instanceof Error ? err.message : "Failed to delete crons",
      },
      "listener_cron_send_failed",
      "listener_cron_command",
    );
  }
  return true;
}

export function handleCronProtocolCommand(
  parsed: unknown,
  context: CronCommandContext,
): boolean {
  const { socket, safeSocketSend, runDetachedListenerTask } = context;

  if (
    isCronListCommand(parsed) ||
    isCronAddCommand(parsed) ||
    isCronGetCommand(parsed) ||
    isCronRunsCommand(parsed) ||
    isCronTriggerCommand(parsed) ||
    isCronPauseCommand(parsed) ||
    isCronResumeCommand(parsed) ||
    isCronUpdateCommand(parsed) ||
    isCronDeleteCommand(parsed) ||
    isCronDeleteAllCommand(parsed)
  ) {
    runDetachedListenerTask("cron_command", async () => {
      await handleCronCommand(parsed, socket, safeSocketSend);
    });
    return true;
  }

  return false;
}
