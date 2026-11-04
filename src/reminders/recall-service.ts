import { getLocalBackendMemoryFilesystemRoot } from "@/backend/local/paths";
import {
  type EmbeddingDegradeReason,
  embeddingMetrics,
} from "./embedding-metrics";
import {
  createRecallDeadline,
  freezeRecallDeadline,
  type RecallDeadline,
} from "./recall-deadline";
import {
  fuseRecallCandidates,
  RECALL_FUSION_DEFAULTS,
  type RecallFusedCandidate,
  type RecallFusionOptions,
  type RecallFusionResult,
} from "./recall-fusion";
import { selectRecallEntries } from "./recall-orchestrator";
import {
  RECALL_DEFAULTS,
  type RecallArm,
  type RecallBackendPort,
  type RecallCandidate,
  type RecallDecision,
  type RecallEntry,
  type RecallOptions,
  type RecallQueryTerms,
  type RecallScope,
  type RecallSourceDiagnostic,
  type RecallSourcePort,
} from "./recall-port";
import {
  RECALL_QUERY_DEFAULTS,
  type RecallQueryOptions,
  recallQueryTerms,
} from "./recall-query";
import { buildRecallSources } from "./recall-sources";
import { partitionRecallCandidates } from "./recall-vector-source";

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
  /** The vector arm when the host has one; injected, as the encoder lives above this layer. */
  vectorSource?: RecallSourcePort;
  /**
   * The two-arm fusion tunables: `w_vector`, `k`, the relative ratio and the
   * per-arm depth.
   *
   * Supplied by the host from the D3 settings (`recallEmbeddingWeight`,
   * `recallEmbeddingCandidateDepth`) — this layer reads no settings, so a
   * fixture can assert a weight without a settings file. Omitted entirely means
   * {@link RECALL_FUSION_DEFAULTS}: 0.5:0.5 at `k = 60`, top × 0.35.
   *
   * Ignored on the lexical-only path (no vector source, an arm that produced
   * nothing, or `vectorWeight: 0`): that path keeps the pre-fusion behaviour
   * bit for bit, so the vector arm can never perturb a turn it did not serve.
   */
  fusion?: RecallFusionOptions;
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

/** Monotonic clock for the round's telemetry; it never decides anything. */
function nowMs(): number {
  return performance.now();
}

type RecallArmPartition = {
  lexical: RecallCandidate[];
  vector: RecallCandidate[];
};

/** The merged list the selector runs on, plus what the merge looked like. */
type FusedRecallCandidates = RecallArmPartition & {
  /** Fused candidates when both arms contributed, else the untouched flat list. */
  candidates: readonly RecallCandidate[];
  /** `null` on the lexical-only path, which is kept bit for bit. */
  fusion: RecallFusionResult | null;
  /** Wall-clock spent in the merge; `0` when it was skipped. */
  fusionMs: number;
  /** The relative floor the selector will apply (the fusion ratio when it ran). */
  minScoreRatio: number;
  /** The per-arm depth the merge enforced. */
  candidateDepth: number;
};

/**
 * One arm weight, clamped the way `fuseRecallCandidates` clamps it.
 *
 * Read here as well because the service has to decide *whether* to fuse, and
 * `0` means "lexical only" — not "fuse and let the vector scores vanish".
 */
function resolveVectorWeight(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return RECALL_FUSION_DEFAULTS.vectorWeight;
  }
  return Math.min(1, Math.max(0, value));
}

function resolveCandidateDepth(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return RECALL_FUSION_DEFAULTS.candidateDepth;
  }
  return Math.max(1, Math.trunc(value));
}

/**
 * The per-source depth the lexical arm is built with.
 *
 * Feature ②' s pool is `candidateLimit` per source (12), and that is exactly what
 * the embedding-off path must keep — it is part of the bit-for-bit compatibility
 * guarantee (48-1 §6.7: "off 时保持②的每源 12"). When both arms actually fuse,
 * the requirement raises each arm to `recallEmbeddingCandidateDepth` (50):
 * "两臂候选等深 50", and P-02 explicitly forbids unequal arms, because RRF ranks
 * positionally and a 12-deep arm would simply have fewer votes than a 50-deep
 * one. So the lexical sources are built at the fusion depth when the vector arm
 * is going to participate.
 *
 * `vectorWeight: 0` means "lexical only" — the merge drops the vector arm, so
 * that turn keeps ②'s depth: raising it would change a turn the vector arm does
 * not serve, and the weight is the user's statement that they want ②'s result.
 */
