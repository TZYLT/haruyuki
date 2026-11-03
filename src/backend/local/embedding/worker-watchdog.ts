/**
 * C7 watchdog policy for the embedding worker: typed failure classification,
 * a bounded restart budget with exponential backoff, and the first-start
 * timeout tiers (split out of `worker-client.ts` so the client stays under the
 * 1,000-line ceiling and the policy is testable without spawning a process).
 *
 * **Why a crash is not just "retry".** 48-2 §4.4 records three real timings:
 * the first spawn can take 3.3 s while antivirus scans the runtime, an m3 model
 * needs 32.4 s for its first load, and a retry storm is unacceptable. So the
 * decision is explicit instead of a loop:
 *
 * - `retriable` — the process died (non-zero exit or a crash signal) or the
 *   handshake timed out; a bounded restart can recover it.
 * - terminal — a clean exit, a spawn failure (missing file/ENOENT), a protocol
 *   desync, cancellation/disposal and worker-reported request errors. Retrying
 *   those only repeats the failure more slowly.
 *
 * Automatic restarts are hard-capped at `maxRestarts` (2) with exponential
 * backoff, and each decision carries a typed `reason` plus `canRetry`, so
 * callers never parse messages.
 *
 * **Why timeout tiers.** A cold first start is the slow path; a restart after
 * a crash is not. The first start gets a wider handshake/init window, and the
 * first load (m3: 32.4 s) is covered by the wider init window. The client
 * applies the tier; `resolveEmbeddingWorkerTimeoutTier` only resolves it, with
 * the same precedence as the client options.
 *
 * Layer: `backend/local/`; imports protocol/process types only.
 */

import type { EmbeddingWorkerExit } from "./worker-process";
import type { EmbeddingWorkerErrorCode } from "./worker-protocol";

/** Default handshake window once the worker is warm. */
export const DEFAULT_EMBEDDING_WORKER_HANDSHAKE_TIMEOUT_MS = 15_000;

/** Default `init` window once the worker is warm (m3 first load is 32.4 s). */
export const DEFAULT_EMBEDDING_WORKER_INIT_TIMEOUT_MS = 120_000;

/** Default window for one `embed` request. */
export const DEFAULT_EMBEDDING_WORKER_EMBED_TIMEOUT_MS = 120_000;

/** Default window for cancel/stats/shutdown replies. */
export const DEFAULT_EMBEDDING_WORKER_CONTROL_TIMEOUT_MS = 10_000;

/** Grace before a SIGKILL after SIGTERM during shutdown/reaping. */
export const DEFAULT_EMBEDDING_WORKER_KILL_GRACE_MS = 2_000;

/** First start is cold: antivirus may scan the freshly downloaded runtime. */
export const DEFAULT_EMBEDDING_WORKER_FIRST_START_HANDSHAKE_TIMEOUT_MS = 30_000;

/** First load is the slow one (m3: 32.4 s measured); never wait forever. */
export const DEFAULT_EMBEDDING_WORKER_FIRST_START_INIT_TIMEOUT_MS = 180_000;

/**
 * Copy a surface may show while a first start is slow. Stable API: the status
 * line/wizard can render it without re-deriving the antivirus explanation.
 */
export const EMBEDDING_WORKER_FIRST_START_HINT =
  "The built-in embedding runtime is loading for the first time. A cold start can take tens of seconds while the downloaded files are scanned; later starts are faster.";

/** Why a client call failed. `code` is stable API. */
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

/** Typed watchdog reason; the only thing callers may branch on. */
export type EmbeddingWorkerRestartReason =
  | "caller"
  | "clean-exit"
  | "crash-exit"
  | "crash-signal"
  | "handshake-timeout"
  | "killed"
  | "protocol"
  | "request-timeout"
  | "spawn-failed"
  | "unknown"
  | "worker-error";

/**
 * Typed client failure; `code` is stable API. `reason`/`canRetry` are filled
 * on failures the watchdog classifies, so a caller can decide without a
 * second lookup.
 */
