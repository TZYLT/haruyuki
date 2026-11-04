import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeVectorBase64 } from "./featurize";
import { EmbeddingWorkerClient } from "./worker-client";
import {
  type EmbeddingRuntime,
  type EmbeddingSession,
  type EmbeddingSessionInput,
  type EmbeddingWorkerDependencies,
  type EmbeddingWorkerRunSummary,
  isEmbeddingWorkerMain,
  runEmbeddingWorker,
} from "./worker-entry";
import {
  type EmbeddingWorkerEmbedResult,
  type EmbeddingWorkerErrorFrame,
  type EmbeddingWorkerFrame,
  type EmbeddingWorkerInitResult,
  type EmbeddingWorkerReadyFrame,
  type EmbeddingWorkerResultFrame,
  type EmbeddingWorkerStats,
  parseEmbeddingWorkerFrame,
} from "./worker-protocol";
import {
  createHuggingFaceTokenizerLoader,
  createTokenizerFromModule,
  type EmbeddingTokenizer,
} from "./worker-tokenizer";

const WORKER_PID = 4321;

interface ChunkSource {
  iterate(): AsyncGenerator<string | Uint8Array>;
  push(chunk: string): void;
  close(): void;
}

/** Async iterable that the test pushes raw chunks into (no real stdin). */
function createChunkSource(): ChunkSource {
  const queue: string[] = [];
  let notify: (() => void) | null = null;
  let closed = false;
  async function* iterate(): AsyncGenerator<string> {
    for (;;) {
      const next = queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (closed) return;
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
      notify = null;
    }
  }
  return {
    iterate,
    push(chunk: string): void {
      queue.push(chunk);
      notify?.();
    },
    close(): void {
      closed = true;
      notify?.();
    },
  };
}

interface Harness {
  readonly frames: EmbeddingWorkerFrame[];
  readonly run: Promise<EmbeddingWorkerRunSummary>;
  send(frame: Record<string, unknown>): void;
  sendRaw(chunk: string): void;
  close(): void;
  waitFor(predicate: () => boolean, label: string): Promise<void>;
  waitForResult(id: number): Promise<EmbeddingWorkerResultFrame>;
  waitForError(id: number | null): Promise<EmbeddingWorkerErrorFrame>;
}

