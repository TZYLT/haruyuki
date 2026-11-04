import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import type {
  EmbeddingEndpointClient,
  EmbeddingEndpointProbe,
} from "@/backend/local/embedding/endpoint-client";
import type { EmbeddingWorkerEmbedOutput } from "@/backend/local/embedding/worker-client-types";
import type {
  EmbeddingWorkerInitOptions,
  EmbeddingWorkerInitResult,
} from "@/backend/local/embedding/worker-protocol";
import {
  type BuiltinQueryEncoderOptions,
  createBuiltinQueryEncoder,
  createEmbeddingQueryEncoder,
  createEndpointQueryEncoder,
  type EmbeddingEncoderWorker,
  resetEmbeddingEncoderCacheForTests,
  resolveEmbeddingWorkerEntryForRuntime,
} from "@/backend/local/embedding-encoder";
import {
  EMBEDDING_SETTING_DEFAULTS,
  type ResolvedEmbeddingSettings,
  resolveEmbeddingSettings,
} from "@/recall-settings";
import {
  createEmbeddingFixtureDirs,
  type EmbeddingFixtureDirs,
} from "@/test-utils/embedding-fixture";

const QUERY_INSTRUCTION = "为这个句子生成表示以用于检索相关文章：";

class FakeEncoderWorker implements EmbeddingEncoderWorker {
  static instances: FakeEncoderWorker[] = [];
  static failNextStart = false;
  static failNextInit = false;

  readonly initCalls: EmbeddingWorkerInitOptions[] = [];
  readonly embedCalls: string[][] = [];
  disposed = false;

  constructor() {
    FakeEncoderWorker.instances.push(this);
  }

  static reset(): void {
    FakeEncoderWorker.instances = [];
    FakeEncoderWorker.failNextStart = false;
    FakeEncoderWorker.failNextInit = false;
  }

  async start(): Promise<unknown> {
    if (FakeEncoderWorker.failNextStart) {
      FakeEncoderWorker.failNextStart = false;
      throw new Error("fake worker start failed");
    }
    return {};
  }

  async init(
    options: EmbeddingWorkerInitOptions,
  ): Promise<EmbeddingWorkerInitResult> {
    if (FakeEncoderWorker.failNextInit) {
      FakeEncoderWorker.failNextInit = false;
      throw new Error("fake worker init failed");
    }
    this.initCalls.push(options);
    return { dim: 8, runtime: "node", maxTokens: 512, warmupMs: 1 };
  }

  async embed(texts: readonly string[]): Promise<EmbeddingWorkerEmbedOutput> {
    this.embedCalls.push([...texts]);
    return {
      vectors: texts.map(() => new Float32Array([1, 0, 0, 0, 0, 0, 0, 0])),
      dim: 8,
      cancelled: false,
      texts: texts.length,
      tokens: 0,
      batches: 1,
      elapsedMs: 1,
    };
  }

  async shutdown(): Promise<void> {
    this.disposed = true;
  }

  dispose(): void {
    this.disposed = true;
  }
}

let dirs: EmbeddingFixtureDirs;
let previousHome: string | undefined;

beforeEach(async () => {
  dirs = createEmbeddingFixtureDirs("haru-embedding-encoder-");
  previousHome = process.env.HARUYUKI_HOME;
  process.env.HARUYUKI_HOME = dirs.homeDir;
  FakeEncoderWorker.reset();
  await resetEmbeddingEncoderCacheForTests();
});

afterEach(async () => {
  await resetEmbeddingEncoderCacheForTests();
  FakeEncoderWorker.reset();
  if (previousHome === undefined) delete process.env.HARUYUKI_HOME;
  else process.env.HARUYUKI_HOME = previousHome;
  dirs.cleanup();
});

function builtinSettings(
  overrides: Partial<ResolvedEmbeddingSettings> = {},
): ResolvedEmbeddingSettings {
  return { ...EMBEDDING_SETTING_DEFAULTS, ...overrides };
}

