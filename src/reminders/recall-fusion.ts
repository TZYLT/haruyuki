import type { RecallArm, RecallCandidate } from "./recall-port";

/**
 * Weighted reciprocal-rank fusion for the two recall arms.
 *
 * The lexical and vector arms score on incomparable scales — BM25 against
 * cosine similarity — so they are merged by *rank*, not by score:
 * `fused = Σ w_arm / (k + rank_arm)`. A passage both arms found gets both
 * contributions added, which is what makes agreement rank above either arm's
 * lone favourite; a passage only one arm found keeps its own term.
 *
 * Pure on purpose. The service (`recall-service.ts`) owns I/O and sequencing, the
 * orchestrator owns selection policy, and this module owns only the merge. It
 * reads no settings: the arm weight, `k`, the relative ratio and the per-arm
 * depth all arrive as arguments, because the settings keys land with E3 and this
 * layer has to stay assertable on a fixture.
 *
 * The result is shaped as `RecallCandidate[]` with `score` *replaced by the fused
 * score*. That is deliberate: `selectRecallEntries` already sorts by `score` and
 * applies its relative floor (`topScore * minScoreRatio`), so wiring this module
 * in does not change the selector at all — the same relative-threshold rule now
 * simply sees RRF scores. The per-arm original scores survive in `armScores` for
 * diagnostics and display, and `arms` says which arm(s) produced the entry.
 *
 * Merging is keyed on the existing `fingerprint` — the same key the dedup window
 * uses (`transcript:<conversation>:<message>`, `memory:<path>`). The same parent
 * unit therefore becomes one entry here and one fingerprint downstream, which is
 * what keeps a two-arm hit from being injected twice. Within one arm a repeated
 * fingerprint is collapsed to its best rank (the vector source aggregates chunks
 * by parent before this point; this is a guard, not a second weighting), while
 * across arms the contributions are summed.
 */

export const RECALL_FUSION_DEFAULTS = {
  /** `w_vector`; `w_lexical = 1 - vectorWeight`. `0` = lexical only, `1` = vector only. */
  vectorWeight: 0.5,
  /** The RRF constant. 60 is the requirement's value; a calibration round may revisit it. */
  k: 60,
  /**
   * Relative floor (`top * ratio`). Never absolute: an RRF score is ~0.01, so a
   * fixed cut-off would be a different — and wrong — rule.
   */
  minScoreRatio: 0.35,
  /**
   * Per-arm candidate depth. Both arms are cut to the same depth, so a caller
   * cannot accidentally hand the fusion two arms of unequal depth (the
   * requirement forbids that).
   */
  candidateDepth: 50,
} as const;

export type RecallFusionInput = {
  /**
   * Lexical arm candidates. RRF ranks by position, so they must be in that arm's
   * own score order; the strategy sorts defensively (`compareArmRank`) because
   * the lexical arm's list is a concatenation of two corpora (transcript, then
   * memory) and a missed sort would rank every memory hit below every transcript
   * hit regardless of score.
   */
  lexical: readonly RecallCandidate[];
  /** Vector arm candidates, in that arm's own score order. */
  vector: readonly RecallCandidate[];
};

export type RecallFusionOptions = {
  /** `w_vector` in `[0, 1]`; clamped. Defaults to `RECALL_FUSION_DEFAULTS.vectorWeight`. */
  vectorWeight?: number;
  /** RRF constant, clamped to `>= 0`. Defaults to `RECALL_FUSION_DEFAULTS.k`. */
  k?: number;
  /** Relative floor ratio, clamped to `>= 0`; `0` disables the floor. */
  minScoreRatio?: number;
  /** Per-arm depth, clamped to `>= 1`. Defaults to `RECALL_FUSION_DEFAULTS.candidateDepth`. */
  candidateDepth?: number;
};

/** Options after clamping, as handed to a strategy. */
export type ResolvedRecallFusionOptions = {
  lexicalWeight: number;
  vectorWeight: number;
  k: number;
  minScoreRatio: number;
  candidateDepth: number;
};

