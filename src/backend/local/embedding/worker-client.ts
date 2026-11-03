/**
 * Main-process client for the embedding worker (C3), and the seam C7's
 * watchdog/restart policy is built on.
 *
 * **Why a child process at all.** See `worker-entry.ts`: the native runtime must
 * not be loaded in the TUI process (48-1 §5.4). This module is the only place
 * that knows how to launch it. The command is always `process.execPath` and the
 * script path is supplied by the caller — `worker-entry-path.ts` owns the
 * bundled-vs-source rule that picks `embedding-worker.js` (Node package) or
 * `worker-entry.ts` (Bun source). Nothing here imports the worker module at
 * runtime, so the main process keeps zero native dependencies; the worker's
 * response types are imported with `import type` only.
 *
 * **Framing.** JSON Lines each way: one JSON object per line, request ids
 * correlate replies. The reader joins arbitrarily split chunks (including a
 * multi-byte UTF-8 character split across two chunks) and rejects a frame that
 * is not a well-formed ready/result/error frame. A malformed stream is treated
 * as a worker crash: pending requests fail and the process is killed, because
 * continuing after a desync means guessing which request a reply belongs to.
 *
 * **Failure semantics (C7).** Every pending request is rejected exactly once,
 * with a typed `EmbeddingWorkerClientError`:
 * - `spawn-failed` / `handshake-timeout` — the worker never got to `ready`;
 * - `exited` — the worker died (message carries the exit code/signal and its
 *   stderr tail);
 * - `request-timeout` — a reply never arrived (the request may still be
 *   executing; the caller decides whether to kill);
 * - `worker-error` — the worker answered with an error frame (its `workerCode`
 *   is preserved);
 * - `protocol`, `not-running`, `disposed`, `aborted`.
 * `worker-watchdog.ts` classifies each failure (crash vs. terminal), and only a
 * retriable one may consume the bounded restart budget: non-zero exit/crash
 * signal or a handshake timeout, at most twice, with exponential backoff.
 * Shutdown/dispose/public `kill` are intentional stops and never restart.
 *
 * **Timeout tiers.** A first start is cold (antivirus may scan the downloaded
 * runtime), so the first handshake/init use wider windows than a warm restart;
 * `timeouts` exposes the tier in force, and the defaults cover the measured
 * 3.3 s first spawn / 32.4 s m3 first load (48-2 §4.4) without waiting forever.
 *
 * **Injection.** `spawn` is injectable so failure paths (spawn error, silent
 * worker, handshake timeout) are deterministic in tests without relying on a
 * child's timing. The happy paths use a real fake worker script spawned via
 * `process.execPath`, so framing and exit handling are exercised for real.
 *
 * Layer: `backend/local/`. Imports `node:` builtins, `./featurize`,
 * `./worker-protocol`, `./worker-process` and `./worker-watchdog`; no `cli/`,
 * `websocket/`, `reminders/` or `agent/`.
 */

