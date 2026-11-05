/**
 * The encode path one embedding build runs on (A3's `embed` callback).
 *
 * Extracted from the CLI runtime port so the **reminders** turn path can run an
 * incremental catch-up build without importing `cli/` (feature 48's "next turn
 * embeds the previous turn" requirement). It owns no UI, no progress and no
 * lock: the caller supplies those.
 *
 * `builtin` starts a C8 device adapter (CPU, or DirectML first when the platform
 * and `settings.gpu` allow it) and adapts it to A3's chunk callback; a GPU
 * refusal is reported through `onDegrade` and the adapter keeps working on CPU.
 * `endpoint` uses C6's long-lived client, which owns retries and the breaker;
 * the API key is read from the secret store exactly once.
 *
 * Layer: `backend/local/`. Imports sibling embedding modules and
 * `recall-settings` (the resolved settings type), never `cli/` or `reminders/`.
 */

import {
  createEmbeddingEndpointClient,
  DEFAULT_ENDPOINT_TIMEOUT_MS,
  type EmbeddingEndpointClient,
  type EmbeddingEndpointOptions,
} from "@/backend/local/embedding/endpoint-client";
import {
  type CreateEmbeddingDeviceAdapterOptions,
  createChunkEmbedCallback,
  createEmbeddingDeviceAdapter,
  EMBEDDING_QUERY_EXECUTION_PROVIDERS,
  type EmbeddingBuildWorker,
  type EmbeddingDeviceAdapter,
  planEmbeddingBuildDevice,
} from "@/backend/local/embedding/gpu-build-path";
import { getEmbeddingEndpointApiKey } from "@/backend/local/embedding/secrets";
import { EmbeddingWorkerClient } from "@/backend/local/embedding/worker-client";
import {
  checkEmbeddingBuiltinAssets,
  type EmbeddingBuiltinAssets,
  type EmbeddingBuiltinAssetsOptions,
} from "@/backend/local/embedding-assets";
import type { EmbeddingEmbedCallback } from "@/backend/local/embedding-build";
import type { EmbeddingBuildDeviceSnapshot } from "@/backend/local/embedding-build-state";
import { createGpuTrialBudget } from "@/backend/local/embedding-calibration-probe";
import { resolveEmbeddingWorkerEntryForRuntime } from "@/backend/local/embedding-encoder";
import {
  endpointFingerprint,
  endpointSecretId,
} from "@/backend/local/embedding-profile";
import type { ResolvedEmbeddingSettings } from "@/recall-settings";
import { debugWarn } from "@/utils/debug";

/** One built encode path plus the cleanup that releases it. */
export interface EmbeddingBuildEmbed {
  readonly embed: EmbeddingEmbedCallback;
  readonly dispose: () => Promise<void>;
  /** Redacted GPU fallback reason, when the build worker degraded to CPU. */
  readonly degradedReason: string | null;
  /** Device facts to persist with the build (48-4 D-02). */
  readonly device: EmbeddingBuildDeviceSnapshot;
}

/** Test seams; every field defaults to production. */
export interface EmbeddingBuildEmbedDeps {
  /** Built-in asset directory overrides. */
  assets?: EmbeddingBuiltinAssetsOptions;
  /** Asset readiness probe; defaults to `checkEmbeddingBuiltinAssets`. */
  checkAssets?: typeof checkEmbeddingBuiltinAssets;
  /** Platform override for the GPU decision (tests). */
  platform?: NodeJS.Platform;
  /** C3 worker factory for the build; defaults to a real client. */
  createWorker?: () => EmbeddingBuildWorker;
  /** Explicit worker script path; defaults to the package-root resolution. */
  workerPath?: string;
  /** C8 device adapter factory; defaults to `createEmbeddingDeviceAdapter`. */
  createDeviceAdapter?: (
    options: CreateEmbeddingDeviceAdapterOptions,
  ) => Promise<EmbeddingDeviceAdapter>;
  /** C6 client factory; defaults to `createEmbeddingEndpointClient`. */
  createEndpointClient?: (
    options: EmbeddingEndpointOptions,
  ) => EmbeddingEndpointClient;
  /** Clock for the device block's `measuredAt`; defaults to `Date.now`. */
  now?: () => number;
}

/** The endpoint client surface A3's batch adapter needs. */
export interface EmbeddingEndpointEmbedSource {
  embed(
    texts: readonly string[],
    options?: { signal?: AbortSignal },
  ): Promise<readonly Float32Array[]>;
}

function assertVectors(
  vectors: readonly (Float32Array | null)[],
  expected: number,
  cancelled: boolean,
  source: string,
): readonly Float32Array[] {
  if (cancelled) {
    throw new Error(
      `${source} cancelled the batch before committing vectors; the unit will be retried from its checkpoint.`,
    );
  }
  if (vectors.length !== expected) {
    throw new Error(
      `${source} returned ${vectors.length} vector(s) for ${expected} chunk(s).`,
    );
  }
  return vectors.map((vector, index) => {
    if (!(vector instanceof Float32Array)) {
      throw new Error(`${source} returned no vector for chunk ${index + 1}.`);
    }
    return vector;
  });
}

