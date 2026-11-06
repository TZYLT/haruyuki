import type WebSocket from "ws";
import type {
  EmbeddingBuildCommand,
  EmbeddingBuildResponseMessage,
  EmbeddingCancelCommand,
  EmbeddingCancelResponseMessage,
  EmbeddingConfigGetCommand,
  EmbeddingConfigSetCommand,
  EmbeddingConnectCommand,
  EmbeddingConnectPatch,
  EmbeddingConnectResponseMessage,
  EmbeddingDeviceCommand,
  EmbeddingDeviceTestCommand,
  EmbeddingDisableCommand,
  EmbeddingDisableResponseMessage,
  EmbeddingEnableCommand,
  EmbeddingEnableResponseMessage,
  EmbeddingProfileDeleteCommand,
  EmbeddingProfilePinCommand,
  EmbeddingProfileSelectCommand,
  EmbeddingProfilesListCommand,
  EmbeddingStatusCommand,
  EmbeddingStatusResponseMessage,
} from "@/types/embedding-protocol";
import { getErrorMessage } from "@/utils/error";
import {
  isEmbeddingBuildCommand,
  isEmbeddingCancelCommand,
  isEmbeddingConfigGetCommand,
  isEmbeddingConfigSetCommand,
  isEmbeddingConnectCommand,
  isEmbeddingConnectPatch,
  isEmbeddingDeviceCommand,
  isEmbeddingDeviceTestCommand,
  isEmbeddingDisableCommand,
  isEmbeddingEnableCommand,
  isEmbeddingProfileDeleteCommand,
  isEmbeddingProfilePinCommand,
  isEmbeddingProfileSelectCommand,
  isEmbeddingProfilesListCommand,
  isEmbeddingStatusCommand,
} from "@/websocket/listener/embedding-protocol-inbound";
import {
  createEmbeddingCommandBackend,
  type EmbeddingCommandBackend,
} from "./embedding-backend";
import {
  createEmbeddingSend,
  EMBEDDING_INVALID_PATCH,
  requireAgentId,
} from "./embedding-command-shared";
import {
  handleEmbeddingConfigGetCommand,
  handleEmbeddingConfigSetCommand,
  handleEmbeddingDeviceCommand,
  handleEmbeddingDeviceTestCommand,
  handleEmbeddingProfileDeleteCommand,
  handleEmbeddingProfilePinCommand,
  handleEmbeddingProfileSelectCommand,
  handleEmbeddingProfilesListCommand,
} from "./embedding-profile-handlers";
import type { RunDetachedListenerTask, SafeSocketSend } from "./types";

/**
 * R-26 embedding protocol handlers (D2, 48-2 §4.9).
 *
 * The eight commands are thin protocol adapters: they validate the payload,
 * delegate to a narrow `EmbeddingCommandBackend`, and answer with the frozen
 * D1 response shapes. No handler touches settings, the secrets store or the
 * build runner directly — the production backend in `./embedding-backend`
 * adapts the same owners the TUI and CLI use (D3 settings/secrets, A2's
 * runtime port, A4's host, C5/C3 calibration).
 *
 * {@link createEmbeddingCommandBackend} is that production adapter. Its
 * `deps` parameter is the test seam: it injects a fake runtime/settings
 * writer/calibration pass, so this file never spawns a worker or touches the
 * network in tests. The runtime port is the same `cli/helpers/embedding-runtime`
 * one `/recall embedding` uses, so the three surfaces cannot disagree about
 * asset gating, GPU policy or reset targets.
 *
 * The family entry matches the other families: the reply is queued through
 * `runDetachedListenerTask`, so the router's await path never waits on it.
 */

export type EmbeddingProtocolCommandContext = {
  socket: WebSocket;
  safeSocketSend: SafeSocketSend;
  runDetachedListenerTask: RunDetachedListenerTask;
};

