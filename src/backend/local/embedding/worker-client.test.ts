import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeVectorBase64 } from "./featurize";
import {
  EmbeddingWorkerClient,
  type EmbeddingWorkerClientError,
  type EmbeddingWorkerClientOptions,
  type EmbeddingWorkerExit,
  type EmbeddingWorkerProcessHandle,
} from "./worker-client";

/**
 * Fake worker: a plain CommonJS script executed with `process.execPath`, so the
 * client's spawn/framing/exit handling is exercised for real. It never loads a
 * native module and never touches the network. Modes are selected by argv[1].
 */
const FAKE_WORKER_SOURCE = String.raw`
"use strict";
const readline = require("node:readline");
const { Buffer } = require("node:buffer");

const mode = process.argv[2] || "ok";

function writeFrame(frame, then) {
  const line = JSON.stringify(frame) + "\n";
  if (then) process.stdout.write(line, then);
  else process.stdout.write(line);
}

function encodeVector(values) {
  const buffer = Buffer.alloc(values.length * 4);
  for (let index = 0; index < values.length; index += 1) {
    buffer.writeFloatLE(values[index], index * 4);
  }
  return buffer.toString("base64");
}

function vectorForText(text) {
  const raw = [text.length, 1, 2, 3];
  const norm = Math.hypot(raw[0], raw[1], raw[2], raw[3]);
  return encodeVector(raw.map((value) => value / norm));
}

function readyFrame() {
  return {
    type: "ready",
    protocol: 1,
    pid: process.pid,
    runtime: "node",
    startedAt: Date.now(),
  };
}

const statsResult = {
  initialized: true,
  modelPath: null,
  tokenizerPath: null,
  runtime: "node",
  dim: 4,
  maxTokens: 512,
  maxBatchSize: 8,
  maxBatchTokens: 1700,
  inits: 1,
  embeds: 0,
  texts: 0,
  tokens: 0,
  batches: 0,
  errors: 0,
  cancelled: 0,
  totalEmbedMs: 0,
  lastEmbedMs: 0,
  textsPerSecond: 0,
  tokensPerSecond: 0,
  uptimeMs: 1,
  queueDepth: 0,
  pendingRequestId: null,
};

const pendingDelayed = [];

function start() {
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    const frame = JSON.parse(line);
    if (frame.type === "init") {
      writeFrame({
        type: "result",
        id: frame.id,
        result: { dim: 4, runtime: "node", maxTokens: 512, warmupMs: 1 },
      });
      return;
    }
    if (frame.type === "stats") {
      writeFrame({ type: "result", id: frame.id, result: statsResult });
      return;
    }
    if (frame.type === "cancel") {
      writeFrame({
        type: "result",
        id: frame.id,
        result: { cancelled: 0, targets: [] },
      });
      return;
    }
    if (frame.type === "shutdown") {
      writeFrame(
        { type: "result", id: frame.id, result: { uptimeMs: 1, embeds: 0 } },
        () => process.exit(0),
      );
      return;
    }
    if (frame.type === "embed") handleEmbed(frame);
  });
}

function resultFor(frame) {
  return {
    type: "result",
    id: frame.id,
    result: {
      vectors: frame.texts.map(vectorForText),
      dim: 4,
      cancelled: false,
      texts: frame.texts.length,
      tokens: frame.texts.length * 2,
      batches: 1,
      elapsedMs: 1,
    },
  };
}

function handleEmbed(frame) {
  if (mode === "crash-on-embed") {
    process.stderr.write("embed crash\n");
    process.exit(7);
  }
  if (mode === "error-frame") {
    writeFrame({
      type: "error",
      id: frame.id,
      error: { code: "embed-failed", message: "boom from worker", requestType: "embed" },
    });
    return;
  }
  if (mode === "bad-json") {
    process.stdout.write("not a frame\n");
    return;
  }
  if (mode === "ignore-embed") return;
  const result = resultFor(frame);
  if (mode === "delayed-order") {
    pendingDelayed.push(result);
    if (pendingDelayed.length === 2) {
      const first = pendingDelayed.shift();
      const second = pendingDelayed.shift();
      writeFrame(second);
      writeFrame(first);
    }
    return;
  }
  if (mode === "split-lines") {
    const line = JSON.stringify(result) + "\n";
    process.stdout.write(line.slice(0, 20));
    setTimeout(() => process.stdout.write(line.slice(20)), 10);
    return;
  }
  writeFrame(result);
}

if (mode === "crash-before-ready") {
  process.stderr.write("boom before ready\n");
  process.exit(3);
} else if (mode === "no-ready") {
  setInterval(() => {}, 1000);
} else if (mode === "split-lines") {
  const line = JSON.stringify(readyFrame()) + "\n";
  process.stdout.write(line.slice(0, 12));
  setTimeout(() => process.stdout.write(line.slice(12)), 20);
  start();
} else {
  writeFrame(readyFrame());
  start();
}
`;

