import type WebSocket from "ws";
import {
  getReflectionSettings,
  persistReflectionSettingsForAgent,
} from "@/cli/helpers/memory-reminder";
import { experimentManager } from "@/experiments/manager";
import {
  legacyTriggerToReflectionSwitches,
  type ReflectionSettings,
} from "@/reflection-settings";
import type {
  GetExperimentsCommand,
  GetExperimentsResponseMessage,
  GetReflectionSettingsCommand,
  ReflectionSettingsScope,
  ReflectionSettingsSnapshot,
  SetExperimentCommand,
  SetExperimentResponseMessage,
  SetReflectionSettingsCommand,
} from "@/types/protocol_v2";
import { getConversationWorkingDirectory } from "@/websocket/listener/cwd";
import {
  isGetExperimentsCommand,
  isGetReflectionSettingsCommand,
  isSetExperimentCommand,
  isSetReflectionSettingsCommand,
} from "@/websocket/listener/protocol-inbound";
import { emitDeviceStatusUpdate } from "@/websocket/listener/protocol-outbound";
import type { ListenerRuntime } from "@/websocket/listener/types";
import type { RunDetachedListenerTask, SafeSocketSend } from "./types";

export type ReflectionSettingsCommand =
  | GetReflectionSettingsCommand
  | SetReflectionSettingsCommand;

export type ExperimentCommand = GetExperimentsCommand | SetExperimentCommand;

type SettingsCommandContext = {
  socket: WebSocket;
  runtime: ListenerRuntime;
  safeSocketSend: SafeSocketSend;
  runDetachedListenerTask: RunDetachedListenerTask;
};

function toReflectionSettingsResponse(
  agentId: string,
  workingDirectory: string,
): ReflectionSettingsSnapshot {
  const settings = getReflectionSettings(agentId, workingDirectory);
  return {
    agent_id: agentId,
    trigger: settings.trigger,
    step_count: settings.stepCount,
    onCompaction: settings.onCompaction,
    everyUserMessages: settings.everyUserMessages,
    deleteSessionOnSuccess: settings.deleteSessionOnSuccess,
    timeoutMinutes: settings.timeoutMinutes,
    merge: settings.merge,
    merge_instructions: settings.mergeInstructions,
  };
}

/**
 * F-03/B3: the fields the pre-F-03 wire could not express, mapped onto
 * `ReflectionSettings`. Omitted fields are left untouched, so an old client
 * that sends only `trigger`/`step_count` keeps the existing behaviour.
 */
function explicitReflectionSettingsOverrides(
  settings: SetReflectionSettingsCommand["settings"],
): Partial<ReflectionSettings> {
  return {
    ...(settings.on_compaction !== undefined
      ? { onCompaction: settings.on_compaction }
      : {}),
    ...(settings.every_user_messages !== undefined
      ? { everyUserMessages: settings.every_user_messages }
      : {}),
    ...(settings.delete_session_on_success !== undefined
      ? { deleteSessionOnSuccess: settings.delete_session_on_success }
      : {}),
    ...(settings.timeout_minutes !== undefined
      ? { timeoutMinutes: settings.timeout_minutes }
      : {}),
  };
}

function resolveReflectionSettingsScope(
  scope: ReflectionSettingsScope | undefined,
): {
  persistLocalProject: boolean;
  persistGlobal: boolean;
  normalizedScope: ReflectionSettingsScope;
} {
  if (scope === "local_project") {
    return {
      persistLocalProject: true,
      persistGlobal: false,
      normalizedScope: scope,
    };
  }
  if (scope === "global") {
    return {
      persistLocalProject: false,
      persistGlobal: true,
      normalizedScope: scope,
    };
  }
  return {
    persistLocalProject: true,
    persistGlobal: true,
    normalizedScope: "both",
  };
}

export async function handleExperimentCommand(
  parsed: ExperimentCommand,
  socket: WebSocket,
  listener: ListenerRuntime,
  safeSocketSend: SafeSocketSend,
): Promise<boolean> {
  if (parsed.type === "get_experiments") {
    const response: GetExperimentsResponseMessage = {
      type: "get_experiments_response",
      request_id: parsed.request_id,
      success: true,
      experiments: experimentManager.list(),
    };
    safeSocketSend(
      socket,
      response,
      "listener_experiments_send_failed",
      "listener_experiments",
    );
    return true;
  }

  try {
    experimentManager.set(parsed.experiment_id, parsed.enabled);
    const response: SetExperimentResponseMessage = {
      type: "set_experiment_response",
      request_id: parsed.request_id,
      success: true,
      experiments: experimentManager.list(),
    };
    safeSocketSend(
      socket,
      response,
      "listener_experiments_send_failed",
      "listener_experiments",
    );

    emitDeviceStatusUpdate(socket, listener);
  } catch (err) {
    const response: SetExperimentResponseMessage = {
      type: "set_experiment_response",
      request_id: parsed.request_id,
      success: false,
      experiments: experimentManager.list(),
      error: err instanceof Error ? err.message : "Failed to update experiment",
    };
    safeSocketSend(
      socket,
      response,
      "listener_experiments_send_failed",
      "listener_experiments",
    );
  }

  return true;
}

