/**
 * Feature ②'s query port: what a recall source is, and what a scope means.
 *
 * The port is deliberately implementation-free. A source today is the transcript
 * index or the MemFS scan; the requirement reserves room for a vector or tree
 * source later, and the orchestrator must not learn which one answered. So a
 * source is "given a query and a scope, return scored candidates", and everything
 * source-specific (a conversation directory, a workspace path) travels as opaque
 * locator fields on the candidate.
 *
 * The defaults below are the v1.1 requirement's numbers (《26》§5.7/§6.9). They
 * live here rather than in a settings module because M3 has to be testable
 * without one; M6 reads the user's settings and overrides them.
 */

export type RecallSourceId = "transcript" | "memory";

/**
 * How the K slots are shared out.
 *
 * - `none`: pure score order. The default, because the user could not predict
 *   which constraint would read better on real traffic and asked for the
 *   permissive one; the other two stay one setting away.
 * - `file`: at most one entry per source file. A transcript conversation is one
 *   file (`messages.jsonl`) and a memory document is one file, so this is the same
 *   rule on both sides. It is a hard cap: an unused slot stays unused rather than
 *   being refilled from a file that already contributed.
 * - `split`: half the slots for each source (an odd slot goes to whichever source
 *   has the better remaining score).
 */
export type RecallDiversity = "none" | "file" | "split";

/**
 * The accepted values, in the order a picker should offer them.
 *
 * Defined next to the type, the way `recall-display.ts` defines its tiers: the
 * settings resolver, the `/recall` command and the settings picker all have to
 * agree on what a valid value is, and three private copies of this list is how
 * they stop agreeing.
 */
export const RECALL_DIVERSITIES: readonly RecallDiversity[] = [
  "none",
  "file",
  "split",
];

export function isRecallDiversity(value: unknown): value is RecallDiversity {
  return RECALL_DIVERSITIES.includes(value as RecallDiversity);
}

export type RecallOptions = {
  /** Total entries across both sources. */
  limit: number;
  /** Characters per entry before truncation. */
  excerptCharacters: number;
  /** Hard ceiling on the excerpt text, before the block's marker and headers. */
  totalCharacters: number;
  /**
   * Relative score floor: an entry scoring below `topScore * minScoreRatio` counts
   * as "no match" (《26》§5.7 / U4). Relative rather than absolute because BM25
   * scores move with the corpus size and the number of query terms.
   */
  minScoreRatio: number;
  diversity: RecallDiversity;
  /** Transcript context: messages on each side of the hit. */
  neighbors: number;
  /** Memory context: lines on each side of the hit line. */
  excerptLines: number;
  /** Dedup window in user turns; `0` disables dedup. */
  dedupTurns: number;
  /** Per-source candidate pool, before merging. */
  candidateLimit: number;
  /**
   * Wall-clock budget for one turn; `0` disables the budget (《26》§6.5).
   *
   * Not a knob the orchestrator reads — the service turns it into a deadline
   * (`recall-deadline.ts`) and the sources consult that — but it belongs here
   * with the other tunables so M6 can overlay one settings record on all of them.
   */
  timeoutMs: number;
};

export const RECALL_DEFAULTS: RecallOptions = {
  limit: 3,
  excerptCharacters: 400,
  totalCharacters: 1200,
  minScoreRatio: 0.35,
  diversity: "none",
  neighbors: 1,
  excerptLines: 2,
  dedupTurns: 10,
  candidateLimit: 12,
  timeoutMs: 1000,
};

/** The query, already reduced to terms. Sources never see the raw sentence. */
export type RecallQueryTerms = {
  terms: readonly string[];
  phrases: readonly string[];
};

export type RecallScope = {
  agentId: string;
  currentConversationId: string;
};

export type RecallSourceRequest = {
  terms: RecallQueryTerms;
  scope: RecallScope;
};

/**
 * One recallable passage, with everything the caller needs to render it and to
 * recognise it again next turn.
 */
