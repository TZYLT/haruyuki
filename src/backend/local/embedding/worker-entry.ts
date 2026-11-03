/**
 * Child-process entry point for the built-in embedding runtime (C3).
 *
 * `onnxruntime-node` is native, so it is never loaded in the TUI process: this
 * file is spawned with `process.execPath` by `worker-client.ts` and loads the
 * runtime closure dynamically from the directory C2 downloaded it to. The wire
 * contract lives in `worker-protocol.ts`.
 *
 * **Cancel is out of band.** `session.run` cannot be preempted, so a `cancel`
 * frame is handled the moment it arrives: the in-flight embed gets a sentinel
 * checked between batches, and queued embeds are answered immediately with
 * `cancelled: true` and `null` vectors instead of disappearing (48-2 §4.4:
 * ≈200 ms is the honest bound).
 *
 * **Injection.** `loadRuntime`/`loadTokenizer` are injectable, so
 * `worker-entry.test.ts` drives the real state machine with fakes — no ORT, no
 * tokenizer package, no network.
 *
 * Layer: `backend/local/`; never imports the client.
 */

import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertHiddenStateShape,
  DEFAULT_BATCH_MAX_SIZE,
  DEFAULT_BATCH_MAX_TOKENS,
  encodeVectorBase64,
  FeaturizeError,
  padTokenBatch,
  planTokenBatches,
  poolBatch,
  sumSequenceTokens,
  type TokenizedSequence,
  truncateSequence,
} from "./featurize";
import {
  EMBEDDING_WORKER_PROTOCOL_VERSION,
  type EmbeddingWorkerCancelResult,
  type EmbeddingWorkerEmbedResult,
  type EmbeddingWorkerErrorCode,
  type EmbeddingWorkerFrame,
  type EmbeddingWorkerInitResult,
  type EmbeddingWorkerRequest,
  type EmbeddingWorkerRequestType,
  type EmbeddingWorkerResultFrame,
  type EmbeddingWorkerRuntimeName,
  type EmbeddingWorkerShutdownResult,
  type EmbeddingWorkerStats,
  isEmbeddingWorkerRequestType,
  isRecord,
  normalizeInitOptions,
  requireEmbedTexts,
  splitEmbeddingWorkerLines,
  truncateMessage,
  WorkerRequestError,
} from "./worker-protocol";

export const DEFAULT_MAX_TOKENS = 512;
export const DEFAULT_WARMUP_TEXT = ".";

export interface EmbeddingTokenizer {
  encode(
    text: string,
    options?: { readonly maxTokens?: number },
  ): TokenizedSequence;
  readonly padTokenId?: number;
}

export interface EmbeddingSessionInput {
  readonly inputIds: Int32Array;
  readonly attentionMask: Int32Array;
  readonly sequences: number;
  readonly tokens: number;
}

export interface EmbeddingSessionOutput {
  readonly hidden: Float32Array;
  readonly dim: number;
}

export interface EmbeddingSession {
  run(input: EmbeddingSessionInput): Promise<EmbeddingSessionOutput>;
  release?(): void | Promise<void>;
}

export interface EmbeddingRuntime {
  createSession(options: {
    readonly runtimeDir: string;
    readonly modelPath: string;
    readonly intraOpThreads?: number;
    readonly executionProviders?: readonly string[];
  }): Promise<EmbeddingSession>;
}

export type EmbeddingRuntimeLoader = (options: {
  readonly runtimeDir: string;
}) => Promise<EmbeddingRuntime>;

export type EmbeddingTokenizerLoader = (options: {
  readonly runtimeDir: string;
  readonly tokenizerPath: string;
}) => Promise<EmbeddingTokenizer>;

export interface EmbeddingWorkerDependencies {
  readonly loadRuntime?: EmbeddingRuntimeLoader;
  readonly loadTokenizer?: EmbeddingTokenizerLoader;
  readonly now?: () => number;
}

