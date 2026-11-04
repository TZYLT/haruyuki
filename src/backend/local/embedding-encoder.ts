/**
 * Query encoders for vector recall (feature 48, rework A1).
 *
 * The recall search path needs "text → one L2-normalized query vector" from
 * either backend, behind one small injectable interface:
 *
 * - **Built-in**: lazily spawns C3's `EmbeddingWorkerClient` once per
 *   configuration, initialises it with the installed runtime/model/tokenizer and
 *   prepends the manifest's `queryInstruction` (48-2 O-07: query side only, never
 *   the documents). A second `createBuiltinQueryEncoder` with the same
 *   configuration reuses the module-level worker; each returned handle holds a
 *   reference, and the worker is shut down when the last handle is disposed.
 * - **Endpoint**: wraps C6's long-lived `createEmbeddingEndpointClient`, which
 *   already owns retries, the circuit breaker and URL policy. Errors propagate;
 *   the caller degrades to lexical recall for that turn.
 * - **Dispatch**: {@link createEmbeddingQueryEncoder} picks one from resolved
 *   settings (defaults read through `readEmbeddingSettings`).
 *
 * **Query encoding is always CPU** (48-1 §5.3): a batch-1 GPU encode is slower
 * than CPU, so `gpu: "index-only"` must not move queries onto the GPU even
 * though the same settings drive the index build. The option exists for API
 * symmetry and is deliberately ignored.
 *
 * **Missing built-in assets are not an error.** When the model or runtime is not
 * installed, `encodeQuery` resolves `null` instead of throwing, so the caller's
 * existing "no vector → lexical only" path keeps working while setup is pending.
 * Worker start/init failures do reject: those are runtime faults the caller
 * reports and degrades.
 *
 * `resolveEmbeddingWorkerEntryForRuntime` owns the bundled-vs-source decision
 * from `worker-entry-path.ts`, walking up from this module to the package root so
 * both `bun run dev` (`.ts` source) and the published package
 * (`embedding-worker.js`) work without the caller knowing which one it is.
 *
 * Layer: `backend/local/embedding*`. Imports sibling embedding modules, the
 * `ResolvedEmbeddingSettings` type (type-only) and `readEmbeddingSettings`.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createEmbeddingEndpointClient,
  type EmbeddingEndpointClient,
} from "@/backend/local/embedding/endpoint-client";
import { EMBEDDING_QUERY_EXECUTION_PROVIDERS } from "@/backend/local/embedding/gpu-build-path";
import { getEmbeddingEndpointApiKey } from "@/backend/local/embedding/secrets";
import { EmbeddingWorkerClient } from "@/backend/local/embedding/worker-client";
import type {
  EmbeddingWorkerEmbedOptions,
  EmbeddingWorkerEmbedOutput,
} from "@/backend/local/embedding/worker-client-types";
import {
  EMBEDDING_WORKER_BUNDLE_FILENAME,
  EMBEDDING_WORKER_SOURCE_FILENAME,
  type EmbeddingWorkerEntryResolution,
  resolveEmbeddingWorkerEntry,
} from "@/backend/local/embedding/worker-entry-path";
import type {
  EmbeddingWorkerInitOptions,
  EmbeddingWorkerInitResult,
} from "@/backend/local/embedding/worker-protocol";
import {
  checkEmbeddingBuiltinAssets,
  type EmbeddingBuiltinAssetsOptions,
  resolveEmbeddingBuiltinAssets,
} from "@/backend/local/embedding-assets";
import {
  type ResolvedEmbeddingSettings,
  readEmbeddingSettings,
} from "@/recall-settings";

/** Prefix every built-in encoder id starts with, for logs and diagnostics. */
const BUILTIN_ID_PREFIX = "builtin:";

/** How long a dispose waits for the worker's graceful shutdown reply. */
const DISPOSE_SHUTDOWN_TIMEOUT_MS = 5_000;

/**
 * The small worker surface a query encoder needs. `EmbeddingWorkerClient`
 * satisfies it structurally; tests inject a fake so no process is spawned.
 */
export interface EmbeddingEncoderWorker {
  start(): Promise<unknown>;
  init(
    options: EmbeddingWorkerInitOptions,
    timeoutMs?: number,
  ): Promise<EmbeddingWorkerInitResult>;
  embed(
    texts: readonly string[],
    options?: EmbeddingWorkerEmbedOptions,
  ): Promise<EmbeddingWorkerEmbedOutput>;
  shutdown?(options?: { timeoutMs?: number }): Promise<void>;
  dispose?(): void;
}

