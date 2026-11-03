/**
 * C5 calibration tests (48-2 §4.5 / 48-1 §6.6).
 *
 * All measurements are injected fakes: no ONNX Runtime, no GPU, no filesystem,
 * no clock waiting. Deadline exhaustion is simulated with a fake epoch clock
 * that the fake probe advances, so every test is deterministic.
 */

import { describe, expect, test } from "bun:test";
import type {
  EmbeddingBatchSample,
  EmbeddingCalibrationEnvironment,
  EmbeddingCalibrationInput,
  EmbeddingCalibrationProbe,
  EmbeddingGpuProbe,
} from "./calibration";
import {
  ARENA_MAX_RSS_BYTES,
  ARENA_MIN_TOTAL_MEMORY_BYTES,
  BATCH_THROUGHPUT_TEXTS,
  calibrateEmbedding,
  computeEmbeddingFingerprint,
  DEFAULT_BUILD_THREADS,
  DEFAULT_QUERY_BUDGET_MS,
  deriveBuildThreads,
  deriveEmbeddingTier,
  EMBEDDING_CALIBRATION_BUDGET_MS,
  EmbeddingCalibrationError,
  latencyPercentiles,
  M3_MIN_THROUGHPUT_PER_SEC,
  M3_MIN_TOTAL_MEMORY_BYTES,
  QUERY_BUDGET_MAX_MS,
  QUERY_BUDGET_MIN_MS,
  QUERY_LATENCY_SAMPLES,
  queryBudgetFromP90,
  RSS_BATCH_MIN_TOKENS,
  RSS_BATCH_TEXT_COUNT,
  shouldEnableCpuArena,
  shouldRecalibrate,
  skipEmbeddingCalibration,
  THREAD_SCALE_MIN_THROUGHPUT_PER_SEC,
} from "./calibration";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const MEASURED_AT = "2026-11-04T00:00:00.000Z";

function makeEnvironment(
  overrides: Partial<EmbeddingCalibrationEnvironment> = {},
): EmbeddingCalibrationEnvironment {
  return {
    platform: "win32",
    arch: "x64",
    cpuModel: "Intel(R) Core(TM) i7-13700F",
    cores: 16,
    totalMemoryBytes: 32 * GIB,
    executionProviders: ["cpu", "dml"],
    runtime: "bun",
    modelId: "bge-small-zh-v1.5",
    quantization: "float32",
    chunkerVersion: 1,
    ...overrides,
  };
}

/**
 * Deterministic CPU probe. `batch`/`rss`/`disk` are typed `unknown` so a test
 * can inject a malformed value and assert the rejection path.
 */
function makeProbe(
  options: {
    latencies?: readonly number[];
    batch?: unknown;
    rss?: unknown;
    disk?: unknown;
    onQuery?: (index: number) => void;
    onDisk?: () => void;
  } = {},
): EmbeddingCalibrationProbe {
  const latencies = options.latencies ?? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  let cursor = 0;
  return {
    queryLatencyMs: () => {
      const index = cursor;
      cursor = (cursor + 1) % latencies.length;
      options.onQuery?.(index);
      return latencies[index] ?? 0;
    },
    batchEmbed: (texts) =>
      (options.batch ?? {
        texts: texts.length,
        tokens: 3_200,
        elapsedMs: 100,
      }) as EmbeddingBatchSample,
    rssBytes: () => (options.rss ?? 180 * MIB) as number,
    diskFreeBytes: () => {
      options.onDisk?.();
      return (options.disk ?? 8 * GIB) as number;
    },
  };
}

function makeInput(
  overrides: Partial<EmbeddingCalibrationInput> = {},
): EmbeddingCalibrationInput {
  return {
    environment: makeEnvironment(),
    probe: makeProbe(),
    measuredAt: MEASURED_AT,
    ...overrides,
  };
}

