import type WebSocket from "ws";
import type {
  EmbeddingBuildCommand,
  EmbeddingBuildMode,
  EmbeddingBuildResponseMessage,
  EmbeddingCalibrateCommand,
  EmbeddingCalibrateResponseMessage,
  EmbeddingCalibrationSnapshot,
  EmbeddingCancelCommand,
  EmbeddingCancelResponseMessage,
  EmbeddingConfigureCommand,
  EmbeddingConfigurePatch,
  EmbeddingConfigureResponseMessage,
  EmbeddingDisableCommand,
  EmbeddingDisableResponseMessage,
  EmbeddingEnableCommand,
  EmbeddingEnableResponseMessage,
  EmbeddingResetCommand,
  EmbeddingResetResponseMessage,
  EmbeddingSettingsSnapshot,
  EmbeddingStatusCommand,
  EmbeddingStatusResponseMessage,
  EmbeddingStatusSnapshot,
} from "@/types/embedding-protocol";
import type { AgentRuntimeScope } from "@/types/runtime-scope";
import { getErrorMessage } from "@/utils/error";
import {
  isEmbeddingBuildCommand,
  isEmbeddingCalibrateCommand,
  isEmbeddingCancelCommand,
  isEmbeddingConfigureCommand,
  isEmbeddingConfigurePatch,
  isEmbeddingDisableCommand,
  isEmbeddingEnableCommand,
  isEmbeddingResetCommand,
  isEmbeddingStatusCommand,
} from "@/websocket/listener/embedding-protocol-inbound";
import type { RunDetachedListenerTask, SafeSocketSend } from "./types";

/**
 * R-26 embedding protocol handlers (D2, 48-2 §4.9).
 *
 * The eight commands are thin protocol adapters: they validate the payload,
 * delegate to a narrow `EmbeddingCommandBackend`, and answer with the frozen
 * D1 response shapes. No handler touches settings, the secrets store or the
 * build runner directly — the real owners (D3 settings/secrets, A2 build-state,
 * A3 runner, A4 host) land behind the interface, in one wiring diff.
 *
 * This file is the only place the not-yet-wired backend is stubbed:
 * `createEmbeddingCommandBackend` returns the placeholder. It answers `status`
 * as "not configured" and every write command as a typed `not_configured`
 * failure, so a client sees an honest, actionable state instead of a timeout.
 *
 * The family entry matches the other families: the reply is queued through
 * `runDetachedListenerTask`, so the router's await path never waits on it.
 */

export type EmbeddingProtocolCommandContext = {
  socket: WebSocket;
  safeSocketSend: SafeSocketSend;
  runDetachedListenerTask: RunDetachedListenerTask;
};

/** Code the placeholder backend and the handlers use for "nothing wired yet". */
export const EMBEDDING_NOT_CONFIGURED = "not_configured";
/** The command's runtime scope is malformed (defense in depth; the guard runs first). */
export const EMBEDDING_INVALID_SCOPE = "invalid_embedding_scope";
/** The patch failed the handler-side shape/coherence check. */
export const EMBEDDING_INVALID_PATCH = "invalid_embedding_patch";

/** A write command that the backend declined without throwing. */
export type EmbeddingBackendFailure = { ok: false; error: string };

/** First version of the family's result type; see the backend interface below. */
export type EmbeddingBackendResult<T> =
  | { ok: true; value: T }
  | EmbeddingBackendFailure;

/**
 * `embedding_status` distinguishes "not configured" from "read failed": the
 * former is a normal, renderable state (no space, no endpoint), not an error.
 */
export type EmbeddingStatusBackendResult =
  | { configured: true; status: EmbeddingStatusSnapshot }
  | { configured: false; error: string };

export type EmbeddingConfigureBackendValue = {
  settings: EmbeddingSettingsSnapshot;
  requiresRebuild: boolean;
};
export type EmbeddingEnableBackendValue = {
  enabled: boolean;
  buildStarted: boolean;
};
export type EmbeddingDisableBackendValue = { enabled: boolean };
export type EmbeddingBuildBackendValue = {
  started: boolean;
  buildId?: string;
  reason?: string;
};
export type EmbeddingCancelBackendValue = { cancelled: boolean };
export type EmbeddingResetBackendValue = {
  removedSpaces: number;
  requiresRebuild: boolean;
};
export type EmbeddingCalibrateBackendValue = {
  calibration: EmbeddingCalibrationSnapshot | null;
};

export type EmbeddingBuildOptions = {
  mode: EmbeddingBuildMode;
  keepAfterExit: boolean;
};
export type EmbeddingResetScope = "index" | "all";

/**
 * The narrow seam between the protocol family and the embedding subsystem.
 *
 * Every method is agent-scoped: the vector index is a rebuildable derivative of
 * one agent's local data, so the runtime's conversation id is not a selector.
 * Failures are typed rather than thrown when the subsystem declines normally
 * (disabled, locked, not configured); an unexpected throw is caught by the
 * handler and mapped to the response's `error`.
 */
