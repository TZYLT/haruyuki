/**
 * Feature ③'s per-round retrieval telemetry (48-1 §7.5, 48-2 §3.4 D6 / §4.9).
 *
 * The rule the requirement sets is "record numbers, never text": every field
 * here is a count, a reason code or a duration, so the window can be printed
 * from `/recall status`, handed to the headless receipt and asserted in a test
 * without a single passage of user content crossing the boundary.
 *
 * The module is pure bookkeeping. It reads no settings, opens no file and does
 * no clock work of its own — `at` comes from the injected clock, and the
 * recorder is what its owner makes it: the exported {@link embeddingMetrics}
 * singleton is the process-wide instance the status faces read, while tests
 * (and any caller that wants a private window) use
 * {@link createEmbeddingMetricsRecorder}.
 *
 * **The ring is a window, the totals are lifetime.** `snapshot().rounds` holds
 * the most recent `windowSize` rounds and `snapshot().totals` covers every round
 * since the recorder was created (or reset). `summarizeEmbeddingMetrics` turns
 * the lifetime totals into per-round averages, which is the shape a status line
 * wants: a single outlier round should not move the displayed rate.
 *
 * Why the three chunk counters are separate: a passage can be *found* (chunk
 * hit), *aggregated* to its parent unit, and only then *injected*. Collapsing
 * them into one number is what made the original review unable to answer
 * "did the vector arm find nothing, or did the budget throw it away" (S-04).
 */

/** Why the vector arm contributed less than a full search this round. */
export type EmbeddingDegradeReason =
  /** The vector arm hit its own deadline and returned what it had (A1/E2). */
  | "timedOut"
  /** A source was cut short (budget) but still produced candidates. */
  | "degraded"
  /** The source could not run at all (no workspace, index unusable). */
  | "unavailable"
  /** The source ran and found nothing. */
  | "empty"
  /** The source threw; the turn continued without it. */
  | "failed";

/**
 * Canonical order (same vocabulary as `RecallSourceStatus` plus the vector
 * arm's own `timedOut`), used to dedupe and stabilise a round's reason list.
 */
export const EMBEDDING_DEGRADE_REASONS: readonly EmbeddingDegradeReason[] = [
  "timedOut",
  "degraded",
  "unavailable",
  "empty",
  "failed",
];

/** Rounds kept in the default window (48-1 §7.5 asks for "recent rounds"). */
export const EMBEDDING_METRICS_WINDOW_SIZE = 50;

/** Ceiling for an injected `windowSize`; keeps the ring small on a long run. */
export const EMBEDDING_METRICS_MAX_WINDOW_SIZE = 500;

/** One arm's round. */
export interface EmbeddingArmRoundMetrics {
  /** Candidates the arm produced this round, after its own depth cut. */
  candidates: number;
  /** Passages the arm contributed to the injected block. */
  injected: number;
}

/** Chunk-level counts, kept apart from the arm counts (see the module note). */
export interface EmbeddingChunkRoundMetrics {
  /** Chunk hits before parent-unit aggregation. */
  hits: number;
  /** Parent units after aggregation. */
  parents: number;
  /** Messages/parents skipped because they carry no embeddable prose. */
  skipVector: number;
}

/** Wall-clock spent by the two arms and the merge. */
export interface EmbeddingRoundTimings {
  /** The lexical arm (never on the vector arm's critical path). */
  lexicalMs: number;
  /** Query encode + index scan; the vector arm's own budget applies here. */
  vectorMs: number;
  /** RRF merge + relative threshold. */
  fusionMs: number;
  /** The whole recall turn, including both arms and the merge. */
  totalMs: number;
}

