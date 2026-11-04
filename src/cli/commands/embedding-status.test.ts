/**
 * `/recall embedding status`'s D6 additions (48-1 §7.4, S-04): the two-arm
 * counters, A2's `state.json` projection and the stored C5 calibration.
 *
 * These are pure formatters, so the copy is asserted without a settings
 * manager, a runtime or an index: the caller's reads are what integration
 * tests cover.
 */
import { describe, expect, test } from "bun:test";
import type { EmbeddingBuildStateSnapshot } from "@/backend/local/embedding-build-state";
import { previewEmbeddingSettings } from "@/cli/app/pages/settings/embedding-settings";
import {
  type EmbeddingCommandDeps,
  type EmbeddingRuntimePort,
  type EmbeddingRuntimeStatus,
  handleEmbeddingCommand,
} from "@/cli/commands/embedding";
import {
  formatEmbeddingBuildSnapshotLines,
  formatEmbeddingMetricsLines,
  formatEmbeddingStoredCalibrationLine,
} from "@/cli/commands/embedding-status";
import {
  EMBEDDING_SETTING_DEFAULTS,
  type EmbeddingCalibrationSettings,
  type ResolvedEmbeddingSettings,
} from "@/recall-settings";
import {
  createEmbeddingMetricsRecorder,
  type EmbeddingRoundMetricsInput,
} from "@/reminders/embedding-metrics";

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

function buildSnapshot(
  overrides: Partial<EmbeddingBuildStateSnapshot> = {},
): EmbeddingBuildStateSnapshot {
  return {
    schemaVersion: 1,
    agentId: "agent-1",
    spaceId: "space-1",
    buildId: "build-1",
    mode: "incremental",
    phase: "running",
    updatedAt: 1_760_000_000_000,
    startedAt: 1_759_999_000_000,
    finishedAt: null,
    progress: {
      embeddedChunks: 1_200,
      totalChunks: 3_600,
      processedConversations: 12,
      totalConversations: 40,
      remainingChunks: 2_400,
      fraction: 1 / 3,
    },
    coverage: {
      embeddedChars: 2_000,
      recallableChars: 2_500,
      ratio: 0.8,
    },
    rate: { chunksPerSecond: 42.5, windowMs: 30_000, sampleCount: 12 },
    eta: { remainingChunks: 2_400, remainingMs: 480_000 },
    failures: [],
    ...overrides,
  };
}

const STORED_CALIBRATION: EmbeddingCalibrationSettings = {
  fingerprint: "abc123",
  measuredAt: "2026-11-03T09:00:00Z",
  queryLatencyP50Ms: 2,
  queryLatencyP90Ms: 6,
  batchThroughputPerSec: 12_600,
  gpuRole: "off",
  threads: 8,
  quantization: "float32",
};

describe("formatEmbeddingMetricsLines", () => {
  test("says so before the first round instead of printing zeros", () => {
    expect(formatEmbeddingMetricsLines(null)).toEqual([
      "Arms: no recall rounds recorded yet",
    ]);
    expect(
      formatEmbeddingMetricsLines(createEmbeddingMetricsRecorder().snapshot()),
    ).toEqual(["Arms: no recall rounds recorded yet"]);
  });

  test("averages the two arms, chunks and timings across rounds", () => {
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

    const lines = formatEmbeddingMetricsLines(recorder.snapshot());
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("2 rounds");
    expect(lines[0]).toContain("lexical 5");
    expect(lines[0]).toContain("vector 5");
    expect(lines[0]).toContain("2 injected");
    expect(lines[0]).toContain("both arms 0.5/round");
    expect(lines[1]).toContain("7 hits/round");
    expect(lines[1]).toContain("0.5 skipped");
    expect(lines[2]).toContain("lexical 10ms");
    expect(lines[2]).toContain("vector 30ms");
    expect(lines[2]).toContain("fusion 1.5ms");
    expect(lines[2]).toContain("total 42ms");
    expect(lines[3]).toBe("  Degraded: no round was degraded");
  });

  test("lists the degrade reasons in canonical order with their counts", () => {
    const recorder = createEmbeddingMetricsRecorder();
    recorder.record(round({ degrade: ["unavailable", "timedOut"] }));
    recorder.record(round({ degrade: ["timedOut"] }));
    recorder.record(round());
    const lines = formatEmbeddingMetricsLines(recorder.snapshot());
    const degraded = lines.at(-1) ?? "";
    expect(degraded).toBe(
      "  Degraded: 2/3 rounds (timedOut ×2, unavailable ×1)",
    );
  });
});

