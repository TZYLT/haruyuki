/**
 * Profile, config and device handlers for the embedding protocol family
 * (48-4 D-09/D-10/D-16/D-03).
 *
 * Split from `embedding.ts` so each handler module stays a protocol adapter
 * below the size ceiling. Every branch here is a thin mapping onto
 * `EmbeddingCommandBackend`; no handler reads settings, spawns a worker or
 * touches the network directly.
 */

import type WebSocket from "ws";
import type {
  EmbeddingConfigGetCommand,
  EmbeddingConfigGetResponseMessage,
  EmbeddingConfigSetCommand,
  EmbeddingConfigSetResponseMessage,
  EmbeddingDeviceCommand,
  EmbeddingDeviceResponseMessage,
  EmbeddingDeviceTestCommand,
  EmbeddingDeviceTestResponseMessage,
  EmbeddingProfileDeleteCommand,
  EmbeddingProfileDeleteResponseMessage,
  EmbeddingProfilePinCommand,
  EmbeddingProfilePinResponseMessage,
  EmbeddingProfileSelectCommand,
  EmbeddingProfileSelectResponseMessage,
  EmbeddingProfilesListCommand,
  EmbeddingProfilesListResponseMessage,
} from "@/types/embedding-protocol";
import { getErrorMessage } from "@/utils/error";
import {
  createEmbeddingCommandBackend,
  type EmbeddingCommandBackend,
} from "./embedding-backend";
import {
  createEmbeddingSend,
  requireAgentId,
} from "./embedding-command-shared";
import type { SafeSocketSend } from "./types";

export async function handleEmbeddingProfilesListCommand(
  command: EmbeddingProfilesListCommand,
  socket: WebSocket,
  safeSocketSend: SafeSocketSend,
  backend: EmbeddingCommandBackend = createEmbeddingCommandBackend(),
): Promise<void> {
  const send = createEmbeddingSend(socket, safeSocketSend);
  try {
    const agentId = requireAgentId(command.runtime);
    const result = await backend.profilesList(agentId);
    const response: EmbeddingProfilesListResponseMessage = result.ok
      ? {
          type: "embedding_profiles_list_response",
          request_id: command.request_id,
          success: true,
          profiles: result.value.profiles,
        }
      : {
          type: "embedding_profiles_list_response",
          request_id: command.request_id,
          success: false,
          profiles: [],
          error: result.error,
        };
    send(response);
  } catch (error) {
    const response: EmbeddingProfilesListResponseMessage = {
      type: "embedding_profiles_list_response",
      request_id: command.request_id,
      success: false,
      profiles: [],
      error: getErrorMessage(error),
    };
    send(response);
  }
}

export async function handleEmbeddingProfileSelectCommand(
  command: EmbeddingProfileSelectCommand,
  socket: WebSocket,
  safeSocketSend: SafeSocketSend,
  backend: EmbeddingCommandBackend = createEmbeddingCommandBackend(),
): Promise<void> {
  const send = createEmbeddingSend(socket, safeSocketSend);
  try {
    const agentId = requireAgentId(command.runtime);
    const result = await backend.profileSelect(agentId, {
      ...(command.index === undefined ? {} : { index: command.index }),
      ...(command.space_id === undefined ? {} : { spaceId: command.space_id }),
    });
    const response: EmbeddingProfileSelectResponseMessage = result.ok
      ? {
          type: "embedding_profile_select_response",
          request_id: command.request_id,
          success: true,
          settings: result.value.settings,
          requires_rebuild: result.value.requiresRebuild,
          ...(result.value.reason === undefined
            ? {}
            : { reason: result.value.reason }),
        }
      : {
          type: "embedding_profile_select_response",
          request_id: command.request_id,
          success: false,
          settings: null,
          requires_rebuild: false,
          error: result.error,
        };
    send(response);
  } catch (error) {
    const response: EmbeddingProfileSelectResponseMessage = {
      type: "embedding_profile_select_response",
      request_id: command.request_id,
      success: false,
      settings: null,
      requires_rebuild: false,
      error: getErrorMessage(error),
    };
    send(response);
  }
}

