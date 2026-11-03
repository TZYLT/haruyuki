import { describe, expect, test } from "bun:test";
import type { EmbeddingChunk } from "@/backend/local/embedding-chunk";
import type { EmbeddingCalibrationBudget } from "./calibration";
import {
  createChunkEmbedCallback,
  createEmbeddingDeviceAdapter,
  createEmbeddingQueryAdapter,
  EMBEDDING_QUERY_EXECUTION_PROVIDERS,
  type EmbeddingBuildWorker,
  type EmbeddingDeviceAdapter,
  EmbeddingGpuBuildPathError,
  planEmbeddingBuildDevice,
  resolveQueryExecutionProviders,
  sanitizeDeviceFailureReason,
} from "./gpu-build-path";
import type { EmbeddingWorkerClient } from "./worker-client";
import type { EmbeddingWorkerEmbedOutput } from "./worker-client-types";
import type {
  EmbeddingWorkerInitOptions,
  EmbeddingWorkerInitResult,
} from "./worker-protocol";

const INIT_OPTIONS = {
  runtimeDir: "/tmp/runtime",
  modelPath: "/tmp/model.onnx",
  tokenizerPath: "/tmp/tokenizer.json",
};

/** Minimal complete chunk so the callback's `EmbeddingChunk` contract holds. */
function chunk(text: string, chunkIndex = 0): EmbeddingChunk {
  return {
    parentId: "parent",
    chunkIndex,
    kind: "prose",
    text,
    startChar: 0,
    endChar: text.length,
    spans: [{ startChar: 0, endChar: text.length }],
    focusChar: 0,
    estimatedTokens: 1,
  };
}

function budget(
  overrides: Partial<EmbeddingCalibrationBudget> = {},
): EmbeddingCalibrationBudget {
  return {
    tier: "small",
    calibrated: true,
    timedOut: false,
    queryBudgetMs: 100,
    threads: 2,
    cpuArena: false,
    gpuRole: "off",
    quantization: "float32",
    rssBytes: 0,
    diskFreeBytes: 0,
    diskHeadroomOk: true,
    totalMemoryBytes: 16 * 1024 ** 3,
    batchTokensPerSec: 0,
    queryExecutionProviders: ["cpu"],
    buildExecutionProviders: ["cpu"],
    ...overrides,
  };
}

interface WorkerCalls {
  starts: number;
  shutdowns: number;
  disposals: number;
  inits: EmbeddingWorkerInitOptions[];
  embeddedTexts: string[][];
}

interface FakeWorkerBehavior {
  /** Return an error to make `init` fail for these providers. */
  failInitFor?: (providers: readonly string[]) => Error | undefined;
  /** Emit vectors built from this dimension (default 4). */
  dim?: number;
  /** Emit vectors of this width while `init` still reports `dim`. */
  vectorDim?: number;
  /** Return a `null` vector for every text (cancellation). */
  cancel?: boolean;
  /** Return no vectors at all (protocol violation). */
  dropVectors?: boolean;
}
function makeFakeWorker(behavior: FakeWorkerBehavior = {}): {
  worker: EmbeddingBuildWorker;
  calls: WorkerCalls;
} {
  const calls: WorkerCalls = {
    starts: 0,
    shutdowns: 0,
    disposals: 0,
    inits: [],
    embeddedTexts: [],
  };
  const dim = behavior.dim ?? 4;
  const worker: EmbeddingBuildWorker = {
    async start(): Promise<unknown> {
      calls.starts += 1;
      return { protocolVersion: 1 };
    },
    async init(
      options: EmbeddingWorkerInitOptions,
    ): Promise<EmbeddingWorkerInitResult> {
      calls.inits.push(options);
      const failure = behavior.failInitFor?.(options.executionProviders ?? []);
      if (failure !== undefined) throw failure;
      return { dim, runtime: "node", maxTokens: 512, warmupMs: 1 };
    },
    async embed(texts): Promise<EmbeddingWorkerEmbedOutput> {
      calls.embeddedTexts.push([...texts]);
      const vector = Float32Array.from(
        { length: behavior.vectorDim ?? dim },
        (_, axis) => (axis === 0 ? 1 : 0),
      );
      return {
        vectors: behavior.dropVectors
          ? []
          : texts.map(() => (behavior.cancel === true ? null : vector)),
        dim,
        cancelled: behavior.cancel === true,
        texts: texts.length,
        tokens: texts.length * 2,
        batches: 1,
        elapsedMs: 1,
      };
    },
    async shutdown(): Promise<void> {
      calls.shutdowns += 1;
    },
    dispose(): void {
      calls.disposals += 1;
    },
  };
  return { worker, calls };
}

