/**
 * Production wiring for the embedding index (feature 48, rework A2).
 *
 * The command layer talks to `EmbeddingRuntimePort`; this is the real port. It
 * joins A1's space/summary/unit modules, A5's build-state projection, A4's host
 * (`startEmbeddingBuild`/`cancelEmbeddingBuild`) and C3/C6/C8's encode paths.
 * GPU applies to the build only — a refusal degrades to CPU inside C8's adapter
 * and the reason is reported in the receipt; queries stay on CPU.
 *
 * Nothing here downloads (missing assets are refused with the
 * `/recall embedding connect` remedy), and nothing here throws at the turn path:
 * `build`/`cancel`/`reset` return copy, and `readStatus` degrades to `null`.
 *
 * Layer: `cli/helpers/`. Imports `backend/local/` and the command contract.
 */

import { type Backend, getBackend } from "@/backend";
import {
  DEFAULT_ENDPOINT_TIMEOUT_MS,
  type EmbeddingEndpointClient,
  type EmbeddingEndpointOptions,
  listEmbeddingEndpointModels,
  testEmbeddingEndpoint,
} from "@/backend/local/embedding/endpoint-client";
import type {
  CreateEmbeddingDeviceAdapterOptions,
  EmbeddingBuildWorker,
  EmbeddingDeviceAdapter,
} from "@/backend/local/embedding/gpu-build-path";
import { isEmbeddingModelInstalled } from "@/backend/local/embedding/model-download-install";
import {
  checkEmbeddingBuiltinAssets,
  type EmbeddingBuiltinAssetsOptions,
} from "@/backend/local/embedding-assets";
import type { EmbeddingEmbedCallback } from "@/backend/local/embedding-build";
import { createEmbeddingBuildEmbed } from "@/backend/local/embedding-build-embed";
import type { EmbeddingBuildDeviceSnapshot } from "@/backend/local/embedding-build-state";
import {
  type EmbeddingBuildStateSnapshot,
  embeddingBuildStatePath,
  readEmbeddingBuildState,
  snapshotEmbeddingBuildState,
} from "@/backend/local/embedding-build-state";
import {
  resolveEmbeddingAgentMemoryDir,
  scanEmbeddingBuildUnits,
} from "@/backend/local/embedding-build-units";
import {
  EMBEDDING_INDEX_CHUNKER_VERSION,
  getRecallVectorsRoot,
} from "@/backend/local/embedding-format";
import {
  EMBEDDING_PROFILE_SCHEMA_VERSION,
  type EmbeddingProfile,
  endpointFingerprint,
  readEmbeddingProfile,
} from "@/backend/local/embedding-profile";
import type {
  EmbeddingRunnerOptions,
  EmbeddingRunResult,
} from "@/backend/local/embedding-runner";
import {
  type EmbeddingSpaceIdentity,
  resolveEmbeddingSpace,
} from "@/backend/local/embedding-space";
import { migrateLegacyEmbeddingSpace } from "@/backend/local/embedding-space-migrate";
import { pruneEmbeddingSpaces } from "@/backend/local/embedding-space-retention";
import {
  hasUsableEmbeddingSpace,
  readEmbeddingSpaceSummary,
} from "@/backend/local/embedding-space-status";
import { LocalBackend } from "@/backend/local/local-backend";
import type {
  EmbeddingEndpointProbeInput,
  EmbeddingEndpointProbeResult,
  EmbeddingResetTarget,
  EmbeddingRuntimeCalibration,
  EmbeddingRuntimePort,
  EmbeddingRuntimeScope,
  EmbeddingRuntimeSpace,
  EmbeddingRuntimeStatus,
} from "@/cli/commands/embedding";
import {
  cancelEmbeddingBuild,
  type EmbeddingBuildHostError,
  type EmbeddingBuildHostOutcome,
  type EmbeddingBuildHostStartResult,
  type EmbeddingHostLifecycle,
  startEmbeddingBuild,
} from "@/cli/helpers/embedding-build-host";
import type {
  EmbeddingDetachedCommand,
  EmbeddingDetachedSpawner,
} from "@/cli/helpers/embedding-detached-child";
import { resetEmbeddingSpaces } from "@/cli/helpers/embedding-runtime-reset";
import {
  noteEmbeddingBuildProgress,
  readEmbeddingBuildStatusSnapshot,
  refreshEmbeddingBuildStatus,
} from "@/cli/hooks/use-embedding-build-status";
import {
  type ResolvedEmbeddingSettings,
  readEmbeddingSettings,
} from "@/recall-settings";
import type { EmbeddingBuildMode } from "@/types/embedding-protocol";
import { debugWarn } from "@/utils/debug";
import { getErrorMessage } from "@/utils/error";

