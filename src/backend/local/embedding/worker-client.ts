/**
 * Main-process client for the embedding worker (C3), and the seam C7 builds the
 * watchdog/restart policy on.
 *
 * **Why a child process at all.** See `worker-entry.ts`: the native runtime must
 * not be loaded in the TUI process (48-1 §5.4). This module is the only place
 * that knows how to launch it. The command is always `process.execPath` and the
 * script path is supplied by the caller — under Bun (source checkout) that is
 * `worker-entry.ts`, under Node (published bundle) it is the built
 * `embedding-worker.js`. Nothing here imports the worker module at runtime, so
 * the main process keeps zero native dependencies; the worker's response types
 * are imported with `import type` only.
 *
 * **Framing.** JSON Lines each way: one JSON object per line, request ids
 * correlate replies. The reader joins arbitrarily split chunks (including a
 * multi-byte UTF-8 character split across two chunks) and rejects a frame that
 * is not a well-formed ready/result/error frame. A malformed stream is treated
 * as a worker crash: pending requests fail and the process is killed, because
 * continuing after a desync means guessing which request a reply belongs to.
 *
 * **Failure semantics.** Every pending request is rejected exactly once, with a
 * typed `EmbeddingWorkerClientError`:
 * - `spawn-failed` / `handshake-timeout` — the worker never got to `ready`;
 * - `exited` — the worker died (message carries the exit code/signal and its
 *   stderr tail); this is the signal C7 restarts on;
 * - `request-timeout` — a reply never arrived (the request may still be
 *   executing; the caller decides whether to kill);
 * - `worker-error` — the worker answered with an error frame (its `workerCode`
 *   is preserved);
 * - `protocol`, `not-running`, `disposed`, `aborted`.
 *
 * **Injection.** `spawn` is injectable so failure paths (spawn error, silent
 * worker, handshake timeout) are deterministic in tests without relying on a
 * child's timing. The happy paths use a real fake worker script spawned via
 * `process.execPath`, so framing and exit handling are exercised for real.
 *
 * Layer: `backend/local/`. Imports `node:` builtins, `./featurize` and
 * `./worker-entry` types; no `cli/`, `websocket/`, `reminders/` or `agent/`.
 */

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { decodeVectorBase64 } from "./featurize";
import {
  EMBEDDING_WORKER_PROTOCOL_VERSION,
  type EmbeddingWorkerCancelResult,
  type EmbeddingWorkerEmbedResult,
  type EmbeddingWorkerErrorCode,
  type EmbeddingWorkerErrorFrame,
  type EmbeddingWorkerFrame,
  type EmbeddingWorkerInitOptions,
  type EmbeddingWorkerInitResult,
  type EmbeddingWorkerReadyFrame,
  type EmbeddingWorkerRequestType,
  type EmbeddingWorkerShutdownResult,
  type EmbeddingWorkerStats,
  parseEmbeddingWorkerFrame,
} from "./worker-protocol";

/** Default time allowed for the `ready` handshake (native load happens after). */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;

/** Default time allowed for `init` (first load can take >30 s on m3 models). */
export const DEFAULT_INIT_TIMEOUT_MS = 120_000;

/** Default time allowed for one `embed` request. */
export const DEFAULT_EMBED_TIMEOUT_MS = 120_000;

/** Default time allowed for cancel/stats/shutdown replies. */
export const DEFAULT_CONTROL_TIMEOUT_MS = 10_000;

/** Grace before a SIGKILL after SIGTERM during shutdown. */
export const DEFAULT_KILL_GRACE_MS = 2_000;

/** Upper bound on one inbound frame, in characters. */
const MAX_FRAME_CHARS = 8 * 1024 * 1024;

/** How much worker stderr is retained for error messages. */
const MAX_STDERR_CHARS = 8_192;

/** How the process ended. `error` is set when the spawn itself failed. */
export interface EmbeddingWorkerExit {
  readonly code: number | null;
  readonly signal: string | null;
  readonly error?: Error;
}

/**
 * Minimal normalized handle over a spawned child. The default implementation
 * wraps `node:child_process`; tests may inject any object with the same shape.
 */