function createHarness(
  dependencies: EmbeddingWorkerDependencies = {},
  options: { protocolVersion?: number } = {},
): Harness {
  const frames: EmbeddingWorkerFrame[] = [];
  const source = createChunkSource();
  const run = runEmbeddingWorker({
    input: source.iterate(),
    output: {
      writeLine(line: string): void {
        frames.push(parseEmbeddingWorkerFrame(line));
      },
    },
    dependencies,
    pid: WORKER_PID,
    runtimeName: "bun",
    protocolVersion: options.protocolVersion ?? 1,
  });
  const waitFor = async (
    predicate: () => boolean,
    label: string,
  ): Promise<void> => {
    const deadline = Date.now() + 2_000;
    while (!predicate()) {
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for ${label}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  };
  return {
    frames,
    run,
    send(frame): void {
      source.push(`${JSON.stringify(frame)}\n`);
    },
    sendRaw(chunk: string): void {
      source.push(chunk);
    },
    close(): void {
      source.close();
    },
    waitFor,
    async waitForResult(id: number): Promise<EmbeddingWorkerResultFrame> {
      await waitFor(
        () =>
          frames.some((frame) => frame.type === "result" && frame.id === id),
        `result ${id}`,
      );
      const frame = frames.find(
        (candidate): candidate is EmbeddingWorkerResultFrame =>
          candidate.type === "result" && candidate.id === id,
      );
      if (frame === undefined) throw new Error(`Missing result ${id}`);
      return frame;
    },
    async waitForError(id: number | null): Promise<EmbeddingWorkerErrorFrame> {
      await waitFor(
        () => frames.some((frame) => frame.type === "error" && frame.id === id),
        `error ${String(id)}`,
      );
      const frame = frames.find(
        (candidate): candidate is EmbeddingWorkerErrorFrame =>
          candidate.type === "error" && candidate.id === id,
      );
      if (frame === undefined) throw new Error(`Missing error ${String(id)}`);
      return frame;
    },
  };
}

/** Deterministic tokenizer: one token per character of the text. */
function createFakeTokenizer(): EmbeddingTokenizer {
  return {
    padTokenId: 0,
    encode(text) {
      const inputIds = Array.from(
        text,
        (character) => ((character.codePointAt(0) ?? 1) % 89) + 1,
      );
      if (inputIds.length === 0) inputIds.push(7);
      return { inputIds, attentionMask: inputIds.map(() => 1) };
    },
  };
}

interface FakeRuntimeControl {
  readonly runtime: EmbeddingRuntime;
  readonly createSessionCalls: () => number;
  readonly releaseCount: () => number;
  setDim(next: number): void;
  setGate(): void;
  releaseGate(): void;
  waitForNextRun(): Promise<void>;
}

interface FakeRuntimeOptions {
  readonly dim?: number;
  readonly failCreate?: boolean;
  readonly failRun?: boolean;
}

/**
 * Deterministic fake session. Hidden values scale with token position and the
 * attention mask: a leaked pad would produce 9999-scaled values and visibly
 * change the pooled vector.
 */
function createFakeRuntime(
  options: FakeRuntimeOptions = {},
): FakeRuntimeControl {
  let dim = options.dim ?? 3;
  let createSessionCalls = 0;
  let releaseCount = 0;
  let gate: Promise<void> | null = null;
  let release: (() => void) | null = null;
  const runWaiters: Array<() => void> = [];
  const runtime: EmbeddingRuntime = {
    async createSession(): Promise<EmbeddingSession> {
      createSessionCalls += 1;
      if (options.failCreate === true) {
        throw new Error("session create exploded");
      }
      return {
        async run(input: EmbeddingSessionInput) {
          const waiter = runWaiters.shift();
          waiter?.();
          if (options.failRun === true) throw new Error("session run exploded");
          if (gate !== null) await gate;
          const hidden = new Float32Array(input.sequences * input.tokens * dim);
          for (let sequence = 0; sequence < input.sequences; sequence += 1) {
            for (let token = 0; token < input.tokens; token += 1) {
              const index = sequence * input.tokens + token;
              const masked = (input.attentionMask[index] ?? 0) > 0;
              const value = masked ? (token + 1) * 10 : 9_999;
              for (let axis = 0; axis < dim; axis += 1) {
                hidden[index * dim + axis] = value * (axis + 1);
              }
            }
          }
          return { hidden, dim };
        },
        release: async (): Promise<void> => {
          releaseCount += 1;
        },
      };
    },
  };
  return {
    runtime,
    createSessionCalls: () => createSessionCalls,
    releaseCount: () => releaseCount,
    setDim(next: number): void {
      dim = next;
    },
    setGate(): void {
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    releaseGate(): void {
      const resolve = release;
      release = null;
      gate = null;
      resolve?.();
    },
    waitForNextRun(): Promise<void> {
      return new Promise<void>((resolve) => {
        runWaiters.push(resolve);
      });
    },
  };
}

function initFrame(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 1,
    type: "init",
    runtimeDir: "/cache/runtime/1.31.1",
    modelPath: "/cache/models/bge/model.onnx",
    tokenizerPath: "/cache/models/bge/tokenizer.json",
    ...overrides,
  };
}

function readyFrame(harness: Harness): EmbeddingWorkerReadyFrame {
  const frame = harness.frames[0];
  if (frame === undefined || frame.type !== "ready") {
    throw new Error("The first frame was not a ready frame");
  }
  return frame;
}

function norm(vector: Float32Array): number {
  let total = 0;
  for (let axis = 0; axis < vector.length; axis += 1) {
    const value = vector[axis] ?? 0;
    total += value * value;
  }
  return Math.sqrt(total);
}

/** Monotonic fake clock: timings are deterministic and never zero. */
function createClock(): () => number {
  let value = 1_000;
  return () => {
    value += 5;
    return value;
  };
}

async function initialisedHarness(
  options: { dim?: number; maxBatchSize?: number } = {},
): Promise<{
  harness: Harness;
  control: FakeRuntimeControl;
  init: EmbeddingWorkerInitResult;
}> {
  const control = createFakeRuntime({ dim: options.dim ?? 3 });
  const harness = createHarness({
    loadRuntime: async () => control.runtime,
    loadTokenizer: async () => createFakeTokenizer(),
    now: createClock(),
  });
  harness.send(
    initFrame(
      options.maxBatchSize === undefined
        ? {}
        : { maxBatchSize: options.maxBatchSize },
    ),
  );
  const result = await harness.waitForResult(1);
  return {
    harness,
    control,
    init: result.result as EmbeddingWorkerInitResult,
  };
}

describe("runEmbeddingWorker: handshake and stats", () => {
  test("emits ready before reading any request", async () => {
    const harness = createHarness();
    await harness.waitFor(() => harness.frames.length >= 1, "ready frame");
    const ready = readyFrame(harness);
    expect(ready.protocol).toBe(1);
    expect(ready.pid).toBe(WORKER_PID);
    expect(ready.runtime).toBe("bun");
    expect(ready.startedAt).toBeGreaterThan(0);
    harness.close();
    expect((await harness.run).reason).toBe("input-closed");
  });

  test("reports uninitialised stats before init", async () => {
    const harness = createHarness();
    harness.send({ id: 1, type: "stats" });
    const stats = (await harness.waitForResult(1))
      .result as EmbeddingWorkerStats;
    expect(stats.initialized).toBe(false);
    expect(stats.dim).toBeNull();
    expect(stats.modelPath).toBeNull();
    expect(stats.inits).toBe(0);
    expect(stats.embeds).toBe(0);
    expect(stats.tokensPerSecond).toBe(0);
    harness.send({ id: 2, type: "shutdown" });
    expect((await harness.run).reason).toBe("shutdown");
  });

  test("refuses embed before init with a typed error frame", async () => {
    const harness = createHarness();
    harness.send({ id: 1, type: "embed", texts: ["hello"] });
    const error = await harness.waitForError(1);
    expect(error.error.code).toBe("not-initialized");
    expect(error.error.requestType).toBe("embed");
    harness.send({ id: 2, type: "shutdown" });
    await harness.run;
  });
});

describe("runEmbeddingWorker: init", () => {
  test("loads the tokenizer/runtime, warms up and reports the width", async () => {
    const control = createFakeRuntime({ dim: 3 });
    const harness = createHarness({
      loadRuntime: async () => control.runtime,
      loadTokenizer: async () => createFakeTokenizer(),
    });
    harness.send(initFrame());
    const init = (await harness.waitForResult(1))
      .result as EmbeddingWorkerInitResult;
    expect(init.dim).toBe(3);
    expect(init.runtime).toBe("bun");
    expect(init.maxTokens).toBe(512);
    expect(init.warmupMs).toBeGreaterThanOrEqual(0);
    expect(control.createSessionCalls()).toBe(1);

    harness.send({ id: 2, type: "stats" });
    const stats = (await harness.waitForResult(2))
      .result as EmbeddingWorkerStats;
    expect(stats.initialized).toBe(true);
    expect(stats.dim).toBe(3);
    expect(stats.inits).toBe(1);
    expect(stats.modelPath).toBe("/cache/models/bge/model.onnx");
    harness.send({ id: 3, type: "shutdown" });
    await harness.run;
  });

  test("re-init swaps the session and releases the previous one", async () => {
    const { harness } = await initialisedHarness();
    harness.send(
      initFrame({ id: 2, modelPath: "/cache/models/m3/model.onnx" }),
    );
    await harness.waitForResult(2);
    harness.send({ id: 3, type: "stats" });
    const stats = (await harness.waitForResult(3))
      .result as EmbeddingWorkerStats;
    expect(stats.inits).toBe(2);
    expect(stats.modelPath).toBe("/cache/models/m3/model.onnx");
    harness.send({ id: 4, type: "shutdown" });
    await harness.run;
  });

  test("maps tokenizer load failure to tokenizer-failed", async () => {
    const harness = createHarness({
      loadTokenizer: async () => {
        throw new Error("no tokenizer");
      },
      loadRuntime: async () => createFakeRuntime().runtime,
    });
    harness.send(initFrame());
    const error = await harness.waitForError(1);
    expect(error.error.code).toBe("tokenizer-failed");
    expect(error.error.message).toContain("no tokenizer");
    harness.send({ id: 2, type: "shutdown" });
    await harness.run;
  });

  test("maps runtime load failure to runtime-failed", async () => {
    const harness = createHarness({
      loadTokenizer: async () => createFakeTokenizer(),
      loadRuntime: async () => {
        throw new Error("no runtime");
      },
    });
    harness.send(initFrame());
    expect((await harness.waitForError(1)).error.code).toBe("runtime-failed");
    harness.send({ id: 2, type: "shutdown" });
    await harness.run;
  });

  test("maps session creation and warmup failures to init-failed", async () => {
    const failingCreate = createHarness({
      loadTokenizer: async () => createFakeTokenizer(),
      loadRuntime: async () => createFakeRuntime({ failCreate: true }).runtime,
    });
    failingCreate.send(initFrame());
    expect((await failingCreate.waitForError(1)).error.code).toBe(
      "init-failed",
    );
    failingCreate.send({ id: 2, type: "shutdown" });
    await failingCreate.run;

    const control = createFakeRuntime({ failRun: true });
    const failingWarmup = createHarness({
      loadTokenizer: async () => createFakeTokenizer(),
      loadRuntime: async () => control.runtime,
    });
    failingWarmup.send(initFrame());
    const error = await failingWarmup.waitForError(1);
    expect(error.error.code).toBe("init-failed");
    expect(error.error.message).toContain("warmup");
    expect(control.releaseCount()).toBe(1);
    failingWarmup.send({ id: 2, type: "shutdown" });
    await failingWarmup.run;
  });

  test("rejects an init frame with a missing path", async () => {
    const harness = createHarness();
    harness.send(initFrame({ modelPath: "" }));
    expect((await harness.waitForError(1)).error.code).toBe("invalid-request");
    harness.send({ id: 2, type: "shutdown" });
    await harness.run;
  });
});

describe("runEmbeddingWorker: embed", () => {
  test("returns one normalized base64 vector per text with counters", async () => {
    const { harness } = await initialisedHarness({ dim: 3 });
    harness.send({ id: 2, type: "embed", texts: ["ab", "cde"] });
    const embed = (await harness.waitForResult(2))
      .result as EmbeddingWorkerEmbedResult;
    expect(embed.dim).toBe(3);
    expect(embed.cancelled).toBe(false);
    expect(embed.vectors.length).toBe(2);
    expect(embed.texts).toBe(2);
    expect(embed.tokens).toBe(5);
    expect(embed.batches).toBe(1);
    for (const encoded of embed.vectors) {
      expect(typeof encoded).toBe("string");
      const vector = decodeVectorBase64(encoded ?? "", 3);
      expect(norm(vector)).toBeCloseTo(1, 5);
    }
    harness.send({ id: 3, type: "stats" });
    const stats = (await harness.waitForResult(3))
      .result as EmbeddingWorkerStats;
    expect(stats.embeds).toBe(1);
    expect(stats.texts).toBe(2);
    expect(stats.tokens).toBe(5);
    expect(stats.batches).toBe(1);
    expect(stats.tokensPerSecond).toBeGreaterThan(0);
    harness.send({ id: 4, type: "shutdown" });
    await harness.run;
  });

  test("batches by the token budget and keeps vector order", async () => {
    const control = createFakeRuntime({ dim: 2 });
    const harness = createHarness({
      loadRuntime: async () => control.runtime,
      loadTokenizer: async () => createFakeTokenizer(),
    });
    harness.send(initFrame({ maxBatchSize: 1, maxBatchTokens: 1_700 }));
    await harness.waitForResult(1);
    harness.send({ id: 2, type: "embed", texts: ["a", "bb", "ccc"] });
    const embed = (await harness.waitForResult(2))
      .result as EmbeddingWorkerEmbedResult;
    expect(embed.batches).toBe(3);
    expect(embed.texts).toBe(3);
    expect(embed.vectors.filter((entry) => entry !== null).length).toBe(3);
    harness.send({ id: 3, type: "shutdown" });
    await harness.run;
  });

  test("padding does not change a sequence's vector", async () => {
    const { harness } = await initialisedHarness();
    harness.send({ id: 2, type: "embed", texts: ["a"] });
    const single = (await harness.waitForResult(2))
      .result as EmbeddingWorkerEmbedResult;
    harness.send({ id: 3, type: "embed", texts: ["a", "bbbb"] });
    const batch = (await harness.waitForResult(3))
      .result as EmbeddingWorkerEmbedResult;
    const singleVector = decodeVectorBase64(single.vectors[0] ?? "", 3);
    const batchedVector = decodeVectorBase64(batch.vectors[0] ?? "", 3);
    expect(Array.from(batchedVector)).toEqual(Array.from(singleVector));
    harness.send({ id: 4, type: "shutdown" });
    await harness.run;
  });

  test("rejects an embed frame with no texts", async () => {
    const { harness } = await initialisedHarness();
    harness.send({ id: 2, type: "embed", texts: [] });
    expect((await harness.waitForError(2)).error.code).toBe("invalid-request");
    harness.send({ id: 3, type: "shutdown" });
    await harness.run;
  });

  test("reports a mismatched model width as an internal error", async () => {
    const { harness, control } = await initialisedHarness({ dim: 3 });
    // The warmup sized the model at 3; a later run reporting 2 must be refused
    // instead of silently writing vectors the index cannot store.
    control.setDim(2);
    harness.send({ id: 2, type: "embed", texts: ["a"] });
    const error = await harness.waitForError(2);
    expect(error.error.code).toBe("internal");
    expect(error.error.message).toContain("dimensions");
    harness.send({ id: 3, type: "shutdown" });
    await harness.run;
  });
});

describe("runEmbeddingWorker: cancel", () => {
  test("cancels a queued embed without touching the running one", async () => {
    const { harness, control } = await initialisedHarness({ maxBatchSize: 1 });
    control.setGate();
    harness.send({ id: 2, type: "embed", texts: ["aa", "bb"] });
    await control.waitForNextRun();
    harness.send({ id: 3, type: "embed", texts: ["c"] });
    harness.send({ id: 4, type: "cancel", requestId: 3 });
    const cancel = (await harness.waitForResult(4)).result as {
      cancelled: number;
      targets: number[];
    };
    expect(cancel).toEqual({ cancelled: 1, targets: [3] });
    const queued = (await harness.waitForResult(3))
      .result as EmbeddingWorkerEmbedResult;
    expect(queued.cancelled).toBe(true);
    expect(queued.vectors).toEqual([null]);
    control.releaseGate();
    const running = (await harness.waitForResult(2))
      .result as EmbeddingWorkerEmbedResult;
    expect(running.cancelled).toBe(false);
    expect(running.vectors.every((entry) => entry !== null)).toBe(true);
    harness.send({ id: 5, type: "shutdown" });
    await harness.run;
  });

  test("stops the in-flight embed at the next batch boundary", async () => {
    const { harness, control } = await initialisedHarness({ maxBatchSize: 1 });
    control.setGate();
    harness.send({ id: 2, type: "embed", texts: ["aa", "bb"] });
    await control.waitForNextRun();
    harness.send({ id: 3, type: "cancel" });
    const cancel = (await harness.waitForResult(3)).result as {
      cancelled: number;
      targets: number[];
    };
    expect(cancel).toEqual({ cancelled: 1, targets: [2] });
    control.releaseGate();
    const embed = (await harness.waitForResult(2))
      .result as EmbeddingWorkerEmbedResult;
    expect(embed.cancelled).toBe(true);
    expect(embed.vectors[0]).not.toBeNull();
    expect(embed.vectors[1]).toBeNull();
    expect(embed.batches).toBe(1);
    harness.send({ id: 4, type: "shutdown" });
    await harness.run;
  });

  test("rejects a cancel request with a bad target id", async () => {
    const { harness } = await initialisedHarness();
    harness.send({ id: 2, type: "cancel", requestId: -3 });
    expect((await harness.waitForError(2)).error.code).toBe("invalid-request");
    harness.send({ id: 3, type: "shutdown" });
    await harness.run;
  });

  test("cancelling nothing is a no-op, not an error", async () => {
    const { harness } = await initialisedHarness();
    harness.send({ id: 2, type: "cancel" });
    const result = (await harness.waitForResult(2)).result as {
      cancelled: number;
      targets: number[];
    };
    expect(result).toEqual({ cancelled: 0, targets: [] });
    harness.send({ id: 3, type: "shutdown" });
    await harness.run;
  });
});

describe("runEmbeddingWorker: protocol errors and lifecycle", () => {
  test("reports invalid JSON and keeps serving later requests", async () => {
    const { harness } = await initialisedHarness();
    harness.sendRaw("this is not json\n");
    const error = await harness.waitForError(null);
    expect(error.error.code).toBe("protocol");
    harness.send({ id: 2, type: "stats" });
    const stats = (await harness.waitForResult(2))
      .result as EmbeddingWorkerStats;
    expect(stats.initialized).toBe(true);
    harness.send({ id: 3, type: "shutdown" });
    await harness.run;
  });

  test("rejects unknown request types with the request id", async () => {
    const harness = createHarness();
    harness.send({ id: 9, type: "progress" });
    const error = await harness.waitForError(9);
    expect(error.error.code).toBe("protocol");
    expect(error.error.message).toContain("Unknown request type");
    harness.send({ id: 10, type: "shutdown" });
    await harness.run;
  });

  test("rejects frames without a positive integer id", async () => {
    const harness = createHarness();
    harness.send({ id: 0, type: "stats" });
    const error = await harness.waitForError(null);
    expect(error.error.code).toBe("protocol");
    harness.send({ id: 1, type: "shutdown" });
    await harness.run;
  });

  test("ignores blank lines", async () => {
    const harness = createHarness();
    harness.sendRaw("\n\n   \n");
    harness.send({ id: 1, type: "stats" });
    await harness.waitForResult(1);
    expect(harness.frames.filter((frame) => frame.type === "error")).toEqual(
      [],
    );
    harness.send({ id: 2, type: "shutdown" });
    await harness.run;
  });

  test("shutdown replies, sets the exit signal and stops processing", async () => {
    const { harness } = await initialisedHarness();
    harness.send({ id: 2, type: "shutdown" });
    const result = (await harness.waitForResult(2)).result as {
      uptimeMs: number;
      embeds: number;
    };
    expect(result.embeds).toBe(0);
    expect(result.uptimeMs).toBeGreaterThanOrEqual(0);
    const summary = await harness.run;
    expect(summary.reason).toBe("shutdown");
    const frameCount = harness.frames.length;
    harness.send({ id: 3, type: "stats" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.frames.length).toBe(frameCount);
  });

  test("reports the protocol version it was configured with", async () => {
    const harness = createHarness({}, { protocolVersion: 7 });
    await harness.waitFor(() => harness.frames.length >= 1, "ready frame");
    expect(readyFrame(harness).protocol).toBe(7);
    harness.close();
    await harness.run;
  });
});

describe("spawned entry point", () => {
  test("runs over real stdio: ready, stats, shutdown with exit code 0", async () => {
    const client = new EmbeddingWorkerClient({
      workerPath: fileURLToPath(new URL("./worker-entry.ts", import.meta.url)),
      handshakeTimeoutMs: 15_000,
      controlTimeoutMs: 5_000,
    });
    try {
      const ready = await client.start();
      expect(ready.protocol).toBe(1);
      expect(ready.runtime).toBe(process.versions.bun ? "bun" : "node");
      expect(ready.pid).toBeGreaterThan(0);
      // No init: loading the real ORT/tokenizer closure is C7/C8's smoke, not
      // this test's job. The protocol and process lifecycle are exercised here.
      const stats = await client.stats();
      expect(stats.initialized).toBe(false);
      await client.shutdown();
      const exit = await client.waitForExit(5_000);
      expect(exit?.code).toBe(0);
    } finally {
      client.dispose();
    }
  }, 30_000);
});

describe("isEmbeddingWorkerMain", () => {
  test("matches the module path as the process entry", () => {
    const modulePath = fileURLToPath(import.meta.url);
    expect(isEmbeddingWorkerMain(import.meta.url, modulePath)).toBe(true);
    expect(isEmbeddingWorkerMain(import.meta.url, `${modulePath}.other`)).toBe(
      false,
    );
  });

  test("returns false without an entry path", () => {
    expect(isEmbeddingWorkerMain(import.meta.url, undefined)).toBe(false);
    expect(isEmbeddingWorkerMain(import.meta.url, "")).toBe(false);
  });

  test("is case-insensitive on Windows paths only", () => {
    expect(
      isEmbeddingWorkerMain(
        "file:///C:/Repo/src/worker-entry.ts",
        "c:/repo/src/worker-entry.ts",
        "win32",
      ),
    ).toBe(true);
    expect(
      isEmbeddingWorkerMain(
        "file:///C:/Repo/src/worker-entry.ts",
        "c:/repo/src/worker-entry.ts",
        "linux",
      ),
    ).toBe(false);
  });
});

describe("tokenizer module contract", () => {
  class FakeTokenizer {
    readonly tokenizerJson: unknown;
    readonly config: unknown;

    constructor(tokenizerJson: unknown, config: unknown) {
      this.tokenizerJson = tokenizerJson;
      this.config = config;
    }

    encode(): { ids: number[]; attention_mask: number[] } {
      return { ids: [101, 7, 102], attention_mask: [1, 1, 1] };
    }
  }

  test("constructs @huggingface/tokenizers 0.2.0 via Tokenizer(json, config)", () => {
    const tokenizerJson = { model: { type: "WordPiece" } };
    const tokenizerConfig = { model_max_length: 512 };
    const tokenizer = createTokenizerFromModule(
      { Tokenizer: FakeTokenizer },
      tokenizerJson,
      tokenizerConfig,
    );
    expect(tokenizer.encode("部署卡住")).toEqual({
      inputIds: [101, 7, 102],
      attentionMask: [1, 1, 1],
    });
  });

  test("finds the class behind a CJS/ESM default wrapper", () => {
    const tokenizer = createTokenizerFromModule(
      { default: { Tokenizer: FakeTokenizer } },
      {},
      {},
    );
    expect(tokenizer.encode("x").inputIds).toEqual([101, 7, 102]);
  });

  test("still accepts the legacy fromFile(path) shape", () => {
    const tokenizer = createTokenizerFromModule(
      {
        fromFile: () => ({
          encode: () => ({ ids: [9] }),
        }),
      },
      {},
      {},
    );
    expect(tokenizer.encode("x").inputIds).toEqual([9]);
  });

  test("reports a module with no usable entry point", () => {
    expect(() => createTokenizerFromModule({}, {}, {})).toThrow(
      "exposes no loadable entry point",
    );
  });

  test("the real loader reads both JSON files next to tokenizer.json", async () => {
    const root = mkdtempSync(join(tmpdir(), "hryk-worker-tokenizer-"));
    try {
      const packageDir = join(
        root,
        "node_modules",
        "@huggingface",
        "tokenizers",
      );
      mkdirSync(packageDir, { recursive: true });
      writeFileSync(join(root, "package.json"), "{}");
      writeFileSync(
        join(packageDir, "package.json"),
        JSON.stringify({ name: "@huggingface/tokenizers", main: "index.cjs" }),
      );
      writeFileSync(
        join(packageDir, "index.cjs"),
        [
          "class Tokenizer {",
          "  constructor(tokenizerJson, tokenizerConfig) {",
          "    this.tokenizerJson = tokenizerJson;",
          "    this.tokenizerConfig = tokenizerConfig;",
          "  }",
          "  encode() {",
          "    return { ids: [this.tokenizerJson.marker, 2], attention_mask: [1, 1] };",
          "  }",
          "}",
          "module.exports = { Tokenizer };",
        ].join("\n"),
      );
      const modelDir = join(root, "model");
      mkdirSync(modelDir, { recursive: true });
      writeFileSync(
        join(modelDir, "tokenizer.json"),
        JSON.stringify({ marker: 42 }),
      );
      writeFileSync(
        join(modelDir, "tokenizer_config.json"),
        JSON.stringify({ pad_token_id: 7 }),
      );

      const loadTokenizer = createHuggingFaceTokenizerLoader();
      const tokenizer = await loadTokenizer({
        runtimeDir: root,
        tokenizerPath: join(modelDir, "tokenizer.json"),
      });
      expect(tokenizer.padTokenId).toBe(7);
      expect(tokenizer.encode("hello")).toEqual({
        inputIds: [42, 2],
        attentionMask: [1, 1],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