function lexicalCandidateLimit(
  options: RecallOptions,
  request: RecallRequest,
): number {
  if (request.vectorSource === undefined) return options.candidateLimit;
  if (!(resolveVectorWeight(request.fusion?.vectorWeight) > 0)) {
    return options.candidateLimit;
  }
  return Math.max(
    options.candidateLimit,
    resolveCandidateDepth(request.fusion?.candidateDepth),
  );
}

/**
 * Replace the first arm's text with the vector arm's when both found the unit.
 *
 * RRF keys on `fingerprint`, so a two-arm hit is one entry — but the two arms
 * render the *same* unit differently: the lexical arm truncates from the head of
 * the message/excerpt, while B4's vector window is centred on the matched chunk
 * (focus 300 + one neighbour, ≤400) and carries the memory title prefix
 * (48-2 §4.3, R-33). When both arms agree the unit is relevant, the hit-centred
 * window is the better context, so the merged entry keeps the vector arm's text
 * and the line span that text was cut from. Lexical-only entries (and every
 * turn without a vector arm) keep the lexical text untouched.
 */
function preferVectorText(
  fused: readonly RecallFusedCandidate[],
  vector: readonly RecallCandidate[],
): RecallFusedCandidate[] {
  const byFingerprint = new Map(
    vector.map((candidate) => [candidate.fingerprint, candidate]),
  );
  return fused.map((candidate) => {
    if (!candidate.arms.includes("vector")) return candidate;
    const vectorCandidate = byFingerprint.get(candidate.fingerprint);
    if (vectorCandidate === undefined) return candidate;
    return {
      ...candidate,
      text: vectorCandidate.text,
      ...(vectorCandidate.startLine === undefined
        ? {}
        : { startLine: vectorCandidate.startLine }),
      ...(vectorCandidate.endLine === undefined
        ? {}
        : { endLine: vectorCandidate.endLine }),
      ...(vectorCandidate.focusChar === undefined
        ? {}
        : { focusChar: vectorCandidate.focusChar }),
      ...(vectorCandidate.chunkIndex === undefined
        ? {}
        : { chunkIndex: vectorCandidate.chunkIndex }),
    };
  });
}

/**
 * Split the flat two-phase list back into arms and fuse it.
 *
 * Three fallbacks keep the lexical-only path *bit for bit* the pre-fusion one:
 * no vector source ran, the vector arm produced no candidate (missing index, a
 * spent budget, an encoder that cannot answer — 48-1 §6.9 says fall back to
 * lexical), or the user set `vectorWeight: 0` (lexical only). In those cases the
 * original list is returned unchanged, so `entries`, `threshold`, status and the
 * candidate count are exactly what feature ② produced.
 */
function fuseRecallArms(
  candidates: readonly RecallCandidate[],
  options: RecallFusionOptions | undefined,
  selectorRatio: number,
): FusedRecallCandidates {
  const partition = partitionRecallCandidates(candidates);
  const vectorWeight = resolveVectorWeight(options?.vectorWeight);
  const candidateDepth = resolveCandidateDepth(options?.candidateDepth);
  const requestedRatio = options?.minScoreRatio;
  const minScoreRatio =
    requestedRatio === undefined || !Number.isFinite(requestedRatio)
      ? selectorRatio
      : Math.max(0, requestedRatio);
  if (partition.vector.length === 0) {
    // Nothing from the vector arm: the flat list is already lexical-only.
    return {
      ...partition,
      candidates,
      fusion: null,
      fusionMs: 0,
      minScoreRatio: selectorRatio,
      candidateDepth,
    };
  }
  if (!(vectorWeight > 0)) {
    // `vectorWeight: 0` means "lexical only". Drop the arm's candidates instead
    // of letting them through unfused, or the setting would not mean anything.
    return {
      ...partition,
      candidates: partition.lexical,
      fusion: null,
      fusionMs: 0,
      minScoreRatio: selectorRatio,
      candidateDepth,
    };
  }
  const startedAt = nowMs();
  const fusion = fuseRecallCandidates(
    { lexical: partition.lexical, vector: partition.vector },
    {
      vectorWeight,
      minScoreRatio,
      ...(options?.k === undefined ? {} : { k: options.k }),
      candidateDepth,
    },
  );
  return {
    ...partition,
    candidates: preferVectorText(fusion.candidates, partition.vector),
    fusion,
    fusionMs: Math.max(0, nowMs() - startedAt),
    minScoreRatio,
    candidateDepth,
  };
}