export type {
  EmbeddingBackendFailure,
  EmbeddingBackendResult,
  EmbeddingBuildBackendValue,
  EmbeddingBuildOptions,
  EmbeddingCalibrateBackendValue,
  EmbeddingCancelBackendValue,
  EmbeddingCommandBackend,
  EmbeddingCommandBackendDeps,
  EmbeddingConfigGetBackendValue,
  EmbeddingConfigSetBackendValue,
  EmbeddingConnectBackendValue,
  EmbeddingDeviceBackendValue,
  EmbeddingDisableBackendValue,
  EmbeddingEnableBackendValue,
  EmbeddingProfileDeleteBackendValue,
  EmbeddingProfileDeleteRequest,
  EmbeddingProfilePinBackendValue,
  EmbeddingProfileSelectBackendValue,
  EmbeddingProfileSelector,
  EmbeddingProfilesListBackendValue,
  EmbeddingStatusBackendResult,
} from "./embedding-backend";
// The backend contract and the production adapter live in their own module
// (size ceiling); these re-exports keep the family's public import site.
export {
  createEmbeddingCommandBackend,
  EMBEDDING_NOT_CONFIGURED,
} from "./embedding-backend";
export {
  EMBEDDING_INVALID_PATCH,
  EMBEDDING_INVALID_SCOPE,
} from "./embedding-command-shared";

type EmbeddingProtocolCommand =
  | EmbeddingStatusCommand
  | EmbeddingConnectCommand
  | EmbeddingEnableCommand
  | EmbeddingDisableCommand
  | EmbeddingBuildCommand
  | EmbeddingCancelCommand
  | EmbeddingProfilesListCommand
  | EmbeddingProfileSelectCommand
  | EmbeddingProfileDeleteCommand
  | EmbeddingProfilePinCommand
  | EmbeddingConfigGetCommand
  | EmbeddingConfigSetCommand
  | EmbeddingDeviceCommand
  | EmbeddingDeviceTestCommand;

/**
 * Handler-side patch coherence, on top of the D1 shape guard.
 *
 * The wire guard already bounds every scalar; the cross-field rules the guard
 * deliberately leaves to the handler are checked here only when the patch itself
 * carries both sides of the relation, so a partial patch is never judged
 * against a value it does not set. Endpoint/backend coherence is not checked
 * here at all: it depends on the *stored* settings, so the production backend
 * validates the merged result (see `EmbeddingCommandBackend.connect`).
 */
function validateConnectPatch(patch: EmbeddingConnectPatch): string | null {
  if (
    patch.chunk_target !== undefined &&
    patch.chunk_max !== undefined &&
    patch.chunk_target > patch.chunk_max
  ) {
    return "embedding_chunk_target_exceeds_max";
  }
  if (patch.chunk_overlap !== undefined) {
    const reference = patch.chunk_target ?? patch.chunk_max;
    if (reference !== undefined && patch.chunk_overlap >= reference) {
      return "embedding_chunk_overlap_exceeds_target";
    }
  }
  return null;
}

/** `embedding_status`: the full snapshot, or an honest "not configured". */
export async function handleEmbeddingStatusCommand(
  command: EmbeddingStatusCommand,
  socket: WebSocket,
  safeSocketSend: SafeSocketSend,
  backend: EmbeddingCommandBackend = createEmbeddingCommandBackend(),
): Promise<void> {
  const send = createEmbeddingSend(socket, safeSocketSend);
  try {
    const agentId = requireAgentId(command.runtime);
    const result = await backend.status(agentId);
    if (!result.configured) {
      const response: EmbeddingStatusResponseMessage = {
        type: "embedding_status_response",
        request_id: command.request_id,
        success: false,
        status: null,
        error: result.error,
      };
      send(response);
      return;
    }
    const response: EmbeddingStatusResponseMessage = {
      type: "embedding_status_response",
      request_id: command.request_id,
      success: true,
      status: result.status,
    };
    send(response);
  } catch (error) {
    const response: EmbeddingStatusResponseMessage = {
      type: "embedding_status_response",
      request_id: command.request_id,
      success: false,
      status: null,
      error: getErrorMessage(error),
    };
    send(response);
  }
}