export async function handleEmbeddingProfileDeleteCommand(
  command: EmbeddingProfileDeleteCommand,
  socket: WebSocket,
  safeSocketSend: SafeSocketSend,
  backend: EmbeddingCommandBackend = createEmbeddingCommandBackend(),
): Promise<void> {
  const send = createEmbeddingSend(socket, safeSocketSend);
  try {
    const agentId = requireAgentId(command.runtime);
    const scope = command.scope ?? "current";
    if (scope !== "current" && scope !== "all" && scope !== "model") {
      throw new Error("invalid_embedding_profile_delete_scope");
    }
    const result = await backend.profileDelete(agentId, {
      scope,
      confirm: command.confirm === true,
      ...(command.index === undefined ? {} : { index: command.index }),
      ...(command.space_id === undefined ? {} : { spaceId: command.space_id }),
    });
    const response: EmbeddingProfileDeleteResponseMessage = result.ok
      ? {
          type: "embedding_profile_delete_response",
          request_id: command.request_id,
          success: true,
          removed_spaces: result.value.removedSpaces,
          requires_rebuild: result.value.requiresRebuild,
          ...(result.value.requiresConfirmation === undefined
            ? {}
            : { requires_confirmation: result.value.requiresConfirmation }),
          ...(result.value.preview === undefined
            ? {}
            : { preview: result.value.preview }),
        }
      : {
          type: "embedding_profile_delete_response",
          request_id: command.request_id,
          success: false,
          removed_spaces: 0,
          requires_rebuild: false,
          error: result.error,
        };
    send(response);
  } catch (error) {
    const response: EmbeddingProfileDeleteResponseMessage = {
      type: "embedding_profile_delete_response",
      request_id: command.request_id,
      success: false,
      removed_spaces: 0,
      requires_rebuild: false,
      error: getErrorMessage(error),
    };
    send(response);
  }
}

export async function handleEmbeddingProfilePinCommand(
  command: EmbeddingProfilePinCommand,
  socket: WebSocket,
  safeSocketSend: SafeSocketSend,
  backend: EmbeddingCommandBackend = createEmbeddingCommandBackend(),
): Promise<void> {
  const send = createEmbeddingSend(socket, safeSocketSend);
  try {
    const agentId = requireAgentId(command.runtime);
    const result = await backend.profilePin(
      agentId,
      {
        ...(command.index === undefined ? {} : { index: command.index }),
        ...(command.space_id === undefined
          ? {}
          : { spaceId: command.space_id }),
      },
      command.pinned,
    );
    const response: EmbeddingProfilePinResponseMessage = result.ok
      ? {
          type: "embedding_profile_pin_response",
          request_id: command.request_id,
          success: true,
          profiles: result.value.profiles,
        }
      : {
          type: "embedding_profile_pin_response",
          request_id: command.request_id,
          success: false,
          profiles: [],
          error: result.error,
        };
    send(response);
  } catch (error) {
    const response: EmbeddingProfilePinResponseMessage = {
      type: "embedding_profile_pin_response",
      request_id: command.request_id,
      success: false,
      profiles: [],
      error: getErrorMessage(error),
    };
    send(response);
  }
}

