/**
 * The listener's half of one local `/compact`: exclusion, execution, accounting.
 *
 * Both listener entry points run the same three steps (`prepare → resolve pick →
 * apply`, from `@/agent/compaction-execute`): the `/compact` command and the
 * desktop's `conversation_compact`. This module is what they share around that
 * run, and it exists because the two things around it are easy to get subtly
 * wrong in two places at once:
 *
 * 1. **At most one run per conversation.** The model call between `prepare` and
 *    `apply` is owned by no turn. §5.2.6 gives the preparation no timeout and no
 *    cancel channel, so holding the conversation's `command` lifecycle across it
 *    would block the queue with no way out if the summarizer hung — the listener
 *    guide's lease rule exists to stop exactly that kind of indefinite
 *    ownership. Without any guard, a second run can prepare against an older
 *    context and apply after the first one's write-back, so the older preview
 *    wins the race. The write-back already refuses a preview whose boundaries
 *    left the context (`stale_preview`), which bounds the damage; this lock is
 *    the earlier layer that keeps the situation from arising. It is a
 *    process-local set keyed by conversation id, not a lease, and it carries no
 *    state beyond "claimed".
 *
 * 2. **Exactly one usage row per attempt (§5.14).** The executor returns numbers
 *    and ids and writes nothing, because §5.14 makes the caller the writer. This
 *    is the listener's caller: without a single mapping here, one of the two
 *    entry points would eventually record a failure as `0` while the other
 *    recorded the tokens the summarizer actually burned.
 *
 * The claim is released in a `finally`, so a throw cannot lock the conversation
 * forever, and a refused claim spends nothing and writes nothing — it is reported
 * as the command's own failure instead.
 */
import {
  compactionUsageFactsFromFailure,
  type LocalCompactionBackend,
  type LocalCompactionFacts,
  type LocalCompactionOutcome,
  runLocalCompaction,
} from "@/agent/compaction-execute";
import { recordCompactionUsage } from "@/usage/compaction-usage";

/** The one sentence a refused second `/compact` says. */
export const LOCAL_COMPACTION_BUSY_TEXT =
  "A compaction is already running for this conversation. Wait for it to finish, then try again.";

/** Conversations with a compaction in flight in this process. */
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

/**
 * Run one local compaction under the conversation's claim, recording exactly one
 * ledger row for it.
 *
 * Throws {@link LOCAL_COMPACTION_BUSY_TEXT} without spending or writing anything
 * when another run already holds the claim, and rethrows whatever the run itself
 * threw — after the failure's row is written, because the spend is real even when
 * the run is not.
 */
export async function runListenerLocalCompaction(
  input: ListenerLocalCompactionInput,
): Promise<LocalCompactionOutcome> {
  if (compactionInFlight.has(input.conversationId)) {
    throw new Error(LOCAL_COMPACTION_BUSY_TEXT);
  }
  compactionInFlight.add(input.conversationId);
  let outcome: LocalCompactionOutcome;
  try {
    outcome = await runLocalCompaction({
      backend: input.backend,
      conversationId: input.conversationId,
      ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
      ...(input.blockIndex === undefined
        ? {}
        : { blockIndex: input.blockIndex }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } catch (error) {
    await recordOutcome(
      input.conversationId,
      compactionUsageFactsFromFailure(error, input.agentId),
      "failed",
    );
    throw error;
  } finally {
    compactionInFlight.delete(input.conversationId);
  }
  // Written before the caller reports, so the receipt and the ledger cannot
  // disagree about whether the run happened. Outside the claim: a row that
  // failed to land must never be re-reported as a failed compaction.
  await recordOutcome(input.conversationId, outcome, outcome.kind);
  return outcome;
}

/**
 * Append the row. The spend is the executor's facts — including a failed or
 * cancelled run's, which rode up on the error (§5.14).
 *
 * An agent nobody can name writes no row: looking it up through
 * `retrieveConversation` would *create* an unknown conversation on the local
 * backend, turning a zero-write failure into a write (§5.9.1).
 */
async function recordOutcome(
  conversationId: string,
  facts: LocalCompactionFacts,
  outcome: "completed" | "cancelled" | "failed",
): Promise<void> {
  if (facts.agentId === null) return;
  await recordCompactionUsage({
    agentId: facts.agentId,
    conversationId,
    model: facts.model,
    promptTokens: facts.usage?.promptTokens ?? 0,
    cachedInputTokens: facts.usage?.cachedInputTokens ?? 0,
    completionTokens: facts.usage?.completionTokens ?? 0,
    wallMs: facts.usage?.wallMs ?? 0,
    outcome,
  });
}

/** Tests only: forget every claim, so one failing case cannot poison the next. */
export function __testResetLocalCompactionLocks(): void {
  compactionInFlight.clear();
}
