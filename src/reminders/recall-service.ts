import { getLocalBackendMemoryFilesystemRoot } from "@/backend/local/paths";
import { createRecallDeadline, type RecallDeadline } from "./recall-deadline";
import { selectRecallEntries } from "./recall-orchestrator";
import {
  RECALL_DEFAULTS,
  type RecallBackendPort,
  type RecallCandidate,
  type RecallDecision,
  type RecallOptions,
  type RecallSourceDiagnostic,
  type RecallSourcePort,
} from "./recall-port";
import {
  RECALL_QUERY_DEFAULTS,
  type RecallQueryOptions,
  recallQueryTerms,
} from "./recall-query";
import { buildRecallSources } from "./recall-sources";

/**
 * The recall turn: assemble the scope, ask both sources, choose, record.
 *
 * This is the only part of the feature that touches the outside world, and it is
 * deliberately thin — all policy is in the orchestrator and all corpus access is in
 * the sources. What it owns is the *sequence*, which is the part that is easy to get
 * wrong:
 *
 * 1. Read `N` (`in_context_message_ids`) for the agent the caller named.
 * 2. Read the dedup window, so this turn cannot re-send what the window covers.
 * 3. Search, with each source's failure contained to that source.
 * 4. Choose.
 * 5. Record only what was actually injected — after the budget, not before.
 *
 * Nothing in here throws. A source that fails contributes no candidates and one
 * diagnostic line; the turn continues. That is invariant I7: recall may never be
 * the reason a message does not get sent.
 *
 * A turn that runs out of its budget returns what it has and says so: the
 * decision carries `timedOut`, and any source that was cut short reports
 * `degraded` instead of `searched`. Both are the caller's signal, not this
 * function's policy — the breaker and the user-visible line live in
 * `recall-runtime.ts`.
 */

export type RecallRequest = {
  backend: RecallBackendPort;
  agentId: string;
  conversationId: string;
  /** The verbatim user input; keyword extraction happens here, not at the caller. */
  userText: string;
  /**
   * Monotonic user-turn counter for the dedup window.
   *
   * Supplied by the caller rather than derived here. The reminders engine already
   * keeps one (`state.turnCount`, incremented once per user turn), and deriving a
   * durable equivalent would mean either counting a transcript on the send path or
   * writing `conversation.json` every turn just to bump a number. The in-memory
   * counter's only failure mode is that it starts at zero in a fresh process, and in
   * the TUI it is also reset when the user switches conversations, so an entry the
   * window recorded earlier reads as "in the future" and stays suppressed until the
   * counter climbs past it: over-suppression for as long as the earlier episode's
   * turn count, never under-suppression. That direction is deliberate — the
   * alternative (discarding entries above the current counter) trades it for a
   * possible duplicate injection after every restart.
   */
  currentTurn: number;
  options?: Partial<RecallOptions>;
  queryOptions?: Partial<RecallQueryOptions>;
  /** Defaults to on; `false` keeps the transcript source only. */
  memoryEnabled?: boolean;
  /**
   * An already-started budget. Omitted by the turn path, which lets
   * `options.timeoutMs` define one; supplied by callers that want to share a
   * budget — and by tests, which cannot make `Date.now` advance inside one
   * synchronous run.
   */
  deadline?: RecallDeadline;
  /**
   * The manual probe (`/recall now`): search, but neither read the dedup window
   * nor write to it.
   *
   * The window is a statement about a *turn*, and a probe is not one. Reading it
   * would answer "what would the next turn inject" (usually "nothing, you just
   * saw it"), and writing to it would suppress those passages from the real turn
   * the probe was meant to inform. Both are wrong for the question being asked, so
   * the probe sees the corpus unfiltered and leaves no trace. `currentTurn` is
   * unused on this path, which is why the probe passes a placeholder.
   */
  dryRun?: boolean;
};

function resolveOptions(options?: Partial<RecallOptions>): RecallOptions {
  const resolved = { ...RECALL_DEFAULTS, ...options };
  const total = Math.max(0, Math.trunc(resolved.totalCharacters));
  return {
    ...resolved,
    limit: Math.max(0, Math.trunc(resolved.limit)),
    totalCharacters: total,
    // One entry must always fit, or a bad ratio between the two budgets would
    // silently drop everything instead of injecting a shortened message.
    excerptCharacters: Math.max(
      0,
      Math.min(Math.trunc(resolved.excerptCharacters), total),
    ),
    minScoreRatio: Math.max(0, resolved.minScoreRatio),
    dedupTurns: Math.max(0, Math.trunc(resolved.dedupTurns)),
    candidateLimit: Math.max(1, Math.trunc(resolved.candidateLimit)),
    neighbors: Math.max(0, Math.trunc(resolved.neighbors)),
    excerptLines: Math.max(0, Math.trunc(resolved.excerptLines)),
    // `0` survives because it means "no budget"; the deadline itself rejects
    // everything else unusable, so there is no second fallback here.
    timeoutMs: Math.max(0, Math.trunc(resolved.timeoutMs)),
  };
}

function emptyDiagnostics(
  threshold: number,
  candidates: number,
  sources: RecallSourceDiagnostic[],
): RecallDecision["diagnostics"] {
  return { threshold, candidates, sources };
}