const workerDir = mkdtempSync(join(tmpdir(), "hryk-c3-worker-"));
const workerPath = join(workerDir, "fake-worker.cjs");
writeFileSync(workerPath, FAKE_WORKER_SOURCE, "utf8");

const clients: EmbeddingWorkerClient[] = [];

function createClient(
  mode = "ok",
  options: Partial<EmbeddingWorkerClientOptions> = {},
): EmbeddingWorkerClient {
  const client = new EmbeddingWorkerClient({
    workerPath,
    args: [mode],
    handshakeTimeoutMs: 5_000,
    initTimeoutMs: 5_000,
    embedTimeoutMs: 5_000,
    controlTimeoutMs: 5_000,
    killGraceMs: 500,
    ...options,
  });
  clients.push(client);
  return client;
}

async function disposeAll(): Promise<void> {
  for (const client of clients.splice(0)) {
    client.dispose();
    await client.waitForExit(2_000);
  }
}

afterAll(async () => {
  await disposeAll();
  rmSync(workerDir, { force: true, recursive: true, maxRetries: 5 });
});

function norm(vector: Float32Array): number {
  let total = 0;
  for (let axis = 0; axis < vector.length; axis += 1) {
    const value = vector[axis] ?? 0;
    total += value * value;
  }
  return Math.sqrt(total);
}

function emptyStream(): AsyncIterable<string | Uint8Array> {
  return {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    async *[Symbol.asyncIterator]() {
      // An immediately empty stream.
    },
  };
}

function neverStream(): AsyncIterable<string | Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      await new Promise(() => {
        // Never resolves: the injected worker never writes a frame.
      });
    },
  };
}

interface ScriptedHandle {
  readonly handle: EmbeddingWorkerProcessHandle;
  readonly written: string[];
  push(chunk: string): void;
  readonly killed: () => boolean;
}

/** Injected child handle whose stdout the test drives frame by frame. */
function createScriptedHandle(): ScriptedHandle {
  const queue: string[] = [];
  const written: string[] = [];
  let notify: (() => void) | null = null;
  let closed = false;
  let killed = false;
  let resolveExit: (exit: EmbeddingWorkerExit) => void = () => {};
  const exited = new Promise<EmbeddingWorkerExit>((resolve) => {
    resolveExit = resolve;
  });
  const stdout: AsyncIterable<string | Uint8Array> = {
    async *[Symbol.asyncIterator]() {
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
    },
  };
  return {
    handle: {
      pid: 9_999,
      stdout,
      stderr: emptyStream(),
      write(line: string): void {
        written.push(line);
      },
      kill(): void {
        if (killed) return;
        killed = true;
        closed = true;
        resolveExit({ code: null, signal: "SIGKILL" });
        notify?.();
        notify = null;
      },
      exited,
    },
    written,
    push(chunk: string): void {
      queue.push(chunk);
      if (notify !== null) {
        const resolve = notify;
        notify = null;
        resolve();
      }
    },
    killed: () => killed,
  };
}