export interface EmbeddingWorkerSink {
  writeLine(line: string): void | Promise<void>;
}

export interface EmbeddingWorkerOptions {
  readonly input: AsyncIterable<string | Uint8Array>;
  readonly output: EmbeddingWorkerSink;
  readonly dependencies?: EmbeddingWorkerDependencies;
  readonly pid?: number;
  readonly runtimeName?: EmbeddingWorkerRuntimeName;
  readonly protocolVersion?: number;
}

export interface EmbeddingWorkerRunSummary {
  readonly reason: "input-closed" | "shutdown";
  readonly requests: number;
  readonly embeds: number;
  readonly texts: number;
  readonly tokens: number;
  readonly errors: number;
  readonly cancelled: number;
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 500 ? `${message.slice(0, 500)}…` : message;
}

async function loadStage<T>(
  code: EmbeddingWorkerErrorCode,
  label: string,
  load: () => Promise<T>,
): Promise<T> {
  try {
    return await load();
  } catch (error) {
    throw new WorkerRequestError(
      code,
      `Could not load the ${label}: ${describeError(error)}`,
    );
  }
}

function rate(count: number, elapsedMs: number): number {
  if (elapsedMs <= 0 || count <= 0) return 0;
  return Math.round((count / (elapsedMs / 1000)) * 100) / 100;
}

async function releaseQuietly(session: EmbeddingSession | null): Promise<void> {
  if (session === null || session.release === undefined) return;
  try {
    await session.release();
  } catch {}
}

class EmbeddingWorkerState {
  private readonly input: AsyncIterable<string | Uint8Array>;
  private readonly sink: EmbeddingWorkerSink;
  private readonly loadRuntime: EmbeddingRuntimeLoader;
  private readonly loadTokenizer: EmbeddingTokenizerLoader;
  private readonly now: () => number;
  private readonly pid: number;
  private readonly runtimeName: EmbeddingWorkerRuntimeName;
  private readonly protocolVersion: number;
  private readonly startedAt: number;

  private writeChain: Promise<void> = Promise.resolve();
  private writeError: Error | null = null;
  private queue: EmbeddingWorkerRequest[] = [];
  private pumpPromise: Promise<void> | null = null;
  private stopped = false;
  private readonly stopSignal: Promise<void>;
  private stopResolve: (() => void) | null = null;

  private tokenizer: EmbeddingTokenizer | null = null;
  private session: EmbeddingSession | null = null;
  private dim: number | null = null;
  private modelPath: string | null = null;
  private tokenizerPath: string | null = null;
  private maxTokens = DEFAULT_MAX_TOKENS;
  private maxBatchSize = DEFAULT_BATCH_MAX_SIZE;
  private maxBatchTokens = DEFAULT_BATCH_MAX_TOKENS;

  private activeEmbedId: number | null = null;
  private cancelRequested = false;
  private readonly counters = {
    requests: 0,
    inits: 0,
    embeds: 0,
    texts: 0,
    tokens: 0,
    batches: 0,
    errors: 0,
    cancelled: 0,
    totalEmbedMs: 0,
    lastEmbedMs: 0,
  };

  constructor(options: EmbeddingWorkerOptions) {
    this.input = options.input;
    this.sink = options.output;
    const dependencies = options.dependencies ?? {};
    this.loadRuntime = dependencies.loadRuntime ?? createOnnxRuntimeLoader();
    this.loadTokenizer =
      dependencies.loadTokenizer ?? createHuggingFaceTokenizerLoader();
    this.now = dependencies.now ?? (() => Date.now());
    this.pid = options.pid ?? process.pid;
    this.runtimeName =
      options.runtimeName ?? (process.versions.bun ? "bun" : "node");
    this.protocolVersion =
      options.protocolVersion ?? EMBEDDING_WORKER_PROTOCOL_VERSION;
    this.startedAt = this.now();
    this.stopSignal = new Promise<void>((resolve) => {
      this.stopResolve = resolve;
    });
  }