/**
 * `embedding_connect`: a patch onto the resolved settings plus the space id it
 * addresses (48-4 D-08/D-11).
 *
 * `api_key` is write-only (48-2 O-18): it is validated and forwarded to the
 * backend, which persists it through the secrets store; no branch below copies
 * it into the response.
 */
export async function handleEmbeddingConnectCommand(
  command: EmbeddingConnectCommand,
  socket: WebSocket,
  safeSocketSend: SafeSocketSend,
  backend: EmbeddingCommandBackend = createEmbeddingCommandBackend(),
): Promise<void> {
  const send = createEmbeddingSend(socket, safeSocketSend);
  try {
    const agentId = requireAgentId(command.runtime);
    if (!isEmbeddingConnectPatch(command.patch)) {
      throw new Error(EMBEDDING_INVALID_PATCH);
    }
    const invalid = validateConnectPatch(command.patch);
    if (invalid !== null) throw new Error(invalid);
    const result = await backend.connect(agentId, command.patch);
    if (!result.ok) {
      const response: EmbeddingConnectResponseMessage = {
        type: "embedding_connect_response",
        request_id: command.request_id,
        success: false,
        settings: null,
        space_id: null,
        requires_rebuild: false,
        error: result.error,
      };
      send(response);
      return;
    }
    const response: EmbeddingConnectResponseMessage = {
      type: "embedding_connect_response",
      request_id: command.request_id,
      success: true,
      settings: result.value.settings,
      space_id: result.value.spaceId,
      requires_rebuild: result.value.requiresRebuild,
    };
    send(response);
  } catch (error) {
    const response: EmbeddingConnectResponseMessage = {
      type: "embedding_connect_response",
      request_id: command.request_id,
      success: false,
      settings: null,
      space_id: null,
      requires_rebuild: false,
      error: getErrorMessage(error),
    };
    send(response);
  }
}

/** `embedding_enable`: flip the master switch; may start the first build. */
export async function handleEmbeddingEnableCommand(
  command: EmbeddingEnableCommand,
  socket: WebSocket,
  safeSocketSend: SafeSocketSend,
  backend: EmbeddingCommandBackend = createEmbeddingCommandBackend(),
): Promise<void> {
  const send = createEmbeddingSend(socket, safeSocketSend);
  try {
    const agentId = requireAgentId(command.runtime);
    const result = await backend.enable(agentId);
    if (!result.ok) {
      const response: EmbeddingEnableResponseMessage = {
        type: "embedding_enable_response",
        request_id: command.request_id,
        success: false,
        enabled: false,
        build_started: false,
        error: result.error,
      };
      send(response);
      return;
    }
    const response: EmbeddingEnableResponseMessage = {
      type: "embedding_enable_response",
      request_id: command.request_id,
      success: true,
      enabled: result.value.enabled,
      build_started: result.value.buildStarted,
      ...(result.value.reason === undefined
        ? {}
        : { reason: result.value.reason }),
    };
    send(response);
  } catch (error) {
    const response: EmbeddingEnableResponseMessage = {
      type: "embedding_enable_response",
      request_id: command.request_id,
      success: false,
      enabled: false,
      build_started: false,
      error: getErrorMessage(error),
    };
    send(response);
  }
}

/** `embedding_disable`: flip the master switch off; vectors stay on disk. */
export async function handleEmbeddingDisableCommand(
  command: EmbeddingDisableCommand,
  socket: WebSocket,
  safeSocketSend: SafeSocketSend,
  backend: EmbeddingCommandBackend = createEmbeddingCommandBackend(),
): Promise<void> {
  const send = createEmbeddingSend(socket, safeSocketSend);
  try {
    const agentId = requireAgentId(command.runtime);
    const result = await backend.disable(agentId);
    if (!result.ok) {
      const response: EmbeddingDisableResponseMessage = {
        type: "embedding_disable_response",
        request_id: command.request_id,
        success: false,
        enabled: false,
        error: result.error,
      };
      send(response);
      return;
    }
    const response: EmbeddingDisableResponseMessage = {
      type: "embedding_disable_response",
      request_id: command.request_id,
      success: true,
      enabled: result.value.enabled,
    };
    send(response);
  } catch (error) {
    const response: EmbeddingDisableResponseMessage = {
      type: "embedding_disable_response",
      request_id: command.request_id,
      success: false,
      enabled: false,
      error: getErrorMessage(error),
    };
    send(response);
  }
}