async function calibrate(overrides: Partial<EmbeddingCalibrationInput> = {}) {
  return calibrateEmbedding(makeInput(overrides));
}

async function catchCalibrationError(
  run: () => Promise<unknown>,
): Promise<EmbeddingCalibrationError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof EmbeddingCalibrationError) return error;
    throw error;
  }
  throw new Error("expected calibrateEmbedding to reject");
}

function fakeClock(initial = 0) {
  let current = initial;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

// ---------------------------------------------------------------------------
// Fingerprint
// ---------------------------------------------------------------------------

describe("computeEmbeddingFingerprint", () => {
  test("is a stable 64-character sha256 for equal environments", () => {
    const first = computeEmbeddingFingerprint(makeEnvironment());
    const second = computeEmbeddingFingerprint(makeEnvironment());
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  test("folds case, whitespace, memory jitter and provider order", () => {
    const base = computeEmbeddingFingerprint(makeEnvironment());
    const noisy = computeEmbeddingFingerprint(
      makeEnvironment({
        platform: " WIN32 ",
        cpuModel: "intel(r)   core(tm) i7-13700f",
        runtime: "BUN",
        totalMemoryBytes: 32 * GIB + 4096, // < 1 MiB of OS fuzz
        executionProviders: ["dml", "dml", "cpu"],
      }),
    );
    expect(noisy).toBe(base);
  });

  test("moves when an effective environment field changes", () => {
    const base = computeEmbeddingFingerprint(makeEnvironment());
    const variants: EmbeddingCalibrationEnvironment[] = [
      makeEnvironment({ platform: "linux" }),
      makeEnvironment({ arch: "arm64" }),
      makeEnvironment({ cpuModel: "AMD Ryzen 9" }),
      makeEnvironment({ cores: 8 }),
      makeEnvironment({ totalMemoryBytes: 16 * GIB }),
      makeEnvironment({ executionProviders: ["cpu"] }),
      makeEnvironment({ runtime: "node-22.19.0" }),
      makeEnvironment({ modelId: "bge-m3" }),
      makeEnvironment({ quantization: "int8" }),
      makeEnvironment({ chunkerVersion: 2 }),
    ];
    const fingerprints = variants.map((environment) =>
      computeEmbeddingFingerprint(environment),
    );
    for (const fingerprint of fingerprints) {
      expect(fingerprint).not.toBe(base);
    }
    expect(new Set([base, ...fingerprints]).size).toBe(variants.length + 1);
  });

  test("rejects a malformed environment instead of hashing garbage", () => {
    expect(() => computeEmbeddingFingerprint(null as never)).toThrow(
      EmbeddingCalibrationError,
    );
    expect(() =>
      computeEmbeddingFingerprint(makeEnvironment({ modelId: "  " })),
    ).toThrow(EmbeddingCalibrationError);
    expect(() =>
      computeEmbeddingFingerprint(makeEnvironment({ cores: 0 })),
    ).toThrow(EmbeddingCalibrationError);
    expect(() =>
      computeEmbeddingFingerprint(makeEnvironment({ chunkerVersion: 1.5 })),
    ).toThrow(EmbeddingCalibrationError);
    expect(() =>
      computeEmbeddingFingerprint(
        makeEnvironment({ quantization: "q4" as never }),
      ),
    ).toThrow(EmbeddingCalibrationError);
    expect(() =>
      computeEmbeddingFingerprint(
        makeEnvironment({ executionProviders: "cpu" as never }),
      ),
    ).toThrow(EmbeddingCalibrationError);
    expect(() =>
      computeEmbeddingFingerprint(makeEnvironment({ totalMemoryBytes: -1 })),
    ).toThrow(EmbeddingCalibrationError);
  });
});

describe("shouldRecalibrate", () => {
  test("is false when the stored fingerprint matches", () => {
    const fingerprint = computeEmbeddingFingerprint(makeEnvironment());
    expect(shouldRecalibrate({ fingerprint }, fingerprint)).toBe(false);
    expect(
      shouldRecalibrate(
        { fingerprint: fingerprint.toUpperCase() },
        fingerprint,
      ),
    ).toBe(false);
  });

  test("is true when the stored result is missing or moved", () => {
    const fingerprint = computeEmbeddingFingerprint(makeEnvironment());
    expect(shouldRecalibrate(null, fingerprint)).toBe(true);
    expect(shouldRecalibrate(undefined, fingerprint)).toBe(true);
    expect(shouldRecalibrate({}, fingerprint)).toBe(true);
    expect(shouldRecalibrate({ fingerprint: "" }, fingerprint)).toBe(true);
    expect(shouldRecalibrate({ fingerprint: "deadbeef" }, fingerprint)).toBe(
      true,
    );
    expect(shouldRecalibrate({ fingerprint: 42 as never }, fingerprint)).toBe(
      true,
    );
  });

  test("is true (fail-safe) when the current fingerprint is unusable", () => {
    expect(shouldRecalibrate({ fingerprint: "abc" }, "")).toBe(true);
    expect(shouldRecalibrate(null, "  ")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Bounded measurements
// ---------------------------------------------------------------------------

describe("latencyPercentiles", () => {
  test("interpolates p50 and p90 over ten samples", () => {
    const percentiles = latencyPercentiles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(percentiles.p50).toBeCloseTo(5.5, 6);
    expect(percentiles.p90).toBeCloseTo(9.1, 6);
  });

  test("handles one sample and unsorted input", () => {
    expect(latencyPercentiles([2.5])).toEqual({ p50: 2.5, p90: 2.5 });
    const percentiles = latencyPercentiles([9, 1, 5, 3, 7]);
    expect(percentiles.p50).toBe(5);
    expect(percentiles.p90).toBeGreaterThanOrEqual(7);
  });

  test("rejects empty or malformed samples", () => {
    for (const samples of [
      [],
      [Number.NaN],
      [Number.POSITIVE_INFINITY],
      [-1],
      [1, "2" as never],
    ]) {
      expect(() => latencyPercentiles(samples)).toThrow(
        EmbeddingCalibrationError,
      );
    }
  });
});

describe("queryBudgetFromP90", () => {
  test("clamps the p90 multiplier into the documented 50–300ms window", () => {
    expect(queryBudgetFromP90(0)).toBe(QUERY_BUDGET_MIN_MS);
    expect(queryBudgetFromP90(1.69)).toBe(68);
    expect(queryBudgetFromP90(5.24)).toBe(210);
    expect(queryBudgetFromP90(100)).toBe(QUERY_BUDGET_MAX_MS);
  });

  test("rejects malformed input", () => {
    expect(() => queryBudgetFromP90(Number.NaN)).toThrow(
      EmbeddingCalibrationError,
    );
    expect(() => queryBudgetFromP90(-1)).toThrow(EmbeddingCalibrationError);
  });
});

// ---------------------------------------------------------------------------
// Budget derivation
// ---------------------------------------------------------------------------

describe("deriveEmbeddingTier", () => {
  test("requires 16 GiB (or an accepted GPU) and the throughput floor", () => {
    expect(
      deriveEmbeddingTier({
        totalMemoryBytes: M3_MIN_TOTAL_MEMORY_BYTES,
        throughputPerSec: M3_MIN_THROUGHPUT_PER_SEC,
      }),
    ).toBe("m3");
    expect(
      deriveEmbeddingTier({
        totalMemoryBytes: M3_MIN_TOTAL_MEMORY_BYTES - 1,
        throughputPerSec: 1_000,
      }),
    ).toBe("small");
    expect(
      deriveEmbeddingTier({
        totalMemoryBytes: 64 * GIB,
        throughputPerSec: M3_MIN_THROUGHPUT_PER_SEC - 0.001,
      }),
    ).toBe("small");
    expect(
      deriveEmbeddingTier({
        totalMemoryBytes: 8 * GIB,
        throughputPerSec: 1_000,
        gpuRole: "index-only",
      }),
    ).toBe("m3");
    expect(
      deriveEmbeddingTier({
        totalMemoryBytes: 8 * GIB,
        throughputPerSec: 1_000,
        gpuRole: "off",
      }),
    ).toBe("small");
  });
});

describe("deriveBuildThreads", () => {
  test("scales 1 → 2 threads with throughput and caps at two", () => {
    expect(
      deriveBuildThreads({
        cores: 16,
        throughputPerSec: THREAD_SCALE_MIN_THROUGHPUT_PER_SEC,
      }),
    ).toBe(2);
    expect(
      deriveBuildThreads({
        cores: 16,
        throughputPerSec: THREAD_SCALE_MIN_THROUGHPUT_PER_SEC - 0.001,
      }),
    ).toBe(DEFAULT_BUILD_THREADS);
    expect(deriveBuildThreads({ cores: 2, throughputPerSec: 1_000 })).toBe(1);
    expect(deriveBuildThreads({ cores: 64, throughputPerSec: 1_000 })).toBe(2);
    expect(deriveBuildThreads({ cores: 0, throughputPerSec: 1_000 })).toBe(1);
    expect(
      deriveBuildThreads({ cores: 16, throughputPerSec: Number.NaN }),
    ).toBe(1);
  });
});

describe("shouldEnableCpuArena", () => {
  test("needs 16 GiB and a sub-500MB long-batch RSS", () => {
    expect(
      shouldEnableCpuArena({
        totalMemoryBytes: ARENA_MIN_TOTAL_MEMORY_BYTES,
        rssBytes: ARENA_MAX_RSS_BYTES - 1,
      }),
    ).toBe(true);
    expect(
      shouldEnableCpuArena({
        totalMemoryBytes: ARENA_MIN_TOTAL_MEMORY_BYTES,
        rssBytes: ARENA_MAX_RSS_BYTES,
      }),
    ).toBe(false);
    expect(
      shouldEnableCpuArena({
        totalMemoryBytes: ARENA_MIN_TOTAL_MEMORY_BYTES - 1,
        rssBytes: 100 * MIB,
      }),
    ).toBe(false);
    expect(
      shouldEnableCpuArena({ totalMemoryBytes: 64 * GIB, rssBytes: 0 }),
    ).toBe(false);
    expect(
      shouldEnableCpuArena({
        totalMemoryBytes: 64 * GIB,
        rssBytes: Number.NaN,
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Full pass: happy path
// ---------------------------------------------------------------------------

describe("calibrateEmbedding (calibrated)", () => {
  test("measures p50/p90, throughput, RSS and disk, then derives the budget", async () => {
    const batchSizes: number[] = [];
    const rssBatches: Array<readonly string[]> = [];
    const probe: EmbeddingCalibrationProbe = {
      ...makeProbe(),
      batchEmbed: (texts) => {
        batchSizes.push(texts.length);
        return { texts: texts.length, tokens: 3_200, elapsedMs: 100 };
      },
      rssBytes: (texts) => {
        rssBatches.push(texts);
        return 180 * MIB;
      },
    };
    const result = await calibrate({ probe });

    expect(result.budget.calibrated).toBe(true);
    expect(result.budget.timedOut).toBe(false);
    expect(result.budget.reason).toBeUndefined();
    expect(result.snapshot).toMatchObject({
      fingerprint: computeEmbeddingFingerprint(makeEnvironment()),
      measured_at: MEASURED_AT,
      query_latency_p50_ms: 5.5,
      query_latency_p90_ms: 9.1,
      batch_throughput_per_s: 320,
      gpu_role: "off",
      threads: 2,
      quantization: "float32",
    });
    expect(result.budget).toMatchObject({
      tier: "m3",
      queryBudgetMs: 300,
      threads: 2,
      cpuArena: true,
      gpuRole: "off",
      quantization: "float32",
      rssBytes: 180 * MIB,
      diskFreeBytes: 8 * GIB,
      diskHeadroomOk: true,
      totalMemoryBytes: 32 * GIB,
      batchTokensPerSec: 32_000,
      queryExecutionProviders: ["cpu"],
      buildExecutionProviders: ["cpu"],
    });
    expect(result.snapshot.threads).toBe(result.budget.threads);

    expect(batchSizes).toEqual([BATCH_THROUGHPUT_TEXTS]);
    expect(rssBatches).toHaveLength(1);
    expect(rssBatches[0]).toHaveLength(RSS_BATCH_TEXT_COUNT);
    const rssChars = (rssBatches[0] ?? []).reduce(
      (total, text) => total + text.length,
      0,
    );
    expect(rssChars).toBeGreaterThanOrEqual(RSS_BATCH_MIN_TOKENS);
  });

  test("probes receive a bounded slice of the caller's budget", async () => {
    const limits: number[] = [];
    const probe: EmbeddingCalibrationProbe = {
      ...makeProbe(),
      queryLatencyMs: (_text, limit) => {
        limits.push(limit.remainingMs);
        return 2;
      },
    };
    await calibrate({ probe, budgetMs: 1_200 });
    expect(limits).toHaveLength(QUERY_LATENCY_SAMPLES);
    for (const remainingMs of limits) {
      expect(remainingMs).toBeGreaterThan(0);
      expect(remainingMs).toBeLessThanOrEqual(1_200);
    }
  });

  test("honors an explicit int8 request and keeps float32 otherwise", async () => {
    const int8 = await calibrate({
      environment: makeEnvironment({ quantization: "int8" }),
    });
    expect(int8.snapshot.quantization).toBe("int8");
    expect(int8.budget.quantization).toBe("int8");

    const float32 = await calibrate();
    expect(float32.snapshot.quantization).toBe("float32");
    expect(float32.budget.quantization).toBe("float32");
  });

  test("defaults measured_at to an ISO timestamp when not injected", async () => {
    const result = await calibrateEmbedding({
      environment: makeEnvironment(),
      probe: makeProbe(),
    });
    expect(result.snapshot.measured_at).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    expect(Number.isFinite(Date.parse(result.snapshot.measured_at))).toBe(true);
  });

  test("rejects an unparseable measured_at and a non-positive budget", async () => {
    for (const options of [
      { measuredAt: "not-a-date" },
      { measuredAt: "   " },
      { budgetMs: 0 },
      { budgetMs: -5 },
      { budgetMs: Number.NaN },
    ]) {
      const error = await catchCalibrationError(() => calibrate(options));
      expect(error.code).toBe("invalid-environment");
    }
  });
});

// ---------------------------------------------------------------------------
// GPU gating
// ---------------------------------------------------------------------------

describe("calibrateEmbedding (GPU gate)", () => {
  test("a successful trial resolves index-only; queries stay on CPU", async () => {
    let probed = 0;
    const gpuProbe: EmbeddingGpuProbe = {
      probe: () => {
        probed += 1;
        return { ok: true, executionProvider: "DML" };
      },
    };
    const result = await calibrate({ gpuProbe });

    expect(probed).toBe(1);
    expect(result.snapshot.gpu_role).toBe("index-only");
    expect(result.snapshot.gpu_reason).toBeUndefined();
    expect(result.budget.gpuRole).toBe("index-only");
    expect(result.budget.gpuExecutionProvider).toBe("dml");
    expect(result.budget.queryExecutionProviders).toEqual(["cpu"]);
    expect(result.budget.buildExecutionProviders).toContain("dml");
    expect(result.budget.buildExecutionProviders).toContain("cpu");
    expect(result.budget.calibrated).toBe(true);
  });

  test("a failed trial falls back to CPU with a redacted reason", async () => {
    const gpuProbe: EmbeddingGpuProbe = {
      probe: () => ({
        ok: false,
        failure:
          "CreateSession failed for sk-abcdefgh12345678 at C:\\Users\\someone\\model.onnx\nBearer abcdefgh1234",
      }),
    };
    const result = await calibrate({ gpuProbe });

    expect(result.snapshot.gpu_role).toBe("off");
    expect(result.budget.gpuRole).toBe("off");
    expect(result.budget.calibrated).toBe(true);
    const reason = result.snapshot.gpu_reason ?? "";
    expect(reason).toContain("GPU initialization failed");
    expect(reason).toContain("[redacted]");
    expect(reason).toContain("[path]");
    expect(reason).not.toContain("abcdefgh12345678");
    expect(reason).not.toContain("Users");
    expect(reason).not.toContain("\n");
    expect(result.budget.buildExecutionProviders).toEqual(["cpu"]);
  });

  test("a throwing or malformed trial also falls back to CPU", async () => {
    const throwing: EmbeddingGpuProbe = {
      probe: () => {
        throw new Error("DML device lost");
      },
    };
    const threw = await calibrate({ gpuProbe: throwing });
    expect(threw.snapshot.gpu_role).toBe("off");
    expect(threw.snapshot.gpu_reason).toContain("DML device lost");
    expect(threw.budget.calibrated).toBe(true);

    const malformed: EmbeddingGpuProbe = {
      probe: () => ({}) as never,
    };
    const bad = await calibrate({ gpuProbe: malformed });
    expect(bad.snapshot.gpu_role).toBe("off");
    expect(bad.snapshot.gpu_reason).toContain("no boolean");
  });

  test("requested `off` never probes", async () => {
    const gpuProbe: EmbeddingGpuProbe = {
      probe: () => {
        throw new Error("must not be called");
      },
    };
    const result = await calibrate({
      gpuProbe,
      requestedGpuRole: "off",
    });
    expect(result.snapshot.gpu_role).toBe("off");
    expect(result.snapshot.gpu_reason).toBeUndefined();
  });

  test("skips the GPU trial when the CPU stages consumed the budget", async () => {
    const clock = fakeClock();
    let gpuCalls = 0;
    const probe = makeProbe({
      onDisk: () => clock.advance(EMBEDDING_CALIBRATION_BUDGET_MS),
    });
    const gpuProbe: EmbeddingGpuProbe = {
      probe: () => {
        gpuCalls += 1;
        return { ok: true, executionProvider: "dml" };
      },
    };
    const result = await calibrate({
      probe,
      gpuProbe,
      now: clock.now,
    });

    expect(gpuCalls).toBe(0);
    expect(result.budget.calibrated).toBe(true);
    expect(result.budget.gpuRole).toBe("off");
    expect(result.snapshot.gpu_reason).toContain("budget exhausted");
  });
});

// ---------------------------------------------------------------------------
// Failure, malformed measurements and deadline
// ---------------------------------------------------------------------------

describe("calibrateEmbedding (uncalibrated fallback)", () => {
  test("a throwing measurement yields the default budget and a reason", async () => {
    const probe: EmbeddingCalibrationProbe = {
      ...makeProbe(),
      queryLatencyMs: () => {
        throw new Error("worker exited (code 1)");
      },
    };
    const result = await calibrate({ probe });

    expect(result.budget.calibrated).toBe(false);
    expect(result.budget.timedOut).toBe(false);
    expect(result.budget.reason).toContain("query latency");
    expect(result.budget.reason).toContain("worker exited");
    expect(result.snapshot).toMatchObject({
      query_latency_p50_ms: 0,
      query_latency_p90_ms: 0,
      batch_throughput_per_s: 0,
      gpu_role: "off",
      threads: DEFAULT_BUILD_THREADS,
      quantization: "float32",
    });
    expect(result.budget).toMatchObject({
      tier: "small",
      queryBudgetMs: DEFAULT_QUERY_BUDGET_MS,
      threads: DEFAULT_BUILD_THREADS,
      cpuArena: false,
      rssBytes: 0,
      diskFreeBytes: 0,
      diskHeadroomOk: true,
      buildExecutionProviders: ["cpu"],
      queryExecutionProviders: ["cpu"],
    });
    expect(result.snapshot.gpu_reason).toContain("did not complete");
    expect(result.snapshot.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  test("malformed measurement values are rejected, never trusted", async () => {
    const cases: Array<{ probe: EmbeddingCalibrationProbe; needle: string }> = [
      {
        probe: makeProbe({ latencies: [2, Number.NaN] }),
        needle: "query latency sample",
      },
      {
        probe: makeProbe({
          batch: { texts: 31, tokens: 3_200, elapsedMs: 100 },
        }),
        needle: "expected 32",
      },
      {
        probe: makeProbe({ batch: { texts: 32, tokens: 3_200, elapsedMs: 0 } }),
        needle: "batch elapsed time",
      },
      {
        probe: makeProbe({ batch: { texts: 32, tokens: -1, elapsedMs: 100 } }),
        needle: "batch token count",
      },
      {
        probe: makeProbe({ rss: Number.POSITIVE_INFINITY }),
        needle: "rss measurement",
      },
      {
        probe: makeProbe({ rss: 0 }),
        needle: "rss measurement",
      },
      {
        probe: makeProbe({ disk: Number.NaN }),
        needle: "disk free space",
      },
      {
        probe: makeProbe({ disk: "8GB" }),
        needle: "disk free space",
      },
    ];
    for (const { probe, needle } of cases) {
      const result = await calibrate({ probe });
      expect(result.budget.calibrated).toBe(false);
      expect(result.budget.reason).toContain(needle);
    }
  });

  test("deadline exhaustion mid-pass is uncalibrated and marked timedOut", async () => {
    const clock = fakeClock();
    const probe: EmbeddingCalibrationProbe = {
      ...makeProbe(),
      queryLatencyMs: () => {
        clock.advance(600);
        return 2;
      },
    };
    const result = await calibrate({ probe, now: clock.now });

    expect(result.budget.calibrated).toBe(false);
    expect(result.budget.timedOut).toBe(true);
    expect(result.budget.reason).toContain("budget exhausted");
    expect(result.snapshot.query_latency_p50_ms).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Skip path
// ---------------------------------------------------------------------------

describe("skipEmbeddingCalibration", () => {
  test("returns the default budget with the current fingerprint", () => {
    const result = skipEmbeddingCalibration(makeEnvironment(), {
      measuredAt: MEASURED_AT,
    });
    expect(result.budget.calibrated).toBe(false);
    expect(result.budget.reason).toBe("calibration skipped");
    expect(result.budget.timedOut).toBe(false);
    expect(result.budget.queryBudgetMs).toBe(DEFAULT_QUERY_BUDGET_MS);
    expect(result.budget.tier).toBe("small");
    expect(result.snapshot.fingerprint).toBe(
      computeEmbeddingFingerprint(makeEnvironment()),
    );
    expect(result.snapshot.measured_at).toBe(MEASURED_AT);
    expect(result.snapshot.gpu_role).toBe("off");
    expect(result.snapshot.gpu_reason).toContain("skipped");
  });

  test("keeps an explicit reason (sanitized) and validates the environment", () => {
    const result = skipEmbeddingCalibration(makeEnvironment(), {
      reason: "wizard skipped: token=secretvalue123",
    });
    expect(result.budget.reason).toContain("wizard skipped");
    expect(result.budget.reason).toContain("[redacted]");
    expect(() =>
      skipEmbeddingCalibration(makeEnvironment({ cores: 0 })),
    ).toThrow(EmbeddingCalibrationError);
  });
});