export async function runRecall(
  request: RecallRequest,
): Promise<RecallDecision> {
  const options = resolveOptions(request.options);
  const query = recallQueryTerms(request.userText, {
    ...RECALL_QUERY_DEFAULTS,
    ...request.queryOptions,
  });
  const noSources: RecallSourceDiagnostic[] = [];
  if (query.terms.length === 0 && query.phrases.length === 0) {
    // Nothing to search for. The dedup window is left alone: a read-only turn must
    // not write a conversation record.
    return {
      entries: [],
      status: "no-match",
      reason: "the input has no searchable terms",
      diagnostics: emptyDiagnostics(0, 0, noSources),
    };
  }

  // One budget for the whole turn, created before the store reads so that the
  // searches below are bounded. It does not bound the scope assembly: the
  // in-context read is a single awaited store call with no cancellation, and the
  // query is parsed before this line runs. The sources get the predicate rather than
  // the object: they only ever ask, they never own the clock.
  const deadline = request.deadline ?? createRecallDeadline(options.timeoutMs);

  // Everything before the search loop runs inside one guard: these are the only
  // steps that read the store, and the promise at the top of this file has to hold
  // for them too. A corrupt conversation record must not be the reason a user's
  // message does not get sent.
  let excludedMessageIds: ReadonlySet<string>;
  let suppressed: ReadonlySet<string>;
  let sources: RecallSourcePort[];
  try {
    excludedMessageIds = new Set(
      await request.backend.getInContextMessageIds(
        request.conversationId,
        request.agentId,
      ),
    );
    suppressed =
      request.dryRun === true
        ? new Set<string>()
        : request.backend.settleRecallDedup({
            conversationId: request.conversationId,
            agentId: request.agentId,
            currentTurn: request.currentTurn,
            keepTurns: options.dedupTurns,
          }).suppressed;

    const memoryDir = getLocalBackendMemoryFilesystemRoot(
      request.agentId,
      request.backend.getLocalStorageDir(),
    );
    const built = buildRecallSources({
      storageDir: request.backend.getLocalStorageDir(),
      memoryDir,
      excludedMessageIds,
      candidateLimit: options.candidateLimit,
      neighbors: options.neighbors,
      excerptLines: options.excerptLines,
      shouldStop: () => deadline.expired(),
    });
    // A source switched off by the caller is not a degradation: it is left out
    // entirely rather than reported as unavailable, which is reserved for "the source
    // exists but could not be searched".
    sources =
      request.memoryEnabled === false
        ? built.filter((source) => source.id !== "memory")
        : built;
  } catch (error) {
    return {
      entries: [],
      status: "failed",
      reason: error instanceof Error ? error.message : String(error),
      diagnostics: emptyDiagnostics(0, 0, noSources),
    };
  }

  const candidates: RecallCandidate[] = [];
  const diagnostics: RecallSourceDiagnostic[] = [];
  for (const source of sources) {
    // The source already contains its own failure, so this catch only covers the
    // scope assembly above it. Two layers because the cost of being wrong is the
    // user's message not being sent.
    try {
      const result = source.search({
        terms: query,
        scope: {
          agentId: request.agentId,
          currentConversationId: request.conversationId,
        },
      });
      candidates.push(...result.candidates);
      diagnostics.push(result.diagnostic);
    } catch (error) {
      diagnostics.push({
        source: source.id,
        status: "failed",
        candidates: 0,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const selection = selectRecallEntries({
    candidates,
    limit: options.limit,
    minScoreRatio: options.minScoreRatio,
    diversity: options.diversity,
    excerptCharacters: options.excerptCharacters,
    totalCharacters: options.totalCharacters,
    suppressed,
  });

  if (selection.entries.length > 0 && request.dryRun !== true) {
    const injected: Record<string, number> = {};
    for (const entry of selection.entries) {
      injected[entry.fingerprint] = request.currentTurn;
    }
    request.backend.settleRecallDedup({
      conversationId: request.conversationId,
      agentId: request.agentId,
      currentTurn: request.currentTurn,
      keepTurns: options.dedupTurns,
      injected,
    });
  }

  const settled = emptyDiagnostics(
    selection.threshold,
    candidates.length,
    diagnostics,
  );
  // The status cascade answers "what did the turn produce"; the deadline flag
  // answers "was the turn cut short". They are independent, so the flag is
  // applied once, on the way out, rather than repeated in every branch.
  let decision: RecallDecision;
  if (selection.entries.length > 0) {
    decision = {
      entries: selection.entries,
      status: "injected",
      diagnostics: settled,
    };
  } else if (
    diagnostics.length > 0 &&
    diagnostics.every((d) => d.status === "failed")
  ) {
    decision = {
      entries: [],
      status: "failed",
      reason: diagnostics[0]?.reason,
      diagnostics: settled,
    };
  } else if (
    diagnostics.length > 0 &&
    diagnostics.every((d) => d.status === "unavailable")
  ) {
    decision = {
      entries: [],
      status: "unavailable",
      reason: diagnostics[0]?.reason,
      diagnostics: settled,
    };
  } else if (candidates.length > 0 && selection.deduped === candidates.length) {
    decision = {
      entries: [],
      status: "suppressed",
      reason: "everything that matched was injected inside the dedup window",
      diagnostics: settled,
    };
  } else {
    decision = { entries: [], status: "no-match", diagnostics: settled };
  }

  if (!deadline.expired()) return decision;
  return {
    ...decision,
    timedOut: true,
    reason: decision.reason ?? "the recall deadline expired",
  };
}
