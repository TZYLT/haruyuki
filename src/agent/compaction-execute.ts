/**
 * F-04's `/compact` execution body: one `prepare → resolve pick → apply` run,
 * shared by every path that has no picker.
 *
 * The TUI, the websocket listener and headless all run these three steps and
 * differ only in what they do with the answer — a picker, a wire report, a
 * receipt. The ordering, the receipt copy and the cut-point report therefore
 * live here instead of in whichever path happened to be written first.
 *
 * Two boundaries are deliberate:
 *
 * - **It does not write the usage ledger.** §5.14 makes the caller the writer:
 *   the TUI records from its own preview, the listener and headless record from
 *   the facts returned here, and each has its own ledger path (tests point theirs
 *   at a temporary file). A run therefore returns ids and numbers, and nothing
 *   else. Writing the row here would also invert the layer direction, because
 *   `usage/` sits *above* `agent/`.
 * - **It does not import `@/cli/`.** The websocket listener runs the same code
 *   and a listener may not reach up into the TUI shell; the copy that used to
 *   live in `cli/helpers/compact-command.ts` moved down here with the runner so
 *   neither caller has to import the TUI's parsing module for a sentence.
 */
import type {
  CompactionDegraded,
  CompactionPreview,
  CompactPick,
  CompactUsage,
} from "@/backend/local/compaction-preview";
import { renderCompactionOverview } from "@/backend/local/compaction-preview";
import type { CompactionApplyResult } from "@/backend/local/compaction-run";
import { CompactionCancelledError } from "@/backend/local/compaction-summarizer";
import { compactUsageOf } from "@/backend/local/compaction-usage-error";
import type { LocalBackend } from "@/backend/local/local-backend";
import type {
  TopicBlock,
  TrimNoopReason,
} from "@/backend/local/topic-compaction";
import type { CompactionTopicReport } from "@/types/task-control-protocol";

/**
 * The three backend calls a compaction run makes.
 *
 * Kept structural rather than naming `LocalBackend` so a test can stand in for
 * the store: the state machine under test is this module's ordering, not the
 * backend's.
 */
export type LocalCompactionBackend = Pick<
  LocalBackend,
  "listTopics" | "prepareCompaction" | "applyCompaction"
>;

/**
 * What a run owes the usage ledger, as ids and numbers only (§5.14, §5.16.6).
 *
 * `agentId` is `null` when neither the caller nor the preview could name the
 * agent. Such a run writes no row at all: looking the agent up through
 * `retrieveConversation` would *create* an unknown conversation on the local
 * backend, turning a zero-write failure into a write (§5.9.1).
 */
export interface LocalCompactionFacts {
  /** The summarizer's model; `""` when the call never answered. */
  model: string;
  /** The agent this run belonged to, or `null` when nobody can name it. */
  agentId: string | null;
  /** The spend, when the run got far enough to measure it. */
  usage: CompactUsage | null;
}

export interface LocalCompactionRunInput {
  backend: LocalCompactionBackend;
  conversationId: string;
  /** When omitted the preview's own agent id is used. */
  agentId?: string;
  /** 1-based block from `/compact <n>`; omitted = the rate's default choice. */
  blockIndex?: number;
  signal?: AbortSignal;
}

export type LocalCompactionOutcome =
  | ({
      kind: "completed";
      preview: CompactionPreview;
      result: CompactionApplyResult;
      receipt: string;
      report: CompactionTopicReport;
    } & LocalCompactionFacts)
  | ({ kind: "cancelled"; receipt: string } & LocalCompactionFacts);

/** The one sentence a cancelled compaction says, in every path that can cancel. */
const COMPACT_CANCELLED_TEXT = "Cancelled: the context is unchanged.";

/**
 * Run `prepare → pick → apply` and return what happened, without writing a thing.
 *
 * A cancelled or failed run writes nothing to the context: the preview is
 * dropped whole (requirement §5.9.1), so there is nothing to undo. The spend is
 * still reported — a failure's tokens ride on the thrown error
 * (`withCompactUsage`), and `compactionUsageFactsFromFailure` reads them back out
 * without consuming the error, so the caller can still rethrow it.
 */
export async function runLocalCompaction(
  input: LocalCompactionRunInput,
): Promise<LocalCompactionOutcome> {
  let preview: CompactionPreview | null = null;
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
      ...factsOf({ agentId: input.agentId, preview, spend: undefined }),
    };
  } catch (error) {
    if (error instanceof CompactionCancelledError) {
      return {
        kind: "cancelled",
        receipt: COMPACT_CANCELLED_TEXT,
        ...factsOf({
          agentId: input.agentId,
          preview,
          spend: compactUsageOf(error),
        }),
      };
    }
    throw error;
  }
}

