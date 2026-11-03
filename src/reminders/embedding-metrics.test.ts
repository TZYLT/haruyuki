/**
 * Feature ③'s per-round telemetry (48-1 §7.5, 48-2 §3.4 D6). F-12's acceptance
 * row is "counts, durations and degrade reasons are readable, no text" — this
 * file pins the counting rules, the window/lifetime split and the degrade
 * vocabulary, because the status face only ever sees this snapshot.
 */
import { describe, expect, test } from "bun:test";
import {
  createEmbeddingMetricsRecorder,
  EMBEDDING_DEGRADE_REASONS,
  EMBEDDING_METRICS_MAX_WINDOW_SIZE,
  EMBEDDING_METRICS_WINDOW_SIZE,
  type EmbeddingMetricsSnapshot,
  type EmbeddingRoundMetricsInput,
  embeddingMetrics,
  resetEmbeddingMetrics,
  summarizeEmbeddingMetrics,
} from "./embedding-metrics";

/** A full round, so each assertion can override exactly the field it is about. */
function round(
  overrides: EmbeddingRoundMetricsInput = {},
): EmbeddingRoundMetricsInput {
  return {
    lexical: { candidates: 8, injected: 2 },
    vector: { candidates: 6, injected: 1 },
    chunks: { hits: 9, parents: 6, skipVector: 1 },
    bothArms: 1,
    fusedIn: 14,
    fusedOut: 12,
    injected: 3,
    timings: { lexicalMs: 12, vectorMs: 40, fusionMs: 2, totalMs: 54 },
    ...overrides,
  };
}

describe("createEmbeddingMetricsRecorder", () => {
  test("keeps the recent N rounds in a ring and the lifetime totals apart", () => {
    let now = 1_000;
    const recorder = createEmbeddingMetricsRecorder({
      windowSize: 3,
      clock: () => now,
    });

    for (let index = 0; index < 5; index += 1) {
      now += 10;
      recorder.record(round());
    }

    const snapshot = recorder.snapshot();
    expect(snapshot.windowSize).toBe(3);
    expect(snapshot.rounds).toHaveLength(3);
    expect(snapshot.rounds.map((entry) => entry.at)).toEqual([
      1_030, 1_040, 1_050,
    ]);
    // Lifetime totals cover all five rounds, not only the window.
    expect(snapshot.totals.rounds).toBe(5);
    expect(snapshot.totals.lexical.candidates).toBe(40);
    expect(snapshot.totals.vector.candidates).toBe(30);
    expect(snapshot.totals.vector.chunks).toBe(45);
    expect(snapshot.totals.injected).toBe(15);
    expect(snapshot.last?.at).toBe(1_050);
  });

  test("totals stay empty until a round is recorded, and reset clears both halves", () => {
    const recorder = createEmbeddingMetricsRecorder({ windowSize: 2 });
    const empty = recorder.snapshot();
    expect(empty.last).toBeNull();
    expect(empty.rounds).toEqual([]);
    expect(empty.totals.rounds).toBe(0);
    expect(empty.totals.degrade.timedOut).toBe(0);

    recorder.record(round({ degrade: ["timedOut"] }));
    recorder.reset();
    const cleared = recorder.snapshot();
    expect(cleared.rounds).toEqual([]);
    expect(cleared.totals.rounds).toBe(0);
    expect(cleared.totals.degrade.timedOut).toBe(0);
  });

  test("window size is clamped and defaults to the requirement's N", () => {
    expect(createEmbeddingMetricsRecorder({ windowSize: 0 }).windowSize).toBe(
      1,
    );
    expect(
      createEmbeddingMetricsRecorder({ windowSize: 9_999 }).windowSize,
    ).toBe(EMBEDDING_METRICS_MAX_WINDOW_SIZE);
    expect(createEmbeddingMetricsRecorder().windowSize).toBe(
      EMBEDDING_METRICS_WINDOW_SIZE,
    );
  });

  test("a partial round records zeros instead of NaN", () => {
    const recorder = createEmbeddingMetricsRecorder({ clock: () => 7 });
    const recorded = recorder.record({ vector: { candidates: 2 } });
    expect(recorded.at).toBe(7);
    expect(recorded.lexical).toEqual({ candidates: 0, injected: 0 });
    expect(recorded.vector).toEqual({ candidates: 2, injected: 0 });
    expect(recorded.chunks).toEqual({ hits: 0, parents: 0, skipVector: 0 });
    expect(recorded.degrade).toEqual([]);
    expect(recorded.timings).toEqual({
      lexicalMs: 0,
      vectorMs: 0,
      fusionMs: 0,
      totalMs: 0,
    });
  });

  test("malformed counts are clamped at zero rather than poisoning the totals", () => {
    const recorder = createEmbeddingMetricsRecorder();
    const recorded = recorder.record({
      lexical: { candidates: -4, injected: 1.9 },
      vector: { candidates: Number.NaN, injected: Number.POSITIVE_INFINITY },
      chunks: { hits: -1, parents: 2.7, skipVector: Number.NaN },
      bothArms: -2,
      fusedIn: 3.9,
      fusedOut: Number.NaN,
      injected: 1,
      timings: {
        lexicalMs: -5,
        vectorMs: Number.NaN,
        fusionMs: 1.5,
        totalMs: -1,
      },
    });
    expect(recorded.lexical.candidates).toBe(0);
    expect(recorded.lexical.injected).toBe(1);
    expect(recorded.vector.candidates).toBe(0);
    expect(recorded.vector.injected).toBe(0);
    expect(recorded.chunks.hits).toBe(0);
    expect(recorded.chunks.parents).toBe(2);
    expect(recorded.chunks.skipVector).toBe(0);
    expect(recorded.bothArms).toBe(0);
    expect(recorded.fusedIn).toBe(3);
    expect(recorded.fusedOut).toBe(0);
    expect(recorded.timings).toEqual({
      lexicalMs: 0,
      vectorMs: 0,
      fusionMs: 1.5,
      totalMs: 0,
    });
  });

  test("degrade reasons are deduped into canonical order and counted per round", () => {
    const recorder = createEmbeddingMetricsRecorder();
    recorder.record(
      round({ degrade: ["failed", "timedOut", "failed", "timedOut"] }),
    );
    recorder.record(round({ degrade: ["empty"] }));
    recorder.record(round());

    const snapshot = recorder.snapshot();
    expect(snapshot.rounds[0]?.degrade).toEqual(["timedOut", "failed"]);
    expect(snapshot.rounds[1]?.degrade).toEqual(["empty"]);
    expect(snapshot.totals.degradedRounds).toBe(2);
    expect(snapshot.totals.degrade).toEqual({
      timedOut: 1,
      degraded: 0,
      unavailable: 0,
      empty: 1,
      failed: 1,
    });
  });

  test("the snapshot is a copy: mutating it cannot rewrite the recorder", () => {
    const recorder = createEmbeddingMetricsRecorder();
    recorder.record(round());
    const first = recorder.snapshot();
    // The frozen round array and totals are the contract; a caller that needs to
    // annotate one must clone it.
    expect(() => {
      (first.rounds as unknown as unknown[]).push({});
    }).toThrow();
    first.totals.rounds = 99;
    expect(recorder.snapshot().totals.rounds).toBe(1);
  });

  test("the process-wide recorder resets in tests", () => {
    embeddingMetrics.record(round());
    expect(embeddingMetrics.snapshot().totals.rounds).toBeGreaterThan(0);
    resetEmbeddingMetrics();
    expect(embeddingMetrics.snapshot().totals.rounds).toBe(0);
  });

  test("the degrade vocabulary is complete and stable", () => {
    expect(EMBEDDING_DEGRADE_REASONS).toEqual([
      "timedOut",
      "degraded",
      "unavailable",
      "empty",
      "failed",
    ]);
  });
});

