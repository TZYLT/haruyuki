/**
 * Public option/result shapes for `worker-client.ts` (C7 split: the client's
 * state machine grows a watchdog and stays under the 1,000-line ceiling; the
 * contract types callers import live here).
 *
 * Type-only module: no runtime code, and it never imports the client, so there
 * is no cycle. Layer: `backend/local/`.
 */

import type { EmbeddingWorkerSpawner } from "./worker-process";
import type { EmbeddingWorkerRestartPolicy } from "./worker-watchdog";

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
  /** Warm handshake window; a cold first start gets a wider default tier. */
  readonly handshakeTimeoutMs?: number;
  /** Warm `init` window; a cold first start gets a wider default tier. */
  readonly initTimeoutMs?: number;
  /** Override the cold-first-start handshake window. */
  readonly firstStartHandshakeTimeoutMs?: number;
  /** Override the cold-first-start `init`/model-load window. */
  readonly firstStartInitTimeoutMs?: number;
  readonly embedTimeoutMs?: number;
  readonly controlTimeoutMs?: number;
  readonly killGraceMs?: number;
  readonly protocolVersion?: number;
  /** Automatic crash-restart policy; `false` disables the watchdog retry. */
  readonly restart?: Partial<EmbeddingWorkerRestartPolicy> | false;
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

/** Options for {@link EmbeddingWorkerClient.cancel}. */
export interface EmbeddingWorkerCancelOptions {
  readonly requestId?: number;
  readonly timeoutMs?: number;
  /**
   * C7 SIGKILL fallback: when the worker does not answer `cancel` before the
   * timeout it may be stuck in a native call that cannot be preempted, so the
   * client reaps it instead of leaving an unkillable embed alive. Defaults to
   * `true`; the abort path relies on it.
   */
  readonly killIfUnresponsive?: boolean;
}