  async run(): Promise<"input-closed" | "shutdown"> {
    await this.send({
      type: "ready",
      protocol: this.protocolVersion,
      pid: this.pid,
      runtime: this.runtimeName,
      startedAt: this.startedAt,
    });
    try {
      const lines = splitEmbeddingWorkerLines(this.input);
      for (;;) {
        // Race the next line against `shutdown`: the worker must stop even
        // though stdin stays open (the client may keep the pipe alive).
        const next = await Promise.race([
          lines.next(),
          this.stopSignal.then(() => ({
            done: true as const,
            value: undefined,
          })),
        ]);
        if (next.done === true) break;
        this.acceptLine(next.value);
      }
      void lines.return(undefined).catch(() => {});
    } finally {
      await this.drain();
    }
    return this.stopped ? "shutdown" : "input-closed";
  }

  summary(reason: "input-closed" | "shutdown"): EmbeddingWorkerRunSummary {
    return { reason, ...this.counters };
  }

  private send(frame: EmbeddingWorkerFrame): Promise<void> {
    const line = `${JSON.stringify(frame)}\n`;
    const next = this.writeChain.then(async () => {
      if (this.writeError) return;
      try {
        await this.sink.writeLine(line);
      } catch (error) {
        this.writeError =
          error instanceof Error ? error : new Error(String(error));
      }
    });
    this.writeChain = next;
    return next;
  }

  private sendError(
    id: number | null,
    code: EmbeddingWorkerErrorCode,
    message: string,
    requestType?: EmbeddingWorkerRequestType,
  ): Promise<void> {
    this.counters.errors += 1;
    return this.send({
      type: "error",
      id,
      error: {
        code,
        message: truncateMessage(message, 500),
        ...(requestType === undefined ? {} : { requestType }),
      },
    });
  }