function endpointSettings(): ResolvedEmbeddingSettings {
  return resolveEmbeddingSettings({
    recallEmbeddingBackend: "endpoint",
    recallEmbeddingEndpoint: {
      kind: "openai",
      baseUrl: "https://api.example.test/v1",
      model: "text-embedding-3-small",
      dimensions: 4,
    },
  });
}

function builtinOptions(
  overrides: Partial<BuiltinQueryEncoderOptions> = {},
): BuiltinQueryEncoderOptions {
  return {
    createWorker: () => new FakeEncoderWorker(),
    isReady: async () => true,
    ...overrides,
  };
}

function fakeEndpointClient(): EmbeddingEndpointClient {
  return {
    kind: "openai",
    baseUrl: "https://api.example.test/v1",
    model: "text-embedding-3-small",
    dimensions: 4,
    egress: true,
    probe: async (): Promise<EmbeddingEndpointProbe> => ({
      reachable: true,
      latencyMs: 1,
      url: "https://api.example.test/v1",
    }),
    listModels: async () => ({ models: [] }),
    test: async () => ({
      model: "text-embedding-3-small",
      dimensions: 4,
      norm: 1,
      latencyMs: 1,
    }),
    embed: async (texts) =>
      texts.map(() => new Float32Array([0.5, 0.5, 0.5, 0.5])),
    circuitState: () => "closed",
    resetCircuit: () => {
      // The fake has no breaker state to reset.
    },
  };
}

describe("createBuiltinQueryEncoder", () => {
  test("returns null instead of spawning when the assets are missing", async () => {
    let factoryCalls = 0;
    const encoder = createBuiltinQueryEncoder(
      builtinSettings(),
      builtinOptions({
        isReady: async () => false,
        createWorker: () => {
          factoryCalls += 1;
          return new FakeEncoderWorker();
        },
      }),
    );

    expect(await encoder.encodeQuery("如何部署")).toBeNull();
    expect(await encoder.encodeBatch(["a", "b"])).toEqual([null, null]);
    expect(factoryCalls).toBe(0);
    expect(FakeEncoderWorker.instances).toHaveLength(0);
    await encoder.dispose();
  });

  test("caches one worker per configuration and prepends the query instruction", async () => {
    const first = createBuiltinQueryEncoder(
      builtinSettings(),
      builtinOptions(),
    );
    const vector = await first.encodeQuery("如何部署");
    expect(vector).toBeInstanceOf(Float32Array);

    expect(FakeEncoderWorker.instances).toHaveLength(1);
    const worker = FakeEncoderWorker.instances[0];
    expect(worker).toBeDefined();
    if (worker === undefined) return;
    expect(worker.embedCalls[0]).toEqual([`${QUERY_INSTRUCTION}如何部署`]);
    expect(worker.initCalls[0]?.executionProviders).toEqual(["cpu"]);
    expect(worker.initCalls[0]?.modelPath).toContain("model_quantized.onnx");
    expect(worker.initCalls[0]?.tokenizerPath).toContain("tokenizer.json");

    const second = createBuiltinQueryEncoder(
      builtinSettings(),
      builtinOptions(),
    );
    expect(second.id).toBe(first.id);
    await second.encodeQuery("again");
    expect(FakeEncoderWorker.instances).toHaveLength(1);

    await first.dispose();
    expect(worker.disposed).toBe(false);
    await second.dispose();
    expect(worker.disposed).toBe(true);
  });

  test("encodes queries on CPU even when the GPU role is index-only", async () => {
    const encoder = createBuiltinQueryEncoder(
      builtinSettings({ gpu: "index-only" }),
      builtinOptions(),
    );
    await encoder.encodeQuery("q");
    expect(
      FakeEncoderWorker.instances[0]?.initCalls[0]?.executionProviders,
    ).toEqual(["cpu"]);
    await encoder.dispose();
  });

  test("rejects a failed start and retries with a fresh worker", async () => {
    FakeEncoderWorker.failNextStart = true;
    const encoder = createBuiltinQueryEncoder(
      builtinSettings(),
      builtinOptions(),
    );

    await expect(encoder.encodeQuery("q")).rejects.toThrow(
      "fake worker start failed",
    );
    expect(FakeEncoderWorker.instances).toHaveLength(1);

    const vector = await encoder.encodeQuery("q");
    expect(vector).toBeInstanceOf(Float32Array);
    expect(FakeEncoderWorker.instances).toHaveLength(2);
    await encoder.dispose();
  });

  test("disposes a started worker when init fails and retries with a new one", async () => {
    FakeEncoderWorker.failNextInit = true;
    const encoder = createBuiltinQueryEncoder(
      builtinSettings(),
      builtinOptions(),
    );

    await expect(encoder.encodeQuery("q")).rejects.toThrow(
      "fake worker init failed",
    );
    expect(FakeEncoderWorker.instances).toHaveLength(1);
    // The child process that `start()` brought up must not be leaked when the
    // rest of the session cannot be used.
    expect(FakeEncoderWorker.instances[0]?.disposed).toBe(true);

    const vector = await encoder.encodeQuery("q");
    expect(vector).toBeInstanceOf(Float32Array);
    expect(FakeEncoderWorker.instances).toHaveLength(2);
    expect(FakeEncoderWorker.instances[1]?.disposed).toBe(false);
    await encoder.dispose();
  });

  test("encodeBatch returns one slot per text", async () => {
    const encoder = createBuiltinQueryEncoder(
      builtinSettings(),
      builtinOptions(),
    );
    const vectors = await encoder.encodeBatch(["one", "two", "three"]);
    expect(vectors).toHaveLength(3);
    for (const vector of vectors) expect(vector).toBeInstanceOf(Float32Array);
    await encoder.dispose();
  });
});