export async function handleEmbeddingConfigGetCommand(
  command: EmbeddingConfigGetCommand,
  socket: WebSocket,
  safeSocketSend: SafeSocketSend,
  backend: EmbeddingCommandBackend = createEmbeddingCommandBackend(),
): Promise<void> {
  const send = createEmbeddingSend(socket, safeSocketSend);
  try {
    const agentId = requireAgentId(command.runtime);
    const result = await backend.configGet(agentId, command.key);
    const response: EmbeddingConfigGetResponseMessage = result.ok
      ? {
          type: "embedding_config_get_response",
          request_id: command.request_id,
          success: true,
          keys: result.value.keys,
          settings: result.value.settings,
        }
      : {
          type: "embedding_config_get_response",
          request_id: command.request_id,
          success: false,
          keys: [],
          settings: null,
          error: result.error,
        };
    send(response);
  } catch (error) {
    const response: EmbeddingConfigGetResponseMessage = {
      type: "embedding_config_get_response",
      request_id: command.request_id,
      success: false,
      keys: [],
      settings: null,
      error: getErrorMessage(error),
    };
    send(response);
  }
}

export async function handleEmbeddingConfigSetCommand(
  command: EmbeddingConfigSetCommand,
  socket: WebSocket,
  safeSocketSend: SafeSocketSend,
  backend: EmbeddingCommandBackend = createEmbeddingCommandBackend(),
): Promise<void> {
  const send = createEmbeddingSend(socket, safeSocketSend);
  try {
    const agentId = requireAgentId(command.runtime);
    const result = await backend.configSet(agentId, command.key, command.value);
    const response: EmbeddingConfigSetResponseMessage = result.ok
      ? {
          type: "embedding_config_set_response",
          request_id: command.request_id,
          success: true,
          settings: result.value.settings,
          requires_rebuild: result.value.requiresRebuild,
        }
      : {
          type: "embedding_config_set_response",
          request_id: command.request_id,
          success: false,
          settings: null,
          requires_rebuild: false,
          error: result.error,
        };
    send(response);
  } catch (error) {
    const response: EmbeddingConfigSetResponseMessage = {
      type: "embedding_config_set_response",
      request_id: command.request_id,
      success: false,
      settings: null,
      requires_rebuild: false,
      error: getErrorMessage(error),
    };
    send(response);
  }
}

export async function handleEmbeddingDeviceCommand(
  command: EmbeddingDeviceCommand,
  socket: WebSocket,
  safeSocketSend: SafeSocketSend,
  backend: EmbeddingCommandBackend = createEmbeddingCommandBackend(),
): Promise<void> {
  const send = createEmbeddingSend(socket, safeSocketSend);
  try {
    const agentId = requireAgentId(command.runtime);
    const result = await backend.device(agentId);
    const response: EmbeddingDeviceResponseMessage = result.ok
      ? {
          type: "embedding_device_response",
          request_id: command.request_id,
          success: true,
          device: result.value.device,
        }
      : {
          type: "embedding_device_response",
          request_id: command.request_id,
          success: false,
          device: null,
          error: result.error,
        };
    send(response);
  } catch (error) {
    const response: EmbeddingDeviceResponseMessage = {
      type: "embedding_device_response",
      request_id: command.request_id,
      success: false,
      device: null,
      error: getErrorMessage(error),
    };
    send(response);
  }
}

export async function handleEmbeddingDeviceTestCommand(
  command: EmbeddingDeviceTestCommand,
  socket: WebSocket,
  safeSocketSend: SafeSocketSend,
  backend: EmbeddingCommandBackend = createEmbeddingCommandBackend(),
): Promise<void> {
  const send = createEmbeddingSend(socket, safeSocketSend);
  try {
    const agentId = requireAgentId(command.runtime);
    const result = await backend.deviceTest(agentId);
    const response: EmbeddingDeviceTestResponseMessage = result.ok
      ? {
          type: "embedding_device_test_response",
          request_id: command.request_id,
          success: true,
          calibration: result.value.calibration,
        }
      : {
          type: "embedding_device_test_response",
          request_id: command.request_id,
          success: false,
          calibration: null,
          error: result.error,
        };
    send(response);
  } catch (error) {
    const response: EmbeddingDeviceTestResponseMessage = {
      type: "embedding_device_test_response",
      request_id: command.request_id,
      success: false,
      calibration: null,
      error: getErrorMessage(error),
    };
    send(response);
  }
}