  private acceptLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    const fail = (
      code: EmbeddingWorkerErrorCode,
      message: string,
      id: number | null = null,
    ): void => {
      void this.sendError(id, code, message);
    };
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      fail(
        "protocol",
        `A request frame is not valid JSON: ${truncateMessage(trimmed)}`,
      );
      return;
    }
    if (!isRecord(parsed)) {
      fail("protocol", "A request frame is not an object.");
      return;
    }
    const id = parsed.id;
    if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
      fail("protocol", "Every request frame needs a positive integer id.");
      return;
    }
    const type = parsed.type;
    if (!isEmbeddingWorkerRequestType(type)) {
      fail("protocol", `Unknown request type: ${String(type)}`, id);
      return;
    }
    this.counters.requests += 1;
    if (type === "cancel") {
      this.cancelOutOfBand(id, parsed.requestId);
      return;
    }
    this.queue.push(parsed as unknown as EmbeddingWorkerRequest);
    this.kick();
  }

  /**
   * `cancel` bypasses the queue: the in-flight embed is only reachable while it
   * awaits `session.run`, so the sentinel must be set as the frame arrives.
   */
  private cancelOutOfBand(id: number, target: unknown): void {
    const targetId =
      target === undefined
        ? null
        : typeof target === "number" && Number.isInteger(target) && target > 0
          ? target
          : Number.NaN;
    if (typeof targetId === "number" && Number.isNaN(targetId)) {
      void this.sendError(
        id,
        "invalid-request",
        "cancel.requestId must be a positive integer when present.",
        "cancel",
      );
      return;
    }
    const targets: number[] = [];
    if (
      this.activeEmbedId !== null &&
      (targetId === null || targetId === this.activeEmbedId)
    ) {
      this.cancelRequested = true;
      targets.push(this.activeEmbedId);
    }
    const remaining: EmbeddingWorkerRequest[] = [];
    for (const queued of this.queue) {
      if (
        queued.type !== "embed" ||
        (targetId !== null && targetId !== queued.id)
      ) {
        remaining.push(queued);
        continue;
      }
      targets.push(queued.id);
      void this.send({
        type: "result",
        id: queued.id,
        result: {
          vectors: Array.from({ length: queued.texts.length }, () => null),
          dim: this.dim ?? 0,
          cancelled: true,
          texts: 0,
          tokens: 0,
          batches: 0,
          elapsedMs: 0,
        },
      });
    }
    this.queue = remaining;
    this.counters.cancelled += targets.length;
    void this.send({
      type: "result",
      id,
      result: { cancelled: targets.length, targets },
    } satisfies EmbeddingWorkerResultFrame<EmbeddingWorkerCancelResult>);
  }

  private kick(): void {
    if (this.pumpPromise !== null || this.stopped) return;
    this.pumpPromise = this.runQueue().finally(() => {
      this.pumpPromise = null;
    });
  }

  private async runQueue(): Promise<void> {
    while (!this.stopped && this.queue.length > 0) {
      const request = this.queue.shift();
      if (request === undefined) continue;
      try {
        if (request.type === "init") await this.handleInit(request);
        else if (request.type === "embed") await this.handleEmbed(request);
        else if (request.type === "stats") await this.handleStats(request);
        else if (request.type === "shutdown") {
          await this.handleShutdown(request);
        }
      } catch (error) {
        const code =
          error instanceof WorkerRequestError
            ? error.code
            : error instanceof FeaturizeError
              ? "featurize-failed"
              : "internal";
        await this.sendError(
          request.id,
          code,
          describeError(error),
          request.type,
        );
      }
    }
  }

  private async drain(): Promise<void> {
    while (this.pumpPromise !== null) await this.pumpPromise;
    await this.writeChain;
  }

  private async handleInit(
    request: Extract<EmbeddingWorkerRequest, { type: "init" }>,
  ): Promise<void> {
    const options = normalizeInitOptions(request, {
      maxTokens: DEFAULT_MAX_TOKENS,
      maxBatchSize: DEFAULT_BATCH_MAX_SIZE,
      maxBatchTokens: DEFAULT_BATCH_MAX_TOKENS,
      warmupText: DEFAULT_WARMUP_TEXT,
    });
    const {
      runtimeDir,
      modelPath,
      tokenizerPath,
      maxTokens,
      maxBatchSize,
      maxBatchTokens,
      intraOpThreads,
      executionProviders,
      warmupText,
    } = options;

    const tokenizer = await loadStage("tokenizer-failed", "tokenizer", () =>
      this.loadTokenizer({ runtimeDir, tokenizerPath }),
    );
    const runtime = await loadStage("runtime-failed", "embedding runtime", () =>
      this.loadRuntime({ runtimeDir }),
    );
    const session = await loadStage("init-failed", "inference session", () =>
      runtime.createSession({
        runtimeDir,
        modelPath,
        ...(intraOpThreads === undefined ? {} : { intraOpThreads }),
        ...(executionProviders === undefined ? {} : { executionProviders }),
      }),
    );

    const warmupStartedAt = this.now();
    let dim: number;
    try {
      const batch = padTokenBatch(
        [
          truncateSequence(
            tokenizer.encode(warmupText, { maxTokens }),
            maxTokens,
          ),
        ],
        tokenizer.padTokenId ?? 0,
      );
      const output = await session.run(batch);
      assertHiddenStateShape(
        output.hidden,
        batch.sequences,
        batch.tokens,
        output.dim,
      );
      dim = output.dim;
    } catch (error) {
      await releaseQuietly(session);
      throw new WorkerRequestError(
        "init-failed",
        `The warmup inference failed: ${describeError(error)}`,
      );
    }
    const warmupMs = Math.max(0, this.now() - warmupStartedAt);

    const previous = this.session;
    this.tokenizer = tokenizer;
    this.session = session;
    this.dim = dim;
    this.modelPath = modelPath;
    this.tokenizerPath = tokenizerPath;
    this.maxTokens = maxTokens;
    this.maxBatchSize = maxBatchSize;
    this.maxBatchTokens = maxBatchTokens;
    this.counters.inits += 1;
    await releaseQuietly(previous);

    await this.send({
      type: "result",
      id: request.id,
      result: { dim, runtime: this.runtimeName, maxTokens, warmupMs },
    } satisfies EmbeddingWorkerResultFrame<EmbeddingWorkerInitResult>);
  }

  private async handleEmbed(
    request: Extract<EmbeddingWorkerRequest, { type: "embed" }>,
  ): Promise<void> {
    if (this.session === null || this.tokenizer === null || this.dim === null) {
      throw new WorkerRequestError(
        "not-initialized",
        "The worker is not initialized; send init before embed.",
      );
    }
    const session = this.session;
    const tokenizer = this.tokenizer;
    const dim = this.dim;
    const texts = requireEmbedTexts(request.texts);
    const startedAt = this.now();
    this.activeEmbedId = request.id;
    this.cancelRequested = false;
    const vectors: (string | null)[] = texts.map(() => null);
    let cancelled = false;
    let tokensRun = 0;
    let batchesRun = 0;
    let sequenceOffset = 0;
    try {
      const tokenized = texts.map((text) =>
        truncateSequence(
          tokenizer.encode(text, { maxTokens: this.maxTokens }),
          this.maxTokens,
        ),
      );
      sumSequenceTokens(tokenized); // rejects a sequence with no tokens
      const batches = planTokenBatches(tokenized, {
        maxBatchSize: this.maxBatchSize,
        maxBatchTokens: this.maxBatchTokens,
      });
      for (const batch of batches) {
        if (this.cancelRequested) {
          cancelled = true;
          break;
        }
        const padded = padTokenBatch(batch, tokenizer.padTokenId ?? 0);
        const output = await session.run(padded);
        if (output.dim !== dim) {
          throw new WorkerRequestError(
            "internal",
            `The model returned ${output.dim} dimensions after reporting ${dim}.`,
          );
        }
        const batchVectors = poolBatch({
          hidden: output.hidden,
          dim,
          ...padded,
        });
        for (let row = 0; row < batchVectors.length; row += 1) {
          const vector = batchVectors[row];
          if (vector !== undefined) {
            vectors[sequenceOffset + row] = encodeVectorBase64(vector);
          }
        }
        sequenceOffset += batchVectors.length;
        tokensRun += padded.tokenTotal;
        batchesRun += 1;
      }
    } finally {
      this.activeEmbedId = null;
      this.cancelRequested = false;
    }
    const elapsedMs = Math.max(0, this.now() - startedAt);
    this.counters.embeds += 1;
    this.counters.texts += texts.length;
    this.counters.tokens += tokensRun;
    this.counters.batches += batchesRun;
    this.counters.totalEmbedMs += elapsedMs;
    this.counters.lastEmbedMs = elapsedMs;
    if (cancelled) this.counters.cancelled += 1;
    await this.send({
      type: "result",
      id: request.id,
      result: {
        vectors,
        dim,
        cancelled,
        texts: texts.length,
        tokens: tokensRun,
        batches: batchesRun,
        elapsedMs,
      },
    } satisfies EmbeddingWorkerResultFrame<EmbeddingWorkerEmbedResult>);
  }

  private async handleStats(
    request: Extract<EmbeddingWorkerRequest, { type: "stats" }>,
  ): Promise<void> {
    const counters = this.counters;
    const stats: EmbeddingWorkerStats = {
      ...counters,
      initialized: this.session !== null && this.tokenizer !== null,
      modelPath: this.modelPath,
      tokenizerPath: this.tokenizerPath,
      runtime: this.runtimeName,
      dim: this.dim,
      maxTokens: this.maxTokens,
      maxBatchSize: this.maxBatchSize,
      maxBatchTokens: this.maxBatchTokens,
      textsPerSecond: rate(counters.texts, counters.totalEmbedMs),
      tokensPerSecond: rate(counters.tokens, counters.totalEmbedMs),
      uptimeMs: Math.max(0, this.now() - this.startedAt),
      queueDepth: this.queue.length,
      pendingRequestId: this.activeEmbedId,
    };
    await this.send({
      type: "result",
      id: request.id,
      result: stats,
    } satisfies EmbeddingWorkerResultFrame<EmbeddingWorkerStats>);
  }

  private async handleShutdown(
    request: Extract<EmbeddingWorkerRequest, { type: "shutdown" }>,
  ): Promise<void> {
    await this.send({
      type: "result",
      id: request.id,
      result: {
        uptimeMs: Math.max(0, this.now() - this.startedAt),
        embeds: this.counters.embeds,
      },
    } satisfies EmbeddingWorkerResultFrame<EmbeddingWorkerShutdownResult>);
    this.stopped = true;
    this.stopResolve?.();
  }
}

