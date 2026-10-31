import type WebSocket from "ws";
import {
  isCompactionCancelCommand,
  isCompactionCommitCommand,
  isCompactionPrepareCommand,
} from "@/websocket/listener/compaction-protocol-inbound";
import type { RunDetachedListenerTask, SafeSocketSend } from "./types";

/**
 * F-04 multi-step compaction protocol handlers (M5-A stage 1 scaffold).
 *
 * Stage 1 freezes the wire contract; stage 2 (T4) implements the in-memory
 * pending preview, `commit`, `cancel` and the `conversation_compact` bridge.
 * Until then every command answers `not_implemented`.
 */
export type CompactionProtocolCommandContext = {
  socket: WebSocket;
  safeSocketSend: SafeSocketSend;
  runDetachedListenerTask: RunDetachedListenerTask;
};

export const COMPACTION_PROTOCOL_NOT_IMPLEMENTED = "not_implemented";

export function handleCompactionProtocolCommand(
  parsed: unknown,
  context: CompactionProtocolCommandContext,
): boolean {
  const { socket, safeSocketSend, runDetachedListenerTask } = context;
  if (
    !isCompactionPrepareCommand(parsed) &&
    !isCompactionCommitCommand(parsed) &&
    !isCompactionCancelCommand(parsed)
  ) {
    return false;
  }

  const command = parsed;
  runDetachedListenerTask("compaction_protocol_command", async () => {
    const send = (payload: unknown) =>
      safeSocketSend(
        socket,
        payload,
        "listener_compaction_send_failed",
        "listener_compaction_protocol",
      );
    switch (command.type) {
      case "compaction_prepare":
        send({
          type: "compaction_prepare_response",
          request_id: command.request_id,
          success: false,
          prepare_id: null,
          topic_report: null,
          error: COMPACTION_PROTOCOL_NOT_IMPLEMENTED,
        });
        return;
      case "compaction_commit":
        send({
          type: "compaction_commit_response",
          request_id: command.request_id,
          success: false,
          topic_report: null,
          error: COMPACTION_PROTOCOL_NOT_IMPLEMENTED,
        });
        return;
      case "compaction_cancel":
        send({
          type: "compaction_cancel_response",
          request_id: command.request_id,
          success: false,
          cancelled: false,
          error: COMPACTION_PROTOCOL_NOT_IMPLEMENTED,
        });
        return;
    }
  });
  return true;
}