export interface EmbeddingWorkerProcessHandle {
  readonly pid: number | undefined;
  readonly stdout: AsyncIterable<string | Uint8Array>;
  readonly stderr: AsyncIterable<string | Uint8Array>;
  write(line: string): void;
  kill(signal?: "SIGTERM" | "SIGKILL"): void;
  readonly exited: Promise<EmbeddingWorkerExit>;
}

/** Environment/working directory for the spawned worker. */
export interface EmbeddingWorkerSpawnOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
}

/** Injectable process spawner (`process.execPath` + worker path by default). */
export type EmbeddingWorkerSpawner = (
  command: string,
  args: readonly string[],
  options: EmbeddingWorkerSpawnOptions,
) => EmbeddingWorkerProcessHandle;

/** Why a client call failed. */
export type EmbeddingWorkerClientErrorCode =
  | "aborted"
  | "disposed"
  | "exited"
  | "handshake-timeout"
  | "invalid-argument"
  | "not-running"
  | "protocol"
  | "request-timeout"
  | "spawn-failed"
  | "worker-error";

/** Typed client failure; `code` is stable API. */
export class EmbeddingWorkerClientError extends Error {
  readonly code: EmbeddingWorkerClientErrorCode;
  /** The worker's own error code, for `code === "worker-error"`. */
  readonly workerCode: EmbeddingWorkerErrorCode | undefined;
  /** Exit details, for `code === "exited"`. */
  readonly exit: EmbeddingWorkerExit | undefined;
  /** Request id the failure belongs to, when known. */
  readonly requestId: number | undefined;