function makeFactory(workers: readonly EmbeddingBuildWorker[]): {
  createWorker: () => EmbeddingBuildWorker;
  created: EmbeddingBuildWorker[];
} {
  const created: EmbeddingBuildWorker[] = [];
  let cursor = 0;
  return {
    created,
    createWorker: () => {
      const worker = workers[cursor];
      cursor += 1;
      if (worker === undefined) throw new Error("fake worker exhausted");
      created.push(worker);
      return worker;
    },
  };
}

async function createAdapter(
  options: Parameters<typeof createEmbeddingDeviceAdapter>[0],
): Promise<EmbeddingDeviceAdapter> {
  return createEmbeddingDeviceAdapter(options);
}

describe("planEmbeddingBuildDevice", () => {
  test("no budget, an off role or a CPU-only list resolves to CPU", () => {
    expect(planEmbeddingBuildDevice(undefined).role).toBe("cpu");
    expect(planEmbeddingBuildDevice(null).role).toBe("cpu");
    expect(
      planEmbeddingBuildDevice(
        budget({ gpuRole: "off", buildExecutionProviders: ["dml", "cpu"] }),
      ).role,
    ).toBe("cpu");
    expect(
      planEmbeddingBuildDevice(
        budget({ gpuRole: "index-only", buildExecutionProviders: ["cpu"] }),
      ).role,
    ).toBe("cpu");
    expect(
      planEmbeddingBuildDevice(
        budget({ gpuRole: "index-only", buildExecutionProviders: [] }),
      ).role,
    ).toBe("cpu");
  });

  test("index-only keeps the GPU providers and appends CPU last", () => {
    const plan = planEmbeddingBuildDevice(
      budget({
        gpuRole: "index-only",
        buildExecutionProviders: ["dml", "cpu"],
        gpuExecutionProvider: "dml",
      }),
    );
    expect(plan.role).toBe("index-only");
    expect(plan.executionProviders).toEqual(["dml", "cpu"]);
    expect(plan.gpuExecutionProvider).toBe("dml");
  });

  test("normalises the provider list and honours the preferred provider", () => {
    const plan = planEmbeddingBuildDevice(
      budget({
        gpuRole: "index-only",
        buildExecutionProviders: ["cpu", "DML", "dml", " openvino ", ""],
        gpuExecutionProvider: "openvino",
      }),
    );
    expect(plan.role).toBe("index-only");
    expect(plan.executionProviders).toEqual(["dml", "openvino", "cpu"]);
    expect(plan.gpuExecutionProvider).toBe("openvino");
  });

  test("the query path is CPU even when the budget is GPU-capable", () => {
    const gpuBudget = budget({
      gpuRole: "index-only",
      buildExecutionProviders: ["dml", "cpu"],
      queryExecutionProviders: ["dml", "cpu"],
    });
    expect(resolveQueryExecutionProviders(gpuBudget)).toEqual(["cpu"]);
    expect(resolveQueryExecutionProviders()).toEqual(["cpu"]);
    expect(EMBEDDING_QUERY_EXECUTION_PROVIDERS).toEqual(["cpu"]);
  });
});