/** The one interface the recall path consumes. */
export interface EmbeddingQueryEncoder {
  /** Stable id for logs/diagnostics (`builtin:<model>` or `endpoint:...`). */
  readonly id: string;
  /** One query vector, or `null` when the built-in assets are not ready. */
  encodeQuery(text: string): Promise<Float32Array | null>;
  /** Batch form; `null` entries mean "this text has no vector". */
  encodeBatch(texts: readonly string[]): Promise<(Float32Array | null)[]>;
  /** Stop the underlying worker when it is no longer shared. */
  dispose(): Promise<void>;
}

/** Options for {@link createBuiltinQueryEncoder}. */
export interface BuiltinQueryEncoderOptions
  extends EmbeddingBuiltinAssetsOptions {
  /** Intra-op threads for the worker; `0`/absent lets the runtime decide. */
  readonly threads?: number;
  /**
   * Accepted for API symmetry only: query encoding is fixed to CPU (48-1 §5.3),
   * so non-CPU providers here are ignored.
   */
  readonly executionProviders?: readonly string[];
  /** Explicit worker script path; defaults to the package-root resolution. */
  readonly workerPath?: string;
  /** Test seam: worker factory. Defaults to a real `EmbeddingWorkerClient`. */
  readonly createWorker?: (workerPath: string) => EmbeddingEncoderWorker;
  /** Test seam: readiness probe. Defaults to `checkEmbeddingBuiltinAssets`. */
  readonly isReady?: () => Promise<boolean>;
}

/** Options for {@link createEndpointQueryEncoder}. */
export interface EndpointQueryEncoderOptions {
  /** Test seam: prebuilt endpoint client (skips the secrets read). */
  readonly client?: EmbeddingEndpointClient;
}

/** Options accepted by {@link createEmbeddingQueryEncoder}. */
export interface EmbeddingQueryEncoderOptions
  extends BuiltinQueryEncoderOptions,
    EndpointQueryEncoderOptions {}

/**
 * Resolve the worker entry for the running package.
 *
 * Walks up from this module until it finds `package.json`, then asks
 * `worker-entry-path.ts` to pick between `<root>/embedding-worker.js` (published
 * Node package) and `<root>/src/backend/local/embedding/worker-entry.ts` (Bun
 * source checkout). Throws a clear error when neither exists or when the walk
 * cannot find a package root, instead of spawning a path that does not exist.
 */
export function resolveEmbeddingWorkerEntryForRuntime(
  options: {
    /** Override the starting URL; defaults to this module's `import.meta.url`. */
    readonly fromUrl?: string;
    /** Test seam: existence probe for the two worker candidates. */
    readonly exists?: (path: string) => boolean;
  } = {},
): EmbeddingWorkerEntryResolution {
  const fromUrl = options.fromUrl ?? import.meta.url;
  let startDirectory: string;
  try {
    startDirectory = dirname(fileURLToPath(fromUrl));
  } catch {
    throw new Error(
      `Cannot resolve the embedding worker entry: ${fromUrl} is not a file URL.`,
    );
  }
  const packageRoot = findPackageRoot(startDirectory);
  if (packageRoot === null) {
    throw new Error(
      `Cannot resolve the embedding worker entry: no package.json was found above ${startDirectory}.`,
    );
  }
  const candidates = {
    bundled: join(packageRoot, EMBEDDING_WORKER_BUNDLE_FILENAME),
    source: join(
      packageRoot,
      "src",
      "backend",
      "local",
      "embedding",
      EMBEDDING_WORKER_SOURCE_FILENAME,
    ),
  };
  return resolveEmbeddingWorkerEntry(
    candidates,
    options.exists === undefined ? {} : { exists: options.exists },
  );
}