/**
 * The ledger facts for a run that threw before it could return any (§5.14).
 *
 * A failed `prepare` produced no preview, yet the summarizer may have burned tens
 * of thousands of prompt tokens before it gave up. The numbers are computed
 * inside the summarizer's call ladder, so they travel *on the error*; nothing
 * else can recompute them. The error is not consumed — the caller still rethrows
 * it, and the ledger row is written first.
 */
export function compactionUsageFactsFromFailure(
  error: unknown,
  agentId: string | null | undefined,
): LocalCompactionFacts {
  return factsOf({
    agentId: agentId ?? undefined,
    preview: null,
    spend: compactUsageOf(error),
  });
}

/**
 * Resolve `facts` from the three sources a run has, in priority order.
 *
 * The error's spend wins over the preview's because a failure's ladder total is
 * the more complete number when both exist; the preview is the only source when
 * `apply` itself threw.
 */
function factsOf(input: {
  agentId: string | undefined;
  preview: CompactionPreview | null;
  spend: CompactUsage | undefined;
}): LocalCompactionFacts {
  return {
    model: input.preview?.model ?? "",
    agentId: input.agentId ?? input.preview?.agentId ?? null,
    usage: input.spend ?? input.preview?.usage ?? null,
  };
}

/**
 * Where a `/compact <n>` points, as the frozen `CompactPick` the write-back takes.
 *
 * The block number is 1-based and resolved against the table the caller was
 * looking at *before* the summarizer ran — `/topic list`'s numbering
 * (requirement §5.6.3, Q-08). The identity handed to `apply` is the block's
 * boundary message id, never the row.
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

/**
 * Why a compaction wrote nothing, in the receipt's own words.
 *
 * The structured reason stays structured in the backend; this is the one place
 * it becomes prose, so all three `/compact` paths say the same thing. A raw
 * token in a receipt is a receipt that needs a code lookup.
 */
export function formatCompactNoopReason(
  reason: TrimNoopReason | undefined,
): string {
  switch (reason) {
    case undefined:
      return "the plan kept everything";
    case "empty_context":
      return "there is nothing in the context to trim";
    case "nothing_before_boundary":
      return "the kept block starts at the first message, so nothing older could be folded";
    case "unknown_block":
      return "the block this run was told to keep is no longer in the context";
    case "stale_preview":
      return "the context changed while it was being summarized, so this preview was dropped whole — run /compact again";
    case "no_suggestion":
      return "the compression rate found no cut point";
  }
}

/**
 * The receipt's one line when a run produced no topics (§5.9.2, §5.9.3).
 *
 * The two causes carry the same product but not the same story, and a user
 * deciding whether to retry needs to know which one happened: a refusal means the
 * model would not answer this request at all, a format failure means it answered
 * twice with something unusable.
 */
export function formatCompactionDegradedNote(
  degraded: CompactionDegraded | null,
): string | null {
  switch (degraded) {
    case null:
      return null;
    case "refusal":
      return "the summarizer refused or was unavailable, so this run used the old one-step summary (no topics)";
    case "format":
      return "the summarizer's structured answer was unusable twice, so this run kept one whole-section summary (no topics)";
  }
}

/**
 * Turn a planning failure into something actionable. Local compaction refuses
 * to plan when there is too little context to summarize, which used to surface
 * as the planner's own error text.
 */
export function formatCompactPlanningFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes("Not enough messages") ||
    message.includes("No assistant message found")
  ) {
    return "Nothing to trim: this conversation is too short to summarize. Nothing was written.";
  }
  if (message.includes("at the end of the message buffer")) {
    return "Nothing to trim: the newest messages are already the whole context.";
  }
  return message;
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
 * This is the picker-less receipt, shared by the listener and headless. The TUI
 * has its own (`submit-compact-commands.ts`) because it also names the user's
 * confirmed suggestion; the two live apart for now, and neither is a copy of the
 * other's module.
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
  const degradedNote = formatCompactionDegradedNote(preview.degraded);
  if (degradedNote !== null) {
    lines.push(`  note:       ${degradedNote}`);
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
    degraded: preview.degraded !== null,
    degraded_kind: preview.degraded,
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