/** A3's `embed` for the endpoint backend: one batch of chunks → C6's client. */
export function createEndpointEmbedAdapter(
  source: EmbeddingEndpointEmbedSource,
  options: { signal?: AbortSignal } = {},
): EmbeddingEmbedCallback {
  return async (chunks) => {
    const vectors = await source.embed(
      chunks.map((chunk) => chunk.text),
      options,
    );
    return assertVectors(
      vectors,
      chunks.length,
      false,
      "The embedding endpoint",
    );
  };
}

/** Resolve the built-in assets, refusing rather than downloading. */
async function builtinAssets(
  settings: ResolvedEmbeddingSettings,
  deps: EmbeddingBuildEmbedDeps,
): Promise<EmbeddingBuiltinAssets> {
  const check = await (deps.checkAssets ?? checkEmbeddingBuiltinAssets)(
    settings.model,
    deps.assets ?? {},
  );
  if (!check.installed) {
    throw new Error(
      addSetupRemedy(
        `Built-in embedding is not ready: missing ${check.missing.join(" and ")}.`,
      ),
    );
  }
  return check.assets;
}

function addSetupRemedy(message: string): string {
  return `${message} Run /recall embedding connect to download the model and runtime, then start the build again. The build never downloads assets itself.`;
}

/**
 * Build the encode path for one settings record.
 *
 * Throws when the configured backend cannot produce vectors (missing assets, no
 * endpoint form); callers turn that into their own receipt.
 */
export async function createEmbeddingBuildEmbed(
  settings: ResolvedEmbeddingSettings,
  deps: EmbeddingBuildEmbedDeps = {},
): Promise<EmbeddingBuildEmbed> {
  if (settings.backend === "endpoint") {
    const endpoint = settings.endpoint;
    if (endpoint === null) {
      throw new Error(
        'The embedding backend is "endpoint" but no endpoint is configured; run /recall embedding connect and complete the endpoint form first.',
      );
    }
    const apiKey = await getEmbeddingEndpointApiKey(
      undefined,
      endpointSecretId(endpointFingerprint(endpoint.baseUrl)),
    ).catch(() => null);
    const client = (deps.createEndpointClient ?? createEmbeddingEndpointClient)(
      {
        kind: endpoint.kind,
        baseUrl: endpoint.baseUrl,
        model: endpoint.model,
        dimensions: endpoint.dimensions,
        timeoutMs: endpoint.timeoutMs ?? DEFAULT_ENDPOINT_TIMEOUT_MS,
        ...(apiKey === null ? {} : { apiKey }),
      },
    );
    return {
      embed: createEndpointEmbedAdapter(client),
      dispose: async () => {
        // C6's client holds only breaker state; the transport is per-request.
      },
      degradedReason: null,
      device: {
        backend: "endpoint",
        requested: [...EMBEDDING_QUERY_EXECUTION_PROVIDERS],
        initialized: [...EMBEDDING_QUERY_EXECUTION_PROVIDERS],
        gpu: false,
        degraded: false,
        threads: settings.threads,
        warmupMs: 0,
        measuredAt: measuredAt(deps),
      },
    };
  }

  const assets = await builtinAssets(settings, deps);
  const platform = deps.platform ?? process.platform;
  const gpuAllowed = platform === "win32" && settings.gpu !== "off";
  const gpuBudget = gpuAllowed
    ? createGpuTrialBudget({ quantization: settings.quantization })
    : null;
  const plan = planEmbeddingBuildDevice(gpuBudget);
  let degradedReason: string | null = null;
  const adapter = await (
    deps.createDeviceAdapter ?? createEmbeddingDeviceAdapter
  )({
    ...(plan.role === "index-only" && gpuBudget !== null
      ? { budget: gpuBudget }
      : {}),
    createWorker:
      deps.createWorker ??
      (() =>
        new EmbeddingWorkerClient({
          workerPath:
            deps.workerPath ?? resolveEmbeddingWorkerEntryForRuntime().path,
        })),
    init: {
      runtimeDir: assets.runtimeDir,
      modelPath: assets.modelPath,
      tokenizerPath: assets.tokenizerPath,
      maxTokens: assets.manifest.maxTokens,
      // Build must pool exactly like the query path (mean/cls/last per model),
      // or the index vectors never match an encoded query.
      pooling: assets.manifest.pooling,
      ...(settings.threads > 0 ? { intraOpThreads: settings.threads } : {}),
    },
    onDegrade: (event) => {
      degradedReason = event.reason;
      debugWarn(
        "embedding",
        `the embedding build worker fell back to CPU: ${event.reason}`,
      );
    },
  });
  return {
    embed: createChunkEmbedCallback(adapter),
    dispose: () => adapter.dispose(),
    degradedReason,
    device: {
      backend: "builtin",
      requested: [...plan.executionProviders],
      initialized: [...adapter.executionProviders],
      gpu: adapter.gpu,
      degraded: adapter.degraded,
      ...(adapter.degradedReason === undefined
        ? {}
        : { degradedReason: adapter.degradedReason }),
      threads: settings.threads,
      warmupMs: adapter.initialization.warmupMs,
      measuredAt: measuredAt(deps),
    },
  };
}

function measuredAt(deps: EmbeddingBuildEmbedDeps): string {
  return new Date((deps.now ?? Date.now)()).toISOString();
}
