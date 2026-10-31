/**
 * The listener's half of one local `/compact`, split into the two protocol
 * steps and the one-shot wrapper the terminal path still uses.
 *
 * Every listener entry point runs the same three backend steps (`prepare →
 * resolve pick → apply`, from `@/agent/compaction-execute`). What differs is
 * where a human pick can enter:
 *
 * - `compaction_prepare` → `compaction_commit | compaction_cancel`: the picker
 *   sees `topic_report` between the steps, so the summarizer's spend has to be
 *   parked (in `compaction-pending.ts`) between them.
 * - `conversation_compact` and `execute_command "/compact"`: no picker, one
 *   call. `runListenerLocalCompaction` wraps the same prepare/commit pair and
 *   keeps the exact legacy response shape (§5.12.2, R7).
 *
 * Two things around the run are easy to get subtly wrong in two places at once,
 * which is why they live here instead of in each caller:
 *
 * 1. **At most one summarizer call per conversation.** The model call between
 *    `prepare` and `apply` is owned by no turn. §5.2.6 gives the preparation no
 *    timeout and no cancel channel, so holding the conversation's `command`
 *    lifecycle across it would block the queue with no way out if the summarizer
 *    hung — the listener guide's lease rule exists to stop exactly that kind of
 *    indefinite ownership. Without any guard, a second run can prepare against
 *    an older context and apply after the first one's write-back, so the older
 *    preview wins the race. The write-back already refuses a preview whose
 *    boundaries left the context (`stale_preview`), which bounds the damage;
 *    this claim is the earlier layer that keeps the situation from arising. It
 *    is a process-local set keyed by conversation id, not a lease, and it
 *    carries no state beyond "claimed". Apply needs no claim of its own: one
 *    pending preview per conversation means one write-back at a time.
 *
 * 2. **Exactly one usage row per attempt (§5.14).** The executor returns numbers
 *    and ids and writes nothing, because §5.14 makes the caller the writer. This
 *    is the listener's caller: the row is written where the attempt ends —
 *    immediately for a failed `prepare`, and at commit/cancel/expiry for a
 *    prepared preview (see `compaction-pending.ts`).
 *
 * The claim is released in a `finally`, so a throw cannot lock the conversation
 * forever, and a refused claim spends nothing and writes nothing — it is
 * reported as the command's own failure instead.
 */
import {
  buildCompactionPreviewTopicReport,
  buildCompactionTopicReport,
  compactionUsageFactsFromFailure,
  formatLocalCompactionReceipt,
  type LocalCompactionBackend,
  type LocalCompactionFacts,
  type LocalCompactionOutcome,
  resolveCompactionPick,
} from "@/agent/compaction-execute";
import type {
  CompactionPreview,
  CompactPick,
} from "@/backend/local/compaction-preview";
import type { CompactionApplyResult } from "@/backend/local/compaction-run";
import { CompactionCancelledError } from "@/backend/local/compaction-summarizer";
import type { CompactionTopicReport } from "@/types/task-control-protocol";
import {
  __testResetCompactionPending,
  COMPACTION_PREPARE_EXPIRED_TEXT,
  type CompactionPendingEntry,
  cancelCompactionPending,
  compactionFactsOfPending,
  discardCompactionPending,
  peekCompactionPending,
  recordListenerCompactionAttempt,
  storeCompactionPending,
  takeCompactionPending,
} from "@/websocket/listener/compaction-pending";

/** The one sentence a refused second `/compact` says. */
export const LOCAL_COMPACTION_BUSY_TEXT =
  "A compaction is already running for this conversation. Wait for it to finish, then try again.";

/**
 * The listener's copy of the cancelled receipt. `@/agent/compaction-execute`
 * keeps its own private copy for the paths it returns; the CLI carries one too,
 * so this is the listener's receipt text, not a re-derivation of the run.
 */
const LISTENER_COMPACT_CANCELLED_TEXT = "Cancelled: the context is unchanged.";

/** Conversations with a compaction preparation in flight in this process. */
const compactionInFlight = new Set<string>();

export interface ListenerLocalCompactionInput {
  backend: LocalCompactionBackend;
  conversationId: string;
  /** When omitted the preview's own agent id is used (and the ledger's too). */
  agentId?: string;
  /** 1-based block from `/compact <n>`; omitted = the rate's default choice. */
  blockIndex?: number;
  signal?: AbortSignal;
}

