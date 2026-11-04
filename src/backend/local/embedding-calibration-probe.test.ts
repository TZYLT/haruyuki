/**
 * Production calibration probes (feature 48, rework A2).
 *
 * C5 owns the schedule; these probes own the measurements. The tests inject a
 * fake worker and a fake device adapter, so no ONNX runtime, GPU, network or
 * downloaded model is needed: they pin what each measurement asks the worker
 * for (CPU providers, bounded timeouts, ≥256 RSS tokens) and that a GPU refusal
 * is a typed `ok: false` with the adapter disposed.
 */
import { describe, expect, test } from "bun:test";
import type {
  EmbeddingCalibrationBudget,
  EmbeddingGpuProbe,
} from "@/backend/local/embedding/calibration";
import {
  QUERY_LATENCY_SAMPLES,
  RSS_BATCH_MIN_TOKENS,
} from "@/backend/local/embedding/calibration";
import type {
  CreateEmbeddingDeviceAdapterOptions,
  EmbeddingBuildWorker,
  EmbeddingDeviceAdapter,
} from "@/backend/local/embedding/gpu-build-path";
import { getBuiltinModelManifest } from "@/backend/local/embedding/model-manifest";
import type { EmbeddingWorkerInitOptions } from "@/backend/local/embedding/worker-protocol";
import type { EmbeddingBuiltinAssets } from "@/backend/local/embedding-assets";
import {
  buildEmbeddingCalibrationEnvironment,
  createDirectMlCalibrationProbe,
  createGpuTrialBudget,
  createWorkerCalibrationProbe,
  type EmbeddingWorkerCalibrationProbe,
  readDiskFreeBytesDefault,
  runEmbeddingCalibration,
} from "@/backend/local/embedding-calibration-probe";
import {
  EMBEDDING_SETTING_DEFAULTS,
  type ResolvedEmbeddingSettings,
} from "@/recall-settings";

const DIMENSIONS = 4;

function assets(): EmbeddingBuiltinAssets {
  const manifest = getBuiltinModelManifest();
  const modelDir = "/models/test-model";
  return {
    modelId: manifest.id,
    modelDir,
    modelPath: `${modelDir}/onnx/model.onnx`,
    tokenizerPath: `${modelDir}/tokenizer.json`,
    configPath: `${modelDir}/config.json`,
    runtimeDir: "/models/runtime/1",
    runtimeVersion: "1",
    manifest,
  };
}

function settings(
  overrides: Partial<ResolvedEmbeddingSettings> = {},
): ResolvedEmbeddingSettings {
  return { ...EMBEDDING_SETTING_DEFAULTS, ...overrides };
}

function unitVector(): Float32Array {
  const vector = new Float32Array(DIMENSIONS);
  vector[0] = 1;
  return vector;
}

interface FakeWorkerState {
  starts: number;
  inits: number;
  shutdowns: number;
  disposes: number;
  initOptions: EmbeddingWorkerInitOptions[];
  embeds: string[][];
}

function fakeWorker(): {
  worker: EmbeddingBuildWorker;
  state: FakeWorkerState;
} {
  const state: FakeWorkerState = {
    starts: 0,
    inits: 0,
    shutdowns: 0,
    disposes: 0,
    initOptions: [],
    embeds: [],
  };
  const worker: EmbeddingBuildWorker = {
    async start() {
      state.starts += 1;
    },
    async init(options: EmbeddingWorkerInitOptions) {
      state.inits += 1;
      state.initOptions.push(options);
      return { dim: DIMENSIONS, runtime: "bun", maxTokens: 512, warmupMs: 1 };
    },
    async embed(texts) {
      state.embeds.push([...texts]);
      return {
        vectors: texts.map(() => unitVector()),
        dim: DIMENSIONS,
        cancelled: false,
        texts: texts.length,
        tokens: texts.reduce((total, text) => total + text.length, 0),
        batches: 1,
        elapsedMs: 1,
      };
    },
    async shutdown() {
      state.shutdowns += 1;
    },
    dispose() {
      state.disposes += 1;
    },
  };
  return { worker, state };
}