describe("createEmbeddingDeviceAdapter: GPU path", () => {
  test("initialises with the GPU providers when the budget allows it", async () => {
    const { worker, calls } = makeFakeWorker();
    const adapter = await createAdapter({
      budget: budget({
        gpuRole: "index-only",
        buildExecutionProviders: ["dml", "cpu"],
        gpuExecutionProvider: "dml",
      }),
      createWorker: () => worker,
      init: INIT_OPTIONS,
    });
    expect(adapter.role).toBe("index-only");
    expect(adapter.gpu).toBe(true);
    expect(adapter.degraded).toBe(false);
    expect(adapter.executionProviders).toEqual(["dml", "cpu"]);
    expect(calls.inits[0]?.executionProviders).toEqual(["dml", "cpu"]);
    expect(adapter.initialization.dim).toBe(4);
    const vectors = await adapter.embedTexts(["a", "b"]);
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toBeInstanceOf(Float32Array);
    expect(Array.from(vectors[0] ?? [])).toEqual([1, 0, 0, 0]);
    await adapter.dispose();
    expect(calls.shutdowns).toBe(1);
    expect(calls.disposals).toBe(1);
  });

  test("a GPU init failure falls back to CPU with a redacted reason", async () => {
    const { worker: gpuWorker, calls: gpuCalls } = makeFakeWorker({
      failInitFor: (providers) =>
        providers.includes("dml")
          ? new Error(
              "DML session failed at C:\\Users\\Administrator\\AppData\\dml.dll (api_key=sk-secret123456, Bearer abc.def)",
            )
          : undefined,
    });
    const { worker: cpuWorker, calls: cpuCalls } = makeFakeWorker();
    const factory = makeFactory([gpuWorker, cpuWorker]);
    const degradeEvents: string[] = [];
    const adapter = await createAdapter({
      budget: budget({
        gpuRole: "index-only",
        buildExecutionProviders: ["dml", "cpu"],
        gpuExecutionProvider: "dml",
      }),
      createWorker: factory.createWorker,
      init: INIT_OPTIONS,
      onDegrade: (event) => {
        degradeEvents.push(event.reason);
        expect(event.fallbackExecutionProviders).toEqual(["cpu"]);
      },
    });
    expect(degradeEvents).toHaveLength(1);
    expect(adapter.role).toBe("cpu");
    expect(adapter.gpu).toBe(false);
    expect(adapter.degraded).toBe(true);
    expect(adapter.executionProviders).toEqual(["cpu"]);
    expect(cpuCalls.inits[0]?.executionProviders).toEqual(["cpu"]);
    expect(gpuCalls.disposals).toBe(1);
    expect(adapter.degradedReason).toContain("<path>");
    expect(adapter.degradedReason).toContain("<redacted>");
    expect(adapter.degradedReason).not.toContain("Administrator");
    expect(adapter.degradedReason).not.toContain("sk-secret");
    // The build still embeds after the fallback.
    const vectors = await adapter.embedTexts(["x"]);
    expect(vectors).toHaveLength(1);
  });

  test("a GPU failure does not block a build even when no degrade callback exists", async () => {
    const { worker: gpuWorker } = makeFakeWorker({
      failInitFor: (providers) =>
        providers.includes("dml") ? new Error("no dml") : undefined,
    });
    const { worker: cpuWorker } = makeFakeWorker();
    const adapter = await createAdapter({
      budget: budget({
        gpuRole: "index-only",
        buildExecutionProviders: ["dml", "cpu"],
      }),
      createWorker: makeFactory([gpuWorker, cpuWorker]).createWorker,
      init: INIT_OPTIONS,
    });
    expect(adapter.degraded).toBe(true);
    expect(adapter.degradedReason).toBe("no dml");
  });

  test("throws a typed error only when the CPU retry also fails", async () => {
    const { worker: gpuWorker } = makeFakeWorker({
      failInitFor: () => new Error("gpu broken"),
    });
    const { worker: cpuWorker, calls } = makeFakeWorker({
      failInitFor: () => new Error("cpu broken"),
    });
    let failure: EmbeddingGpuBuildPathError | null = null;
    try {
      await createAdapter({
        budget: budget({
          gpuRole: "index-only",
          buildExecutionProviders: ["dml", "cpu"],
        }),
        createWorker: makeFactory([gpuWorker, cpuWorker]).createWorker,
        init: INIT_OPTIONS,
      });
    } catch (error) {
      failure = error as EmbeddingGpuBuildPathError;
    }
    expect(failure).toBeInstanceOf(EmbeddingGpuBuildPathError);
    expect(failure?.kind).toBe("cpu-init-failed");
    expect(failure?.gpuReason).toBe("gpu broken");
    expect(failure?.cpuReason).toBe("cpu broken");
    // Both failed workers are cleaned up.
    expect(calls.disposals).toBe(1);
  });

  test("a CPU-only budget never degrades and never probes the GPU", async () => {
    const { worker, calls } = makeFakeWorker();
    const adapter = await createAdapter({
      budget: budget({ gpuRole: "off" }),
      createWorker: () => worker,
      init: INIT_OPTIONS,
    });
    expect(adapter.degraded).toBe(false);
    expect(adapter.gpu).toBe(false);
    expect(calls.inits[0]?.executionProviders).toEqual(["cpu"]);
  });

  test("rejects a vector whose width disagrees with the model", async () => {
    const { worker } = makeFakeWorker({ dim: 4, vectorDim: 3 });
    const adapter = await createAdapter({
      createWorker: () => worker,
      init: INIT_OPTIONS,
    });
    await expect(adapter.embedTexts(["x"])).rejects.toThrow(
      /3-dimensional vector for a 4-dimensional model/,
    );
  });
});