export interface ListenerLocalCompactionPrepareInput {
  backend: LocalCompactionBackend;
  conversationId: string;
  agentId?: string;
  /** 1-based block from `/compact <n>`; resolved before the summarizer runs. */
  blockIndex?: number;
  signal?: AbortSignal;
}

/**
 * A prepared preview, parked until `commit` or `cancel` (or its TTL).
 *
 * The cancelled branch carries the failure's ledger facts so the one-shot
 * wrapper can return the same {@link LocalCompactionOutcome} shape the other
 * paths return; the protocol handler reads only `receipt`.
 */
export type ListenerLocalCompactionPrepareResult =
  | {
      kind: "prepared";
      prepareId: string;
      preview: CompactionPreview;
      /** The overview + cut-point table `commit`'s index is numbered against. */
      report: CompactionTopicReport;
    }
  | ({ kind: "cancelled"; receipt: string } & LocalCompactionFacts);

export interface ListenerLocalCompactionCommitInput {
  backend: LocalCompactionBackend;
  conversationId: string;
  prepareId: string;
  /** 1-based block from `topic_report.blocks`; omitted = the rate's default. */
  blockIndex?: number;
}

export interface ListenerLocalCompactionCancelInput {
  conversationId: string;
  prepareId: string;
}

export type ListenerLocalCompactionCommitResult = Extract<
  LocalCompactionOutcome,
  { kind: "completed" }
>;

/**
 * Run one prepare/commit pair under the conversation's claim, recording exactly
 * one ledger row for the attempt.
 *
 * This is the legacy one-shot path (`conversation_compact` and the listener's
 * `/compact`): same implementation as the split protocol commands, one response.
 *
 * Throws {@link LOCAL_COMPACTION_BUSY_TEXT} without spending or writing anything
 * when another run already holds the claim.
 */
export async function runListenerLocalCompaction(
  input: ListenerLocalCompactionInput,
): Promise<LocalCompactionOutcome> {
  return withCompactionClaim(input.conversationId, async () => {
    const prepared = await prepareLocalCompaction(input);
    if (prepared.kind === "cancelled") return prepared;
    return commitListenerLocalCompaction({
      backend: input.backend,
      conversationId: input.conversationId,
      prepareId: prepared.prepareId,
    });
  });
}

/**
 * Run the summarizer and park the preview for `commit`/`cancel`.
 *
 * The pick for a numbered `prepare` is resolved *before* the summarizer runs and
 * locked to its boundary message id (§5.6.3): an unknown number refuses before
 * any spend, and the number the caller saw cannot be moved by the boundaries the
 * summarizer adds.
 */
export async function prepareListenerLocalCompaction(
  input: ListenerLocalCompactionPrepareInput,
): Promise<ListenerLocalCompactionPrepareResult> {
  return withCompactionClaim(input.conversationId, () =>
    prepareLocalCompaction(input),
  );
}

/**
 * Apply a parked preview and report the result.
 *
 * A `blockIndex` this preview does not have is a request error: the pending
 * preview is *not* consumed, so the client can retry with another index instead
 * of paying for a second summarizer call. Once the index resolves, the entry is
 * consumed exactly once and the attempt's spend is written with its real
 * outcome — including an `executed:false` write-back (`stale_preview` or a
 * no-op), which is a completed attempt that spent real tokens.
 */
export async function commitListenerLocalCompaction(
  input: ListenerLocalCompactionCommitInput,
): Promise<ListenerLocalCompactionCommitResult> {
  const peeked = peekCompactionPending(input.conversationId, input.prepareId);
  if (peeked === null) throw new Error(COMPACTION_PREPARE_EXPIRED_TEXT);
  const pick = pickForCommit(peeked.preview, peeked.pick, input.blockIndex);
  const taken = await takeCompactionPending(
    input.conversationId,
    input.prepareId,
  );
  if (taken.kind !== "taken") throw new Error(COMPACTION_PREPARE_EXPIRED_TEXT);
  return applyPreparedCompaction({
    backend: input.backend,
    entry: taken.entry,
    pick,
  });
}

/**
 * Drop a parked preview and settle its spend as cancelled.
 *
 * @returns `false` when the id was unknown or already consumed; the caller
 * reports `prepare_expired`.
 */
export async function cancelListenerLocalCompaction(
  input: ListenerLocalCompactionCancelInput,
): Promise<boolean> {
  return cancelCompactionPending(input.conversationId, input.prepareId);
}

