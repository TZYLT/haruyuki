import type { MessageCompactParams } from "@letta-ai/letta-client/resources/conversations/messages";
import type WebSocket from "ws";
import { formatCompactPlanningFailure } from "@/agent/compaction-execute";
import { getBackend } from "@/backend";
import { LocalBackend } from "@/backend/local/local-backend";
import type {
  CompactionCancelCommand,
  CompactionCancelResponseMessage,
  CompactionCommitCommand,
  CompactionCommitResponseMessage,
  CompactionPrepareCommand,
  CompactionPrepareResponseMessage,
} from "@/types/compaction-protocol";
import { COMPACTION_PREPARE_EXPIRED_TEXT } from "@/websocket/listener/compaction-pending";
import {
  isCompactionCancelCommand,
  isCompactionCommitCommand,
  isCompactionPrepareCommand,
} from "@/websocket/listener/compaction-protocol-inbound";
import {
  cancelListenerLocalCompaction,
  commitListenerLocalCompaction,
  prepareListenerLocalCompaction,
} from "@/websocket/listener/local-compaction";
import type { RunDetachedListenerTask, SafeSocketSend } from "./types";

/**
 * F-04 multi-step compaction protocol handlers (M5-A stage 2).
 *
 * `compaction_prepare` runs the summarizer once and parks the preview in the
 * listener's process-local store (user ruling 2026-10-31: no persistence; a
 * restart answers `prepare_expired`). `commit` applies a pick from the table
 * `prepare` published and `cancel` drops it; both settle the summarizer's spend
 * exactly once (§5.14). The backend is the local one — the cloud compaction
 * command was never a multi-step flow, so there is nothing to prepare.
 *
 * The one-shot `conversation_compact` is not this family: it stays on
 * `runListenerLocalCompaction`, the same prepare→commit implementation without
 * a wire round-trip in between (R7).
 */
export type CompactionProtocolCommandContext = {
  socket: WebSocket;
  safeSocketSend: SafeSocketSend;
  runDetachedListenerTask: RunDetachedListenerTask;
};

/**
 * What a non-local backend answers. The route's additive rule (§4.1) means the
 * commands exist everywhere, but only the local backend has this pipeline.
 */
export const COMPACTION_LOCAL_BACKEND_REQUIRED_TEXT =
  "not_supported: compaction_prepare/commit/cancel require the local backend";

type CompactionResponder = (payload: unknown) => boolean;

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
    const send: CompactionResponder = (payload) =>
      safeSocketSend(
        socket,
        payload,
        "listener_compaction_send_failed",
        "listener_compaction_protocol",
      );
    const backend = getBackend();
    const local = backend instanceof LocalBackend ? backend : null;
    switch (command.type) {
      case "compaction_prepare":
        await respondPrepare(command, local, send);
        return;
      case "compaction_commit":
        await respondCommit(command, local, send);
        return;
      case "compaction_cancel":
        await respondCancel(command, local, send);
        return;
    }
  });
  return true;
}

async function respondPrepare(
  command: CompactionPrepareCommand,
  local: LocalBackend | null,
  send: CompactionResponder,
): Promise<void> {
  const requestId = command.request_id;
  if (local === null) {
    send({
      type: "compaction_prepare_response",
      request_id: requestId,
      success: false,
      prepare_id: null,
      topic_report: null,
      error: COMPACTION_LOCAL_BACKEND_REQUIRED_TEXT,
    } satisfies CompactionPrepareResponseMessage);
    return;
  }
  const requestedAgentId = requestedAgentIdOf(command.body);
  try {
    const prepared = await prepareListenerLocalCompaction({
      backend: local,
      conversationId: command.conversation_id,
      ...(requestedAgentId === undefined ? {} : { agentId: requestedAgentId }),
    });
    if (prepared.kind === "cancelled") {
      send({
        type: "compaction_prepare_response",
        request_id: requestId,
        success: false,
        prepare_id: null,
        topic_report: null,
        error: prepared.receipt,
      } satisfies CompactionPrepareResponseMessage);
      return;
    }
    send({
      type: "compaction_prepare_response",
      request_id: requestId,
      success: true,
      prepare_id: prepared.prepareId,
      // No `applied`: nothing has been written when the picker sees this.
      topic_report: prepared.report,
    } satisfies CompactionPrepareResponseMessage);
  } catch (error) {
    send({
      type: "compaction_prepare_response",
      request_id: requestId,
      success: false,
      prepare_id: null,
      topic_report: null,
      // The planner's own two "too short" cases surface as actionable copy
      // (§5.9): "Nothing to trim", not an internal message.
      error: formatCompactPlanningFailure(error),
    } satisfies CompactionPrepareResponseMessage);
  }
}

async function respondCommit(
  command: CompactionCommitCommand,
  local: LocalBackend | null,
  send: CompactionResponder,
): Promise<void> {
  const requestId = command.request_id;
  if (local === null) {
    send({
      type: "compaction_commit_response",
      request_id: requestId,
      success: false,
      topic_report: null,
      error: COMPACTION_LOCAL_BACKEND_REQUIRED_TEXT,
    } satisfies CompactionCommitResponseMessage);
    return;
  }
  try {
    const committed = await commitListenerLocalCompaction({
      backend: local,
      conversationId: command.conversation_id,
      prepareId: command.prepare_id,
      ...(command.block_index === undefined
        ? {}
        : { blockIndex: command.block_index }),
    });
    send({
      type: "compaction_commit_response",
      request_id: requestId,
      success: true,
      topic_report: committed.report,
    } satisfies CompactionCommitResponseMessage);
  } catch (error) {
    send({
      type: "compaction_commit_response",
      request_id: requestId,
      success: false,
      topic_report: null,
      error: getErrorMessage(error, "Failed to commit compaction"),
    } satisfies CompactionCommitResponseMessage);
  }
}

async function respondCancel(
  command: CompactionCancelCommand,
  local: LocalBackend | null,
  send: CompactionResponder,
): Promise<void> {
  const requestId = command.request_id;
  if (local === null) {
    send({
      type: "compaction_cancel_response",
      request_id: requestId,
      success: false,
      cancelled: false,
      error: COMPACTION_LOCAL_BACKEND_REQUIRED_TEXT,
    } satisfies CompactionCancelResponseMessage);
    return;
  }
  try {
    const cancelled = await cancelListenerLocalCompaction({
      conversationId: command.conversation_id,
      prepareId: command.prepare_id,
    });
    if (cancelled) {
      send({
        type: "compaction_cancel_response",
        request_id: requestId,
        success: true,
        cancelled: true,
      } satisfies CompactionCancelResponseMessage);
      return;
    }
    send({
      type: "compaction_cancel_response",
      request_id: requestId,
      success: false,
      cancelled: false,
      error: COMPACTION_PREPARE_EXPIRED_TEXT,
    } satisfies CompactionCancelResponseMessage);
  } catch (error) {
    send({
      type: "compaction_cancel_response",
      request_id: requestId,
      success: false,
      cancelled: false,
      error: getErrorMessage(error, "Failed to cancel compaction"),
    } satisfies CompactionCancelResponseMessage);
  }
}

/**
 * The requested summarizer agent, if the client named one. Only `agent_id` is
 * meaningful on the local backend (the wire type is the hosted `body`).
 */
function requestedAgentIdOf(
  body: MessageCompactParams | undefined,
): string | undefined {
  const record = body as Record<string, unknown> | undefined;
  const agentId = record?.agent_id;
  return typeof agentId === "string" && agentId.length > 0
    ? agentId
    : undefined;
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