/**
 * `embedding_build`: launch a build through the injected backend.
 *
 * A launcher that declines normally (lock held, already disabled) answers
 * `success: true` with `started: false` and a `reason`; only an unexpected
 * failure sets `success: false`.
 */
export async function handleEmbeddingBuildCommand(
  command: EmbeddingBuildCommand,
  socket: WebSocket,
  safeSocketSend: SafeSocketSend,
  backend: EmbeddingCommandBackend = createEmbeddingCommandBackend(),
): Promise<void> {
  const send = createEmbeddingSend(socket, safeSocketSend);
  try {
    const agentId = requireAgentId(command.runtime);
    const mode = command.mode ?? "incremental";
    if (mode !== "incremental" && mode !== "full") {
      throw new Error("invalid_embedding_build_mode");
    }
    const result = await backend.build(agentId, {
      mode,
      keepAfterExit: command.keep_after_exit === true,
    });
    if (!result.ok) {
      const response: EmbeddingBuildResponseMessage = {
        type: "embedding_build_response",
        request_id: command.request_id,
        success: false,
        started: false,
        error: result.error,
      };
      send(response);
      return;
    }
    const response: EmbeddingBuildResponseMessage = {
      type: "embedding_build_response",
      request_id: command.request_id,
      success: true,
      started: result.value.started,
      ...(result.value.buildId === undefined
        ? {}
        : { build_id: result.value.buildId }),
      ...(result.value.reason === undefined
        ? {}
        : { reason: result.value.reason }),
    };
    send(response);
  } catch (error) {
    const response: EmbeddingBuildResponseMessage = {
      type: "embedding_build_response",
      request_id: command.request_id,
      success: false,
      started: false,
      error: getErrorMessage(error),
    };
    send(response);
  }
}

/** `embedding_cancel`: cancel one build, or whichever build is live. */
export async function handleEmbeddingCancelCommand(
  command: EmbeddingCancelCommand,
  socket: WebSocket,
  safeSocketSend: SafeSocketSend,
  backend: EmbeddingCommandBackend = createEmbeddingCommandBackend(),
): Promise<void> {
  const send = createEmbeddingSend(socket, safeSocketSend);
  try {
    const agentId = requireAgentId(command.runtime);
    // `""` is the status snapshot's "no id assigned" sentinel; treat it as the
    // omitted form so a client echoing status can still cancel the live build.
    const buildId =
      command.build_id === undefined || command.build_id.length === 0
        ? undefined
        : command.build_id;
    const result = await backend.cancel(agentId, buildId);
    if (!result.ok) {
      const response: EmbeddingCancelResponseMessage = {
        type: "embedding_cancel_response",
        request_id: command.request_id,
        success: false,
        cancelled: false,
        error: result.error,
      };
      send(response);
      return;
    }
    const response: EmbeddingCancelResponseMessage = {
      type: "embedding_cancel_response",
      request_id: command.request_id,
      success: true,
      cancelled: result.value.cancelled,
    };
    send(response);
  } catch (error) {
    const response: EmbeddingCancelResponseMessage = {
      type: "embedding_cancel_response",
      request_id: command.request_id,
      success: false,
      cancelled: false,
      error: getErrorMessage(error),
    };
    send(response);
  }
}