/** What one recall turn recorded. Never contains passage text. */
export interface EmbeddingRoundMetrics {
  /** Clock time of the round, from the recorder's injected clock. */
  at: number;
  lexical: EmbeddingArmRoundMetrics;
  vector: EmbeddingArmRoundMetrics;
  chunks: EmbeddingChunkRoundMetrics;
  /** Fingerprints that both arms found (merged by fusion). */
  bothArms: number;
  /** Candidates handed to fusion (both arms, after the depth cut). */
  fusedIn: number;
  /** Unique fingerprints fusion returned. */
  fusedOut: number;
  /** Passages actually injected, after the relative floor and the budget. */
  injected: number;
  /** Reasons the arms did not fully run; canonical order, no duplicates. */
  degrade: readonly EmbeddingDegradeReason[];
  timings: EmbeddingRoundTimings;
}

/** Per-round counters; every field is optional so a caller records what it has. */
export interface EmbeddingRoundMetricsInput {
  lexical?: Partial<EmbeddingArmRoundMetrics>;
  vector?: Partial<EmbeddingArmRoundMetrics>;
  chunks?: Partial<EmbeddingChunkRoundMetrics>;
  bothArms?: number;
  fusedIn?: number;
  fusedOut?: number;
  injected?: number;
  degrade?: readonly EmbeddingDegradeReason[];
  timings?: Partial<EmbeddingRoundTimings>;
}

/** One arm's lifetime totals. */
export interface EmbeddingArmTotals {
  rounds: number;
  candidates: number;
  injected: number;
}

/** The vector arm also owns the chunk counters (the lexical arm has none). */
export interface EmbeddingVectorArmTotals extends EmbeddingArmTotals {
  chunks: number;
  skipVector: number;
}

/** Lifetime timing totals; `summarizeEmbeddingMetrics` divides them. */
export interface EmbeddingTimingTotals {
  lexicalMs: number;
  vectorMs: number;
  fusionMs: number;
  totalMs: number;
}

/** Lifetime counters behind the window. */
export interface EmbeddingMetricsTotals {
  rounds: number;
  lexical: EmbeddingArmTotals;
  vector: EmbeddingVectorArmTotals;
  bothArms: number;
  fusedIn: number;
  fusedOut: number;
  injected: number;
  /** Rounds with at least one degrade reason. */
  degradedRounds: number;
  /** How often each reason appeared (a round may name several). */
  degrade: Record<EmbeddingDegradeReason, number>;
  timings: EmbeddingTimingTotals;
}

/** One read of the recorder: the window plus the lifetime totals. */
export interface EmbeddingMetricsSnapshot {
  /** Configured ring capacity (`rounds.length <= windowSize`). */
  windowSize: number;
  /** Most recent rounds, oldest first. Frozen. */
  rounds: readonly EmbeddingRoundMetrics[];
  totals: EmbeddingMetricsTotals;
  /** The newest round, or `null` before the first record. */
  last: EmbeddingRoundMetrics | null;
}

/** Totals divided by the round count; zero-safe (`0` while no round exists). */
export interface EmbeddingMetricsSummary {
  rounds: number;
  lexicalPerRound: number;
  vectorPerRound: number;
  injectedPerRound: number;
  bothArmsPerRound: number;
  chunksPerRound: number;
  skipVectorPerRound: number;
  degradedRounds: number;
  degrade: Readonly<Record<EmbeddingDegradeReason, number>>;
  averageTimings: EmbeddingRoundTimings;
}

/** The recorder's injectable seams. */
export interface EmbeddingMetricsRecorderOptions {
  /** Ring capacity; clamped to `[1, EMBEDDING_METRICS_MAX_WINDOW_SIZE]`. */
  windowSize?: number;
  /** Clock for `at`; defaults to `Date.now`. */
  clock?: () => number;
}

/** The two operations a caller needs: record a round, read a snapshot. */
export interface EmbeddingMetricsRecorder {
  record(input?: EmbeddingRoundMetricsInput): EmbeddingRoundMetrics;
  snapshot(): EmbeddingMetricsSnapshot;
  reset(): void;
  /** The configured ring capacity. */
  readonly windowSize: number;
}

function normalizeCount(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function normalizeMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, value);
}

function isDegradeReason(value: unknown): value is EmbeddingDegradeReason {
  return EMBEDDING_DEGRADE_REASONS.includes(value as EmbeddingDegradeReason);
}

