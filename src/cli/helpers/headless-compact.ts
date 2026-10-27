/**
 * F-04's `/compact` for the paths that have no picker: the listener and
 * headless.
 *
 * Both paths run the same three steps as the TUI — `prepare` once, resolve a
 * pick, `apply` — and differ only in what they do with the answer. This module
 * owns that shared run, the ledger row it owes (§5.14), the receipt, and the
 * wire report, so neither caller re-implements the ordering:
 *
 * ```
 * prepare ──cancelled──→ nothing written, one "cancelled" ledger row
 *    └──preview──→ pick (block n, or the rate's default) ──→ apply
 *                                                        └──→ ledger + receipt
 * ```
 *
 * It deliberately lives outside `headless.ts` (on the size ratchet) and outside
 * the TUI's `submit-compact-commands.ts` (that module owns the picker): headless
 * has no slash registry (§8-6), so `/compact` has to be recognised on the input
 * path itself, and the listener needs the same execution.
 */
import { randomUUID } from "node:crypto";
import type { Backend } from "@/backend";
import {
  type CompactionPreview,
  type CompactPick,
  renderCompactionOverview,
} from "@/backend/local/compaction-preview";
import type { CompactionApplyResult } from "@/backend/local/compaction-run";
import { CompactionCancelledError } from "@/backend/local/compaction-summarizer";
import { LocalBackend } from "@/backend/local/local-backend";
import type { TopicBlock } from "@/backend/local/topic-compaction";
import type { ResultMessage } from "@/types/protocol";
import type { CompactionTopicReport } from "@/types/task-control-protocol";
import {
  type CompactionUsageOutcome,
  recordCompactionUsage,
} from "@/usage/compaction-usage";
import {
  COMPACT_MODE_LOCAL_UNSUPPORTED,
  formatCompactNoopReason,
  formatCompactPlanningFailure,
  parseCompactCommandArgs,
} from "./compact-command";

/**
 * The slash commands headless can actually answer.
 *
 * Reported as `slash_commands` on the init event so an SDK client knows what it
 * may send. This is a *report*, not a dispatcher: headless has no registry, and
 * `/compact` is recognised on the input path (§8-6).
 */
export const HEADLESS_SLASH_COMMANDS: readonly string[] = ["compact"];

/**
 * Headless usage text.
 *
 * Deliberately not `COMPACT_COMMAND_USAGE`: that copy tells the reader to "pick
 * a topic block", which this mode cannot do — with no picker, a bare `/compact`
 * compresses by the rate (route C-28).
 */
export const HEADLESS_COMPACT_USAGE = [
  "/compact [n]",
  "",
  "Summarize the older part of this conversation and keep the rest.",
  "",
  "USAGE",
  "  /compact        — compress by the compression rate (there is no picker here)",
  "  /compact <n>    — keep block n of the cut-point table",
  "  /compact help   — show this help",
  "",
  "Without a number the rate decides, and the receipt names the cut it took.",
  "`/topic list` (or the TUI) shows the numbered blocks.",
].join("\n");

/** What a `/compact` line on the input path asked for. */
export type HeadlessCompactRequest =
  | { kind: "help" }
  | { kind: "compact"; blockIndex?: number }
  | { kind: "invalid"; message: string };

/**
 * Recognise `/compact` in a user-typed line, or return `null`.
 *
 * Everything else is ordinary prompt text and must stay that way: a message that
 * merely mentions `/compact` is not a command.
 */
export function parseHeadlessCompactInput(
  input: string,
): HeadlessCompactRequest | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const [word, ...rest] = trimmed.split(/\s+/);
  if (word !== "/compact") return null;
  const parsed = parseCompactCommandArgs(rest);
  switch (parsed.kind) {
    case "help":
      return { kind: "help" };
    case "block":
      return { kind: "compact", blockIndex: parsed.index };
    case "invalid":
      return { kind: "invalid", message: parsed.message };
    case "mode":
      // Mode words are the cloud backend's; a local compaction always uses the
      // sliding-window strategy (§5.13).
      return { kind: "invalid", message: COMPACT_MODE_LOCAL_UNSUPPORTED };
    default:
      return { kind: "compact" };
  }
}