/**
 * One merged passage.
 *
 * `score` is the fused score (see the module comment); `armScores` keeps what
 * each arm originally said, and `armRanks` is 1-based within the arm.
 */
export type RecallFusedCandidate = RecallCandidate & {
  /** Arms that contributed, in fixed `lexical` → `vector` order. */
  arms: RecallArm[];
  armRanks: Partial<Record<RecallArm, number>>;
  armScores: Partial<Record<RecallArm, number>>;
};

export type RecallFusionResult = {
  /**
   * Unique fingerprints, descending fused score, stable tie-break on
   * fingerprint. `score` is the fused score.
   */
  candidates: RecallFusedCandidate[];
  /** `top * minScoreRatio`; `0` when there is nothing to compare or the ratio is `0`. */
  threshold: number;
};

/**
 * The replaceable half: a strategy merges and ranks, nothing else.
 *
 * RRF is the default implementation. A weighted-normalised or DBSF strategy can
 * be swapped in without touching this module's caller, because the wrapper below
 * owns option resolution and the relative threshold, and both consume only the
 * candidate shape.
 */
export type RecallFusionStrategy = {
  readonly id: string;
  fuse(
    input: RecallFusionInput,
    options: ResolvedRecallFusionOptions,
  ): RecallFusedCandidate[];
};

type FusionAccumulator = {
  candidate: RecallCandidate;
  score: number;
  arms: RecallArm[];
  armRanks: Partial<Record<RecallArm, number>>;
  armScores: Partial<Record<RecallArm, number>>;
};

function compareFusedCandidates(
  left: RecallFusedCandidate,
  right: RecallFusedCandidate,
): number {
  if (right.score !== left.score) return right.score - left.score;
  if (left.fingerprint === right.fingerprint) return 0;
  // Code-unit order, not locale order: the tie-break must not move with the
  // process locale, or the same fixture would order differently on two machines.
  return left.fingerprint < right.fingerprint ? -1 : 1;
}

/**
 * The order an arm's ranks come from: descending score, then fingerprint.
 *
 * Rank is positional in RRF, so this is the whole of an arm's contribution.
 * The fingerprint tie-break is code-unit order (never locale order) so two runs
 * over the same candidates rank identically on every machine.
 */
function compareArmRank(left: RecallCandidate, right: RecallCandidate): number {
  if (right.score !== left.score) return right.score - left.score;
  if (left.fingerprint === right.fingerprint) return 0;
  return left.fingerprint < right.fingerprint ? -1 : 1;
}

function finiteOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

function resolveRecallFusionOptions(
  options: RecallFusionOptions,
): ResolvedRecallFusionOptions {
  const vectorWeight = Math.min(
    1,
    Math.max(
      0,
      finiteOr(options.vectorWeight, RECALL_FUSION_DEFAULTS.vectorWeight),
    ),
  );
  return {
    vectorWeight,
    lexicalWeight: 1 - vectorWeight,
    k: Math.max(0, finiteOr(options.k, RECALL_FUSION_DEFAULTS.k)),
    minScoreRatio: Math.max(
      0,
      finiteOr(options.minScoreRatio, RECALL_FUSION_DEFAULTS.minScoreRatio),
    ),
    candidateDepth: Math.max(
      1,
      Math.trunc(
        finiteOr(options.candidateDepth, RECALL_FUSION_DEFAULTS.candidateDepth),
      ),
    ),
  };
}

/**
 * The default strategy: `Σ w_arm / (k + rank_arm)`.
 *
 * An arm with weight `0` does not participate at all rather than contributing a
 * zero score: `vectorWeight: 0` means "lexical only", so a vector-only hit must
 * not survive as a zero-scored entry that a later `score >= threshold` filter
 * (where `threshold` is also `0`) would happily admit.
 */