function findPackageRoot(startDirectory: string): string | null {
  let directory = startDirectory;
  for (;;) {
    if (existsSync(join(directory, "package.json"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

interface EncoderSession {
  readonly worker: EmbeddingEncoderWorker;
  readonly queryInstruction: string | null;
}

interface BuiltinEncoderConfiguration {
  readonly id: string;
  readonly modelId: string;
  readonly modelsDir: string | undefined;
  readonly runtimeVersion: string | undefined;
  readonly threads: number;
  readonly workerPath: string | undefined;
  readonly createWorker: (workerPath: string) => EmbeddingEncoderWorker;
  readonly isReady: () => Promise<boolean>;
}

/**
 * One shared worker per configuration key. `refs` is how many handles are
 * outstanding; disposing the last one stops the worker and frees the slot.
 */
class BuiltinEncoderEntry {
  readonly id: string;
  refs = 0;
  private readonly configuration: BuiltinEncoderConfiguration;
  private session: Promise<EncoderSession | null> | null = null;

  constructor(configuration: BuiltinEncoderConfiguration) {
    this.id = configuration.id;
    this.configuration = configuration;
  }

  acquire(): void {
    this.refs += 1;
  }

  async encode(texts: readonly string[]): Promise<(Float32Array | null)[]> {
    if (texts.length === 0) return [];
    const session = await this.open();
    if (session === null) return texts.map(() => null);
    const prepared = texts.map((text) =>
      session.queryInstruction === null
        ? text
        : `${session.queryInstruction}${text}`,
    );
    const output = await session.worker.embed(prepared);
    if (output.vectors.length !== prepared.length) {
      throw new Error(
        `The embedding worker returned ${output.vectors.length} vectors for ${prepared.length} texts.`,
      );
    }
    return output.vectors.map((vector) => vector ?? null);
  }

  async release(): Promise<void> {
    this.refs = Math.max(0, this.refs - 1);
    if (this.refs > 0) return;
    encoderCache.delete(this.id);
    await this.disposeNow();
  }

  async disposeNow(): Promise<void> {
    const pending = this.session;
    this.session = null;
    if (pending === null) return;
    try {
      const session = await pending;
      if (session === null) return;
      try {
        await session.worker.shutdown?.({
          timeoutMs: DISPOSE_SHUTDOWN_TIMEOUT_MS,
        });
      } catch {
        // A worker that already died has nothing to shut down; dispose below
        // still releases the process handle.
      }
      session.worker.dispose?.();
    } catch {
      // The session never reached readiness; the failed start already released
      // whatever it had. Nothing else to stop.
    }
  }

  private open(): Promise<EncoderSession | null> {
    if (this.session === null) {
      this.session = this.initialize().catch((error: unknown) => {
        // A failed start/init must not poison the cache: the next call retries
        // a fresh worker, because a transient spawn failure is recoverable.
        this.session = null;
        throw error;
      });
    }
    return this.session;
  }

  private async initialize(): Promise<EncoderSession | null> {
    const configuration = this.configuration;
    if (!(await configuration.isReady())) return null;
    const assets = resolveEmbeddingBuiltinAssets(configuration.modelId, {
      ...(configuration.modelsDir === undefined
        ? {}
        : { modelsDir: configuration.modelsDir }),
      ...(configuration.runtimeVersion === undefined
        ? {}
        : { runtimeVersion: configuration.runtimeVersion }),
    });
    const workerPath =
      configuration.workerPath ?? resolveEmbeddingWorkerEntryForRuntime().path;
    const worker = configuration.createWorker(workerPath);
    await worker.start();
    await worker.init({
      runtimeDir: assets.runtimeDir,
      modelPath: assets.modelPath,
      tokenizerPath: assets.tokenizerPath,
      maxTokens: assets.manifest.maxTokens,
      executionProviders: [...EMBEDDING_QUERY_EXECUTION_PROVIDERS],
      ...(configuration.threads > 0
        ? { intraOpThreads: configuration.threads }
        : {}),
    });
    return { worker, queryInstruction: assets.manifest.queryInstruction };
  }
}

/** Live workers keyed by their configuration; shared within the process. */
const encoderCache = new Map<string, BuiltinEncoderEntry>();

function builtinEncoderCacheKey(
  settings: ResolvedEmbeddingSettings,
  options: BuiltinQueryEncoderOptions,
): string {
  return JSON.stringify([
    BUILTIN_ID_PREFIX + settings.model,
    options.modelsDir ?? "",
    options.runtimeVersion ?? "",
    options.threads ?? settings.threads,
    options.workerPath ?? "",
  ]);
}

function createBuiltinEncoderEntry(
  settings: ResolvedEmbeddingSettings,
  options: BuiltinQueryEncoderOptions,
): BuiltinEncoderEntry {
  const modelId = settings.model;
  const configuration: BuiltinEncoderConfiguration = {
    id: builtinEncoderCacheKey(settings, options),
    modelId,
    modelsDir: options.modelsDir,
    runtimeVersion: options.runtimeVersion,
    threads: options.threads ?? settings.threads,
    workerPath: options.workerPath,
    createWorker:
      options.createWorker ??
      ((workerPath: string) => new EmbeddingWorkerClient({ workerPath })),
    isReady:
      options.isReady ??
      (async () => {
        const check = await checkEmbeddingBuiltinAssets(modelId, {
          ...(options.modelsDir === undefined
            ? {}
            : { modelsDir: options.modelsDir }),
          ...(options.runtimeVersion === undefined
            ? {}
            : { runtimeVersion: options.runtimeVersion }),
        });
        return check.installed;
      }),
  };
  return new BuiltinEncoderEntry(configuration);
}

/**
 * A built-in query encoder backed by C3's worker, spawned on first use.
 *
 * Instances created with the same configuration share one worker; each returned
 * handle must be disposed when done (the worker exits when the last handle is).
 */
export function createBuiltinQueryEncoder(
  settings: ResolvedEmbeddingSettings,
  options: BuiltinQueryEncoderOptions = {},
): EmbeddingQueryEncoder {
  const id = builtinEncoderCacheKey(settings, options);
  let entry = encoderCache.get(id);
  if (entry === undefined) {
    entry = createBuiltinEncoderEntry(settings, options);
    encoderCache.set(id, entry);
  }
  entry.acquire();
  return createEncoderFacade(entry, `builtin:${settings.model}`);
}

function createEncoderFacade(
  entry: BuiltinEncoderEntry,
  id: string,
): EmbeddingQueryEncoder {
  let disposed = false;
  return {
    id,
    async encodeQuery(text: string): Promise<Float32Array | null> {
      const vectors = await entry.encode([text]);
      return vectors[0] ?? null;
    },
    async encodeBatch(
      texts: readonly string[],
    ): Promise<(Float32Array | null)[]> {
      return await entry.encode(texts);
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      await entry.release();
    },
  };
}

/**
 * A query encoder for an OpenAI-compatible or Ollama endpoint.
 *
 * The API key is read once from the secrets store on the first encode (never
 * captured in settings) and every failure propagates: the caller decides to
 * degrade this turn. A missing endpoint form is a configuration error and throws
 * immediately.
 */
export function createEndpointQueryEncoder(
  settings: ResolvedEmbeddingSettings,
  options: EndpointQueryEncoderOptions = {},
): EmbeddingQueryEncoder {
  const endpoint = settings.endpoint;
  if (endpoint === null) {
    throw new Error(
      'The embedding backend is "endpoint" but no endpoint is configured; run /recall embedding setup and complete the endpoint form first.',
    );
  }
  const id = `endpoint:${endpoint.kind}:${endpoint.baseUrl}:${endpoint.model}`;
  let clientPromise: Promise<EmbeddingEndpointClient> | null =
    options.client === undefined ? null : Promise.resolve(options.client);
  const resolveClient = async (): Promise<EmbeddingEndpointClient> => {
    if (clientPromise === null) {
      const apiKey = await getEmbeddingEndpointApiKey().catch(() => null);
      clientPromise = Promise.resolve(
        createEmbeddingEndpointClient({
          kind: endpoint.kind,
          baseUrl: endpoint.baseUrl,
          model: endpoint.model,
          dimensions: endpoint.dimensions,
          ...(endpoint.timeoutMs === undefined
            ? {}
            : { timeoutMs: endpoint.timeoutMs }),
          ...(apiKey === null ? {} : { apiKey }),
        }),
      );
    }
    return await clientPromise;
  };
  return {
    id,
    async encodeQuery(text: string): Promise<Float32Array | null> {
      const vectors = await (await resolveClient()).embed([text]);
      return vectors[0] ?? null;
    },
    async encodeBatch(
      texts: readonly string[],
    ): Promise<(Float32Array | null)[]> {
      if (texts.length === 0) return [];
      const vectors = await (await resolveClient()).embed(texts);
      return vectors.map((vector) => vector);
    },
    async dispose(): Promise<void> {
      // The client holds only breaker state; the transport is per-request.
    },
  };
}

/**
 * Pick the encoder the configured backend needs.
 *
 * Defaults to the live settings (`readEmbeddingSettings`) so the turn path can
 * call this with no argument and tests can pass an explicit resolved record.
 */
export function createEmbeddingQueryEncoder(
  settings: ResolvedEmbeddingSettings = readEmbeddingSettings(),
  options: EmbeddingQueryEncoderOptions = {},
): EmbeddingQueryEncoder {
  if (settings.backend === "endpoint") {
    return createEndpointQueryEncoder(settings, options);
  }
  return createBuiltinQueryEncoder(settings, options);
}

/**
 * Drop every cached worker, disposing the ones that already started. Tests call
 * this between cases so a fake worker from one case can never serve the next.
 */
export async function resetEmbeddingEncoderCacheForTests(): Promise<void> {
  const entries = [...encoderCache.values()];
  encoderCache.clear();
  await Promise.allSettled(entries.map((entry) => entry.disposeNow()));
}