/**
 * The degrade vocabulary for one arm's diagnostic, or `undefined` when the arm
 * ran normally.
 *
 * `empty` is deliberately **not** a degradation: it means the arm ran and
 * nothing matched, which is the ordinary outcome of a recall turn. Recording it
 * would make the status face paint "degraded" on almost every round and destroy
 * the only distinction it exists for — "no hit" versus "not working"
 * (48-1 §6.9, §7.4). A space that cannot answer at all reports `unavailable`
 * (or the arm is not attached), which is the signal `/recall embedding build` is
 * the fix for.
 */
function degradeReasonFor(
  status: RecallSourceDiagnostic["status"],
): EmbeddingDegradeReason | undefined {
  switch (status) {
    case "degraded":
      return "degraded";
    case "unavailable":
      return "unavailable";
    case "failed":
      return "failed";
    case "empty":
      return undefined;
    case "searched":
      return undefined;
  }
}

/**
 * Record this round's numbers for D6's status face (48-1 §7.5).
 *
 * One call, on the way out, after the selection is final. It reads only counts
 * (arm candidates, merged/injected totals, degrade codes, timings) — never
 * passage text — and never feeds back into the decision. A degraded vector arm
 * is recorded as a degrade reason and nothing else: it is not a timeout, so the
 * breaker in `recall-runtime.ts` (which reads `timedOut`/`status` only) is
 * untouched by this function.
 *
 * Chunk-level counts (`chunks.hits`) are not visible at this layer: E2/B2 report
 * parent hits after aggregation, so only `parents` is recorded and the
 * pre-aggregation hit count stays `0`.
 */
function recordRecallMetrics(input: {
  fused: FusedRecallCandidates;
  diagnostics: readonly RecallSourceDiagnostic[];
  entries: readonly RecallEntry[];
  timings: { lexicalMs: number; vectorMs: number; totalMs: number };
}): void {
  const fusedResult = input.fused.fusion;
  const armsByFingerprint = new Map<string, readonly RecallArm[]>();
  if (fusedResult !== null) {
    for (const candidate of fusedResult.candidates) {
      armsByFingerprint.set(candidate.fingerprint, candidate.arms);
    }
  }
  const injectedByArm = (arm: RecallArm): number =>
    input.entries.filter((entry) => {
      const arms = armsByFingerprint.get(entry.fingerprint);
      // Without a merge every injected entry came from the lexical arm.
      return arms === undefined ? arm === "lexical" : arms.includes(arm);
    }).length;
  const degrade: EmbeddingDegradeReason[] = [];
  for (const diagnostic of input.diagnostics) {
    if (diagnostic.source !== "vector") continue;
    const reason = degradeReasonFor(diagnostic.status);
    if (reason !== undefined) degrade.push(reason);
  }
  const depth = input.fused.candidateDepth;
  embeddingMetrics.record({
    lexical: {
      candidates: input.fused.lexical.length,
      injected: injectedByArm("lexical"),
    },
    vector: {
      candidates: input.fused.vector.length,
      injected: injectedByArm("vector"),
    },
    chunks: { parents: input.fused.vector.length },
    bothArms:
      fusedResult === null
        ? 0
        : fusedResult.candidates.filter(
            (candidate) => candidate.arms.length > 1,
          ).length,
    fusedIn:
      fusedResult === null
        ? 0
        : Math.min(input.fused.lexical.length, depth) +
          Math.min(input.fused.vector.length, depth),
    fusedOut: fusedResult === null ? 0 : fusedResult.candidates.length,
    injected: input.entries.length,
    degrade,
    timings: {
      lexicalMs: input.timings.lexicalMs,
      vectorMs: input.timings.vectorMs,
      fusionMs: input.fused.fusionMs,
      totalMs: input.timings.totalMs,
    },
  });
}

/**
 * One turn's search, as the two phases the deadline treats differently.
 *
 * The sequencing is the point, so it has its own function: the lexical arm runs
 * against the turn's budget and its verdict is frozen the moment it ends; the
 * vector arm then runs and may degrade on its own. `timedOut` is therefore the
 * lexical arm's verdict only — the vector arm's overrun is reported as a
 * `degraded` diagnostic and must never become a timeout, because `timedOut` is
 * what trips the breaker (`recall-runtime.ts`).
 *
 * Exported so the phase boundary is testable without the store behind
 * `runRecall`: both arms are ordinary ports, and a fixture can drive them
 * directly.
 */