/** Run the loop until input closes or `shutdown` arrives (exported for tests). */
export async function runEmbeddingWorker(
  options: EmbeddingWorkerOptions,
): Promise<EmbeddingWorkerRunSummary> {
  const worker = new EmbeddingWorkerState(options);
  const reason = await worker.run();
  return worker.summary(reason);
}

function isEsmRequireError(error: unknown): boolean {
  return (
    isRecord(error) &&
    (error.code === "ERR_REQUIRE_ESM" ||
      (typeof error.message === "string" &&
        error.message.includes("require() of ES Module")))
  );
}

async function importRuntimeModule(
  runtimeDir: string,
  specifier: string,
): Promise<unknown> {
  const nodeRequire = createRequire(join(runtimeDir, "package.json"));
  let resolved: string;
  try {
    resolved = nodeRequire.resolve(specifier, {
      paths: [join(runtimeDir, "node_modules")],
    });
  } catch (error) {
    throw new Error(
      `The embedding runtime package "${specifier}" is not installed under ${runtimeDir}: ${describeError(error)}`,
    );
  }
  try {
    return nodeRequire(resolved);
  } catch (error) {
    if (!isEsmRequireError(error)) throw error;
    return await import(pathToFileURL(resolved).href);
  }
}

interface OnnxSession {
  readonly inputNames?: readonly string[];
  readonly outputNames?: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, unknown>>;
  release?: () => Promise<void>;
}

