import { getLocalBackendMemoryFilesystemRoot } from "@/backend/local/paths";
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
   * counter's only failure mode is that a fresh process starts at zero, which makes
   * the window *over*-suppress for at most `dedupTurns` turns after a restart —
   * never under-suppress.
   */
  currentTurn: number;
  options?: Partial<RecallOptions>;
  queryOptions?: Partial<RecallQueryOptions>;
  /** Defaults to on; `false` keeps the transcript source only. */
  memoryEnabled?: boolean;
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
    suppressed = request.backend.settleRecallDedup({
      conversationId: request.conversationId,
      agentId: request.agentId,
      currentTurn: request.currentTurn,
      keepTurns: options.dedupTurns,
    }).suppressed;

    const memoryDir =
      request.memoryEnabled === false
        ? undefined
        : getLocalBackendMemoryFilesystemRoot(
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

  if (selection.entries.length > 0) {
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
  if (selection.entries.length > 0) {
    return {
      entries: selection.entries,
      status: "injected",
      diagnostics: settled,
    };
  }
  if (
    diagnostics.length > 0 &&
    diagnostics.every((d) => d.status === "failed")
  ) {
    return {
      entries: [],
      status: "failed",
      reason: diagnostics[0]?.reason,
      diagnostics: settled,
    };
  }
  if (
    diagnostics.length > 0 &&
    diagnostics.every((d) => d.status === "unavailable")
  ) {
    return {
      entries: [],
      status: "unavailable",
      reason: diagnostics[0]?.reason,
      diagnostics: settled,
    };
  }
  if (candidates.length > 0 && selection.deduped === candidates.length) {
    return {
      entries: [],
      status: "suppressed",
      reason: "everything that matched was injected inside the dedup window",
      diagnostics: settled,
    };
  }
  return { entries: [], status: "no-match", diagnostics: settled };
}