function tickingClock(step = 5): () => number {
  let value = 0;
  return () => {
    value += step;
    return value;
  };
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

describe("buildEmbeddingCalibrationEnvironment", () => {
  test("win32 + gpu auto advertises DirectML; every other case is CPU only", () => {
    const builtinAssets = assets();
    const windows = buildEmbeddingCalibrationEnvironment(
      settings({ gpu: "auto" }),
      builtinAssets,
      { platform: "win32", cores: 8, totalMemoryBytes: 32 * 1024 ** 3 },
    );
    expect(windows.executionProviders).toEqual(["cpu", "dml"]);
    expect(windows.platform).toBe("win32");
    expect(windows.cores).toBe(8);
    expect(windows.totalMemoryBytes).toBe(32 * 1024 ** 3);
    expect(windows.modelId).toBe(builtinAssets.modelId);
    expect(windows.quantization).toBe("float32");
    expect(windows.chunkerVersion).toBe(1);
    expect(windows.runtime).toMatch(/^(bun|node)-/);

    expect(
      buildEmbeddingCalibrationEnvironment(
        settings({ gpu: "off" }),
        builtinAssets,
        { platform: "win32" },
      ).executionProviders,
    ).toEqual(["cpu"]);
    expect(
      buildEmbeddingCalibrationEnvironment(
        settings({ gpu: "auto" }),
        builtinAssets,
        {
          platform: "linux",
        },
      ).executionProviders,
    ).toEqual(["cpu"]);
  });

  test("overrides feed the fingerprint inputs", () => {
    const environment = buildEmbeddingCalibrationEnvironment(
      settings({ quantization: "int8" }),
      assets(),
      {
        platform: "win32",
        arch: "arm64",
        cpuModel: "Test CPU",
        runtime: "node-22.19.0",
        executionProviders: ["cpu"],
      },
    );
    expect(environment).toMatchObject({
      platform: "win32",
      arch: "arm64",
      cpuModel: "Test CPU",
      runtime: "node-22.19.0",
      executionProviders: ["cpu"],
      quantization: "int8",
    });
  });
});

// ---------------------------------------------------------------------------
// Worker probe
// ---------------------------------------------------------------------------

describe("createWorkerCalibrationProbe", () => {
  test("lazily starts one CPU worker and answers all four measurements", async () => {
    const { worker, state } = fakeWorker();
    const probe = createWorkerCalibrationProbe({
      assets: assets(),
      threads: 2,
      worker,
      now: tickingClock(),
      readRssBytes: () => 123_456_789,
      readDiskFreeBytes: () => 987_654_321,
    });

    // Nothing starts until the first measurement.
    expect(state.starts).toBe(0);

    const latency = await probe.queryLatencyMs("query", { remainingMs: 5_000 });
    expect(latency).toBe(5);
    expect(state.starts).toBe(1);
    expect(state.initOptions[0]).toMatchObject({
      runtimeDir: "/models/runtime/1",
      modelPath: "/models/test-model/onnx/model.onnx",
      tokenizerPath: "/models/test-model/tokenizer.json",
      executionProviders: ["cpu"],
      intraOpThreads: 2,
      pooling: assets().manifest.pooling,
    });

    const batch = await probe.batchEmbed([], { remainingMs: 5_000 });
    expect(batch.texts).toBe(32);
    expect(batch.tokens).toBeGreaterThan(0);
    expect(batch.elapsedMs).toBe(5);

    const rss = await probe.rssBytes([], { remainingMs: 5_000 });
    expect(rss).toBe(123_456_789);
    const longBatch = state.embeds.at(-1) ?? [];
    expect(longBatch.length).toBe(8);
    expect(longBatch.join("").length).toBeGreaterThanOrEqual(
      RSS_BATCH_MIN_TOKENS,
    );

    expect(await probe.diskFreeBytes({ remainingMs: 5_000 })).toBe(987_654_321);

    await probe.dispose();
    expect(state.shutdowns).toBe(1);
    expect(state.disposes).toBe(1);
    // Idempotent: a second pass in the same process must not double-close.
    await probe.dispose();
    expect(state.shutdowns).toBe(1);
  });

  test("prefers the worker's own RSS over the parent process", async () => {
    const { worker } = fakeWorker();
    const reported = 640 * 1024 ** 2;
    const withRss: EmbeddingBuildWorker = {
      ...worker,
      async embed(texts) {
        const output = await worker.embed(texts);
        return { ...output, rssBytes: reported };
      },
    };
    const probe = createWorkerCalibrationProbe({
      assets: assets(),
      worker: withRss,
      // The parent number is what the old probe reported; it must lose.
      readRssBytes: () => 1,
    });
    await expect(probe.rssBytes([], { remainingMs: 5_000 })).resolves.toBe(
      reported,
    );
    await probe.dispose();
  });

  test("the default disk probe answers a number, never a throw", () => {
    const free = readDiskFreeBytesDefault();
    expect(Number.isFinite(free)).toBe(true);
    expect(free).toBeGreaterThan(0);
  });

  test("a failed worker init releases the worker it started, then retries", async () => {
    const { worker, state } = fakeWorker();
    let initAttempts = 0;
    const flaky: EmbeddingBuildWorker = {
      ...worker,
      async init(options) {
        initAttempts += 1;
        if (initAttempts === 1) throw new Error("init failed");
        return await worker.init(options);
      },
    };
    const probe = createWorkerCalibrationProbe({
      assets: assets(),
      worker: flaky,
    });

    await expect(
      probe.queryLatencyMs("query", { remainingMs: 5_000 }),
    ).rejects.toThrow("init failed");
    // `start()` succeeded; the child process must be released by `dispose()`.
    expect(state.starts).toBe(1);
    expect(state.disposes).toBe(1);

    await probe.queryLatencyMs("query", { remainingMs: 5_000 });
    expect(state.starts).toBe(2);
    expect(state.disposes).toBe(1);
    await probe.dispose();
    expect(state.disposes).toBe(2);
  });

  test("a failed worker start is retried on the next measurement", async () => {
    let attempts = 0;
    const { worker, state } = fakeWorker();
    const flaky: EmbeddingBuildWorker = {
      ...worker,
      async start() {
        attempts += 1;
        if (attempts === 1) throw new Error("spawn failed");
        state.starts += 1;
      },
    };
    const probe = createWorkerCalibrationProbe({
      assets: assets(),
      worker: flaky,
    });
    await expect(
      probe.queryLatencyMs("query", { remainingMs: 5_000 }),
    ).rejects.toThrow("spawn failed");
    await probe.queryLatencyMs("query", { remainingMs: 5_000 });
    expect(state.starts).toBe(1);
    await probe.dispose();
  });
});

// ---------------------------------------------------------------------------
// DirectML probe
// ---------------------------------------------------------------------------

function fakeAdapter(
  gpu: boolean,
  degradedReason?: string,
): {
  adapter: EmbeddingDeviceAdapter;
  disposed: () => number;
} {
  let disposals = 0;
  return {
    disposed: () => disposals,
    adapter: {
      role: gpu ? "index-only" : "cpu",
      executionProviders: gpu ? ["dml", "cpu"] : ["cpu"],
      gpu,
      degraded: !gpu && degradedReason !== undefined,
      ...(degradedReason === undefined ? {} : { degradedReason }),
      initialization: {
        dim: DIMENSIONS,
        runtime: "bun",
        maxTokens: 512,
        warmupMs: 1,
      },
      async embedTexts(texts) {
        return texts.map(() => unitVector());
      },
      async dispose() {
        disposals += 1;
      },
    },
  };
}

describe("createDirectMlCalibrationProbe", () => {
  test("an accepted GPU provider is reported as ok with dml", async () => {
    const fake = fakeAdapter(true);
    const seen: CreateEmbeddingDeviceAdapterOptions[] = [];
    const probe = createDirectMlCalibrationProbe({
      assets: assets(),
      threads: 1,
      createDeviceAdapter: async (options) => {
        seen.push(options);
        return fake.adapter;
      },
    });
    expect(await probe.probe({ remainingMs: 5_000 })).toEqual({
      ok: true,
      executionProvider: "dml",
    });
    expect(seen[0]?.budget?.buildExecutionProviders).toEqual(["dml", "cpu"]);
    expect(seen[0]?.init).toMatchObject({
      runtimeDir: "/models/runtime/1",
      modelPath: "/models/test-model/onnx/model.onnx",
      intraOpThreads: 1,
    });
    expect(fake.disposed()).toBe(1);
  });

  test("a CPU fallback is a typed refusal with the redacted reason", async () => {
    const fake = fakeAdapter(false, "dml provider not found");
    const probe = createDirectMlCalibrationProbe({
      assets: assets(),
      createDeviceAdapter: async () => fake.adapter,
    });
    expect(await probe.probe({ remainingMs: 5_000 })).toEqual({
      ok: false,
      failure: "dml provider not found",
    });
    expect(fake.disposed()).toBe(1);
  });

  test("a thrown init is reported, not propagated, and creates no adapter", async () => {
    const probe = createDirectMlCalibrationProbe({
      assets: assets(),
      createDeviceAdapter: async () => {
        throw new Error("device exploded");
      },
    });
    const result = await probe.probe({ remainingMs: 5_000 });
    expect(result.ok).toBe(false);
    expect(String(result.failure)).toContain("device exploded");
  });

  test("the trial budget names only providers (no measurements)", () => {
    const budget: EmbeddingCalibrationBudget = createGpuTrialBudget();
    expect(budget.gpuRole).toBe("index-only");
    expect(budget.gpuExecutionProvider).toBe("dml");
    expect(budget.buildExecutionProviders).toEqual(["dml", "cpu"]);
    expect(budget.queryExecutionProviders).toEqual(["cpu"]);
    expect(budget.calibrated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Pass wiring
// ---------------------------------------------------------------------------

describe("runEmbeddingCalibration", () => {
  test("wires environment + probe + GPU probe into C5 and returns the probe", async () => {
    const { worker } = fakeWorker();
    const probe = createWorkerCalibrationProbe({
      assets: assets(),
      worker,
      now: tickingClock(2),
      readRssBytes: () => 200 * 1024 ** 2,
      readDiskFreeBytes: () => 10 * 1024 ** 3,
    });
    const gpuProbe: EmbeddingGpuProbe = {
      probe: () => ({ ok: true, executionProvider: "dml" }),
    };
    const result = await runEmbeddingCalibration({
      settings: settings({ threads: 1 }),
      assets: assets(),
      probe,
      gpuProbe,
      environment: {
        platform: "win32",
        cores: 8,
        totalMemoryBytes: 32 * 1024 ** 3,
      },
      measuredAt: "2026-11-04T00:00:00.000Z",
      now: tickingClock(1),
    });
    expect(result.probe).toBe(probe);
    expect(result.result.budget.calibrated).toBe(true);
    expect(result.result.budget.gpuRole).toBe("index-only");
    expect(result.result.snapshot.measured_at).toBe("2026-11-04T00:00:00.000Z");
    expect(result.result.snapshot.query_latency_p50_ms).toBeGreaterThanOrEqual(
      0,
    );
    expect(result.result.snapshot.batch_throughput_per_s).toBeGreaterThan(0);
    expect(QUERY_LATENCY_SAMPLES).toBe(10);
    await probe.dispose();
  });

  test("disposes the probe it created when the pass throws", async () => {
    let disposals = 0;
    const probe: EmbeddingWorkerCalibrationProbe = {
      queryLatencyMs: async () => 1,
      batchEmbed: async () => ({ texts: 32, tokens: 1_000, elapsedMs: 1 }),
      rssBytes: async () => 1,
      diskFreeBytes: async () => 1,
      async dispose() {
        disposals += 1;
      },
    };

    await expect(
      runEmbeddingCalibration({
        settings: settings(),
        assets: assets(),
        probe,
        // An impossible chunker version makes fingerprinting throw.
        environment: { chunkerVersion: 0 },
      }),
    ).rejects.toThrow();
    // The caller never receives the probe on this path, so the callee owns it.
    expect(disposals).toBe(1);
  });
});