describe("EmbeddingWorkerClient: happy path", () => {
  test("spawns via process.execPath, handshakes, init, embed, shutdown", async () => {
    const client = createClient();
    expect(client.isRunning).toBe(false);
    expect(client.ready).toBeNull();

    const ready = await client.start();
    expect(ready.protocol).toBe(1);
    expect(ready.runtime).toBe("node");
    expect(ready.pid).toBeGreaterThan(0);
    expect(client.isRunning).toBe(true);
    expect(client.pid).toBe(ready.pid);

    const init = await client.init({
      runtimeDir: "/cache/runtime/1.31.1",
      modelPath: "/cache/models/bge/model.onnx",
      tokenizerPath: "/cache/models/bge/tokenizer.json",
    });
    expect(init.dim).toBe(4);

    const stats = await client.stats();
    expect(stats.initialized).toBe(true);
    expect(stats.dim).toBe(4);

    const output = await client.embed(["a", "bb"]);
    expect(output.dim).toBe(4);
    expect(output.cancelled).toBe(false);
    expect(output.texts).toBe(2);
    expect(output.vectors.length).toBe(2);
    for (const vector of output.vectors) {
      expect(vector).not.toBeNull();
      expect(norm(vector ?? new Float32Array(0))).toBeCloseTo(1, 5);
    }

    await client.shutdown();
    expect(client.isRunning).toBe(false);
    const exit = await client.waitForExit(1_000);
    expect(exit?.code).toBe(0);
    expect(client.exit?.code).toBe(0);
  });

  test("refuses requests before start", async () => {
    const client = createClient();
    await expect(client.stats()).rejects.toMatchObject({ code: "not-running" });
    await expect(client.embed(["a"])).rejects.toMatchObject({
      code: "not-running",
    });
    client.dispose();
  });

  test("embedOne returns one vector and embedBatched chunks requests", async () => {
    const client = createClient();
    await client.start();
    await client.init({
      runtimeDir: "/r",
      modelPath: "/m",
      tokenizerPath: "/t",
    });

    const single = await client.embedOne("abc");
    expect(single).not.toBeNull();
    expect(norm(single ?? new Float32Array(0))).toBeCloseTo(1, 5);

    const progress: Array<[number, number]> = [];
    const batched = await client.embedBatched(["a", "b", "c", "d", "e"], {
      batchSize: 2,
      onProgress: (completed, total) => progress.push([completed, total]),
    });
    expect(batched.vectors.length).toBe(5);
    expect(batched.texts).toBe(5);
    expect(progress).toEqual([
      [2, 5],
      [4, 5],
      [5, 5],
    ]);

    await expect(
      client.embedBatched(["a"], { batchSize: 0 }),
    ).rejects.toMatchObject({ code: "invalid-argument" });
    await client.shutdown();
  });

  test("shutdown is idempotent", async () => {
    const client = createClient();
    await client.start();
    await client.shutdown();
    await client.shutdown();
    expect(client.isRunning).toBe(false);
  });

  test("notifies exit listeners exactly once", async () => {
    const client = createClient();
    const exits: number[] = [];
    client.onExit((exit) => exits.push(exit.code ?? -1));
    await client.start();
    await client.shutdown();
    await client.waitForExit(1_000);
    expect(exits).toEqual([0]);
  });
});