import { StringDecoder } from "node:string_decoder";
import { decodeVectorBase64 } from "./featurize";
import {
  describeEmbeddingWorkerExit,
  type EmbeddingWorkerExit,
  type EmbeddingWorkerProcessHandle,
  type EmbeddingWorkerSpawner,
  spawnEmbeddingWorkerProcess,
} from "./worker-process";
import {
  EMBEDDING_WORKER_PROTOCOL_VERSION,
  type EmbeddingWorkerCancelResult,
  type EmbeddingWorkerEmbedResult,
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
import {
  classifyEmbeddingWorkerFailure,
  DEFAULT_EMBEDDING_WORKER_CONTROL_TIMEOUT_MS,
  DEFAULT_EMBEDDING_WORKER_EMBED_TIMEOUT_MS,
  DEFAULT_EMBEDDING_WORKER_KILL_GRACE_MS,
  EmbeddingWorkerClientError,
  type EmbeddingWorkerFailureClassification,
  type EmbeddingWorkerRestartEvent,
  type EmbeddingWorkerTimeoutTier,
  EmbeddingWorkerWatchdog,
  resolveEmbeddingWorkerTimeoutTier,
} from "./worker-watchdog";

/** Upper bound on one inbound frame, in characters. */
const MAX_FRAME_CHARS = 8 * 1024 * 1024;

/** How much worker stderr is retained for error messages. */
const MAX_STDERR_CHARS = 8_192;

export type * from "./worker-client-types";

import type {
  EmbeddingWorkerCancelOptions,
  EmbeddingWorkerClientOptions,
  EmbeddingWorkerEmbedBatchedOptions,
  EmbeddingWorkerEmbedOptions,
  EmbeddingWorkerEmbedOutput,
} from "./worker-client-types";

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
 * Main-process side of the JSON Lines protocol. One client owns one worker
 * process; the watchdog restarts that process in place (bounded) after a
 * crash, so callers do not need to recreate the client for transient crashes.
 */
export class EmbeddingWorkerClient {
  private readonly workerPath: string;
  private readonly args: readonly string[];
  private readonly execPath: string;
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly cwd: string | undefined;
  private readonly spawnWorker: EmbeddingWorkerSpawner;
  private readonly firstStartTimeouts: EmbeddingWorkerTimeoutTier;
  private readonly steadyTimeouts: EmbeddingWorkerTimeoutTier;
  private readonly embedTimeoutMs: number;
  private readonly controlTimeoutMs: number;
  private readonly killGraceMs: number;
  private readonly protocolVersion: number;
  private readonly watchdog: EmbeddingWorkerWatchdog;

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
  private decoder = new StringDecoder("utf8");
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
  private startFailure: EmbeddingWorkerClientError | null = null;
  private hasInitialized = false;
  private intentionalStop = false;

  constructor(options: EmbeddingWorkerClientOptions) {
    this.workerPath = options.workerPath;
    this.args = options.args ?? [];
    this.execPath = options.execPath ?? process.execPath;
    this.env = options.env;
    this.cwd = options.cwd;
    this.spawnWorker = options.spawn ?? spawnEmbeddingWorkerProcess;
    this.firstStartTimeouts = resolveEmbeddingWorkerTimeoutTier({
      firstStart: true,
      handshakeTimeoutMs: options.handshakeTimeoutMs,
      initTimeoutMs: options.initTimeoutMs,
      firstStartHandshakeTimeoutMs: options.firstStartHandshakeTimeoutMs,
      firstStartInitTimeoutMs: options.firstStartInitTimeoutMs,
    });
    this.steadyTimeouts = resolveEmbeddingWorkerTimeoutTier({
      firstStart: false,
      handshakeTimeoutMs: options.handshakeTimeoutMs,
      initTimeoutMs: options.initTimeoutMs,
      firstStartHandshakeTimeoutMs: options.firstStartHandshakeTimeoutMs,
      firstStartInitTimeoutMs: options.firstStartInitTimeoutMs,
    });
    this.embedTimeoutMs =
      options.embedTimeoutMs ?? DEFAULT_EMBEDDING_WORKER_EMBED_TIMEOUT_MS;
    this.controlTimeoutMs =
      options.controlTimeoutMs ?? DEFAULT_EMBEDDING_WORKER_CONTROL_TIMEOUT_MS;
    this.killGraceMs =
      options.killGraceMs ?? DEFAULT_EMBEDDING_WORKER_KILL_GRACE_MS;
    this.protocolVersion =
      options.protocolVersion ?? EMBEDDING_WORKER_PROTOCOL_VERSION;
    this.watchdog = new EmbeddingWorkerWatchdog({ restart: options.restart });
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

  /** Timeouts the next spawn/init would use; the first start is wider. */
  get timeouts(): EmbeddingWorkerTimeoutTier {
    return this.hasInitialized ? this.steadyTimeouts : this.firstStartTimeouts;
  }

  /** Automatic restarts performed so far (the first spawn is not one). */
  get restartCount(): number {
    return this.watchdog.restartCount;
  }

  /** Typed classification of the last failure the watchdog saw. */
  get lastFailure(): EmbeddingWorkerFailureClassification | null {
    return this.watchdog.lastFailure;
  }

  /** Whether the watchdog may still restart this worker automatically. */
  get canRetry(): boolean {
    return this.watchdog.canRetry;
  }

  /** Pending requests; the crash path must drain this to zero. */
  get pendingRequestCount(): number {
    return this.pending.size;
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

  /** Subscribe to watchdog restart decisions (typed reason + canRetry). */
  onRestart(
    listener: (event: EmbeddingWorkerRestartEvent) => void,
  ): () => void {
    return this.watchdog.onRestart(listener);
  }

  /**
   * Spawn the worker and wait for its `ready` frame. Concurrent calls share one
   * attempt. A failed attempt leaves the client stopped; the watchdog may then
   * schedule a bounded automatic restart, and an explicit call starts a new
   * attempt immediately (the first spawn of a client is not a restart).
   */
  start(): Promise<EmbeddingWorkerReadyFrame> {
    if (this.readyFrame !== null) return Promise.resolve(this.readyFrame);
    if (this.startPromise !== null) return this.startPromise;
    if (this.disposed) {
      return Promise.reject(
        new EmbeddingWorkerClientError(
          "disposed",
          "The embedding worker client was disposed.",
        ),
      );
    }
    this.watchdog.cancel();
    const attempt = this.spawnAndHandshake();
    this.startPromise = attempt;
    attempt
      .finally(() => {
        if (this.startPromise === attempt) this.startPromise = null;
      })
      .catch(() => {
        // The rejection is surfaced through `attempt`; this branch only frees
        // the shared slot so a later explicit/automatic start can retry.
      });
    return attempt;
  }

  /** Load the runtime/tokenizer and create the session (may take >30 s). */
  async init(
    options: EmbeddingWorkerInitOptions,
    timeoutMs?: number,
  ): Promise<EmbeddingWorkerInitResult> {
    const result = await this.request<EmbeddingWorkerInitResult>(
      "init",
      { ...options },
      timeoutMs ?? this.timeouts.initTimeoutMs,
    );
    this.hasInitialized = true;
    return result;
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

  /**
   * Ask the worker to stop at the next batch boundary. When the cancel reply
   * never arrives, C7's fallback reaps the worker (SIGKILL) because a native
   * embed cannot be preempted and a stuck worker must not stay alive.
   */
  async cancel(
    options: EmbeddingWorkerCancelOptions = {},
  ): Promise<EmbeddingWorkerCancelResult> {
    const timeoutMs = options.timeoutMs ?? this.controlTimeoutMs;
    try {
      return await this.request<EmbeddingWorkerCancelResult>(
        "cancel",
        options.requestId === undefined ? {} : { requestId: options.requestId },
        timeoutMs,
      );
    } catch (error) {
      if (
        options.killIfUnresponsive !== false &&
        error instanceof EmbeddingWorkerClientError &&
        (error.code === "request-timeout" || error.code === "not-running")
      ) {
        await this.reapWorker();
      }
      throw error;
    }
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
   * the process already exited. An intentional stop never auto-restarts.
   */
  async shutdown(options: { timeoutMs?: number } = {}): Promise<void> {
    this.intentionalStop = true;
    this.watchdog.cancel();
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
    if (exit !== null) return;
    this.killChild("SIGKILL");
    const killed = await this.waitForExit(this.killGraceMs);
    if (killed === null && this.exitInfo === null) {
      // The process did not report exit after SIGKILL: release every waiter
      // instead of leaving a zombie handle that callers wait on forever.
      this.handleExit({ code: null, signal: "SIGKILL" });
    }
  }

  /** Send SIGTERM/SIGKILL and treat the stop as intentional (no restart). */
  kill(signal: "SIGTERM" | "SIGKILL" = "SIGKILL"): void {
    this.intentionalStop = true;
    this.watchdog.cancel();
    this.killChild(signal);
  }

  /** Reject everything pending, kill the process, and stop accepting requests. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.intentionalStop = true;
    this.watchdog.cancel();
    this.watchdog.dispose();
    const error = new EmbeddingWorkerClientError(
      "disposed",
      "The embedding worker client was disposed.",
    );
    this.rejectAllPending(error);
    if (this.exitInfo === null) this.killChild("SIGKILL");
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
    this.startFailure = null;
    this.intentionalStop = false;
    this.exitHandled = false;
    this.exitInfo = null;
    this.readyFrame = null;
    this.stdoutBuffer = "";
    this.stderrBuffer = "";
    this.decoder = new StringDecoder("utf8");
    this.watchdog.noteSpawn();
    this.state = "starting";
    const timeouts = this.timeouts;
    let child: EmbeddingWorkerProcessHandle;
    try {
      child = this.spawnWorker(this.execPath, [this.workerPath, ...this.args], {
        ...(this.env === undefined ? {} : { env: this.env }),
        ...(this.cwd === undefined ? {} : { cwd: this.cwd }),
      });
    } catch (error) {
      this.state = "stopped";
      const failure = new EmbeddingWorkerClientError(
        "spawn-failed",
        `Could not spawn the embedding worker: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
      this.startFailure = failure;
      this.reportFailure(failure);
      throw failure;
    }
    this.child = child;
    void this.pumpStdout(child);
    void this.pumpStderr(child);
    void child.exited
      .then((exit) => this.handleExit(exit, child))
      .catch(() => this.handleExit({ code: null, signal: null }, child));

    const handshake = new Promise<EmbeddingWorkerReadyFrame>(
      (resolveReady, rejectReady) => {
        this.readyWaiter = { resolve: resolveReady, reject: rejectReady };
      },
    );
    const timer = setTimeout(() => {
      const failure = classifyEmbeddingWorkerFailure("handshake-timeout");
      const error = new EmbeddingWorkerClientError(
        "handshake-timeout",
        `The embedding worker did not report ready within ${timeouts.handshakeTimeoutMs} ms.`,
        {
          reason: failure.reason,
          canRetry: this.watchdog.canRetryFailure(failure),
        },
      );
      this.startFailure = error;
      this.failHandshake(error);
      this.killChild("SIGKILL");
    }, timeouts.handshakeTimeoutMs);
    try {
      return await handshake;
    } catch (error) {
      this.state = "stopped";
      const failure =
        error instanceof EmbeddingWorkerClientError
          ? error
          : new EmbeddingWorkerClientError(
              "handshake-timeout",
              error instanceof Error ? error.message : String(error),
              { cause: error },
            );
      this.reportFailure(failure);
      throw failure;
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
    this.startFailure = null;
    this.state = "ready";
    const waiter = this.readyWaiter;
    this.readyWaiter = null;
    waiter?.resolve(frame);
  }

  private async pumpStdout(child: EmbeddingWorkerProcessHandle): Promise<void> {
    try {
      for await (const chunk of child.stdout) {
        if (this.child !== child) return;
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
        if (this.child !== child) return;
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
        reason: "worker-error",
        canRetry: false,
      }),
    );
  }

  /** A desynced stream cannot be resynchronized: fail everything and kill. */
  private failProtocol(message: string): void {
    if (this.lastProtocolError !== null) return;
    this.lastProtocolError = message;
    const error = new EmbeddingWorkerClientError("protocol", message, {
      reason: "protocol",
      canRetry: false,
    });
    this.startFailure = error;
    this.failHandshake(error);
    this.rejectAllPending(error);
    this.killChild("SIGKILL");
  }

  private handleExit(
    exit: EmbeddingWorkerExit,
    child?: EmbeddingWorkerProcessHandle,
  ): void {
    // A killed/replaced child may report its exit after a restart spawned the
    // next process; that stale exit must not mark the new worker stopped.
    if (child !== undefined && child !== this.child) return;
    if (this.exitHandled) return;
    this.exitHandled = true;
    this.exitInfo = exit;
    this.readyFrame = null;
    this.state = "stopped";
    const startFailure = this.startFailure;
    this.startFailure = null;
    const details = describeEmbeddingWorkerExit(exit);
    const stderr = this.stderrTail(2_048);
    const message = stderr.length > 0 ? `${details}\n${stderr}` : details;
    const code =
      startFailure?.code ??
      (exit.error === undefined ? "exited" : "spawn-failed");
    const failure = classifyEmbeddingWorkerFailure(code, exit);
    const canRetry = this.watchdog.canRetryFailure(failure);
    const failureError = new EmbeddingWorkerClientError(
      exit.error === undefined ? "exited" : "spawn-failed",
      `The embedding worker ${
        exit.error === undefined ? "exited" : "failed to start"
      }: ${message}`,
      {
        exit,
        reason: failure.reason,
        canRetry,
        ...(exit.error === undefined ? {} : { cause: exit.error }),
      },
    );
    this.failHandshake(failureError);
    this.rejectAllPending(
      new EmbeddingWorkerClientError(
        "exited",
        `The embedding worker exited before answering: ${message}`,
        { exit, reason: failure.reason, canRetry },
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
    if (this.disposed || this.intentionalStop) return;
    this.watchdog.reportFailure(failure, failureError, () => {
      this.attemptRestart();
    });
  }

  private reportFailure(error: EmbeddingWorkerClientError): void {
    const failure = classifyEmbeddingWorkerFailure(error.code, error.exit);
    this.watchdog.reportFailure(failure, error, () => {
      this.attemptRestart();
    });
  }

  private attemptRestart(): void {
    if (this.disposed || this.intentionalStop) return;
    void this.start().catch(() => {
      // The failed attempt reports itself; the watchdog either schedules the
      // next bounded restart or stops at the budget.
    });
  }

  /**
   * C7 SIGKILL fallback after an unresponsive cancel: reap the worker and
   * release every waiter even if the process handle never reports exit.
   */
  private async reapWorker(): Promise<void> {
    const child = this.child;
    if (child === null || this.exitInfo !== null) return;
    this.killChild("SIGKILL");
    const exit = await this.waitForExit(this.killGraceMs);
    if (exit === null && this.exitInfo === null && this.child === child) {
      this.handleExit({ code: null, signal: "SIGKILL" }, child);
    }
  }

  private killChild(signal: "SIGTERM" | "SIGKILL"): void {
    this.child?.kill(signal);
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