/** Same copy `recall.ts` prints for the other store-backed subcommands. */
export const EMBEDDING_LOCAL_ONLY =
  "Vector recall is local-backend only: it builds vectors from this machine's transcripts and memory files.";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/** Environment variables a detached child needs to find the same data. */
const DETACHED_ENV_KEYS = ["HARUYUKI_HOME", "LETTA_LOCAL_BACKEND_DIR"] as const;

// ── Dependency seams ─────────────────────────────────────────────────

/**
 * Injected seams for the port. Every field defaults to production; tests use
 * them to keep a build offline (no spawn, no GPU, no real index scan).
 */
export interface EmbeddingRuntimeDeps {
  /** Backend instance; defaults to the process backend. */
  backend?: Backend;
  /** Local storage root; wins over the backend resolution (tests/CLI). */
  storageDir?: string;
  /** Recall-vectors root; defaults to B2's call-time resolver. */
  root?: string;
  /** Settings reader; defaults to the global resolved settings. */
  readSettings?: () => ResolvedEmbeddingSettings;
  /** Clock; defaults to `Date.now`. */
  clock?: () => number;
  /** Platform override for the GPU decision (tests). */
  platform?: NodeJS.Platform;
  /** Built-in asset directory overrides. */
  assets?: EmbeddingBuiltinAssetsOptions;
  /** Asset readiness probe; defaults to `checkEmbeddingBuiltinAssets`. */
  checkAssets?: typeof checkEmbeddingBuiltinAssets;
  /** Unit scanner; defaults to `scanEmbeddingBuildUnits`. */
  scanUnits?: typeof scanEmbeddingBuildUnits;
  /** A4's host start; defaults to `startEmbeddingBuild`. */
  startBuild?: typeof startEmbeddingBuild;
  /** A4's cancel; defaults to `cancelEmbeddingBuild`. */
  cancelBuild?: typeof cancelEmbeddingBuild;
  /** A3's runner; defaults to `runEmbeddingBuild` (A4's own default). */
  runBuild?: (options: EmbeddingRunnerOptions) => Promise<EmbeddingRunResult>;
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
  /** C6 test-embed; defaults to `testEmbeddingEndpoint`. */
  testEndpoint?: typeof testEmbeddingEndpoint;
  /** Endpoint model lister; defaults to `listEmbeddingEndpointModels`. */
  listEndpointModels?: typeof listEmbeddingEndpointModels;
  /** A5 synchronous snapshot; defaults to `readEmbeddingBuildStatusSnapshot`. */
  readStatusSnapshot?: typeof readEmbeddingBuildStatusSnapshot;
  /** A5 forced refresh (used when the cache is cold); defaults to A5's own. */
  refreshStatus?: typeof refreshEmbeddingBuildStatus;
  /** A4 spawn seam for a detached build; defaults to the real spawn. */
  spawnDetached?: EmbeddingDetachedSpawner;
  /** Environment for the detached child; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Lifecycle used when the caller passes none; defaults to `tui`. */
  lifecycle?: EmbeddingHostLifecycle;
}

function settingsOf(deps: EmbeddingRuntimeDeps): ResolvedEmbeddingSettings {
  return (deps.readSettings ?? readEmbeddingSettings)();
}

function clockOf(deps: EmbeddingRuntimeDeps): () => number {
  return deps.clock ?? Date.now;
}

/**
 * The local storage root, or `null` when this process is not on the local
 * backend (the only backend in this fork, but the check keeps the port honest
 * when a caller injects a different one).
 */