describe("formatEmbeddingBuildSnapshotLines", () => {
  test("paints A2's progress, coverage, rate, remaining time and skipped list", () => {
    const lines = formatEmbeddingBuildSnapshotLines(
      buildSnapshot({
        failures: [
          { conversationId: "conv-1", code: "embed_failed", at: 1 },
          { conversationId: "conv-2", code: "too_large", at: 2 },
        ],
      }),
    );
    expect(lines[0]).toBe(
      "Build (state.json): running · 1200/3600 chunks · 12/40 conversations · coverage 80% · 43 chunks/s",
    );
    expect(lines[1]).toBe("  Remaining: 2400 chunks · ETA 8m");
    expect(lines[2]).toBe(
      "  Skipped: 2 conversations — conv-1 (embed_failed), conv-2 (too_large)",
    );
  });

  test("bounds a long skipped list and reports the tail as a count", () => {
    const failures = Array.from({ length: 5 }, (_, index) => ({
      conversationId: `conv-${index + 1}`,
      code: "embed_failed",
      at: index,
    }));
    const lines = formatEmbeddingBuildSnapshotLines(
      buildSnapshot({ failures }),
    );
    expect(lines.at(-1)).toBe(
      "  Skipped: 5 conversations — conv-1 (embed_failed), conv-2 (embed_failed), conv-3 (embed_failed), +2 more",
    );
  });

  test("an absent snapshot paints nothing (e.g. no runtime in this process)", () => {
    expect(formatEmbeddingBuildSnapshotLines(null)).toEqual([]);
  });

  test("unknown coverage and rate degrade to words, never NaN", () => {
    const lines = formatEmbeddingBuildSnapshotLines(
      buildSnapshot({
        coverage: { embeddedChars: 0, recallableChars: 0, ratio: null },
        rate: { chunksPerSecond: null, windowMs: 0, sampleCount: 0 },
        eta: { remainingChunks: 0, remainingMs: null },
        failures: [],
      }),
    );
    expect(lines[0]).toContain("coverage unknown");
    expect(lines[0]).toContain("rate unknown");
    expect(lines).toHaveLength(1);
  });
});