/**
 * Where a `/compact <n>` points, as the frozen `CompactPick` the write-back takes.
 *
 * The block number is 1-based and resolved against the table the caller was
 * looking at *before* the summarizer ran — `/topic list`'s numbering
 * (requirement §5.6.3, Q-08). That lock has to happen before `prepare`, because
 * the summarizer adds boundaries of its own and a number resolved afterwards
 * would name a block the user never saw. The identity handed to `apply` is the
 * block's boundary message id, never the row.
 */
export function resolveCompactionPick(
  blocks: readonly TopicBlock[],
  blockIndex: number | undefined,
): CompactPick {
  if (blockIndex === undefined) return { kind: "ratio_suggestion" };
  const block = blocks[blockIndex - 1];
  if (!block) {
    const count = `${blocks.length} block${blocks.length === 1 ? "" : "s"}`;
    throw new Error(
      `There is no topic block ${blockIndex}: this context has ${count}. Run /topic list to list them, or /compact with no number to compress by the rate.`,
    );
  }
  return { kind: "message", messageId: block.boundaryMessageId };
}

export interface LocalCompactionRunInput {
  backend: LocalBackend;
  conversationId: string;
  /** When omitted the preview's own agent id is used (and the ledger's too). */
  agentId?: string;
  /** 1-based block from `/compact <n>`; omitted = the rate's default choice. */
  blockIndex?: number;
  signal?: AbortSignal;
  /** Tests point this at a temporary ledger; production reads the default. */
  ledgerPath?: string;
}

export type LocalCompactionOutcome =
  | {
      kind: "completed";
      preview: CompactionPreview;
      result: CompactionApplyResult;
      receipt: string;
      report: CompactionTopicReport;
    }
  | { kind: "cancelled"; receipt: string };

/** The one sentence a cancelled compaction says, in every path that can cancel. */
const COMPACT_CANCELLED_TEXT = "Cancelled: the context is unchanged.";

/**
 * Run `prepare → pick → apply` and record the ledger row, whatever happens.
 *
 * A cancelled or failed run writes nothing but the ledger: the preview is
 * dropped whole (requirement §5.9.1), so there is nothing to undo. The ledger
 * row is written *before* the caller reports, so the receipt and the ledger
 * cannot disagree about whether the run happened (§5.14).
 */
