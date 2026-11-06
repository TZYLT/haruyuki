/**
 * Small shared pieces of the embedding protocol family (D1/D2).
 *
 * Both the base command handlers and the profile/config/device handlers need
 * the same envelope checks and socket send. Keeping them here avoids an import
 * cycle between the two handler modules and keeps each below the size ceiling.
 */

import type WebSocket from "ws";
import type { AgentRuntimeScope } from "@/types/runtime-scope";
import type { SafeSocketSend } from "./types";

/** The command's runtime scope is malformed (defense in depth; the guard runs first). */
export const EMBEDDING_INVALID_SCOPE = "invalid_embedding_scope";
/** The patch failed the handler-side shape/coherence check. */
export const EMBEDDING_INVALID_PATCH = "invalid_embedding_patch";

/** What a command handler sends on the socket; injected so tests stay local. */
export type EmbeddingSend = (payload: unknown) => boolean;

export function createEmbeddingSend(
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

/** Reject a runtime scope that is not a complete agent/conversation address. */
export function requireAgentId(scope: AgentRuntimeScope): string {
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