/**
 * Keep only known reasons, in canonical order, without duplicates.
 *
 * Canonical rather than input order: two rounds that degraded for the same
 * reasons must serialize identically (the status face compares snapshots, and a
 * reordered list would repaint the line for no new information).
 */
function normalizeDegradeReasons(
  reasons: readonly EmbeddingDegradeReason[] | undefined,
): readonly EmbeddingDegradeReason[] {
  if (reasons === undefined || reasons.length === 0) return Object.freeze([]);
  const seen = new Set<EmbeddingDegradeReason>();
  for (const reason of reasons) {
    if (isDegradeReason(reason)) seen.add(reason);
  }
  return Object.freeze(
    EMBEDDING_DEGRADE_REASONS.filter((reason) => seen.has(reason)),
  );
}

function emptyDegradeCounts(): Record<EmbeddingDegradeReason, number> {
  return {
    timedOut: 0,
    degraded: 0,
    unavailable: 0,
    empty: 0,
    failed: 0,
  };
}

function normalizeWindowSize(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return EMBEDDING_METRICS_WINDOW_SIZE;
  }
  const truncated = Math.trunc(value);
  return Math.min(EMBEDDING_METRICS_MAX_WINDOW_SIZE, Math.max(1, truncated));
}

function emptyTotals(): EmbeddingMetricsTotals {
  return {
    rounds: 0,
    lexical: { rounds: 0, candidates: 0, injected: 0 },
    vector: { rounds: 0, candidates: 0, injected: 0, chunks: 0, skipVector: 0 },
    bothArms: 0,
    fusedIn: 0,
    fusedOut: 0,
    injected: 0,
    degradedRounds: 0,
    degrade: emptyDegradeCounts(),
    timings: { lexicalMs: 0, vectorMs: 0, fusionMs: 0, totalMs: 0 },
  };
}

function buildRound(
  input: EmbeddingRoundMetricsInput,
  at: number,
): EmbeddingRoundMetrics {
  return Object.freeze({
    at,
    lexical: Object.freeze({
      candidates: normalizeCount(input.lexical?.candidates),
      injected: normalizeCount(input.lexical?.injected),
    }),
    vector: Object.freeze({
      candidates: normalizeCount(input.vector?.candidates),
      injected: normalizeCount(input.vector?.injected),
    }),
    chunks: Object.freeze({
      hits: normalizeCount(input.chunks?.hits),
      parents: normalizeCount(input.chunks?.parents),
      skipVector: normalizeCount(input.chunks?.skipVector),
    }),
    bothArms: normalizeCount(input.bothArms),
    fusedIn: normalizeCount(input.fusedIn),
    fusedOut: normalizeCount(input.fusedOut),
    injected: normalizeCount(input.injected),
    degrade: normalizeDegradeReasons(input.degrade),
    timings: Object.freeze({
      lexicalMs: normalizeMs(input.timings?.lexicalMs),
      vectorMs: normalizeMs(input.timings?.vectorMs),
      fusionMs: normalizeMs(input.timings?.fusionMs),
      totalMs: normalizeMs(input.timings?.totalMs),
    }),
  });
}

function accumulate(
  totals: EmbeddingMetricsTotals,
  round: EmbeddingRoundMetrics,
): void {
  totals.rounds += 1;
  totals.lexical.rounds += 1;
  totals.lexical.candidates += round.lexical.candidates;
  totals.lexical.injected += round.lexical.injected;
  totals.vector.rounds += 1;
  totals.vector.candidates += round.vector.candidates;
  totals.vector.injected += round.vector.injected;
  totals.vector.chunks += round.chunks.hits;
  totals.vector.skipVector += round.chunks.skipVector;
  totals.bothArms += round.bothArms;
  totals.fusedIn += round.fusedIn;
  totals.fusedOut += round.fusedOut;
  totals.injected += round.injected;
  if (round.degrade.length > 0) totals.degradedRounds += 1;
  for (const reason of round.degrade) totals.degrade[reason] += 1;
  totals.timings.lexicalMs += round.timings.lexicalMs;
  totals.timings.vectorMs += round.timings.vectorMs;
  totals.timings.fusionMs += round.timings.fusionMs;
  totals.timings.totalMs += round.timings.totalMs;
}