function resolveLocalStorageDir(deps: EmbeddingRuntimeDeps): string | null {
  if (deps.storageDir !== undefined) return deps.storageDir;
  const backend = deps.backend ?? getBackend();
  return backend instanceof LocalBackend ? backend.getLocalStorageDir() : null;
}

function recallRoot(deps: EmbeddingRuntimeDeps): string {
  return deps.root ?? getRecallVectorsRoot();
}

// ── Build ────────────────────────────────────────────────────────────

/** What {@link buildEmbeddingFromSettings} needs; the wizard and CLI share it. */
export interface BuildEmbeddingFromSettingsRequest {
  agentId: string;
  conversationId?: string | null;
  mode: EmbeddingBuildMode;
  keepAfterExit: boolean;
  /** Who owns the run; defaults to `deps.lifecycle` and then `tui`. */
  lifecycle?: EmbeddingHostLifecycle;
  /** Progress sink, forwarded on top of A5's throttled note. */
  onProgress?: (snapshot: EmbeddingBuildStateSnapshot) => void;
}

interface BuildEmbeddingResult {
  readonly receipt: string;
  /** `null` when the build was refused; disposal is then the caller's problem. */
  readonly started: EmbeddingBuildHostStartResult | null;
}

/** The profile one build records for its space (48-4 D-10). */
async function buildSpaceProfile(
  space: EmbeddingSpaceIdentity,
  settings: ResolvedEmbeddingSettings,
  now: number,
): Promise<EmbeddingProfile> {
  const existing = await readEmbeddingProfile(space.spaceDir);
  const endpoint = settings.backend === "endpoint" ? settings.endpoint : null;
  return {
    schemaVersion: EMBEDDING_PROFILE_SCHEMA_VERSION,
    backend: settings.backend,
    modelId: space.modelId,
    dimensions: space.dimensions,
    quantization: settings.quantization,
    chunkTarget: settings.chunkTarget,
    chunkMax: settings.chunkMax,
    chunkOverlap: settings.chunkOverlap,
    maxChunksPerMessage: settings.maxChunksPerMessage,
    chunkerVersion: EMBEDDING_INDEX_CHUNKER_VERSION,
    ...(endpoint === null
      ? {}
      : {
          endpoint: {
            kind: endpoint.kind,
            baseUrl: endpoint.baseUrl,
            model: endpoint.model,
            dimensions: endpoint.dimensions,
            fingerprint: endpointFingerprint(endpoint.baseUrl),
          },
        }),
    createdAt: existing?.createdAt ?? new Date(now).toISOString(),
    pinned: existing?.pinned ?? false,
  };
}

function chunkOptionsOf(settings: ResolvedEmbeddingSettings): {
  targetTokens: number;
  maxTokens: number;
  overlapTokens: number;
  maxChunksPerParent: number;
} {
  return {
    targetTokens: settings.chunkTarget,
    maxTokens: settings.chunkMax,
    overlapTokens: settings.chunkOverlap,
    maxChunksPerParent: settings.maxChunksPerMessage,
  };
}

function formatHostError(error: EmbeddingBuildHostError): string {
  return error.action === undefined
    ? error.message
    : `${error.message}\n  ${error.action}`;
}

function formatCount(value: number | null | undefined): string {
  return value === undefined || value === null ? "?" : String(value);
}

/** The receipt for a finished (or detached) build. */
function formatOutcome(
  outcome: EmbeddingBuildHostOutcome,
  degradedReason: string | null,
): string {
  const degradeNote =
    degradedReason === null
      ? ""
      : `\n  GPU unavailable: ${degradedReason}; the build used CPU.`;
  if (outcome.status === "completed") {
    const result = outcome.result;
    return (
      [
        `Build completed: ${formatCount(result?.embeddedChunks)} chunk(s) embedded, ${formatCount(result?.reusedChunks)} reused, ${formatCount(result?.failedUnits)} unit(s) failed.`,
        "Run /recall embedding status to see the space.",
      ].join("\n") + degradeNote
    );
  }
  if (outcome.status === "cancelled") {
    return (
      outcome.error?.message ??
      "The build was cancelled; committed chunks stay and the next run resumes from them."
    );
  }
  if (outcome.status === "detached") {
    return `Build detached (pid ${formatCount(outcome.detachedPid)}); it keeps running after this process exits.`;
  }
  return `${formatHostError(
    outcome.error ?? {
      code: "worker_failed",
      message: "The embedding build failed before it could report a reason.",
    },
  )}${degradeNote}`;
}