  constructor(
    code: EmbeddingWorkerClientErrorCode,
    message: string,
    options: {
      workerCode?: EmbeddingWorkerErrorCode;
      exit?: EmbeddingWorkerExit;
      requestId?: number;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "EmbeddingWorkerClientError";
    this.code = code;
    this.workerCode = options.workerCode;
    this.exit = options.exit;
    this.requestId = options.requestId;
  }
}

/** Options for {@link EmbeddingWorkerClient}. */
export interface EmbeddingWorkerClientOptions {
  /** Path of the worker script (source `.ts` or bundled `.js`). */
  readonly workerPath: string;
  /** Extra argv entries after the worker path. */
  readonly args?: readonly string[];
  /** Override the executable; defaults to `process.execPath`. */
  readonly execPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly spawn?: EmbeddingWorkerSpawner;
  readonly handshakeTimeoutMs?: number;
  readonly initTimeoutMs?: number;
  readonly embedTimeoutMs?: number;
  readonly controlTimeoutMs?: number;
  readonly killGraceMs?: number;
  readonly protocolVersion?: number;
}

export interface EmbeddingWorkerEmbedOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

/** A decoded embed reply: vectors are `null` where cancellation stopped work. */
export interface EmbeddingWorkerEmbedOutput {
  readonly vectors: readonly (Float32Array | null)[];
  readonly dim: number;
  readonly cancelled: boolean;
  readonly texts: number;
  readonly tokens: number;
  readonly batches: number;
  readonly elapsedMs: number;
}

/** Options for {@link EmbeddingWorkerClient.embedBatched}. */
export interface EmbeddingWorkerEmbedBatchedOptions
  extends EmbeddingWorkerEmbedOptions {
  /** Texts per request (the worker sub-batches further by token budget). */
  readonly batchSize?: number;
  /** Called after each request with the number of completed texts. */
  readonly onProgress?: (completed: number, total: number) => void;
}

interface PendingRequest {
  readonly id: number;
  readonly type: EmbeddingWorkerRequestType;
  resolve(value: unknown): void;
  reject(error: Error): void;
  cleanup(): void;
}

function abortError(requestId?: number): EmbeddingWorkerClientError {
  return new EmbeddingWorkerClientError(
    "aborted",
    "The embedding request was aborted.",
    { requestId },
  );
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * Spawn the worker via `process.execPath`. Kept exported (rather than hidden)
 * so C7 can reuse the exact same process shape for its own diagnostics, and so
 * tests can assert the default handle's error handling.
 */
export function spawnEmbeddingWorkerProcess(
  command: string,
  args: readonly string[],
  options: EmbeddingWorkerSpawnOptions,
): EmbeddingWorkerProcessHandle {
  const child = spawn(command, [...args], {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  });
  const stdout = child.stdout;
  const stderr = child.stderr;
  const stdin = child.stdin;
  if (stdout === null || stderr === null || stdin === null) {
    throw new Error("The embedding worker was spawned without piped stdio.");
  }
  let stdinError: Error | null = null;
  stdin.on("error", (error: Error) => {
    stdinError = error;
  });
  const exited = new Promise<EmbeddingWorkerExit>((resolveExit) => {
    let settled = false;
    const settle = (value: EmbeddingWorkerExit): void => {
      if (settled) return;
      settled = true;
      resolveExit(value);
    };
    child.on("exit", (code, signal) => {
      settle({ code, signal: signal ?? null });
    });
    child.on("error", (error) => {
      settle({ code: null, signal: null, error });
    });
  });
  return {
    pid: child.pid,
    stdout,
    stderr,
    write(line: string): void {
      if (stdinError !== null) throw stdinError;
      stdin.write(line);
    },
    kill(signal: "SIGTERM" | "SIGKILL" = "SIGKILL"): void {
      try {
        child.kill(signal);
      } catch {
        // The process may already be gone; the exit promise is the truth.
      }
    },
    exited,
  };
}

/**
 * Main-process side of the JSON Lines protocol. One client owns one worker
 * process; creating a new client is the restart primitive (C7).
 */
export class EmbeddingWorkerClient {
  private readonly workerPath: string;
  private readonly args: readonly string[];
  private readonly execPath: string;
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly cwd: string | undefined;
  private readonly spawnWorker: EmbeddingWorkerSpawner;
  private readonly handshakeTimeoutMs: number;
  private readonly initTimeoutMs: number;
  private readonly embedTimeoutMs: number;
  private readonly controlTimeoutMs: number;
  private readonly killGraceMs: number;
  private readonly protocolVersion: number;

  private child: EmbeddingWorkerProcessHandle | null = null;
  private state: "idle" | "starting" | "ready" | "stopped" = "idle";
  private startPromise: Promise<EmbeddingWorkerReadyFrame> | null = null;
  private readyFrame: EmbeddingWorkerReadyFrame | null = null;
  private readyWaiter: {
    resolve(frame: EmbeddingWorkerReadyFrame): void;
    reject(error: Error): void;
  } | null = null;

  private readonly pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;
  private readonly decoder = new StringDecoder("utf8");
  private stdoutBuffer = "";
  private stderrBuffer = "";

  private exitInfo: EmbeddingWorkerExit | null = null;
  private readonly exitWaiters = new Set<(exit: EmbeddingWorkerExit) => void>();
  private readonly exitListeners = new Set<
    (exit: EmbeddingWorkerExit) => void
  >();
  private exitHandled = false;
  private disposed = false;
  private lastProtocolError: string | null = null;
  private lastWorkerError: EmbeddingWorkerErrorFrame["error"] | null = null;

  constructor(options: EmbeddingWorkerClientOptions) {
    this.workerPath = options.workerPath;
    this.args = options.args ?? [];
    this.execPath = options.execPath ?? process.execPath;
    this.env = options.env;
    this.cwd = options.cwd;
    this.spawnWorker = options.spawn ?? spawnEmbeddingWorkerProcess;
    this.handshakeTimeoutMs =
      options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.initTimeoutMs = options.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
    this.embedTimeoutMs = options.embedTimeoutMs ?? DEFAULT_EMBED_TIMEOUT_MS;
    this.controlTimeoutMs =
      options.controlTimeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS;
    this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.protocolVersion =
      options.protocolVersion ?? EMBEDDING_WORKER_PROTOCOL_VERSION;
  }

  /** OS pid once spawned (also useful for orphan detection). */
  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** True between a successful handshake and process exit. */
  get isRunning(): boolean {
    return this.state === "ready";
  }

  /** The handshake frame, once `start()` has resolved. */
  get ready(): EmbeddingWorkerReadyFrame | null {
    return this.readyFrame;
  }

  /** Last malformed-frame error, for diagnostics. */
  get protocolError(): string | null {
    return this.lastProtocolError;
  }

  /** Last id-less worker error frame, for diagnostics. */
  get workerError(): EmbeddingWorkerErrorFrame["error"] | null {
    return this.lastWorkerError;
  }

  get exit(): EmbeddingWorkerExit | null {
    return this.exitInfo;
  }

  /** Tail of the worker's stderr (diagnostics only; never credentials). */
  stderrTail(limit = MAX_STDERR_CHARS): string {
    return this.stderrBuffer.slice(-limit).trim();
  }

  /** Subscribe to process exit; returns an unsubscribe function. */
  onExit(listener: (exit: EmbeddingWorkerExit) => void): () => void {
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  /**
   * Spawn the worker and wait for its `ready` frame. Idempotent: concurrent or
   * repeated calls share one attempt. A failed start leaves the client stopped;
   * the caller creates a new client to retry.
   */
  start(): Promise<EmbeddingWorkerReadyFrame> {
    if (this.readyFrame !== null) return Promise.resolve(this.readyFrame);
    if (this.startPromise === null)
      this.startPromise = this.spawnAndHandshake();
    return this.startPromise;
  }

  /** Load the runtime/tokenizer and create the session (may take >30 s). */
  async init(
    options: EmbeddingWorkerInitOptions,
    timeoutMs = this.initTimeoutMs,
  ): Promise<EmbeddingWorkerInitResult> {
    return await this.request<EmbeddingWorkerInitResult>(
      "init",
      { ...options },
      timeoutMs,
    );
  }

  /**
   * Embed one or more texts in a single request. `null` entries in the result
   * mean cancellation stopped the worker before reaching them.
   */
  async embed(
    texts: readonly string[],
    options: EmbeddingWorkerEmbedOptions = {},
  ): Promise<EmbeddingWorkerEmbedOutput> {
    const { id, promise } = this.enqueueRequest<EmbeddingWorkerEmbedResult>(
      "embed",
      { texts: [...texts] },
      options.timeoutMs ?? this.embedTimeoutMs,
      options.signal,
    );
    const signal = options.signal;
    const onAbort = (): void => {
      void this.cancel({ requestId: id }).catch(() => {
        // The worker may already be gone; the request is rejected regardless.
      });
    };
    if (signal !== undefined) {
      signal.addEventListener("abort", onAbort, { once: true });
      promise
        .finally(() => {
          signal.removeEventListener("abort", onAbort);
        })
        .catch(() => {
          // The rejection is surfaced through `promise` itself.
        });
    }
    const result = await promise;
    return this.decodeEmbedResult(result);
  }

  /** Convenience wrapper: one text, one vector (or `null` when cancelled). */
  async embedOne(
    text: string,
    options: EmbeddingWorkerEmbedOptions = {},
  ): Promise<Float32Array | null> {
    const result = await this.embed([text], options);
    return result.vectors[0] ?? null;
  }

  /**
   * Client-side chunking for large batches. Each chunk is its own request (so
   * each chunk is one cancellation unit); chunks run sequentially, and the
   * first `cancelled` chunk stops the loop. Already-computed vectors are kept.
   */
  async embedBatched(
    texts: readonly string[],
    options: EmbeddingWorkerEmbedBatchedOptions = {},
  ): Promise<EmbeddingWorkerEmbedOutput> {
    const batchSize = options.batchSize ?? 32;
    if (!isPositiveInteger(batchSize)) {
      throw new EmbeddingWorkerClientError(
        "invalid-argument",
        `batchSize must be a positive integer, received ${String(batchSize)}.`,
      );
    }
    const vectors: (Float32Array | null)[] = [];
    let dim = 0;
    let cancelled = false;
    let tokens = 0;
    let batches = 0;
    let elapsedMs = 0;
    let completed = 0;
    for (let start = 0; start < texts.length; start += batchSize) {
      if (options.signal?.aborted === true) throw abortError();
      const chunk = texts.slice(start, start + batchSize);
      const result = await this.embed(chunk, options);
      dim = result.dim;
      tokens += result.tokens;
      batches += result.batches;
      elapsedMs += result.elapsedMs;
      vectors.push(...result.vectors);
      completed += chunk.length;
      options.onProgress?.(completed, texts.length);
      if (result.cancelled) {
        cancelled = true;
        break;
      }
    }
    return {
      vectors,
      dim,
      cancelled,
      texts: completed,
      tokens,
      batches,
      elapsedMs,
    };
  }

  /** Ask the worker to stop at the next batch boundary. */
  async cancel(
    options: { requestId?: number; timeoutMs?: number } = {},
  ): Promise<EmbeddingWorkerCancelResult> {
    return await this.request<EmbeddingWorkerCancelResult>(
      "cancel",
      options.requestId === undefined ? {} : { requestId: options.requestId },
      options.timeoutMs ?? this.controlTimeoutMs,
    );
  }

  /** Counters/throughput for calibration and the status surface. */
  async stats(
    timeoutMs = this.controlTimeoutMs,
  ): Promise<EmbeddingWorkerStats> {
    return await this.request<EmbeddingWorkerStats>("stats", {}, timeoutMs);
  }

  /**
   * Graceful shutdown: ask for a `shutdown` result, wait for exit, and SIGKILL
   * only if the process outlives the grace window. Safe to call twice and after
   * the process already exited.
   */
  async shutdown(options: { timeoutMs?: number } = {}): Promise<void> {
    if (this.child === null || this.exitInfo !== null) {
      this.state = "stopped";
      return;
    }
    const timeoutMs = options.timeoutMs ?? this.controlTimeoutMs;
    try {
      await this.request<EmbeddingWorkerShutdownResult>(
        "shutdown",
        {},
        timeoutMs,
      );
    } catch {
      // An exiting worker may close stdout before its reply is read.
    }
    const exit = await this.waitForExit(timeoutMs + this.killGraceMs);
    if (exit === null) {
      this.kill("SIGKILL");
      await this.waitForExit(this.killGraceMs);
    }
  }

  /** Send SIGTERM/SIGKILL (C7 restart policy owns when to call this). */
  kill(signal: "SIGTERM" | "SIGKILL" = "SIGKILL"): void {
    this.child?.kill(signal);
  }

  /** Reject everything pending, kill the process, and stop accepting requests. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const error = new EmbeddingWorkerClientError(
      "disposed",
      "The embedding worker client was disposed.",
    );
    this.rejectAllPending(error);
    if (this.exitInfo === null) this.kill("SIGKILL");
    this.state = "stopped";
  }

  /** Resolves with exit details, or `null` when the timeout expires first. */
  waitForExit(timeoutMs: number): Promise<EmbeddingWorkerExit | null> {
    if (this.exitInfo !== null) return Promise.resolve(this.exitInfo);
    return new Promise<EmbeddingWorkerExit | null>((resolveExit) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const waiter = (exit: EmbeddingWorkerExit): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        resolveExit(exit);
      };
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.exitWaiters.delete(waiter);
        resolveExit(null);
      }, timeoutMs);
      this.exitWaiters.add(waiter);
    });
  }

  private async spawnAndHandshake(): Promise<EmbeddingWorkerReadyFrame> {
    if (this.disposed) {
      throw new EmbeddingWorkerClientError(
        "disposed",
        "The embedding worker client was disposed.",
      );
    }
    this.state = "starting";
    let child: EmbeddingWorkerProcessHandle;
    try {
      child = this.spawnWorker(this.execPath, [this.workerPath, ...this.args], {
        ...(this.env === undefined ? {} : { env: this.env }),
        ...(this.cwd === undefined ? {} : { cwd: this.cwd }),
      });
    } catch (error) {
      this.state = "stopped";
      throw new EmbeddingWorkerClientError(
        "spawn-failed",
        `Could not spawn the embedding worker: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    this.child = child;
    void this.pumpStdout(child);
    void this.pumpStderr(child);
    void child.exited
      .then((exit) => this.handleExit(exit))
      .catch(() => this.handleExit({ code: null, signal: null }));

    const handshake = new Promise<EmbeddingWorkerReadyFrame>(
      (resolveReady, rejectReady) => {
        this.readyWaiter = { resolve: resolveReady, reject: rejectReady };
      },
    );
    const timer = setTimeout(() => {
      this.failHandshake(
        new EmbeddingWorkerClientError(
          "handshake-timeout",
          `The embedding worker did not report ready within ${this.handshakeTimeoutMs} ms.`,
        ),
      );
      this.kill("SIGKILL");
    }, this.handshakeTimeoutMs);
    try {
      return await handshake;
    } catch (error) {
      this.state = "stopped";
      throw error;
    } finally {
      clearTimeout(timer);
      this.readyWaiter = null;
    }
  }

  private failHandshake(error: Error): void {
    const waiter = this.readyWaiter;
    if (waiter === null) return;
    this.readyWaiter = null;
    waiter.reject(error);
  }

  private handleReady(frame: EmbeddingWorkerReadyFrame): void {
    if (this.readyFrame !== null) return;
    if (frame.protocol !== this.protocolVersion) {
      this.failProtocol(
        `The embedding worker speaks protocol ${frame.protocol}, expected ${this.protocolVersion}.`,
      );
      return;
    }
    this.readyFrame = frame;
    this.state = "ready";
    const waiter = this.readyWaiter;
    this.readyWaiter = null;
    waiter?.resolve(frame);
  }

  private async pumpStdout(child: EmbeddingWorkerProcessHandle): Promise<void> {
    try {
      for await (const chunk of child.stdout) {
        this.stdoutBuffer +=
          typeof chunk === "string"
            ? chunk
            : this.decoder.write(Buffer.from(chunk));
        this.consumeStdoutLines();
      }
    } catch {
      // The stream ends when the process dies; exit handling is authoritative.
    }
  }

  private async pumpStderr(child: EmbeddingWorkerProcessHandle): Promise<void> {
    try {
      for await (const chunk of child.stderr) {
        const text =
          typeof chunk === "string"
            ? chunk
            : this.decoder.write(Buffer.from(chunk));
        this.stderrBuffer = `${this.stderrBuffer}${text}`.slice(
          -MAX_STDERR_CHARS,
        );
      }
    } catch {
      // Diagnostics only.
    }
  }

  private consumeStdoutLines(): void {
    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      newline = this.stdoutBuffer.indexOf("\n");
      if (line.trim().length > 0) this.handleLine(line);
    }
    if (this.stdoutBuffer.length > MAX_FRAME_CHARS) {
      this.failProtocol(
        `The embedding worker emitted a frame longer than ${MAX_FRAME_CHARS} characters.`,
      );
    }
  }

  private handleLine(line: string): void {
    let frame: EmbeddingWorkerFrame;
    try {
      frame = parseEmbeddingWorkerFrame(line);
    } catch (error) {
      this.failProtocol(error instanceof Error ? error.message : String(error));
      return;
    }
    switch (frame.type) {
      case "ready":
        this.handleReady(frame);
        return;
      case "result":
        this.settleResult(frame.id, frame.result);
        return;
      case "error":
        this.settleError(frame);
        return;
    }
  }

  private settleResult(id: number, result: unknown): void {
    const pending = this.pending.get(id);
    if (pending === undefined) return; // Late reply for an abandoned request.
    this.pending.delete(id);
    pending.cleanup();
    pending.resolve(result);
  }

  private settleError(frame: EmbeddingWorkerErrorFrame): void {
    this.lastWorkerError = frame.error;
    if (frame.id === null) return;
    const pending = this.pending.get(frame.id);
    if (pending === undefined) return;
    this.pending.delete(frame.id);
    pending.cleanup();
    pending.reject(
      new EmbeddingWorkerClientError("worker-error", frame.error.message, {
        workerCode: frame.error.code,
        requestId: frame.id,
      }),
    );
  }

  /** A desynced stream cannot be resynchronized: fail everything and kill. */
  private failProtocol(message: string): void {
    if (this.lastProtocolError !== null) return;
    this.lastProtocolError = message;
    const error = new EmbeddingWorkerClientError("protocol", message);
    this.failHandshake(error);
    this.rejectAllPending(error);
    this.kill("SIGKILL");
  }

  private handleExit(exit: EmbeddingWorkerExit): void {
    if (this.exitHandled) return;
    this.exitHandled = true;
    this.exitInfo = exit;
    this.state = "stopped";
    const details = describeExit(exit);
    const stderr = this.stderrTail(2_048);
    const message = stderr.length > 0 ? `${details}\n${stderr}` : details;
    this.failHandshake(
      new EmbeddingWorkerClientError(
        exit.error === undefined ? "exited" : "spawn-failed",
        `The embedding worker ${exit.error === undefined ? "exited" : "failed to start"}: ${message}`,
        { exit, ...(exit.error === undefined ? {} : { cause: exit.error }) },
      ),
    );
    this.rejectAllPending(
      new EmbeddingWorkerClientError(
        "exited",
        `The embedding worker exited before answering: ${message}`,
        { exit },
      ),
    );
    for (const waiter of [...this.exitWaiters]) waiter(exit);
    this.exitWaiters.clear();
    for (const listener of [...this.exitListeners]) {
      try {
        listener(exit);
      } catch {
        // A listener must not break cleanup for the others.
      }
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of [...this.pending]) {
      this.pending.delete(id);
      pending.cleanup();
      pending.reject(error);
    }
  }

  private enqueueRequest<TResult>(
    type: EmbeddingWorkerRequestType,
    payload: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): { id: number; promise: Promise<TResult> } {
    if (this.state !== "ready" || this.child === null) {
      return {
        id: 0,
        promise: Promise.reject(
          new EmbeddingWorkerClientError(
            "not-running",
            `The embedding worker is not running (state: ${this.state}).`,
          ),
        ),
      };
    }
    const child = this.child;
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const promise = new Promise<TResult>((resolveValue, rejectValue) => {
      let settled = false;
      let onAbort: () => void = () => {};
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const entry: PendingRequest = {
        id,
        type,
        resolve: (value) => {
          finish();
          resolveValue(value as TResult);
        },
        reject: (error) => {
          finish();
          rejectValue(error);
        },
        cleanup: finish,
      };
      onAbort = (): void => {
        if (!this.pending.delete(id)) return;
        entry.reject(abortError(id));
      };
      timer = setTimeout(
        () => {
          if (!this.pending.delete(id)) return;
          entry.reject(
            new EmbeddingWorkerClientError(
              "request-timeout",
              `The embedding worker did not answer ${type} request ${id} within ${timeoutMs} ms.`,
              { requestId: id },
            ),
          );
        },
        Math.max(1, timeoutMs),
      );
      this.pending.set(id, entry);
      if (signal !== undefined) {
        if (signal.aborted) {
          this.pending.delete(id);
          entry.reject(abortError(id));
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
      try {
        child.write(`${JSON.stringify({ type, id, ...payload })}\n`);
      } catch (error) {
        if (this.pending.delete(id)) {
          entry.reject(
            new EmbeddingWorkerClientError(
              "not-running",
              `Could not write to the embedding worker: ${
                error instanceof Error ? error.message : String(error)
              }`,
              { cause: error, requestId: id },
            ),
          );
        }
      }
    });
    return { id, promise };
  }

  private async request<TResult>(
    type: EmbeddingWorkerRequestType,
    payload: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<TResult> {
    return await this.enqueueRequest<TResult>(type, payload, timeoutMs).promise;
  }

  private decodeEmbedResult(
    result: EmbeddingWorkerEmbedResult,
  ): EmbeddingWorkerEmbedOutput {
    if (
      typeof result !== "object" ||
      result === null ||
      !isPositiveInteger(result.dim) ||
      !Array.isArray(result.vectors) ||
      typeof result.cancelled !== "boolean"
    ) {
      throw new EmbeddingWorkerClientError(
        "protocol",
        "The embedding worker returned a malformed embed result.",
      );
    }
    const vectors: (Float32Array | null)[] = [];
    for (let index = 0; index < result.vectors.length; index += 1) {
      const entry = result.vectors[index];
      if (entry === null || entry === undefined) {
        vectors.push(null);
        continue;
      }
      try {
        vectors.push(decodeVectorBase64(entry, result.dim));
      } catch (error) {
        throw new EmbeddingWorkerClientError(
          "protocol",
          `The embedding worker returned a malformed vector at index ${index}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error },
        );
      }
    }
    return {
      vectors,
      dim: result.dim,
      cancelled: result.cancelled,
      texts: typeof result.texts === "number" ? result.texts : vectors.length,
      tokens: typeof result.tokens === "number" ? result.tokens : 0,
      batches: typeof result.batches === "number" ? result.batches : 0,
      elapsedMs: typeof result.elapsedMs === "number" ? result.elapsedMs : 0,
    };
  }
}

function describeExit(exit: EmbeddingWorkerExit): string {
  if (exit.error !== undefined) return exit.error.message;
  if (exit.signal !== null) return `was killed by ${exit.signal}`;
  return `exited with code ${String(exit.code)}`;
}