export async function searchRecallPhases(
  sources: readonly RecallSourcePort[],
  query: RecallQueryTerms,
  scope: RecallScope,
  deadline: RecallDeadline,
): Promise<{
  candidates: RecallCandidate[];
  diagnostics: RecallSourceDiagnostic[];
  timedOut: boolean;
  /**
   * Wall-clock per arm, for D6's per-round telemetry (48-1 §7.5). Recorded,
   * never read: no policy decision depends on it, so a fake clock cannot change
   * what a turn does.
   */
  timings: { lexicalMs: number; vectorMs: number };
}> {
  const candidates: RecallCandidate[] = [];
  const diagnostics: RecallSourceDiagnostic[] = [];

  const searchArm = async (arm: RecallArm): Promise<void> => {
    for (const source of sources) {
      if (source.arm !== arm) continue;
      // One guard per source: a source that throws contributes no candidates and
      // one diagnostic, and the turn continues (invariant I7).
      try {
        const result = await source.search({ terms: query, scope });
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
  };

  // Phase 1 — lexical. Its bodies never await, so the cooperative checkpoints
  // inside them are still the only thing bounding this phase.
  const lexicalStartedAt = nowMs();
  await searchArm("lexical");
  const lexicalMs = Math.max(0, nowMs() - lexicalStartedAt);
  // The phase boundary: from here the turn's verdict is fixed.
  const timedOut = freezeRecallDeadline(deadline).expired();
  // Phase 2 — vector. Empty until the encoder and its source land; the structure
  // is here so wiring that arm is additive.
  const vectorStartedAt = nowMs();
  await searchArm("vector");
  const vectorMs = Math.max(0, nowMs() - vectorStartedAt);

  return {
    candidates,
    diagnostics,
    timedOut,
    timings: { lexicalMs, vectorMs },
  };
}

export async function runRecall(
  request: RecallRequest,
): Promise<RecallDecision> {
  const turnStartedAt = nowMs();
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
      candidateLimit: lexicalCandidateLimit(options, request),
      neighbors: options.neighbors,
      excerptLines: options.excerptLines,
      shouldStop: () => deadline.expired(),
    });
    // A source switched off by the caller is not a degradation: it is left out
    // entirely rather than reported as unavailable, which is reserved for "the source
    // exists but could not be searched".
    const all =
      request.vectorSource === undefined
        ? built
        : [...built, request.vectorSource];
    sources =
      request.memoryEnabled === false
        ? all.filter((source) => source.id !== "memory")
        : all;
  } catch (error) {
    return {
      entries: [],
      status: "failed",
      reason: error instanceof Error ? error.message : String(error),
      diagnostics: emptyDiagnostics(0, 0, noSources),
    };
  }

  const { candidates, diagnostics, timedOut, timings } =
    await searchRecallPhases(
      sources,
      query,
      {
        agentId: request.agentId,
        currentConversationId: request.conversationId,
        // The vector arm reads the B2 index rather than the corpus the lexical
        // arm was built from, so it needs `N` in the scope to apply the same
        // exclusion (48-1 §6.2 item 9). The lexical sources ignore this field —
        // they were already built with it.
        excludedMessageIds,
      },
      deadline,
    );

  // E3: the two flat arms become one list here, and from this point on the
  // existing selector/dedup path runs on fused scores. On the lexical-only path
  // (see `fuseRecallArms`) `fused.candidates` *is* the pre-fusion list, so a turn
  // without a usable vector arm is byte-for-byte what feature ② produced.
  const fused = fuseRecallArms(
    candidates,
    request.fusion,
    options.minScoreRatio,
  );

  const selection = selectRecallEntries({
    candidates: fused.candidates,
    limit: options.limit,
    // The fusion layer's ratio is the same relative floor, now applied to RRF
    // scores; fall back to the ② setting when no fusion options were supplied.
    minScoreRatio: fused.minScoreRatio,
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

  // D6 telemetry: one call, after the round is final. It observes counts and
  // never feeds back into the decision.
  recordRecallMetrics({
    fused,
    diagnostics,
    entries: selection.entries,
    timings: {
      ...timings,
      totalMs: Math.max(0, nowMs() - turnStartedAt),
    },
  });

  const settled = emptyDiagnostics(
    selection.threshold,
    fused.candidates.length,
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
  } else if (
    fused.candidates.length > 0 &&
    selection.deduped === fused.candidates.length
  ) {
    decision = {
      entries: [],
      status: "suppressed",
      reason: "everything that matched was injected inside the dedup window",
      diagnostics: settled,
    };
  } else {
    decision = { entries: [], status: "no-match", diagnostics: settled };
  }

  if (!timedOut) return decision;
  return {
    ...decision,
    timedOut: true,
    reason: decision.reason ?? "the recall deadline expired",
  };
}