function formatDetached(
  result: Extract<EmbeddingBuildHostStartResult, { ok: true }>,
): string {
  return `Build started in the background (pid ${formatCount(result.detachedPid)}); it keeps running after this process exits. Use /recall embedding status to follow it.`;
}

function formatStarted(
  result: Extract<EmbeddingBuildHostStartResult, { ok: true }>,
  request: BuildEmbeddingFromSettingsRequest,
): string {
  if (result.phase === "detached") return formatDetached(result);
  return [
    `Build started (${request.mode}).`,
    "Progress shows in /recall embedding status; /recall embedding cancel stops it after the current batch.",
  ].join("\n");
}

/** The re-entry command a detached child runs; `null` when we cannot name one. */
function detachedCommandFor(
  request: BuildEmbeddingFromSettingsRequest,
  env: NodeJS.ProcessEnv,
): EmbeddingDetachedCommand | null {
  const entry = process.argv[1];
  if (typeof entry !== "string" || entry.length === 0) return null;
  const args = [
    entry,
    "recall",
    "embedding",
    "build",
    "--agent",
    request.agentId,
  ];
  if (request.mode === "full") args.push("--full");
  const childEnv: Record<string, string | undefined> = {};
  for (const key of DETACHED_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined) childEnv[key] = value;
  }
  return { command: process.execPath, args, env: childEnv };
}

/**
 * Start one build from the resolved settings. Shared by the TUI wizard, the
 * slash command and the CLI subcommand so the asset gate, the GPU decision and
 * the detached re-entry command cannot disagree.
 */
export async function buildEmbeddingFromSettings(
  request: BuildEmbeddingFromSettingsRequest,
  deps: EmbeddingRuntimeDeps = {},
): Promise<string> {
  try {
    const { receipt } = await startBuildFromSettings(request, deps);
    return receipt;
  } catch (error) {
    // Settings or path resolution can fail before the host is reached; a build
    // must still answer with copy the caller can render.
    debugWarn(
      "embedding",
      `embedding build could not start: ${getErrorMessage(error)}`,
    );
    return `Could not start the embedding build: ${getErrorMessage(error)}. Nothing is running.`;
  }
}