describe("createEndpointQueryEncoder", () => {
  test("throws when the endpoint form is missing", () => {
    expect(() =>
      createEndpointQueryEncoder(
        builtinSettings({ backend: "endpoint", endpoint: null }),
      ),
    ).toThrow(/no endpoint is configured/i);
  });

  test("encodes through the injected client", async () => {
    const encoder = createEndpointQueryEncoder(endpointSettings(), {
      client: fakeEndpointClient(),
    });
    expect(encoder.id).toContain("endpoint:");
    const vector = await encoder.encodeQuery("如何部署");
    expect(vector).toBeInstanceOf(Float32Array);
    expect(vector?.length).toBe(4);
    const batch = await encoder.encodeBatch(["a", "b"]);
    expect(batch).toHaveLength(2);
    await encoder.dispose();
  });
});

describe("createEmbeddingQueryEncoder", () => {
  test("dispatches to the built-in backend by default", async () => {
    const encoder = createEmbeddingQueryEncoder(
      builtinSettings(),
      builtinOptions(),
    );
    expect(encoder.id.startsWith("builtin:")).toBe(true);
    await encoder.dispose();
  });

  test("dispatches to the endpoint backend", async () => {
    const encoder = createEmbeddingQueryEncoder(endpointSettings(), {
      client: fakeEndpointClient(),
    });
    expect(encoder.id.startsWith("endpoint:")).toBe(true);
    await encoder.dispose();
  });

  test("endpoint mode without an endpoint throws during dispatch", () => {
    expect(() =>
      createEmbeddingQueryEncoder(
        builtinSettings({ backend: "endpoint", endpoint: null }),
      ),
    ).toThrow(/no endpoint is configured/i);
  });
});

describe("resolveEmbeddingWorkerEntryForRuntime", () => {
  test("resolves an existing worker entry in this checkout", () => {
    const resolution = resolveEmbeddingWorkerEntryForRuntime();
    expect(existsSync(resolution.path)).toBe(true);
    expect(resolution.path).toBe(
      resolution.kind === "source"
        ? resolution.candidates.source
        : resolution.candidates.bundled,
    );
  });

  test("throws a clear error when neither candidate exists", () => {
    expect(() =>
      resolveEmbeddingWorkerEntryForRuntime({ exists: () => false }),
    ).toThrow(/missing/i);
  });
});
