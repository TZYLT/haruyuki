import type { MessageCompactParams } from "@letta-ai/letta-client/resources/conversations/messages";
import type { CompactionTopicReport } from "./task-control-protocol";

/**
 * F-04 multi-step compaction over the app-server protocol (M5-A).
 *
 * `prepare → commit | cancel` split the flow the terminal already runs; the
 * legacy one-shot `conversation_compact` stays for clients that never learned
 * this family. The pending preview lives in listener memory only (user ruling
 * 2026-10-31): a restart drops it, and `commit` answers `prepare_expired`.
 */
export interface CompactionPrepareCommand {
  type: "compaction_prepare";
  request_id: string;
  conversation_id: string;
  /** Forwarded to the summarizer; only `agent_id` is meaningful locally. */
  body?: MessageCompactParams;
}
export interface CompactionPrepareResponseMessage {
  type: "compaction_prepare_response";
  request_id: string;
  success: boolean;
  /**
   * Opaque id for `commit`/`cancel`; `null` when preparation failed. It is a
   * per-conversation handle, not a durable token.
   */
  prepare_id: string | null;
  /** Overview + cut-point table, so the client can show the picker. */
  topic_report: CompactionTopicReport | null;
  error?: string;
}

export interface CompactionCommitCommand {
  type: "compaction_commit";
  request_id: string;
  conversation_id: string;
  prepare_id: string;
  /** 1-based block from `topic_report.blocks`; omitted = the rate's default. */
  block_index?: number;
}
export interface CompactionCommitResponseMessage {
  type: "compaction_commit_response";
  request_id: string;
  success: boolean;
  topic_report?: CompactionTopicReport | null;
  error?: string;
}

export interface CompactionCancelCommand {
  type: "compaction_cancel";
  request_id: string;
  conversation_id: string;
  prepare_id: string;
}
export interface CompactionCancelResponseMessage {
  type: "compaction_cancel_response";
  request_id: string;
  success: boolean;
  /** `false` when the id was unknown/expired/already consumed. */
  cancelled: boolean;
  error?: string;
}
