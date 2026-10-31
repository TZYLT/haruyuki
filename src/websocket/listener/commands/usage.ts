import type WebSocket from "ws";
import { isUsageAggregateCommand } from "@/websocket/listener/usage-protocol-inbound";
import type { RunDetachedListenerTask, SafeSocketSend } from "./types";

/**
 * Read-only usage aggregation for app-server clients (M5-A stage 1 scaffold).
 *
 * Stage 1 freezes the wire contract; stage 2 (T3) reads `usage/ledger` and
 * fills `totals`/`runs`. Until then the command answers `not_implemented`.
 */
export type UsageProtocolCommandContext = {
  socket: WebSocket;
  safeSocketSend: SafeSocketSend;
  runDetachedListenerTask: RunDetachedListenerTask;
};

export const USAGE_PROTOCOL_NOT_IMPLEMENTED = "not_implemented";

export function handleUsageProtocolCommand(
  parsed: unknown,
  context: UsageProtocolCommandContext,
): boolean {
  const { socket, safeSocketSend, runDetachedListenerTask } = context;
  if (!isUsageAggregateCommand(parsed)) return false;

  const command = parsed;
  runDetachedListenerTask("usage_protocol_command", async () => {
    safeSocketSend(
      socket,
      {
        type: "usage_aggregate_response",
        request_id: command.request_id,
        success: false,
        totals: {
          turns: 0,
          prompt: 0,
          cachedInput: 0,
          cacheWrite: 0,
          completion: 0,
          reasoning: 0,
          steps: 0,
          wallMs: 0,
          apiMs: 0,
          cost: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 },
        },
        runs: [],
        error: USAGE_PROTOCOL_NOT_IMPLEMENTED,
      },
      "listener_usage_send_failed",
      "listener_usage_protocol",
    );
  });
  return true;
}