export async function handleReflectionSettingsCommand(
  parsed: ReflectionSettingsCommand,
  socket: WebSocket,
  listener: ListenerRuntime,
  safeSocketSend: SafeSocketSend,
): Promise<boolean> {
  const agentId = parsed.runtime.agent_id;
  const workingDirectory = getConversationWorkingDirectory(
    listener,
    parsed.runtime.agent_id,
    parsed.runtime.conversation_id,
  );

  if (parsed.type === "get_reflection_settings") {
    try {
      safeSocketSend(
        socket,
        {
          type: "get_reflection_settings_response",
          request_id: parsed.request_id,
          success: true,
          reflection_settings: toReflectionSettingsResponse(
            agentId,
            workingDirectory,
          ),
        },
        "listener_reflection_settings_send_failed",
        "listener_reflection_settings",
      );
    } catch (err) {
      safeSocketSend(
        socket,
        {
          type: "get_reflection_settings_response",
          request_id: parsed.request_id,
          success: false,
          reflection_settings: null,
          error:
            err instanceof Error
              ? err.message
              : "Failed to load reflection settings",
        },
        "listener_reflection_settings_send_failed",
        "listener_reflection_settings",
      );
    }
    return true;
  }

  const { persistLocalProject, persistGlobal, normalizedScope } =
    resolveReflectionSettingsScope(parsed.scope);

  try {
    const currentSettings = getReflectionSettings(agentId, workingDirectory);
    // F-03 §7.7: the wire still speaks the retired one-of-three selector and
    // the merge knobs. The selector is migrated onto the two switches here; the
    // merge fields are accepted and ignored.
    const migratedSwitches = legacyTriggerToReflectionSwitches(
      parsed.settings.trigger,
      parsed.settings.step_count,
    );
    // B3 additive fields: an explicit new field always wins over the legacy
    // selector's migration, so a client that sends both is not silently
    // downgraded to the mapped value.
    const explicitOverrides = explicitReflectionSettingsOverrides(
      parsed.settings,
    );
    await persistReflectionSettingsForAgent(
      agentId,
      {
        ...currentSettings,
        ...migratedSwitches,
        ...explicitOverrides,
      },
      {
        workingDirectory,
        persistLocalProject,
        persistGlobal,
      },
    );
    safeSocketSend(
      socket,
      {
        type: "set_reflection_settings_response",
        request_id: parsed.request_id,
        success: true,
        scope: normalizedScope,
        reflection_settings: toReflectionSettingsResponse(
          agentId,
          workingDirectory,
        ),
      },
      "listener_reflection_settings_send_failed",
      "listener_reflection_settings",
    );
    emitDeviceStatusUpdate(socket, listener, parsed.runtime);
  } catch (err) {
    safeSocketSend(
      socket,
      {
        type: "set_reflection_settings_response",
        request_id: parsed.request_id,
        success: false,
        scope: normalizedScope,
        reflection_settings: null,
        error:
          err instanceof Error
            ? err.message
            : "Failed to update reflection settings",
      },
      "listener_reflection_settings_send_failed",
      "listener_reflection_settings",
    );
  }
  return true;
}

export function handleSettingsProtocolCommand(
  parsed: unknown,
  context: SettingsCommandContext,
): boolean {
  const { socket, runtime, safeSocketSend, runDetachedListenerTask } = context;

  if (isGetExperimentsCommand(parsed) || isSetExperimentCommand(parsed)) {
    runDetachedListenerTask("experiment_command", async () => {
      await handleExperimentCommand(parsed, socket, runtime, safeSocketSend);
    });
    return true;
  }

  if (
    isGetReflectionSettingsCommand(parsed) ||
    isSetReflectionSettingsCommand(parsed)
  ) {
    runDetachedListenerTask("reflection_settings_command", async () => {
      await handleReflectionSettingsCommand(
        parsed,
        socket,
        runtime,
        safeSocketSend,
      );
    });
    return true;
  }

  return false;
}