async function startBuildFromSettings(
  request: BuildEmbeddingFromSettingsRequest,
  deps: EmbeddingRuntimeDeps,
): Promise<BuildEmbeddingResult> {
  const settings = settingsOf(deps);
  const root = recallRoot(deps);
  migrateLegacyEmbeddingSpace(request.agentId, settings, { root });
  const space = resolveEmbeddingSpace(request.agentId, settings, { root });
  const profile = await buildSpaceProfile(space, settings, clockOf(deps)());
  pruneEmbeddingSpaces(request.agentId, space.spaceId, settings.keepSpaces, {
    root,
  });
  const lifecycle = request.lifecycle ?? deps.lifecycle ?? "tui";
  const keepAfterExit = request.keepAfterExit === true;

  const storageDir = resolveLocalStorageDir(deps);
  if (storageDir === null) {
    return { receipt: EMBEDDING_LOCAL_ONLY, started: null };
  }

  let embed: EmbeddingEmbedCallback;
  let disposeEmbed: () => Promise<void> = async () => {};
  let degradedReason: string | null = null;
  let device: EmbeddingBuildDeviceSnapshot | undefined;
  if (keepAfterExit) {
    // A detached child builds its own encode path; spawn no worker here.
    embed = async () => {
      throw new Error(
        "A detached build runs in its own process and never calls the parent's embed callback.",
      );
    };
  } else {
    try {
      const built = await createEmbeddingBuildEmbed(settings, deps);
      embed = built.embed;
      disposeEmbed = built.dispose;
      degradedReason = built.degradedReason;
      device = built.device;
    } catch (error) {
      return { receipt: getErrorMessage(error), started: null };
    }
  }

  const detachedCommand = keepAfterExit
    ? detachedCommandFor(request, deps.env ?? process.env)
    : undefined;
  if (keepAfterExit && detachedCommand === null) {
    await disposeEmbed();
    return {
      receipt:
        "Cannot detach this build: the process entry point is unknown. Run the build without --keep-after-exit.",
      started: null,
    };
  }

  const memoryDir = resolveEmbeddingAgentMemoryDir(storageDir, request.agentId);
  const scanUnits = deps.scanUnits ?? scanEmbeddingBuildUnits;
  const chunkOptions = chunkOptionsOf(settings);

  let started: EmbeddingBuildHostStartResult;
  try {
    started = await (deps.startBuild ?? startEmbeddingBuild)({
      lifecycle,
      identity: { agentId: request.agentId, spaceId: space.spaceId },
      modelId: space.modelId,
      backend: settings.backend,
      embed,
      units: () =>
        scanUnits({
          agentId: request.agentId,
          spaceId: space.spaceId,
          storageDir,
          memoryDir,
          chunkOptions,
        }),
      mode: request.mode,
      dimensions: space.dimensions,
      quant: space.quantization,
      root,
      keepAfterExit,
      ...(device === undefined ? {} : { device }),
      profile,
      ...(detachedCommand === null || detachedCommand === undefined
        ? {}
        : { detachedCommand }),
      onProgress: (snapshot) => {
        noteEmbeddingBuildProgress(snapshot);
        try {
          request.onProgress?.(snapshot);
        } catch (error) {
          // A display callback must never fail a build (A4 reports it too).
          debugWarn(
            "embedding",
            `build progress listener failed: ${getErrorMessage(error)}`,
          );
        }
      },
      ...(deps.runBuild === undefined ? {} : { runBuild: deps.runBuild }),
      ...(deps.spawnDetached === undefined
        ? {}
        : { spawnDetached: deps.spawnDetached }),
      // A4 repeats this gate; answer it with the directory checked above.
      ...(settings.backend === "builtin"
        ? {
            isModelInstalled: (modelId: string) =>
              isEmbeddingModelInstalled({
                modelId,
                ...(deps.assets?.modelsDir === undefined
                  ? {}
                  : { modelsDir: deps.assets.modelsDir }),
              }),
          }
        : {}),
    });
  } catch (error) {
    await disposeEmbed();
    return {
      receipt: `Could not start the embedding build: ${getErrorMessage(error)}. Nothing is running.`,
      started: null,
    };
  }

  if (!started.ok) {
    await disposeEmbed();
    return { receipt: formatHostError(started.error), started: null };
  }

  if (started.phase === "detached") {
    return { receipt: formatStarted(started, request), started };
  }

  if (lifecycle === "headless") {
    const outcome = await started.outcome;
    await disposeEmbed();
    return { receipt: formatOutcome(outcome, degradedReason), started };
  }

  // A TUI/websocket build outlives this call; release the worker at the end.
  void started.outcome.finally(() => disposeEmbed());
  return {
    receipt: `${formatStarted(started, request)}${
      degradedReason === null
        ? ""
        : `\n  GPU unavailable: ${degradedReason}; the build continues on CPU.`
    }`,
    started,
  };
}

// ── Status ───────────────────────────────────────────────────────────

function mapCalibration(
  calibration: ResolvedEmbeddingSettings["calibration"],
): EmbeddingRuntimeCalibration | null {
  if (calibration === null) return null;
  return {
    measuredAt: calibration.measuredAt,
    queryLatencyP50Ms: calibration.queryLatencyP50Ms,
    queryLatencyP90Ms: calibration.queryLatencyP90Ms,
    throughputPerSecond: calibration.batchThroughputPerSec,
    gpuRole: calibration.gpuRole,
    threads: calibration.threads,
    quantization: calibration.quantization,
  };
}

function mapBuild(
  snapshot: ReturnType<typeof readEmbeddingBuildStatusSnapshot>,
): EmbeddingRuntimeStatus["build"] {
  const build = snapshot?.build ?? null;
  if (build === null) return null;
  return {
    state: build.state,
    progress: build.progress ?? 0,
    processedChunks: build.processedChunks ?? 0,
    totalChunks: build.totalChunks ?? 0,
    etaMs: build.etaMs ?? null,
    ...(typeof build.error === "string" && build.error.length > 0
      ? { error: build.error }
      : {}),
  };
}