interface OnnxModule {
  readonly InferenceSession: {
    create(
      modelPath: string,
      options?: Record<string, unknown>,
    ): Promise<OnnxSession>;
  };
  readonly Tensor: new (
    type: string,
    data: BigInt64Array,
    dims: readonly number[],
  ) => unknown;
}

function resolveOnnxModule(loaded: unknown): OnnxModule {
  for (const candidate of [
    loaded,
    isRecord(loaded) ? loaded.default : undefined,
  ]) {
    if (!isRecord(candidate)) continue;
    const inferenceSession = candidate.InferenceSession;
    if (
      isRecord(inferenceSession) &&
      typeof inferenceSession.create === "function" &&
      typeof candidate.Tensor === "function"
    ) {
      return candidate as unknown as OnnxModule;
    }
  }
  throw new Error(
    "The installed onnxruntime-node module does not expose InferenceSession/Tensor.",
  );
}

function toBigInt64(values: Int32Array): BigInt64Array {
  return BigInt64Array.from(values, (value) => BigInt(value));
}

function toFloat32(data: unknown): Float32Array {
  if (data instanceof Float32Array) return data;
  if (Array.isArray(data) || ArrayBuffer.isView(data)) {
    return Float32Array.from(data as unknown as ArrayLike<number>);
  }
  throw new Error("The inference output tensor has no numeric data.");
}

