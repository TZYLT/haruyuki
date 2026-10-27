import type { AgentRuntimeScope } from "./runtime-scope";

/** Run a slash command in an agent conversation. */
export interface ExecuteCommandCommand {
  type: "execute_command";
  command_id: string;
  request_id: string;
  runtime: AgentRuntimeScope;
  /** Everything after the command name. */
  args?: string;
}

/**
 * One row of F-04's cut-point table, as a client renders it.
 *
 * `index` is the display number `/compact <n>` names (1-based, oldest first).
 * It is computed per call and never persisted (requirement §5.6.2): the stable
 * identity is `boundary_message_id`, the first message the block keeps.
 */
export interface CompactionTopicBlock {
  index: number;
  /** The topic this block belongs to; `null` for the unmarked current topic. */
  title: string | null;
  /** The topic's one-line record (its "section"), when it has one. */
  summary: string | null;
  /** Who wrote the marker that ends this block; `null` for the current topic. */
  created_by: "agent" | "user" | "summarizer" | null;
  boundary_message_id: string;
  message_count: number;
  tokens: number;
  /** ISO timestamp of the block's first message. */
  starts_at: string;
}

/**
 * What one F-04 compaction produced, for clients that have no picker of their
 * own (the desktop app-server, headless).
 *
 * Purely additive on every response that carries it: an older client ignores
 * the field and keeps reading the legacy `compaction`/`output` payload.
 */
export interface CompactionTopicReport {
  /** The model the summarizer call ran on. */
  model: string;
  /** The overview now at the head of the context, as markdown. */
  overview: string;
  /** The cut-point table: marker-derived blocks plus the summarizer's own. */
  blocks: CompactionTopicBlock[];
  /** The block the compression rate keeps — the default choice. */
  suggestion_index: number;
  /**
   * How many blocks existed *before* the summarizer ran. `/compact <n>` is
   * resolved against the preview's table; this is what the caller had seen.
   */
  numbered_blocks: number;
  /** True when the summarizer's output was unusable and one section was kept. */
  degraded: boolean;
  /**
   * Why, when `degraded` is true: `"refusal"` for a model that refused or was
   * unavailable (§5.9.3①), `"format"` for a structured answer that was unusable
   * twice (§5.9.3②). `null` on a clean run.
   *
   * Additive: `degraded` stays the boolean an older client reads, and this names
   * the cause so a client can say which of the two happened instead of reporting
   * both as "one whole-section summary".
   */
  degraded_kind?: "refusal" | "format" | null;
  /** Numbers only; the calling layer writes the ledger row (§5.14). */
  usage: {
    prompt_tokens: number;
    cached_input_tokens: number;
    completion_tokens: number;
    wall_ms: number;
  };
  /** What the write-back did with the chosen cut. */
  applied: {
    executed: boolean;
    /** The topic the kept region starts in; `null` = the current topic. */
    kept_topic: string | null;
    /** Titles of the topics this cut folded into the overview, oldest first. */
    folded_topics: string[];
    messages_before: number;
    messages_after: number;
  };
}

export interface ExecuteCommandResponseMessage {
  type: "execute_command_response";
  request_id: string;
  success: boolean;
  output: string;
  /**
   * F-04: present only for a local `/compact`, so a client without a terminal can
   * show what the summarizer found and which cut the default took.
   */
  topic_report?: CompactionTopicReport;
}

/** Remove a queued input without stopping the active turn. */
export interface RemoveQueueItemCommand {
  type: "remove_queue_item";
  request_id: string;
  runtime: AgentRuntimeScope;
  item_id: string;
}

export interface RemoveQueueItemResponse {
  type: "remove_queue_item_response";
  request_id: string;
  success: boolean;
  item_id: string;
}

export interface MonitorStopCommand {
  type: "monitor_stop";
  request_id: string;
  runtime: AgentRuntimeScope;
  process_id: string;
}

export interface MonitorStopResponse {
  type: "monitor_stop_response";
  request_id: string;
  runtime: AgentRuntimeScope;
  process_id: string;
  success: boolean;
  stopped: boolean;
  error?: string;
}