describe("EmbeddingWorkerClient: failure handling", () => {
  test("surfaces typed worker error frames", async () => {
    const client = createClient("error-frame");
    await client.start();
    await client.init({
      runtimeDir: "/r",
      modelPath: "/m",
      tokenizerPath: "/t",
    });
    let failure: EmbeddingWorkerClientError | null = null;
    try {
      await client.embed(["a"]);
    } catch (error) {
      failure = error as EmbeddingWorkerClientError;
    }
    expect(failure?.code).toBe("worker-error");
    expect(failure?.workerCode).toBe("embed-failed");
    expect(failure?.message).toContain("boom from worker");
    expect(client.workerError?.code).toBe("embed-failed");
    await client.shutdown();
  });

  test("rejects pending requests when the worker crashes", async () => {
    const client = createClient("crash-on-embed");
    await client.start();
    await client.init({
      runtimeDir: "/r",
      modelPath: "/m",
      tokenizerPath: "/t",
    });
    await expect(client.embed(["a"])).rejects.toMatchObject({ code: "exited" });
    const exit = await client.waitForExit(2_000);
    expect(exit?.code).toBe(7);
    expect(client.stderrTail()).toContain("embed crash");
    expect(client.isRunning).toBe(false);
  });

  test("rejects start when the worker exits before the handshake", async () => {
    const client = createClient("crash-before-ready");
    let failure: EmbeddingWorkerClientError | null = null;
    try {
      await client.start();
    } catch (error) {
      failure = error as EmbeddingWorkerClientError;
    }
    expect(failure?.code).toBe("exited");
    expect(failure?.exit?.code).toBe(3);
    expect(failure?.message).toContain("exited with code 3");
    expect(failure?.message).toContain("boom before ready");
    expect(client.isRunning).toBe(false);
  });

  test("times out a silent handshake and kills the process", async () => {
    const client = createClient("no-ready", { handshakeTimeoutMs: 250 });
    await expect(client.start()).rejects.toMatchObject({
      code: "handshake-timeout",
    });
    const exit = await client.waitForExit(3_000);
    expect(exit).not.toBeNull();
    expect(client.isRunning).toBe(false);
  });

  test("treats a malformed frame as a protocol failure and kills the worker", async () => {
    const script = createScriptedHandle();
    const client = new EmbeddingWorkerClient({
      workerPath: "scripted-worker.js",
      spawn: () => script.handle,
      handshakeTimeoutMs: 1_000,
    });
    clients.push(client);
    const handshake = client.start();
    script.push(
      `${JSON.stringify({
        type: "ready",
        protocol: 1,
        pid: 9_999,
        runtime: "node",
        startedAt: 1,
      })}\n`,
    );
    await handshake;

    const init = client.init({
      runtimeDir: "/r",
      modelPath: "/m",
      tokenizerPath: "/t",
    });
    script.push(
      `${JSON.stringify({
        type: "result",
        id: 1,
        result: { dim: 4, runtime: "node", maxTokens: 512, warmupMs: 1 },
      })}\n`,
    );
    await init;

    const embed = client.embed(["a"]);
    script.push("this is not json\n");
    await expect(embed).rejects.toMatchObject({ code: "protocol" });
    expect(client.protocolError).toContain("not JSON");
    expect(script.killed()).toBe(true);
    expect(await client.waitForExit(1_000)).not.toBeNull();
  });

  test("times out a request that is never answered and stays running", async () => {
    const client = createClient("ignore-embed", { embedTimeoutMs: 200 });
    await client.start();
    await expect(client.embed(["a"])).rejects.toMatchObject({
      code: "request-timeout",
    });
    expect(client.isRunning).toBe(true);
    await client.shutdown({ timeoutMs: 1_000 });
  });

  test("aborting an embed rejects it and asks the worker to cancel", async () => {
    const client = createClient("ignore-embed");
    await client.start();
    const controller = new AbortController();
    const pending = client.embed(["a"], { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    expect(client.isRunning).toBe(true);
    await client.shutdown({ timeoutMs: 1_000 });
  });

  test("dispose rejects pending requests", async () => {
    const client = createClient("ignore-embed");
    await client.start();
    const pending = client.embed(["a"]);
    client.dispose();
    await expect(pending).rejects.toMatchObject({ code: "disposed" });
  });

  test("rejects a worker that speaks another protocol version", async () => {
    const client = createClient("ok", { protocolVersion: 2 });
    await expect(client.start()).rejects.toMatchObject({ code: "protocol" });
    expect(client.protocolError).toContain("protocol 1");
    await client.waitForExit(2_000);
  });
});

describe("EmbeddingWorkerClient: framing and ordering", () => {
  test("reassembles frames that arrive split across chunks", async () => {
    const client = createClient("split-lines");
    const ready = await client.start();
    expect(ready.protocol).toBe(1);
    await client.init({
      runtimeDir: "/r",
      modelPath: "/m",
      tokenizerPath: "/t",
    });
    const output = await client.embed(["a"]);
    expect(output.vectors.length).toBe(1);
    expect(norm(output.vectors[0] ?? new Float32Array(0))).toBeCloseTo(1, 5);
    await client.shutdown();
  });

  test("correlates out-of-order replies with their request ids", async () => {
    const client = createClient("delayed-order");
    await client.start();
    await client.init({
      runtimeDir: "/r",
      modelPath: "/m",
      tokenizerPath: "/t",
    });
    const [longText, shortText] = await Promise.all([
      client.embed(["aaa"]),
      client.embed(["a"]),
    ]);
    const longVector = longText.vectors[0] ?? new Float32Array(0);
    const shortVector = shortText.vectors[0] ?? new Float32Array(0);
    const longNorm = Math.hypot(3, 1, 2, 3);
    const shortNorm = Math.hypot(1, 1, 2, 3);
    expect(longVector[0] ?? 0).toBeCloseTo(3 / longNorm, 5);
    expect(shortVector[0] ?? 0).toBeCloseTo(1 / shortNorm, 5);
    await client.shutdown();
  });

  test("decodes base64 vectors with the expected width", async () => {
    const client = createClient();
    await client.start();
    await client.init({
      runtimeDir: "/r",
      modelPath: "/m",
      tokenizerPath: "/t",
    });
    const output = await client.embed(["ab"]);
    const vector = decodeVectorBase64(
      // Re-encode to prove the client's decode matches the framing helper.
      Buffer.from(
        new Float32Array(output.vectors[0] ?? new Float32Array(0)).buffer,
      ).toString("base64"),
      4,
    );
    expect(Array.from(vector)).toEqual(Array.from(output.vectors[0] ?? []));
    await client.shutdown();
  });
});

describe("EmbeddingWorkerClient: injected spawner", () => {
  test("reports a spawn failure from the process handle", async () => {
    const handle: EmbeddingWorkerProcessHandle = {
      pid: undefined,
      stdout: emptyStream(),
      stderr: emptyStream(),
      write(): void {},
      kill(): void {},
      exited: Promise.resolve({
        code: null,
        signal: null,
        error: new Error("ENOENT: no such file"),
      }),
    };
    const client = new EmbeddingWorkerClient({
      workerPath: "missing-worker.js",
      spawn: () => handle,
      handshakeTimeoutMs: 500,
    });
    clients.push(client);
    await expect(client.start()).rejects.toMatchObject({
      code: "spawn-failed",
    });
    expect(client.isRunning).toBe(false);
  });

  test("times out the handshake of a silent injected worker and kills it", async () => {
    let killed = false;
    const handle: EmbeddingWorkerProcessHandle = {
      pid: 123,
      stdout: neverStream(),
      stderr: emptyStream(),
      write(): void {},
      kill(): void {
        killed = true;
      },
      exited: new Promise(() => {
        // Never resolves; the client must rely on its handshake timeout.
      }),
    };
    const client = new EmbeddingWorkerClient({
      workerPath: "silent-worker.js",
      spawn: () => handle,
      handshakeTimeoutMs: 100,
    });
    clients.push(client);
    await expect(client.start()).rejects.toMatchObject({
      code: "handshake-timeout",
    });
    expect(killed).toBe(true);
  });
});