/** Dynamic `onnxruntime-node` loader; C5 decides threads/providers. */ export function createOnnxRuntimeLoader(): EmbeddingRuntimeLoader {
  return async ({ runtimeDir }) => {
    const ort = resolveOnnxModule(
      await importRuntimeModule(runtimeDir, "onnxruntime-node"),
    );
    return {
      async createSession(options): Promise<EmbeddingSession> {
        const session = await ort.InferenceSession.create(options.modelPath, {
          executionProviders: options.executionProviders
            ? [...options.executionProviders]
            : ["cpu"],
          ...(options.intraOpThreads === undefined
            ? {}
            : { intraOpNumThreads: options.intraOpThreads }),
          interOpNumThreads: 1,
          enableCpuMemArena: false,
          enableMemPattern: false,
          logSeverityLevel: 3,
        });
        const [inputIdsName, attentionMaskName] = session.inputNames ?? [];
        if (inputIdsName === undefined || attentionMaskName === undefined) {
          throw new Error(
            "The inference session must expose input_ids and attention_mask.",
          );
        }
        const release = session.release?.bind(session);
        return {
          async run(input): Promise<EmbeddingSessionOutput> {
            const dims = [input.sequences, input.tokens];
            const outputs = await session.run({
              [inputIdsName]: new ort.Tensor(
                "int64",
                toBigInt64(input.inputIds),
                dims,
              ),
              [attentionMaskName]: new ort.Tensor(
                "int64",
                toBigInt64(input.attentionMask),
                dims,
              ),
            });
            const outputName =
              session.outputNames?.[0] ?? Object.keys(outputs)[0];
            const output =
              outputName === undefined ? undefined : outputs[outputName];
            if (!isRecord(output)) {
              throw new Error(
                "The inference session returned no usable output tensor.",
              );
            }
            const tensor = output as unknown as {
              readonly data: unknown;
              readonly dims: unknown;
            };
            const outputDims = Array.isArray(tensor.dims)
              ? tensor.dims.map((value) => Number(value))
              : [];
            if (outputDims.length !== 3) {
              throw new Error(
                `The inference session returned an unsupported output rank: ${outputDims.length}.`,
              );
            }
            return { hidden: toFloat32(tensor.data), dim: outputDims[2] ?? 0 };
          },
          ...(release === undefined ? {} : { release }),
        };
      },
    };
  };
}

/**
 * Dynamic `@huggingface/tokenizers` loader. The API has moved between releases,
 * so the entry point is probed and a mismatch is a typed init error (C8 pins the
 * version with its real-runtime smoke).
 */
export function createHuggingFaceTokenizerLoader(): EmbeddingTokenizerLoader {
  return async ({ runtimeDir, tokenizerPath }) => {
    const loaded = await importRuntimeModule(
      runtimeDir,
      "@huggingface/tokenizers",
    );
    return adaptTokenizer(instantiateTokenizer(loaded, tokenizerPath));
  };
}

function instantiateTokenizer(loaded: unknown, tokenizerPath: string): unknown {
  for (const candidate of [
    loaded,
    isRecord(loaded) ? loaded.default : undefined,
  ]) {
    const fromFile = isRecord(candidate) ? candidate.fromFile : undefined;
    if (typeof fromFile === "function") {
      return (fromFile as (this: unknown, path: string) => unknown).call(
        candidate,
        tokenizerPath,
      );
    }
    if (typeof candidate !== "function") continue;
    try {
      return new (candidate as new (path: string) => unknown)(tokenizerPath);
    } catch {}
  }
  throw new Error(
    "The installed @huggingface/tokenizers exposes no loadable entry point.",
  );
}