export async function runLocalCompaction(
  input: LocalCompactionRunInput,
): Promise<LocalCompactionOutcome> {
  let preview: CompactionPreview | null = null;
  let outcome: CompactionUsageOutcome = "completed";
  try {
    // §5.6.3: resolve `n` against the numbering table the user was looking at
    // and lock the identity *before* the summarizer adds boundaries of its own.
    // A number this context does not have refuses here, without paying for a
    // provider call. Without a number there is nothing to lock, so the backend
    // is not touched at all.
    const pick =
      input.blockIndex === undefined
        ? { kind: "ratio_suggestion" as const }
        : resolveCompactionPick(
            input.backend.listTopics(input.conversationId, input.agentId)
              .blocks,
            input.blockIndex,
          );
    preview = await input.backend.prepareCompaction({
      conversationId: input.conversationId,
      ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    const result = await input.backend.applyCompaction({ preview, pick });
    return {
      kind: "completed",
      preview,
      result,
      receipt: formatLocalCompactionReceipt(preview, result),
      report: buildCompactionTopicReport(preview, result),
    };
  } catch (error) {
    if (error instanceof CompactionCancelledError) {
      outcome = "cancelled";
      return { kind: "cancelled", receipt: COMPACT_CANCELLED_TEXT };
    }
    outcome = "failed";
    throw error;
  } finally {
    await recordCompactionRun(input, preview, outcome);
  }
}

/**
 * One ledger row per attempt (§5.14): numbers and ids only.
 *
 * A call that never answered has no model to name. It stays empty rather than
 * guessing, because a guessed model would be aggregated as if the summarizer had
 * really run on it — the same rule the TUI's path follows.
 *
 * The agent id has to come from the caller or the preview. It is deliberately not
 * looked up through `retrieveConversation`: on the local backend that call
 * *creates* an unknown conversation, so bookkeeping on a failed compaction would
 * turn a zero-write exit into a write (§5.9.1). A caller that cannot name the
 * agent therefore writes no row for a failure that never reached a preview —
 * but every successful run and every failed write-back still lands.
 */
async function recordCompactionRun(
  input: LocalCompactionRunInput,
  preview: CompactionPreview | null,
  outcome: CompactionUsageOutcome,
): Promise<void> {
  const agentId = input.agentId ?? preview?.agentId;
  if (agentId === undefined) return;
  const usage = preview?.usage;
  await recordCompactionUsage(
    {
      agentId,
      conversationId: input.conversationId,
      model: preview?.model ?? "",
      promptTokens: usage?.promptTokens ?? 0,
      cachedInputTokens: usage?.cachedInputTokens ?? 0,
      completionTokens: usage?.completionTokens ?? 0,
      wallMs: usage?.wallMs ?? 0,
      outcome,
    },
    input.ledgerPath === undefined ? {} : { path: input.ledgerPath },
  );
}

/** Which cut the receipt should name, in the words the old receipt used. */
function cutPointLabel(result: CompactionApplyResult): string {
  switch (result.source) {
    case "topic_pick":
      return "the topic block you picked";
    case "ratio_cap":
      return "compression rate (the picked block kept more than the rate allows)";
    default:
      return "compression rate (no marker defines a boundary here, so it decided)";
  }
}

/**
 * The receipt (§5.14): what the summarizer wrote, what the context weighs now,
 * and what the call cost.
 *
 * Mirrors the TUI's `formatCompactionReceipt` copy. The two live apart because
 * that one is inside the picker's module; consolidating them into
 * `cli/helpers/compact-command.ts` is a follow-up, not a reason for the
 * listener to import the TUI shell.
 */
export function formatLocalCompactionReceipt(
  preview: CompactionPreview,
  result: CompactionApplyResult,
): string {
  if (!result.executed) {
    return [
      "Nothing was written: there is no cut point to take here.",
      `  reason:     ${formatCompactNoopReason(result.noopReason)}`,
      `  context:    ${result.numMessagesBefore} messages · ~${result.retainedTokens} tokens`,
    ].join("\n");
  }

  const overview = renderCompactionOverview(preview.overview);
  const folded = result.foldedTitles.length;
  const cap =
    result.retentionCapTokens === null
      ? ""
      : ` · cap ~${result.retentionCapTokens}`;
  const lines = [
    "Compaction complete.",
    `  summary:    ${overview.length} characters · ${folded} topic${folded === 1 ? "" : "s"} folded${folded > 0 ? ` (${result.foldedTitles.join(", ")})` : ""}`,
    `  tokens:     ~${result.summarizedTokens} → ~${result.retainedTokens} (${result.numMessagesBefore} → ${result.numMessagesAfter} messages${cap})`,
    `  cut point:  ${cutPointLabel(result)}`,
    `  model:      ${preview.model} · ${(preview.usage.wallMs / 1000).toFixed(1)}s`,
    `  usage:      ${preview.usage.promptTokens} prompt (${preview.usage.cachedInputTokens} cached) · ${preview.usage.completionTokens} completion`,
  ];
  if (preview.degraded === "whole-section") {
    lines.push(
      "  note:       this run produced no topics (one whole-section summary)",
    );
  }
  lines.push(
    "  note:       the next turn re-reads the prefix, so it evicts the provider cache",
  );
  return lines.join("\n");
}

/**
 * The overview and cut-point table, as a client without a picker reads them.
 *
 * Purely derived from the preview and the apply result: it names the default the
 * rate took (`suggestion_index`) and what the write-back actually did, so a
 * desktop client can show the same story the TUI's receipt tells.
 */
export function buildCompactionTopicReport(
  preview: CompactionPreview,
  result: CompactionApplyResult,
): CompactionTopicReport {
  return {
    model: preview.model,
    overview: renderCompactionOverview(preview.overview),
    blocks: preview.blocks.map((block) => ({
      index: block.index,
      title: block.title,
      summary: block.summary ?? null,
      created_by: block.createdBy,
      boundary_message_id: block.boundaryMessageId,
      message_count: block.messageCount,
      tokens: block.tokens,
      starts_at: block.startsAt,
    })),
    suggestion_index: preview.suggestionIndex,
    numbered_blocks: preview.numberedBlocks,
    degraded: preview.degraded === "whole-section",
    usage: {
      prompt_tokens: preview.usage.promptTokens,
      cached_input_tokens: preview.usage.cachedInputTokens,
      completion_tokens: preview.usage.completionTokens,
      wall_ms: preview.usage.wallMs,
    },
    applied: {
      executed: result.executed,
      kept_topic: result.topicTitle,
      folded_topics: [...result.foldedTitles],
      messages_before: result.numMessagesBefore,
      messages_after: result.numMessagesAfter,
    },
  };
}

export interface HeadlessCompactCommandInput {
  backend: Backend;
  conversationId: string;
  agentId?: string;
  request: HeadlessCompactRequest;
  signal?: AbortSignal;
  /** Tests point this at a temporary ledger; production reads the default. */
  ledgerPath?: string;
}

export interface HeadlessCompactResult {
  success: boolean;
  output: string;
  topic_report?: CompactionTopicReport;
}

/**
 * Answer one `/compact` on the headless input path.
 *
 * Unlike the TUI there is no picker and no cancel channel: a bare `/compact`
 * takes the rate's default selection, and the only way out of a slow summarizer
 * is the process signal.
 */
export async function handleHeadlessCompactCommand(
  input: HeadlessCompactCommandInput,
): Promise<HeadlessCompactResult> {
  if (input.request.kind === "help") {
    return { success: true, output: HEADLESS_COMPACT_USAGE };
  }
  if (input.request.kind === "invalid") {
    return {
      success: false,
      output: `${input.request.message}\n\n${HEADLESS_COMPACT_USAGE}`,
    };
  }
  if (!(input.backend instanceof LocalBackend)) {
    return {
      success: false,
      output:
        "Compaction needs the local backend, and this session is not running on it.",
    };
  }
  try {
    const outcome = await runLocalCompaction({
      backend: input.backend,
      conversationId: input.conversationId,
      ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
      ...(input.request.blockIndex === undefined
        ? {}
        : { blockIndex: input.request.blockIndex }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.ledgerPath === undefined
        ? {}
        : { ledgerPath: input.ledgerPath }),
    });
    if (outcome.kind === "cancelled") {
      return { success: false, output: outcome.receipt };
    }
    return {
      success: true,
      output: outcome.receipt,
      topic_report: outcome.report,
    };
  } catch (error) {
    return {
      success: false,
      output: `Failed: ${formatCompactPlanningFailure(error)}`,
    };
  }
}

/**
 * The `result` envelope a `/compact`-only run emits.
 *
 * Same shape a turn's result envelope has, with zero usage: the summarizer's own
 * numbers live in the receipt and in the ledger, and no turn ran.
 */
export function buildHeadlessCompactResultEnvelope(input: {
  result: HeadlessCompactResult;
  sessionId: string;
  agentId: string | null;
  conversationId: string;
}): ResultMessage & { is_error: boolean } {
  return {
    type: "result",
    subtype: input.result.success ? "success" : "error",
    is_error: !input.result.success,
    session_id: input.sessionId,
    uuid: `result-compact-${randomUUID()}`,
    agent_id: input.agentId,
    conversation_id: input.conversationId,
    duration_ms: 0,
    duration_api_ms: 0,
    num_turns: 0,
    result: input.result.output,
    run_ids: [],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      step_count: 0,
      cached_input_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
    },
  };
}

/**
 * Where a `/compact` result goes in each headless output format.
 *
 * The sinks are passed in rather than imported: `headless.ts` owns stdout and
 * the wire, this module owns the choice between them — so the pinned entry file
 * gains a call site instead of a second copy of the format switch.
 */
export interface HeadlessCompactOutputSinks {
  outputFormat: string;
  sessionId: string;
  agentId: string | null;
  conversationId: string;
  writeWire: (message: ResultMessage & { is_error: boolean }) => void;
  writeStdout: (text: string) => Promise<void>;
  writeStderr: (text: string) => void;
}

export async function emitHeadlessCompactResult(
  result: HeadlessCompactResult,
  sinks: HeadlessCompactOutputSinks,
): Promise<void> {
  const envelope = buildHeadlessCompactResultEnvelope({
    result,
    sessionId: sinks.sessionId,
    agentId: sinks.agentId,
    conversationId: sinks.conversationId,
  });
  if (sinks.outputFormat === "stream-json") {
    sinks.writeWire(envelope);
    return;
  }
  if (sinks.outputFormat === "json") {
    await sinks.writeStdout(`${JSON.stringify(envelope, null, 2)}\n`);
    return;
  }
  // Text keeps the old contract: success on stdout, failure on stderr.
  if (result.success) await sinks.writeStdout(`${result.output}\n`);
  else sinks.writeStderr(result.output);
}