describe("summarizeEmbeddingMetrics", () => {
  function snapshotWith(
    recorder: ReturnType<typeof createEmbeddingMetricsRecorder>,
  ): EmbeddingMetricsSnapshot {
    return recorder.snapshot();
  }

  test("divides lifetime totals by rounds and zero-guards an empty window", () => {
    const recorder = createEmbeddingMetricsRecorder();
    recorder.record(round());
    recorder.record(
      round({
        lexical: { candidates: 2, injected: 1 },
        vector: { candidates: 4, injected: 0 },
        chunks: { hits: 5, parents: 3, skipVector: 0 },
        bothArms: 0,
        fusedIn: 6,
        fusedOut: 5,
        injected: 1,
        timings: { lexicalMs: 8, vectorMs: 20, fusionMs: 1, totalMs: 29 },
      }),
    );

    const summary = summarizeEmbeddingMetrics(snapshotWith(recorder));
    expect(summary.rounds).toBe(2);
    expect(summary.lexicalPerRound).toBe(5);
    expect(summary.vectorPerRound).toBe(5);
    expect(summary.injectedPerRound).toBe(2);
    expect(summary.bothArmsPerRound).toBe(0.5);
    expect(summary.chunksPerRound).toBe(7);
    expect(summary.skipVectorPerRound).toBe(0.5);
    expect(summary.averageTimings.lexicalMs).toBe(10);
    expect(summary.averageTimings.vectorMs).toBe(30);
    expect(summary.averageTimings.fusionMs).toBe(1.5);
    expect(summary.averageTimings.totalMs).toBe(41.5);

    const empty = summarizeEmbeddingMetrics(
      createEmbeddingMetricsRecorder().snapshot(),
    );
    expect(empty.rounds).toBe(0);
    expect(empty.lexicalPerRound).toBe(0);
    expect(empty.vectorPerRound).toBe(0);
    expect(empty.injectedPerRound).toBe(0);
    expect(empty.averageTimings.totalMs).toBe(0);
  });

  test("carries the degrade counts through unchanged", () => {
    const recorder = createEmbeddingMetricsRecorder();
    recorder.record(round({ degrade: ["degraded"] }));
    recorder.record(round({ degrade: ["degraded", "unavailable"] }));
    const summary = summarizeEmbeddingMetrics(recorder.snapshot());
    expect(summary.degradedRounds).toBe(2);
    expect(summary.degrade.degraded).toBe(2);
    expect(summary.degrade.unavailable).toBe(1);
    expect(summary.degrade.timedOut).toBe(0);
  });
});