export class EmbeddingWorkerClientError extends Error {
  readonly code: EmbeddingWorkerClientErrorCode;
  /** The worker's own error code, for `code === "worker-error"`. */
  readonly workerCode: EmbeddingWorkerErrorCode | undefined;
  /** Exit details, for `code === "exited"`. */
  readonly exit: EmbeddingWorkerExit | undefined;
  /** Request id the failure belongs to, when known. */
  readonly requestId: number | undefined;
  /** Typed watchdog reason, when this failure reached the watchdog. */
  readonly reason: EmbeddingWorkerRestartReason | undefined;
  /** Whether a bounded restart may recover this failure, when known. */
  readonly canRetry: boolean | undefined;

  constructor(
    code: EmbeddingWorkerClientErrorCode,
    message: string,
    options: {
      workerCode?: EmbeddingWorkerErrorCode;
      exit?: EmbeddingWorkerExit;
      requestId?: number;
      reason?: EmbeddingWorkerRestartReason;
      canRetry?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "EmbeddingWorkerClientError";
    this.code = code;
    this.workerCode = options.workerCode;
    this.exit = options.exit;
    this.requestId = options.requestId;
    this.reason = options.reason;
    this.canRetry = options.canRetry;
  }
}

/** Watchdog verdict for one failure. */
export interface EmbeddingWorkerFailureClassification {
  readonly code: EmbeddingWorkerClientErrorCode;
  readonly reason: EmbeddingWorkerRestartReason;
  /** A bounded restart may recover this failure. */
  readonly retriable: boolean;
  readonly exitCode: number | null;
  readonly signal: string | null;
}

/** Signals that mean the runtime crashed, not that someone killed it. */
const CRASH_SIGNALS: ReadonlySet<string> = new Set([
  "SIGABRT",
  "SIGBUS",
  "SIGFPE",
  "SIGILL",
  "SIGSEGV",
  "SIGSYS",
]);

/** Signals an owner/xterm kill produces; retrying would fight the caller. */
const TERMINATION_SIGNALS: ReadonlySet<string> = new Set([
  "SIGKILL",
  "SIGTERM",
]);

/**
 * Classify a failed worker call. Only process death (non-zero exit, crash
 * signal) and a slow handshake are retriable; everything else is terminal.
 */
export function classifyEmbeddingWorkerFailure(
  code: EmbeddingWorkerClientErrorCode,
  exit?: EmbeddingWorkerExit,
): EmbeddingWorkerFailureClassification {
  const exitCode = exit?.code ?? null;
  const signal = exit?.signal ?? null;
  if (code === "exited") {
    if (exit === undefined) {
      return { code, reason: "unknown", retriable: false, exitCode, signal };
    }
    if (exit.error !== undefined) {
      return {
        code,
        reason: "spawn-failed",
        retriable: false,
        exitCode,
        signal,
      };
    }
    if (signal !== null) {
      const crashed = CRASH_SIGNALS.has(signal);
      return {
        code,
        reason: crashed
          ? "crash-signal"
          : TERMINATION_SIGNALS.has(signal)
            ? "killed"
            : "crash-signal",
        retriable: crashed || !TERMINATION_SIGNALS.has(signal),
        exitCode,
        signal,
      };
    }
    if (exit.code === 0) {
      return {
        code,
        reason: "clean-exit",
        retriable: false,
        exitCode,
        signal,
      };
    }
    return { code, reason: "crash-exit", retriable: true, exitCode, signal };
  }
  if (code === "handshake-timeout") {
    return {
      code,
      reason: "handshake-timeout",
      retriable: true,
      exitCode,
      signal,
    };
  }
  if (code === "spawn-failed") {
    return { code, reason: "spawn-failed", retriable: false, exitCode, signal };
  }
  if (code === "protocol") {
    return { code, reason: "protocol", retriable: false, exitCode, signal };
  }
  if (code === "worker-error") {
    return { code, reason: "worker-error", retriable: false, exitCode, signal };
  }
  if (code === "request-timeout") {
    return {
      code,
      reason: "request-timeout",
      retriable: false,
      exitCode,
      signal,
    };
  }
  return { code, reason: "caller", retriable: false, exitCode, signal };
}

/** How many automatic restarts a client may perform, and how fast. */
export interface EmbeddingWorkerRestartPolicy {
  /** Hard cap on automatic restarts for one client instance (default 2). */
  readonly maxRestarts: number;
  /** Delay before restart #1; doubles per attempt (default 250 ms). */
  readonly baseDelayMs: number;
  /** Backoff ceiling (default 2 s). */
  readonly maxDelayMs: number;
}

/** Defaults: two restarts, 250 ms doubling, capped at 2 s (no storm). */
export const DEFAULT_EMBEDDING_WORKER_RESTART_POLICY: EmbeddingWorkerRestartPolicy =
  Object.freeze({
    maxRestarts: 2,
    baseDelayMs: 250,
    maxDelayMs: 2_000,
  });

/** Resolve a partial policy, clamping nonsense values instead of looping. */
export function resolveEmbeddingWorkerRestartPolicy(
  overrides?: Partial<EmbeddingWorkerRestartPolicy>,
): EmbeddingWorkerRestartPolicy {
  const maxRestarts = overrides?.maxRestarts;
  const baseDelayMs = overrides?.baseDelayMs;
  const maxDelayMs = overrides?.maxDelayMs;
  return {
    maxRestarts:
      typeof maxRestarts === "number" && Number.isFinite(maxRestarts)
        ? Math.max(0, Math.floor(maxRestarts))
        : DEFAULT_EMBEDDING_WORKER_RESTART_POLICY.maxRestarts,
    baseDelayMs:
      typeof baseDelayMs === "number" && Number.isFinite(baseDelayMs)
        ? Math.max(1, Math.floor(baseDelayMs))
        : DEFAULT_EMBEDDING_WORKER_RESTART_POLICY.baseDelayMs,
    maxDelayMs:
      typeof maxDelayMs === "number" && Number.isFinite(maxDelayMs)
        ? Math.max(1, Math.floor(maxDelayMs))
        : DEFAULT_EMBEDDING_WORKER_RESTART_POLICY.maxDelayMs,
  };
}

/** Exponential backoff for restart number `attempt` (1-based). */
export function embeddingWorkerRestartDelayMs(
  attempt: number,
  policy: EmbeddingWorkerRestartPolicy = DEFAULT_EMBEDDING_WORKER_RESTART_POLICY,
): number {
  const exponent = Math.max(0, Math.floor(attempt) - 1);
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** exponent);
}