async function prepareLocalCompaction(
  input: ListenerLocalCompactionPrepareInput,
): Promise<ListenerLocalCompactionPrepareResult> {
  const pick =
    input.blockIndex === undefined
      ? null
      : resolveCompactionPick(
          input.backend.listTopics(input.conversationId, input.agentId).blocks,
          input.blockIndex,
        );
  // A new prepare supersedes the old preview *now*, not when it succeeds: the
  // old id stops working the moment the client replaces it, and its summarizer
  // spend is settled rather than leaked.
  await discardCompactionPending(input.conversationId);
  let preview: CompactionPreview;
  try {
    preview = await input.backend.prepareCompaction({
      conversationId: input.conversationId,
      ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } catch (error) {
    const facts = compactionUsageFactsFromFailure(error, input.agentId);
    if (error instanceof CompactionCancelledError) {
      // Nothing is written back (§5.9.1) but the tokens were spent.
      await recordListenerCompactionAttempt({
        conversationId: input.conversationId,
        facts,
        outcome: "cancelled",
      });
      return {
        kind: "cancelled",
        receipt: LISTENER_COMPACT_CANCELLED_TEXT,
        ...facts,
      };
    }
    // The spend rides on the error (§5.14); write the row before rethrowing so
    // the caller's failure report cannot disagree with the ledger.
    await recordListenerCompactionAttempt({
      conversationId: input.conversationId,
      facts,
      outcome: "failed",
    });
    throw error;
  }
  const entry = await storeCompactionPending({
    conversationId: input.conversationId,
    preview,
    agentId: input.agentId ?? null,
    pick,
  });
  return {
    kind: "prepared",
    prepareId: entry.prepareId,
    preview: entry.preview,
    report: buildCompactionPreviewTopicReport(entry.preview),
  };
}

async function applyPreparedCompaction(input: {
  backend: LocalCompactionBackend;
  entry: CompactionPendingEntry;
  pick: CompactPick;
}): Promise<ListenerLocalCompactionCommitResult> {
  const { entry } = input;
  const facts = compactionFactsOfPending(entry);
  let result: CompactionApplyResult;
  try {
    result = await input.backend.applyCompaction({
      preview: entry.preview,
      pick: input.pick,
    });
  } catch (error) {
    await recordListenerCompactionAttempt({
      conversationId: entry.conversationId,
      facts,
      outcome: "failed",
    });
    throw error;
  }
  const completed: ListenerLocalCompactionCommitResult = {
    kind: "completed",
    preview: entry.preview,
    result,
    receipt: formatLocalCompactionReceipt(entry.preview, result),
    report: buildCompactionTopicReport(entry.preview, result),
    ...facts,
  };
  // Written before the caller reports, so the receipt and the ledger cannot
  // disagree about whether the run happened. Outside the apply try/catch: a row
  // that failed to land must never re-report a completed run as failed.
  await recordListenerCompactionAttempt({
    conversationId: entry.conversationId,
    facts,
    outcome: "completed",
  });
  return completed;
}

/**
 * The write-back's pick.
 *
 * An explicit `block_index` is numbered against the table `prepare` published
 * (`preview.blocks`), because that is the table the client was looking at. The
 * legacy `/compact <n>` pick was already resolved against the pre-summarizer
 * table (§5.6.3) and rides on the entry. Without either, the compression rate
 * decides.
 */
function pickForCommit(
  preview: CompactionPreview,
  preparedPick: CompactPick | null,
  blockIndex: number | undefined,
): CompactPick {
  if (blockIndex !== undefined) {
    try {
      return resolveCompactionPick(preview.blocks, blockIndex);
    } catch {
      const count = preview.blocks.length;
      throw new Error(
        `block_index ${blockIndex} is out of range: this preview has ${count} block${count === 1 ? "" : "s"}. Pick an index from topic_report.blocks, or omit block_index to compress by the rate.`,
      );
    }
  }
  return preparedPick ?? { kind: "ratio_suggestion" };
}

async function withCompactionClaim<T>(
  conversationId: string,
  run: () => Promise<T>,
): Promise<T> {
  if (compactionInFlight.has(conversationId)) {
    throw new Error(LOCAL_COMPACTION_BUSY_TEXT);
  }
  compactionInFlight.add(conversationId);
  try {
    return await run();
  } finally {
    compactionInFlight.delete(conversationId);
  }
}

/** Tests only: forget every claim and pending preview, so one case cannot leak. */
export function __testResetLocalCompactionLocks(): void {
  compactionInFlight.clear();
  __testResetCompactionPending();
}