export interface EmbeddingCommandBackend {
  status(agentId: string): Promise<EmbeddingStatusBackendResult>;
  configure(
    agentId: string,
    patch: EmbeddingConfigurePatch,
  ): Promise<EmbeddingBackendResult<EmbeddingConfigureBackendValue>>;
  enable(
    agentId: string,
  ): Promise<EmbeddingBackendResult<EmbeddingEnableBackendValue>>;
  disable(
    agentId: string,
  ): Promise<EmbeddingBackendResult<EmbeddingDisableBackendValue>>;
  build(
    agentId: string,
    options: EmbeddingBuildOptions,
  ): Promise<EmbeddingBackendResult<EmbeddingBuildBackendValue>>;
  cancel(
    agentId: string,
    buildId: string | undefined,
  ): Promise<EmbeddingBackendResult<EmbeddingCancelBackendValue>>;
  reset(
    agentId: string,
    scope: EmbeddingResetScope,
  ): Promise<EmbeddingBackendResult<EmbeddingResetBackendValue>>;
  calibrate(
    agentId: string,
    persist: boolean,
  ): Promise<EmbeddingBackendResult<EmbeddingCalibrateBackendValue>>;
}

type EmbeddingProtocolCommand =
  | EmbeddingStatusCommand
  | EmbeddingConfigureCommand
  | EmbeddingEnableCommand
  | EmbeddingDisableCommand
  | EmbeddingBuildCommand
  | EmbeddingCancelCommand
  | EmbeddingResetCommand
  | EmbeddingCalibrateCommand;

/** What a command handler sends on the socket; injected so tests stay local. */
type EmbeddingSend = (payload: unknown) => boolean;

function createEmbeddingSend(
  socket: WebSocket,
  safeSocketSend: SafeSocketSend,
): EmbeddingSend {
  return (payload) =>
    safeSocketSend(
      socket,
      payload,
      "listener_embedding_send_failed",
      "listener_embedding_protocol",
    );
}

/**
 * The single placeholder backend for this wave.
 *
 * TODO(integration): replace the method bodies with the real owners — D3
 * (`recall-settings`/`embedding-settings` + the secrets store) for
 * configure/status, A2/A3 (build state/lock/runner) for enable/disable/build/
 * cancel/reset, C5 for calibrate. Callers (the router) must not change: pass a
 * real `EmbeddingCommandBackend` into `handleEmbeddingProtocolCommand`, or
 * override individual methods through `deps` while pieces land.
 */
export function createEmbeddingCommandBackend(
  deps: Partial<EmbeddingCommandBackend> = {},
): EmbeddingCommandBackend {
  const notConfigured = async (): Promise<EmbeddingBackendFailure> => ({
    ok: false,
    error: EMBEDDING_NOT_CONFIGURED,
  });
  const notConfiguredStatus =
    async (): Promise<EmbeddingStatusBackendResult> => ({
      configured: false,
      error: EMBEDDING_NOT_CONFIGURED,
    });
  return {
    status: deps.status ?? notConfiguredStatus,
    configure: deps.configure ?? notConfigured,
    enable: deps.enable ?? notConfigured,
    disable: deps.disable ?? notConfigured,
    build: deps.build ?? notConfigured,
    cancel: deps.cancel ?? notConfigured,
    reset: deps.reset ?? notConfigured,
    calibrate: deps.calibrate ?? notConfigured,
  };
}

/** Reject a runtime scope that is not a complete agent/conversation address. */
function requireAgentId(scope: AgentRuntimeScope): string {
  if (
    typeof scope.agent_id !== "string" ||
    scope.agent_id.length === 0 ||
    typeof scope.conversation_id !== "string" ||
    scope.conversation_id.length === 0
  ) {
    throw new Error(EMBEDDING_INVALID_SCOPE);
  }
  return scope.agent_id;
}

/**
 * Handler-side patch coherence, on top of the D1 shape guard.
 *
 * The wire guard already bounds every scalar; the cross-field rules the guard
 * deliberately leaves to the handler are checked here. Returning a code keeps
 * the response's `error` actionable instead of a sentence the client must parse.
 */