function rrfFuse(
  input: RecallFusionInput,
  options: ResolvedRecallFusionOptions,
): RecallFusedCandidate[] {
  const arms: readonly {
    arm: RecallArm;
    candidates: readonly RecallCandidate[];
    weight: number;
  }[] = [
    {
      arm: "lexical",
      candidates: input.lexical,
      weight: options.lexicalWeight,
    },
    { arm: "vector", candidates: input.vector, weight: options.vectorWeight },
  ];
  const merged = new Map<string, FusionAccumulator>();

  for (const { arm, candidates, weight } of arms) {
    if (!(weight > 0)) continue;
    // Rank is position, so the arm is ordered by its own score before the depth
    // cut: taking the first `candidateDepth` of an unordered list would both
    // mis-rank and drop candidates the arm actually preferred.
    const ordered = [...candidates].sort(compareArmRank);
    const end = Math.min(ordered.length, options.candidateDepth);
    for (let index = 0; index < end; index += 1) {
      const candidate = ordered[index];
      if (candidate === undefined) continue;
      const rank = index + 1;
      const contribution = weight / (options.k + rank);
      const existing = merged.get(candidate.fingerprint);
      if (existing === undefined) {
        merged.set(candidate.fingerprint, {
          candidate,
          score: contribution,
          arms: [arm],
          armRanks: { [arm]: rank },
          armScores: { [arm]: candidate.score },
        });
        continue;
      }
      // One arm counts a parent unit once, at its best rank. The vector source
      // already aggregates chunks by parent; this only makes a malformed input
      // (the same fingerprint twice in one list) behave like the aggregate.
      if (existing.armRanks[arm] !== undefined) continue;
      existing.score += contribution;
      existing.arms.push(arm);
      existing.armRanks[arm] = rank;
      existing.armScores[arm] = candidate.score;
    }
  }

  return [...merged.values()]
    .map((entry) => ({
      ...entry.candidate,
      score: entry.score,
      arms: entry.arms,
      armRanks: entry.armRanks,
      armScores: entry.armScores,
    }))
    .sort(compareFusedCandidates);
}

export const rrfFusionStrategy: RecallFusionStrategy = {
  id: "rrf",
  fuse: rrfFuse,
};

/**
 * The relative floor, `topScore * ratio`. `0` means "no floor".
 *
 * Relative, never absolute: RRF scores are ~0.01 and move with the arm weights
 * and `k`, so a constant would select nothing or everything depending on the
 * setting. This is the same rule `selectRecallEntries` applies to `score`.
 */
export function relativeScoreThreshold(
  topScore: number,
  ratio: number,
): number {
  if (!(topScore > 0) || !(ratio > 0)) return 0;
  return topScore * ratio;
}

/**
 * The selection aid: fused candidates at or above `top * ratio`.
 *
 * Fusion itself keeps every merged candidate so diagnostics can see what was
 * found; a caller that wants the threshold applied (E3 wiring) uses this instead
 * of re-deriving the rule.
 */
export function filterAboveRelativeThreshold(
  candidates: readonly RecallFusedCandidate[],
  ratio: number = RECALL_FUSION_DEFAULTS.minScoreRatio,
): RecallFusionResult {
  const threshold = relativeScoreThreshold(candidates[0]?.score ?? 0, ratio);
  return {
    candidates:
      threshold > 0
        ? candidates.filter((candidate) => candidate.score >= threshold)
        : [...candidates],
    threshold,
  };
}

/**
 * Fuse the two arms. The caller never learns which strategy ran.
 *
 * `candidates` is every merged fingerprint, ordered; `threshold` is the relative
 * floor that `filterAboveRelativeThreshold` would apply. The fused `score`
 * replaces the arm-local score, so the existing selector keeps working unchanged.
 */
export function fuseRecallCandidates(
  input: RecallFusionInput,
  options: RecallFusionOptions = {},
  strategy: RecallFusionStrategy = rrfFusionStrategy,
): RecallFusionResult {
  const resolved = resolveRecallFusionOptions(options);
  const candidates = strategy.fuse(input, resolved);
  return {
    candidates,
    threshold: relativeScoreThreshold(
      candidates[0]?.score ?? 0,
      resolved.minScoreRatio,
    ),
  };
}