function endpointLeavesMachine(settings: ResolvedEmbeddingSettings): boolean {
  const endpoint = settings.endpoint;
  if (settings.backend !== "endpoint" || endpoint === null) return false;
  try {
    return !LOOPBACK_HOSTS.has(
      new URL(endpoint.baseUrl).hostname.toLowerCase(),
    );
  } catch {
    return false;
  }
}

async function builtinReady(
  settings: ResolvedEmbeddingSettings,
  deps: EmbeddingRuntimeDeps,
): Promise<boolean> {
  if (settings.backend !== "builtin") return settings.endpoint !== null;
  try {
    const check = await (deps.checkAssets ?? checkEmbeddingBuiltinAssets)(
      settings.model,
      deps.assets ?? {},
    );
    return check.installed;
  } catch {
    return false;
  }
}

async function readRuntimeStatus(
  scope: EmbeddingRuntimeScope,
  deps: EmbeddingRuntimeDeps,
): Promise<EmbeddingRuntimeStatus | null> {
  const settings = settingsOf(deps);
  const root = recallRoot(deps);
  // One-time rename of a pre-48-4 directory, so the status face shows the space
  // the user already built instead of "not built yet".
  migrateLegacyEmbeddingSpace(scope.agentId, settings, { root });
  const space = resolveEmbeddingSpace(scope.agentId, settings, { root });
  const summary = readEmbeddingSpaceSummary(space.spaceDir);
  const usable = hasUsableEmbeddingSpace(space.spaceDir);

  const readOptions = {
    root,
    spaceId: space.spaceId,
    clock: clockOf(deps),
    settings,
  };
  const readSnapshot =
    deps.readStatusSnapshot ?? readEmbeddingBuildStatusSnapshot;
  const snapshot =
    readSnapshot(scope.agentId, readOptions) ??
    (await (deps.refreshStatus ?? refreshEmbeddingBuildStatus)(
      scope.agentId,
      readOptions,
    ));

  const stateRead = await readEmbeddingBuildState(
    embeddingBuildStatePath(space.spaceDir),
    {
      agentId: scope.agentId,
      spaceId: space.spaceId,
      clock: clockOf(deps),
    },
  );
  // An unreadable/missing state.json must print "no build yet", not a 0/0 line.
  const buildSnapshot =
    stateRead.status === "ok"
      ? snapshotEmbeddingBuildState(stateRead.state)
      : null;
  const build = mapBuild(snapshot);
  const runtimeSpace: EmbeddingRuntimeSpace | null = usable
    ? {
        model: space.modelId,
        dimensions: summary.dimensions ?? space.dimensions,
        chunks: summary.chunks,
        // The summary counts conversation units and memory units separately;
        // folding them would make the status line claim more conversations
        // than exist.
        conversations: summary.conversations,
        memoryFiles: summary.memoryFiles,
        coverage: summary.coverage,
        builtAt: summary.builtAt,
      }
    : null;
  const failure =
    build?.error ??
    (snapshot?.readStatus === "corrupt"
      ? "The build state file is unreadable; the next build rewrites it."
      : null);
  return {
    ready: usable && (await builtinReady(settings, deps)),
    space: runtimeSpace,
    build,
    buildSnapshot,
    calibration: mapCalibration(settings.calibration),
    egress: endpointLeavesMachine(settings),
    failure,
  };
}

// ── Endpoint probe ───────────────────────────────────────────────────

/** Candidate wire protocols for a URL, most likely first. */
function candidateEndpointKinds(baseUrl: string): Array<"openai" | "ollama"> {
  const lower = baseUrl.toLowerCase();
  return /11434|ollama|api\/embed/.test(lower)
    ? ["ollama", "openai"]
    : ["openai", "ollama"];
}