function cloneTotals(totals: EmbeddingMetricsTotals): EmbeddingMetricsTotals {
  return {
    rounds: totals.rounds,
    lexical: { ...totals.lexical },
    vector: { ...totals.vector },
    bothArms: totals.bothArms,
    fusedIn: totals.fusedIn,
    fusedOut: totals.fusedOut,
    injected: totals.injected,
    degradedRounds: totals.degradedRounds,
    degrade: { ...totals.degrade },
    timings: { ...totals.timings },
  };
}

function perRound(total: number, rounds: number): number {
  return rounds === 0 ? 0 : total / rounds;
}

/**
 * Turn lifetime totals into per-round averages (zero-safe).
 *
 * Kept as a separate export rather than a method on the snapshot so a status
 * face can summarise a snapshot it received from somewhere else (a test, a
 * protocol payload, another process's receipt) without a recorder at hand.
 */
export function summarizeEmbeddingMetrics(
  snapshot: EmbeddingMetricsSnapshot,
): EmbeddingMetricsSummary {
  const { totals } = snapshot;
  const rounds = totals.rounds;
  return {
    rounds,
    lexicalPerRound: perRound(totals.lexical.candidates, rounds),
    vectorPerRound: perRound(totals.vector.candidates, rounds),
    injectedPerRound: perRound(totals.injected, rounds),
    bothArmsPerRound: perRound(totals.bothArms, rounds),
    chunksPerRound: perRound(totals.vector.chunks, rounds),
    skipVectorPerRound: perRound(totals.vector.skipVector, rounds),
    degradedRounds: totals.degradedRounds,
    degrade: { ...totals.degrade },
    averageTimings: {
      lexicalMs: perRound(totals.timings.lexicalMs, rounds),
      vectorMs: perRound(totals.timings.vectorMs, rounds),
      fusionMs: perRound(totals.timings.fusionMs, rounds),
      totalMs: perRound(totals.timings.totalMs, rounds),
    },
  };
}

/**
 * Create a recorder with its own ring and totals.
 *
 * `clock` is the only hidden input; passing a fake one is how the tests pin
 * `at` without touching real time.
 */
export function createEmbeddingMetricsRecorder(
  options: EmbeddingMetricsRecorderOptions = {},
): EmbeddingMetricsRecorder {
  const windowSize = normalizeWindowSize(options.windowSize);
  const clock = options.clock ?? (() => Date.now());
  let totals = emptyTotals();
  let rounds: EmbeddingRoundMetrics[] = [];

  return {
    windowSize,
    record(input: EmbeddingRoundMetricsInput = {}): EmbeddingRoundMetrics {
      const round = buildRound(input, clock());
      accumulate(totals, round);
      rounds.push(round);
      if (rounds.length > windowSize) {
        rounds = rounds.slice(rounds.length - windowSize);
      }
      return round;
    },
    snapshot(): EmbeddingMetricsSnapshot {
      return {
        windowSize,
        rounds: Object.freeze([...rounds]),
        totals: cloneTotals(totals),
        last: rounds.at(-1) ?? null,
      };
    },
    reset(): void {
      totals = emptyTotals();
      rounds = [];
    },
  };
}

/** Drop every recorded round and total from the process-wide recorder. */
export function resetEmbeddingMetrics(): void {
  embeddingMetrics.reset();
}

/**
 * The process-wide recorder the status faces read.
 *
 * A singleton because the turn path and the status face are different modules
 * in the same process; anything that needs a private window (tests, a future
 * per-agent recorder) calls {@link createEmbeddingMetricsRecorder} instead.
 */
export const embeddingMetrics: EmbeddingMetricsRecorder =
  createEmbeddingMetricsRecorder();