/** One restart decision, emitted to `onRestart` listeners. */
export interface EmbeddingWorkerRestartEvent {
  readonly reason: EmbeddingWorkerRestartReason;
  /** Restart number being scheduled (1-based). */
  readonly attempt: number;
  readonly delayMs: number;
  /** Another restart remains after this one. */
  readonly canRetry: boolean;
  readonly failure: EmbeddingWorkerFailureClassification;
  readonly error: Error;
}

/** Options for {@link EmbeddingWorkerWatchdog}. */
export interface EmbeddingWorkerWatchdogOptions {
  /** Restart policy overrides, or `false` to disable automatic restarts. */
  readonly restart?: Partial<EmbeddingWorkerRestartPolicy> | false;
}

/**
 * Owns the restart counter, the backoff timer and the decision listeners.
 * The client owns spawning; this class owns "may we, how long, and did we
 * already schedule one" so two failure reports cannot create a storm.
 */
export class EmbeddingWorkerWatchdog {
  private readonly policy: EmbeddingWorkerRestartPolicy | null;
  private readonly listeners = new Set<
    (event: EmbeddingWorkerRestartEvent) => void
  >();
  private spawned = 0;
  private failure: EmbeddingWorkerFailureClassification | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: EmbeddingWorkerWatchdogOptions = {}) {
    this.policy =
      options.restart === false
        ? null
        : resolveEmbeddingWorkerRestartPolicy(options.restart);
  }

  /** True unless automatic restarts are disabled. */
  get enabled(): boolean {
    return this.policy !== null;
  }

  /** Automatic restarts performed so far (the first spawn is not one). */
  get restartCount(): number {
    return this.spawned === 0 ? 0 : this.spawned - 1;
  }

  /** Classification of the last failure seen, if any. */
  get lastFailure(): EmbeddingWorkerFailureClassification | null {
    return this.failure;
  }

  /** True while a backoff timer is pending. */
  get restartScheduled(): boolean {
    return this.timer !== null;
  }

  /** Whether the last failure can still be retried within the budget. */
  get canRetry(): boolean {
    if (this.policy === null) return false;
    if (this.failure === null) return true;
    return this.canRetryFailure(this.failure);
  }

  /** Whether this specific failure can still be retried within the budget. */
  canRetryFailure(failure: EmbeddingWorkerFailureClassification): boolean {
    return (
      this.policy !== null &&
      failure.retriable &&
      this.restartCount < this.policy.maxRestarts
    );
  }

  /** Record every spawn (including the first); restarts are spawn 2..N. */
  noteSpawn(): void {
    this.spawned += 1;
  }

  /** Subscribe to restart decisions; returns an unsubscribe function. */
  onRestart(
    listener: (event: EmbeddingWorkerRestartEvent) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Record a failure and, when the policy allows, schedule exactly one
   * restart. `restart` runs after the exponential backoff. Returns the event
   * that was emitted, or `null` when no restart was scheduled.
   */
  reportFailure(
    failure: EmbeddingWorkerFailureClassification,
    error: Error,
    restart: () => void,
  ): EmbeddingWorkerRestartEvent | null {
    this.failure = failure;
    if (!this.canRetryFailure(failure) || this.timer !== null) return null;
    if (this.policy === null) return null;
    const attempt = this.restartCount + 1;
    const delayMs = embeddingWorkerRestartDelayMs(attempt, this.policy);
    const event: EmbeddingWorkerRestartEvent = {
      reason: failure.reason,
      attempt,
      delayMs,
      canRetry: attempt < this.policy.maxRestarts,
      failure,
      error,
    };
    this.timer = setTimeout(() => {
      this.timer = null;
      restart();
    }, delayMs);
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // A listener must not break cleanup for the others.
      }
    }
    return event;
  }

  /** Cancel a pending restart (intentional stop/restart-and-forget). */
  cancel(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  /** Reset counters and listeners (dispose path; no timers left behind). */
  dispose(): void {
    this.cancel();
    this.listeners.clear();
    this.spawned = 0;
    this.failure = null;
  }
}