describe("createEmbeddingQueryAdapter", () => {
  test("always initialises on CPU even for an index-only budget", async () => {
    const { worker, calls } = makeFakeWorker();
    const adapter = await createEmbeddingQueryAdapter({
      budget: budget({
        gpuRole: "index-only",
        buildExecutionProviders: ["dml", "cpu"],
        queryExecutionProviders: ["dml", "cpu"],
      }),
      createWorker: () => worker,
      init: INIT_OPTIONS,
    });
    expect(calls.inits[0]?.executionProviders).toEqual(["cpu"]);
    expect(adapter.role).toBe("cpu");
    expect(adapter.gpu).toBe(false);
    expect(adapter.degraded).toBe(false);
  });
});

describe("worker port contract", () => {
  test("the real EmbeddingWorkerClient satisfies the injected port", () => {
    // Compile-time contract check: production injects this exact class.
    const asPort = (client: EmbeddingWorkerClient): EmbeddingBuildWorker =>
      client;
    expect(typeof asPort).toBe("function");
  });
});

describe("createChunkEmbedCallback", () => {
  test("embeds chunk text in order and decodes the vectors", async () => {
    const { worker, calls } = makeFakeWorker();
    const adapter = await createAdapter({
      createWorker: () => worker,
      init: INIT_OPTIONS,
    });
    const embed = createChunkEmbedCallback(adapter);
    const vectors = await embed([chunk("first"), chunk("second", 1)]);
    expect(calls.embeddedTexts[0]).toEqual(["first", "second"]);
    expect(vectors).toHaveLength(2);
    expect(Array.from(vectors[0] ?? [])).toEqual([1, 0, 0, 0]);
  });

  test("honours a custom text selector", async () => {
    const { worker, calls } = makeFakeWorker();
    const adapter = await createAdapter({
      createWorker: () => worker,
      init: INIT_OPTIONS,
    });
    const embed = createChunkEmbedCallback(adapter, {
      textOf: (chunk) => `title: ${chunk.text}`,
    });
    await embed([chunk("body")]);
    expect(calls.embeddedTexts[0]).toEqual(["title: body"]);
  });

  test("a cancelled or short worker reply fails the unit", async () => {
    const { worker: cancelledWorker } = makeFakeWorker({ cancel: true });
    const cancelled = await createAdapter({
      createWorker: () => cancelledWorker,
      init: INIT_OPTIONS,
    });
    await expect(
      createChunkEmbedCallback(cancelled)([chunk("x")]),
    ).rejects.toThrow(/cancelled/);

    const { worker: shortWorker } = makeFakeWorker({ dropVectors: true });
    const short = await createAdapter({
      createWorker: () => shortWorker,
      init: INIT_OPTIONS,
    });
    await expect(short.embedTexts(["x"])).rejects.toThrow(/returned 0 vectors/);
  });
});

describe("sanitizeDeviceFailureReason", () => {
  test("strips credentials, absolute paths and bounds the message", () => {
    const reason = sanitizeDeviceFailureReason(
      new Error(
        "failed at C:\\Users\\me\\runtime\\onnx.dll and /home/me/ort/lib with Bearer abc123 sk-abcdef123456 api_key=topsecret\nsecond line",
      ),
    );
    expect(reason).toContain("<path>");
    expect(reason).toContain("<redacted>");
    expect(reason).not.toContain("C:\\Users");
    expect(reason).not.toContain("/home/me");
    expect(reason).not.toContain("sk-abcdef");
    expect(reason).not.toContain("topsecret");
    expect(reason).not.toContain("\n");
    expect(sanitizeDeviceFailureReason(new Error("x".repeat(500))).length).toBe(
      200,
    );
  });

  test("handles non-Error values without throwing", () => {
    expect(sanitizeDeviceFailureReason(undefined)).toBe(
      "unknown device failure",
    );
    expect(sanitizeDeviceFailureReason({ code: 1 })).toBe("[object Object]");
    expect(sanitizeDeviceFailureReason("plain failure")).toBe("plain failure");
  });
});