async function firstEndpointModel(
  options: EmbeddingEndpointOptions,
  deps: EmbeddingRuntimeDeps,
): Promise<string> {
  const listed = await (deps.listEndpointModels ?? listEmbeddingEndpointModels)(
    options,
  );
  const first = listed.models[0]?.id;
  if (first === undefined || first.length === 0) {
    throw new Error(
      "The endpoint did not advertise any embedding model; pass --model with the id it serves.",
    );
  }
  return first;
}

async function probeEndpoint(
  input: EmbeddingEndpointProbeInput,
  deps: EmbeddingRuntimeDeps,
): Promise<EmbeddingEndpointProbeResult> {
  const apiKey = input.apiKey;
  const requestedModel = input.model?.trim() ?? "";
  const test = deps.testEndpoint ?? testEmbeddingEndpoint;
  let lastError: unknown = null;
  for (const kind of candidateEndpointKinds(input.baseUrl)) {
    const options: EmbeddingEndpointOptions = {
      kind,
      baseUrl: input.baseUrl,
      model: requestedModel,
      ...(apiKey === null ? {} : { apiKey }),
    };
    try {
      const model =
        requestedModel.length > 0
          ? requestedModel
          : await firstEndpointModel(options, deps);
      const tested = await test({ ...options, model });
      return {
        kind,
        model: tested.model,
        dimensions: tested.dimensions,
        timeoutMs: DEFAULT_ENDPOINT_TIMEOUT_MS,
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("The embedding endpoint could not be verified.");
}

// ── Port ─────────────────────────────────────────────────────────────

/**
 * The production `EmbeddingRuntimePort`.
 *
 * `readStatus` is fail-soft: an unreadable space/state returns `null` and the
 * command prints the settings-only view instead of an error. `build`/`cancel`/
 * `reset` return receipts, never throw for expected refusals.
 */
export function createEmbeddingRuntimePort(
  deps: EmbeddingRuntimeDeps = {},
): EmbeddingRuntimePort {
  return {
    async readStatus(
      scope: EmbeddingRuntimeScope,
    ): Promise<EmbeddingRuntimeStatus | null> {
      try {
        return await readRuntimeStatus(scope, deps);
      } catch (error) {
        debugWarn(
          "embedding",
          `embedding status could not be read: ${getErrorMessage(error)}`,
        );
        return null;
      }
    },
    async build(
      scope: EmbeddingRuntimeScope,
      mode: EmbeddingBuildMode,
      options = {},
    ): Promise<string> {
      try {
        return await buildEmbeddingFromSettings(
          {
            agentId: scope.agentId,
            conversationId: scope.conversationId,
            mode,
            keepAfterExit: options.keepAfterExit === true,
            ...(options.lifecycle === undefined
              ? {}
              : { lifecycle: options.lifecycle }),
          },
          deps,
        );
      } catch (error) {
        // The turn path must never see a thrown build error.
        return `Could not start the embedding build: ${getErrorMessage(error)}. Nothing is running.`;
      }
    },
    async cancel(_scope: EmbeddingRuntimeScope): Promise<string> {
      try {
        const result = await (deps.cancelBuild ?? cancelEmbeddingBuild)();
        if (result.cancelled) {
          return result.settled
            ? "Cancelled the embedding build; committed chunks stay and the next run resumes from them."
            : "Cancelling the embedding build; it stops at its next checkpoint (at most one batch).";
        }
        return [
          "No embedding build is running in this process.",
          "A build started by another process (or a detached child) is not this process's to stop; check /recall embedding status.",
        ].join("\n");
      } catch (error) {
        return `Could not cancel the embedding build: ${getErrorMessage(error)}`;
      }
    },
    async reset(
      scope: EmbeddingRuntimeScope,
      target: EmbeddingResetTarget,
    ): Promise<string> {
      try {
        return resetEmbeddingSpaces({
          scope,
          target,
          settings: settingsOf(deps),
          root: recallRoot(deps),
        });
      } catch (error) {
        return `Could not delete the vector space: ${getErrorMessage(error)}. Nothing outside the recall root was touched.`;
      }
    },
    async configureEndpoint(
      input: EmbeddingEndpointProbeInput,
    ): Promise<EmbeddingEndpointProbeResult> {
      return await probeEndpoint(input, deps);
    },
  };
}