/** The handshake/init windows the client applies to the next attempt. */
export interface EmbeddingWorkerTimeoutTier {
  readonly handshakeTimeoutMs: number;
  readonly initTimeoutMs: number;
  /** True for the cold-first-start tier. */
  readonly firstStart: boolean;
}

/** Input for {@link resolveEmbeddingWorkerTimeoutTier}. */
export interface EmbeddingWorkerTimeoutOptions {
  readonly firstStart: boolean;
  readonly handshakeTimeoutMs?: number;
  readonly initTimeoutMs?: number;
  readonly firstStartHandshakeTimeoutMs?: number;
  readonly firstStartInitTimeoutMs?: number;
}

/**
 * Resolve the effective timeout tier. Explicit steady overrides apply to both
 * tiers (tests and embedders that intend one timeout keep it), while the
 * first-start defaults are wider than the steady ones (cold start under
 * antivirus vs. a warm restart).
 */
export function resolveEmbeddingWorkerTimeoutTier(
  options: EmbeddingWorkerTimeoutOptions,
): EmbeddingWorkerTimeoutTier {
  const steadyHandshake =
    options.handshakeTimeoutMs ?? DEFAULT_EMBEDDING_WORKER_HANDSHAKE_TIMEOUT_MS;
  const steadyInit =
    options.initTimeoutMs ?? DEFAULT_EMBEDDING_WORKER_INIT_TIMEOUT_MS;
  if (!options.firstStart) {
    return {
      handshakeTimeoutMs: steadyHandshake,
      initTimeoutMs: steadyInit,
      firstStart: false,
    };
  }
  return {
    handshakeTimeoutMs:
      options.firstStartHandshakeTimeoutMs ??
      (options.handshakeTimeoutMs === undefined
        ? DEFAULT_EMBEDDING_WORKER_FIRST_START_HANDSHAKE_TIMEOUT_MS
        : steadyHandshake),
    initTimeoutMs:
      options.firstStartInitTimeoutMs ??
      (options.initTimeoutMs === undefined
        ? DEFAULT_EMBEDDING_WORKER_FIRST_START_INIT_TIMEOUT_MS
        : steadyInit),
    firstStart: true,
  };
}