export type RecallCandidate = {
  source: RecallSourceId;
  /**
   * Stable identity for the dedup window. It must be unique per *injectable unit*
   * and must not collide across conversations: message ids are reused between
   * conversations, so a transcript fingerprint carries its conversation key.
   */
  fingerprint: string;
  /** The source file: a conversation directory name, or a memory path. */
  file: string;
  /** Transcript hits only: the conversation the message belongs to. */
  conversationKey?: string;
  /** Transcript hits only: the matched message. */
  messageId?: string;
  /** Memory hits only: the excerpt's line span, 1-based inclusive. */
  startLine?: number;
  endLine?: number;
  /** Transcript hits only. */
  timestamp?: string;
  /** The injectable text, already carrying its context. */
  text: string;
  score: number;
};

export type RecallSourceStatus =
  | "searched"
  | "empty"
  /** The source could not run at all (missing workspace, unreadable store). */
  | "unavailable"
  /** The source threw; the turn continues without it. */
  | "failed"
  /**
   * The source ran out of budget part-way through. Whatever it had found is
   * kept — a truncated search is a weaker answer, not a missing one — but the
   * caller must not read "only two hits" as "only two hits exist".
   */
  | "degraded";

export type RecallSourceDiagnostic = {
  source: RecallSourceId;
  status: RecallSourceStatus;
  /** Candidates the source produced, after its own scope filtering. */
  candidates: number;
  reason?: string;
};

export type RecallSourceOutcome = {
  candidates: RecallCandidate[];
  diagnostic: RecallSourceDiagnostic;
};

/** What the orchestrator consumes from a source. */
export type RecallSourcePort = {
  readonly id: RecallSourceId;
  search(request: RecallSourceRequest): RecallSourceOutcome;
};

/**
 * The conversation-record operations the dedup window needs, structurally typed
 * so this module (and the service above it) never imports the backend.
 *
 * One method serves both halves of a turn — "what to suppress" before the search
 * and "what was injected" after the selection — because both answers come from the
 * same observation of the conversation record. The service calls it twice, once on
 * each side of the search, so it must not treat the first call as read-only:
 * settling prunes the window, and a turn that injects nothing can still write.
 */
export type RecallDedupPort = {
  settleRecallDedup(input: {
    conversationId: string;
    agentId?: string;
    currentTurn: number;
    keepTurns: number;
    injected?: Record<string, number>;
  }): { suppressed: ReadonlySet<string>; window: Record<string, number> };
};

/**
 * Everything the service needs from the backend. Structural rather than the
 * `LocalBackend` class: the service is a reminders-layer consumer, and taking the
 * narrow shape keeps the dependency one-way and the tests free of a real store.
 */
export type RecallBackendPort = RecallDedupPort & {
  getLocalStorageDir(): string;
  getInContextMessageIds(
    conversationId: string,
    agentId?: string,
  ): Promise<string[]>;
};

export type RecallEntry = RecallCandidate & {
  /** `text` after truncation to the per-entry budget. */
  text: string;
};

export type RecallStatus =
  /** Entries were produced. */
  | "injected"
  /** Nothing scored above the threshold. */
  | "no-match"
  /** Everything that matched had already been injected inside the window. */
  | "suppressed"
  /** No source could be built at all (no storage directory / no memory). */
  | "unavailable"
  /** Every source failed; the turn continues with no recall. */
  | "failed";

export type RecallDecision = {
  entries: RecallEntry[];
  status: RecallStatus;
  reason?: string;
  /**
   * The budget ran out before the search finished (《27》M5-1).
   *
   * Orthogonal to `status` on purpose: a timed-out turn that still produced
   * entries is `injected` *and* `timedOut`, while one that produced none is
   * `no-match` *and* `timedOut`. Only this flag decides whether the turn counts
   * against the breaker and whether the user sees a line, so it must not be
   * inferred from the status.
   */
  timedOut?: boolean;
  diagnostics: {
    /** Absolute score floor that was applied this turn. */
    threshold: number;
    /** Candidates that survived the scope and dedup filters. */
    candidates: number;
    sources: RecallSourceDiagnostic[];
  };
};
