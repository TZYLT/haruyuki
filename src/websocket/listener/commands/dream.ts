import type WebSocket from "ws";
import {
  isDreamRunCommand,
  isDreamStatusCommand,
  isGetDreamSettingsCommand,
  isSetDreamSettingsCommand,
} from "@/websocket/listener/dream-protocol-inbound";
import type { RunDetachedListenerTask, SafeSocketSend } from "./types";

/**
 * F-06 dream protocol handlers (M5-A stage 1 scaffold).
 *
 * Stage 1 freezes the wire contract and the dispatch path; stage 2 fills the
 * bodies (`dream_status`, `dream_run`, settings read/write, device-status
 * summary). Until then every command answers `not_implemented` — the stub is
 * intentionally loud so it cannot ship unnoticed.
 */
export type DreamProtocolCommandContext = {
  socket: WebSocket;
  safeSocketSend: SafeSocketSend;
  runDetachedListenerTask: RunDetachedListenerTask;
};

export const DREAM_PROTOCOL_NOT_IMPLEMENTED = "not_implemented";

export function handleDreamProtocolCommand(
  parsed: unknown,
  context: DreamProtocolCommandContext,
): boolean {
  const { socket, safeSocketSend, runDetachedListenerTask } = context;
  if (
    !isDreamStatusCommand(parsed) &&
    !isDreamRunCommand(parsed) &&
    !isGetDreamSettingsCommand(parsed) &&
    !isSetDreamSettingsCommand(parsed)
  ) {
    return false;
  }

  const command = parsed;
  runDetachedListenerTask("dream_protocol_command", async () => {
    const send = (payload: unknown) =>
      safeSocketSend(
        socket,
        payload,
        "listener_dream_send_failed",
        "listener_dream_protocol",
      );
    switch (command.type) {
      case "dream_status":
        send({
          type: "dream_status_response",
          request_id: command.request_id,
          success: false,
          status: null,
          error: DREAM_PROTOCOL_NOT_IMPLEMENTED,
        });
        return;
      case "dream_run":
        send({
          type: "dream_run_response",
          request_id: command.request_id,
          success: false,
          started: false,
          error: DREAM_PROTOCOL_NOT_IMPLEMENTED,
        });
        return;
      case "get_dream_settings":
        send({
          type: "get_dream_settings_response",
          request_id: command.request_id,
          success: false,
          settings: null,
          error: DREAM_PROTOCOL_NOT_IMPLEMENTED,
        });
        return;
      case "set_dream_settings":
        send({
          type: "set_dream_settings_response",
          request_id: command.request_id,
          success: false,
          settings: null,
          error: DREAM_PROTOCOL_NOT_IMPLEMENTED,
        });
        return;
    }
  });
  return true;
}