describe("formatEmbeddingStoredCalibrationLine", () => {
  test("prints the stored C5 result, never its fingerprint", () => {
    const lines = formatEmbeddingStoredCalibrationLine(STORED_CALIBRATION);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Calibration (stored): 2026-11-03T09:00:00Z");
    expect(lines[0]).toContain("p50 2ms");
    expect(lines[0]).toContain("p90 6ms");
    expect(lines[0]).toContain("12600/s");
    expect(lines[0]).toContain("off gpu");
    expect(lines[0]).toContain("8 threads");
    expect(lines[0]).toContain("float32");
    expect(lines[0]).not.toContain("abc123");
  });

  test("no stored calibration paints nothing", () => {
    expect(formatEmbeddingStoredCalibrationLine(null)).toEqual([]);
  });

  test("a defaults-based record says not measured instead of painting zeros", () => {
    // C5's skipped/failed path stores zeros with a timestamp; `p50 0ms · 0/s`
    // would read as a measurement (48-2 R-43, the same rule as wizard step 3).
    const lines = formatEmbeddingStoredCalibrationLine({
      ...STORED_CALIBRATION,
      queryLatencyP50Ms: 0,
      queryLatencyP90Ms: 0,
      batchThroughputPerSec: 0,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("not measured");
    expect(lines[0]).toContain("documented default budget");
    expect(lines[0]).not.toContain("0ms");
    expect(lines[0]).not.toContain("0/s");
  });
});

// ── handler integration ─────────────────────────────────────────────

/**
 * The formatters above prove the copy; these cases prove the handler actually
 * reads the D6 seam (`readMetrics`, `EmbeddingRuntimeStatus.buildSnapshot`,
 * `settings.calibration`) and prints it. The fake runtime mirrors the one the
 * D4 suite uses.
 */
describe("D6 status surface through the handler", () => {
  const SCOPE = { agentId: "agent-embedding", conversationId: "conv-1" };
  const CONFIGURED_RAW = { recallEmbeddingBackend: "builtin" };

  interface Harness {
    deps: EmbeddingCommandDeps;
    writes: unknown[];
  }

  function harness(
    overrides: Partial<EmbeddingCommandDeps> = {},
    start: ResolvedEmbeddingSettings = EMBEDDING_SETTING_DEFAULTS,
  ): Harness {
    let settings = { ...start };
    const writes: unknown[] = [];
    const deps: EmbeddingCommandDeps = {
      readSettings: () => settings,
      writeSettings: (patch) => {
        writes.push(patch);
        settings = previewEmbeddingSettings(patch, settings);
        return settings;
      },
      readRawSettings: () => CONFIGURED_RAW,
      ...overrides,
    };
    return { deps, writes };
  }

  function runtimeStatus(
    overrides: Partial<EmbeddingRuntimeStatus> = {},
  ): EmbeddingRuntimeStatus {
    return {
      ready: true,
      space: null,
      build: null,
      calibration: null,
      egress: false,
      failure: null,
      ...overrides,
    };
  }

  function fakeRuntime(
    overrides: Partial<EmbeddingRuntimePort> = {},
  ): EmbeddingRuntimePort {
    return { readStatus: async () => runtimeStatus(), ...overrides };
  }

  test("paints the two-arm counters from the injected telemetry", async () => {
    const metrics = createEmbeddingMetricsRecorder();
    metrics.record(round());
    const h = harness(
      { readMetrics: () => metrics.snapshot() },
      { ...EMBEDDING_SETTING_DEFAULTS, enabled: true },
    );
    const output = await handleEmbeddingCommand(["status"], SCOPE, h.deps);
    expect(output).toContain("Arms: 1 round");
    expect(output).toContain("lexical 8");
    expect(output).toContain("vector 6");
    expect(output).toContain("3 injected");
    expect(output).toContain("Degraded: no round was degraded");
  });

  test("falls back to A2's state.json snapshot only when the runtime has no build", async () => {
    const snapshot = buildSnapshot();
    const runtime = fakeRuntime({
      readStatus: async () =>
        runtimeStatus({ build: null, buildSnapshot: snapshot }),
    });
    const h = harness(
      { runtime },
      { ...EMBEDDING_SETTING_DEFAULTS, enabled: true },
    );
    const output = await handleEmbeddingCommand(["status"], SCOPE, h.deps);
    expect(output).toContain(
      "Build (state.json): running · 1200/3600 chunks · 12/40 conversations · coverage 80%",
    );

    const withProgress = fakeRuntime({
      readStatus: async () =>
        runtimeStatus({
          build: {
            state: "running",
            progress: 0.34,
            processedChunks: 1_200,
            totalChunks: 3_600,
            etaMs: 480_000,
          },
          buildSnapshot: snapshot,
        }),
    });
    const deduped = harness(
      { runtime: withProgress },
      { ...EMBEDDING_SETTING_DEFAULTS, enabled: true },
    );
    const output2 = await handleEmbeddingCommand(
      ["status"],
      SCOPE,
      deduped.deps,
    );
    expect(output2).not.toContain("Build (state.json)");
  });

  test("paints the stored calibration when this process has no runtime port", async () => {
    const calibration: EmbeddingCalibrationSettings = {
      fingerprint: "abc",
      measuredAt: "2026-11-03T09:00:00Z",
      queryLatencyP50Ms: 2,
      queryLatencyP90Ms: 6,
      batchThroughputPerSec: 12_600,
      gpuRole: "off",
      threads: 8,
      quantization: "float32",
    };
    const h = harness(
      {},
      {
        ...EMBEDDING_SETTING_DEFAULTS,
        enabled: true,
        calibration,
      },
    );
    const output = await handleEmbeddingCommand(["status"], SCOPE, h.deps);
    expect(output).toContain("Calibration (stored): 2026-11-03T09:00:00Z");
    expect(output).toContain("p50 2ms");
    expect(output).not.toContain("abc");
  });
});