async function handleEmbeddingProtocolRequest(
  command: EmbeddingProtocolCommand,
  socket: WebSocket,
  safeSocketSend: SafeSocketSend,
  backend: EmbeddingCommandBackend,
): Promise<void> {
  switch (command.type) {
    case "embedding_status":
      await handleEmbeddingStatusCommand(
        command,
        socket,
        safeSocketSend,
        backend,
      );
      return;
    case "embedding_connect":
      await handleEmbeddingConnectCommand(
        command,
        socket,
        safeSocketSend,
        backend,
      );
      return;
    case "embedding_enable":
      await handleEmbeddingEnableCommand(
        command,
        socket,
        safeSocketSend,
        backend,
      );
      return;
    case "embedding_disable":
      await handleEmbeddingDisableCommand(
        command,
        socket,
        safeSocketSend,
        backend,
      );
      return;
    case "embedding_build":
      await handleEmbeddingBuildCommand(
        command,
        socket,
        safeSocketSend,
        backend,
      );
      return;
    case "embedding_cancel":
      await handleEmbeddingCancelCommand(
        command,
        socket,
        safeSocketSend,
        backend,
      );
      return;
    case "embedding_profiles_list":
      await handleEmbeddingProfilesListCommand(
        command,
        socket,
        safeSocketSend,
        backend,
      );
      return;
    case "embedding_profile_select":
      await handleEmbeddingProfileSelectCommand(
        command,
        socket,
        safeSocketSend,
        backend,
      );
      return;
    case "embedding_profile_delete":
      await handleEmbeddingProfileDeleteCommand(
        command,
        socket,
        safeSocketSend,
        backend,
      );
      return;
    case "embedding_profile_pin":
      await handleEmbeddingProfilePinCommand(
        command,
        socket,
        safeSocketSend,
        backend,
      );
      return;
    case "embedding_config_get":
      await handleEmbeddingConfigGetCommand(
        command,
        socket,
        safeSocketSend,
        backend,
      );
      return;
    case "embedding_config_set":
      await handleEmbeddingConfigSetCommand(
        command,
        socket,
        safeSocketSend,
        backend,
      );
      return;
    case "embedding_device":
      await handleEmbeddingDeviceCommand(
        command,
        socket,
        safeSocketSend,
        backend,
      );
      return;
    case "embedding_device_test":
      await handleEmbeddingDeviceTestCommand(
        command,
        socket,
        safeSocketSend,
        backend,
      );
      return;
  }
}

/**
 * Family dispatch: claim exactly the eight embedding commands, queue the reply
 * off the router's await path, and let the other families see the rest.
 *
 * `backend` is the tests'/integration wiring seam; the router calls it without
 * one and therefore gets the placeholder until the real owner is wired.
 */
export function handleEmbeddingProtocolCommand(
  parsed: unknown,
  context: EmbeddingProtocolCommandContext,
  backend: EmbeddingCommandBackend = createEmbeddingCommandBackend(),
): boolean {
  if (
    !isEmbeddingStatusCommand(parsed) &&
    !isEmbeddingConnectCommand(parsed) &&
    !isEmbeddingEnableCommand(parsed) &&
    !isEmbeddingDisableCommand(parsed) &&
    !isEmbeddingBuildCommand(parsed) &&
    !isEmbeddingCancelCommand(parsed) &&
    !isEmbeddingProfilesListCommand(parsed) &&
    !isEmbeddingProfileSelectCommand(parsed) &&
    !isEmbeddingProfileDeleteCommand(parsed) &&
    !isEmbeddingProfilePinCommand(parsed) &&
    !isEmbeddingConfigGetCommand(parsed) &&
    !isEmbeddingConfigSetCommand(parsed) &&
    !isEmbeddingDeviceCommand(parsed) &&
    !isEmbeddingDeviceTestCommand(parsed)
  ) {
    return false;
  }

  const command = parsed;
  const { socket, safeSocketSend, runDetachedListenerTask } = context;
  runDetachedListenerTask("embedding_protocol_command", async () => {
    await handleEmbeddingProtocolRequest(
      command,
      socket,
      safeSocketSend,
      backend,
    );
  });
  return true;
}