function adaptTokenizer(instance: unknown): EmbeddingTokenizer {
  const record = isRecord(instance) ? instance : null;
  if (record === null || typeof record.encode !== "function") {
    throw new Error(
      "The installed @huggingface/tokenizers does not expose encode().",
    );
  }
  const encode = (
    record.encode as (this: unknown, text: string) => unknown
  ).bind(record);
  const padTokenId = record.padTokenId ?? record.pad_token_id;
  return {
    encode(text, options) {
      const encoded = encode(text);
      if (encoded instanceof Promise) {
        throw new Error(
          "This tokenizer only offers asynchronous encode(); the worker requires a synchronous one.",
        );
      }
      const sequence = normalizeTokenizedSequence(encoded);
      return options?.maxTokens === undefined
        ? sequence
        : truncateSequence(sequence, options.maxTokens);
    },
    ...(typeof padTokenId === "number" ? { padTokenId } : {}),
  };
}

function toNumberArray(value: unknown, label: string): number[] {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) {
    throw new Error(`Tokenizer field ${label} is not a numeric array.`);
  }
  const view = value as ArrayLike<number | bigint>;
  const numbers: number[] = [];
  for (let index = 0; index < view.length; index += 1) {
    const numeric = Number(view[index]);
    if (!Number.isFinite(numeric)) {
      throw new Error(`Tokenizer field ${label} contains a non-finite id.`);
    }
    numbers.push(numeric);
  }
  return numbers;
}

function readSequenceField(
  record: Record<string, unknown>,
  keys: readonly string[],
  methods: readonly string[],
): number[] | null {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null) return toNumberArray(value, key);
  }
  for (const method of methods) {
    const value = record[method];
    if (typeof value !== "function") continue;
    const produced = (value as (this: unknown) => unknown).call(record);
    if (produced !== undefined && produced !== null) {
      return toNumberArray(produced, method);
    }
  }
  return null;
}

function normalizeTokenizedSequence(raw: unknown): TokenizedSequence {
  if (Array.isArray(raw) || ArrayBuffer.isView(raw)) {
    const inputIds = toNumberArray(raw, "input_ids");
    if (inputIds.length === 0)
      throw new Error("The tokenizer produced no tokens.");
    return { inputIds };
  }
  if (!isRecord(raw)) {
    throw new Error("The tokenizer returned an unexpected encoding shape.");
  }
  const inputIds = readSequenceField(
    raw,
    ["input_ids", "ids"],
    ["getIds", "get_ids"],
  );
  if (inputIds === null || inputIds.length === 0) {
    throw new Error("The tokenizer encoding has no input_ids.");
  }
  const attentionMask = readSequenceField(
    raw,
    ["attention_mask", "attentionMask"],
    ["getAttentionMask", "get_attention_mask"],
  );
  return attentionMask === null ? { inputIds } : { inputIds, attentionMask };
}

/** True when this file is the process entry point (tests import, not run, it). */
export function isEmbeddingWorkerMain(
  moduleUrl: string,
  entryPath: string | undefined,
  platform: string = process.platform,
): boolean {
  if (entryPath === undefined || entryPath.length === 0) return false;
  let modulePath: string;
  try {
    modulePath = fileURLToPath(moduleUrl);
  } catch {
    return false;
  }
  const normalize = (value: string): string =>
    platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
  return normalize(modulePath) === normalize(entryPath);
}

/**
 * Real entry point: stdin into the loop, frames to stdout. The loop returns on
 * `shutdown` or end of input; stdin is then destroyed and the process exits 0.
 * A thrown error exits 1, which the client/C7 watchdog reports as a crash.
 */
async function main(): Promise<void> {
  await runEmbeddingWorker({
    input: process.stdin,
    output: {
      writeLine: (line: string): Promise<void> =>
        new Promise<void>((resolveWrite) => {
          process.stdout.write(line, () => resolveWrite());
        }),
    },
    pid: process.pid,
    runtimeName: process.versions.bun ? "bun" : "node",
  });
  process.stdin.destroy();
  process.exit(0);
}

if (isEmbeddingWorkerMain(import.meta.url, process.argv[1])) {
  void main().catch((error: unknown) => {
    try {
      process.stderr.write(
        `embedding worker failed: ${describeError(error)}\n`,
      );
    } catch {}
    process.exitCode = 1;
  });
}