function validateConfigurePatch(patch: EmbeddingConfigurePatch): string | null {
  if (patch.backend === "endpoint" && !patch.endpoint) {
    return "embedding_endpoint_config_required";
  }
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
 * `embedding_configure`: a patch onto the resolved settings.
 *
 * `api_key` is write-only (48-2 O-18): it is validated and forwarded to the
 * backend, which persists it through the secrets store; no branch below copies
 * it into the response.
 */
export async function handleEmbeddingConfigureCommand(
  command: EmbeddingConfigureCommand,
  socket: WebSocket,
  safeSocketSend: SafeSocketSend,
  backend: EmbeddingCommandBackend = createEmbeddingCommandBackend(),
): Promise<void> {
  const send = createEmbeddingSend(socket, safeSocketSend);
  try {
    const agentId = requireAgentId(command.runtime);
    if (!isEmbeddingConfigurePatch(command.patch)) {
      throw new Error(EMBEDDING_INVALID_PATCH);
    }
    const invalid = validateConfigurePatch(command.patch);
    if (invalid !== null) throw new Error(invalid);
    const result = await backend.configure(agentId, command.patch);
    if (!result.ok) {
      const response: EmbeddingConfigureResponseMessage = {
        type: "embedding_configure_response",
        request_id: command.request_id,
        success: false,
        settings: null,
        requires_rebuild: false,
        error: result.error,
      };
      send(response);
      return;
    }
    const response: EmbeddingConfigureResponseMessage = {
      type: "embedding_configure_response",
      request_id: command.request_id,
      success: true,
      settings: result.value.settings,
      requires_rebuild: result.value.requiresRebuild,
    };
    send(response);
  } catch (error) {
    const response: EmbeddingConfigureResponseMessage = {
      type: "embedding_configure_response",
      request_id: command.request_id,
      success: false,
      settings: null,
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
    const result = await backend.cancel(agentId, command.build_id);
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

/** `embedding_reset`: drop vector spaces (`index`) and optionally calibration. */
export async function handleEmbeddingResetCommand(
  command: EmbeddingResetCommand,
  socket: WebSocket,
  safeSocketSend: SafeSocketSend,
  backend: EmbeddingCommandBackend = createEmbeddingCommandBackend(),
): Promise<void> {
  const send = createEmbeddingSend(socket, safeSocketSend);
  try {
    const agentId = requireAgentId(command.runtime);
    const scope = command.scope ?? "index";
    if (scope !== "index" && scope !== "all") {
      throw new Error("invalid_embedding_reset_scope");
    }
    const result = await backend.reset(agentId, scope);
    if (!result.ok) {
      const response: EmbeddingResetResponseMessage = {
        type: "embedding_reset_response",
        request_id: command.request_id,
        success: false,
        removed_spaces: 0,
        requires_rebuild: false,
        error: result.error,
      };
      send(response);
      return;
    }
    const response: EmbeddingResetResponseMessage = {
      type: "embedding_reset_response",
      request_id: command.request_id,
      success: true,
      removed_spaces: result.value.removedSpaces,
      requires_rebuild: result.value.requiresRebuild,
    };
    send(response);
  } catch (error) {
    const response: EmbeddingResetResponseMessage = {
      type: "embedding_reset_response",
      request_id: command.request_id,
      success: false,
      removed_spaces: 0,
      requires_rebuild: false,
      error: getErrorMessage(error),
    };
    send(response);
  }
}

/** `embedding_calibrate`: run the bounded ≤5s pass and optionally persist it. */
export async function handleEmbeddingCalibrateCommand(
  command: EmbeddingCalibrateCommand,
  socket: WebSocket,
  safeSocketSend: SafeSocketSend,
  backend: EmbeddingCommandBackend = createEmbeddingCommandBackend(),
): Promise<void> {
  const send = createEmbeddingSend(socket, safeSocketSend);
  try {
    const agentId = requireAgentId(command.runtime);
    const result = await backend.calibrate(agentId, command.persist ?? true);
    if (!result.ok) {
      const response: EmbeddingCalibrateResponseMessage = {
        type: "embedding_calibrate_response",
        request_id: command.request_id,
        success: false,
        calibration: null,
        error: result.error,
      };
      send(response);
      return;
    }
    const response: EmbeddingCalibrateResponseMessage = {
      type: "embedding_calibrate_response",
      request_id: command.request_id,
      success: true,
      calibration: result.value.calibration,
    };
    send(response);
  } catch (error) {
    const response: EmbeddingCalibrateResponseMessage = {
      type: "embedding_calibrate_response",
      request_id: command.request_id,
      success: false,
      calibration: null,
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
    case "embedding_configure":
      await handleEmbeddingConfigureCommand(
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
    case "embedding_reset":
      await handleEmbeddingResetCommand(
        command,
        socket,
        safeSocketSend,
        backend,
      );
      return;
    case "embedding_calibrate":
      await handleEmbeddingCalibrateCommand(
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
    !isEmbeddingConfigureCommand(parsed) &&
    !isEmbeddingEnableCommand(parsed) &&
    !isEmbeddingDisableCommand(parsed) &&
    !isEmbeddingBuildCommand(parsed) &&
    !isEmbeddingCancelCommand(parsed) &&
    !isEmbeddingResetCommand(parsed) &&
    !isEmbeddingCalibrateCommand(parsed)
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
