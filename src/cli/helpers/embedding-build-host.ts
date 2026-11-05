/**
 * Embedding build host (feature 48, package A4).
 *
 * A3's runner is a loop; this module decides *where that loop lives*. User
 * ruling f7 (48-1 R-34, 48-2 §4.8) is that **by default the build dies with its
 * host**: a closed TUI, a finished headless command and a disposed websocket
 * listener all cancel the run, keeping at most one batch of work and resuming
 * from the A3 checkpoint next time. Only the explicit `keepAfterExit` opt-in
 * spawns a detached child that outlives its parent.
 *
 * Three lifetimes, one rule: `tui`/`websocket` cancel on unmount/dispose and
 * wait ≤200 ms (one batch); `headless` awaits `startEmbeddingBuild().outcome`
 * unless `keepAfterExit` detached it; no lifecycle at all is a typed `no_host`.
 *
 * It never downloads a model, starts a real ONNX/worker/network call (`embed` is
 * injected; C3/C6 adapters below), or hard-codes a child entry (the caller
 * supplies `detachedCommand`). No native module is imported. Progress
 * throttling/`device_status.embedding` are A5/D6's.
 *
 * Layer: `cli/helpers/`. Imports `backend/local/` (allowed for the CLI); no UI.
 */

import { join } from "node:path";

import type { EmbeddingCalibrationBudget } from "@/backend/local/embedding/calibration";
import {
  isEmbeddingModelInstalled,
  resolveEmbeddingModelPaths,
} from "@/backend/local/embedding/model-download-install";
import type { EmbeddingEmbedCallback } from "@/backend/local/embedding-build";
import type {
  EmbeddingBuildDeviceSnapshot,
  EmbeddingBuildIdentity,
  EmbeddingBuildStateSnapshot,
} from "@/backend/local/embedding-build-state";
import {
  type EmbeddingIndexQuant,
  getRecallVectorsRoot,
} from "@/backend/local/embedding-format";
import {
  type EmbeddingBuildLockEnvironment,
  type EmbeddingBuildLockInspection,
  inspectEmbeddingBuildLock,
} from "@/backend/local/embedding-lock";
import type { EmbeddingProfile } from "@/backend/local/embedding-profile";
import { writeEmbeddingProfileBestEffort } from "@/backend/local/embedding-profile";
import {
  type EmbeddingRunError,
  type EmbeddingRunnerOptions,
  type EmbeddingRunResult,
  type EmbeddingRunUnit,
  runEmbeddingBuild,
} from "@/backend/local/embedding-runner";
import type {
  EmbeddingBackendKind,
  EmbeddingBuildMode,
  EmbeddingBuildState,
} from "@/types/embedding-protocol";
import { debugWarn } from "@/utils/debug";
import { getErrorMessage } from "@/utils/error";
import {
  type EmbeddingDetachedChild,
  type EmbeddingDetachedCommand,
  type EmbeddingDetachedSpawner,
  spawnDetachedBuildChild,
} from "./embedding-detached-child";

/** How long a host waits for the runner to reach its next checkpoint on exit. */
export const EMBEDDING_BUILD_HOST_EXIT_WAIT_MS = 200;

/** The three hosts that may own a build (48-2 §4.8). */
export type EmbeddingHostLifecycle = "tui" | "headless" | "websocket";

const HOST_LIFECYCLES: readonly string[] = ["tui", "headless", "websocket"];

/** Same segment rule A3's runner and B2's writer apply to path segments. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isHostLifecycle(value: unknown): value is EmbeddingHostLifecycle {
  return typeof value === "string" && HOST_LIFECYCLES.includes(value);
}

/** The opt-in gate: f7 is not configurable, so only the literal `true` counts. */
export function shouldKeepAfterExit(keepAfterExit: unknown): boolean {
  return keepAfterExit === true;
}

/** Why a build could not start or did not finish normally. */
export type EmbeddingBuildHostErrorCode =
  | "model_missing"
  | "not_configured"
  | "lock_held"
  | "worker_failed"
  | "aborted"
  | "already_running"
  | "no_host";

/** A typed refusal/outcome; the host never throws for these. */
export interface EmbeddingBuildHostError {
  code: EmbeddingBuildHostErrorCode;
  message: string;
  /** Copy-paste remedy when the user can fix the state. */
  action?: string;
}

function hostError(
  code: EmbeddingBuildHostErrorCode,
  message: string,
  action?: string,
): EmbeddingBuildHostError {
  return action === undefined ? { code, message } : { code, message, action };
}

function refuse(
  code: EmbeddingBuildHostErrorCode,
  message: string,
  action?: string,
): EmbeddingBuildHostStartResult {
  return { ok: false, error: hostError(code, message, action) };
}

function modelMissingError(modelId: string): EmbeddingBuildHostError {
  let modelDir: string | null = null;
  try {
    modelDir = resolveEmbeddingModelPaths({ modelId }).modelDir;
  } catch {
    // An unknown model id has no directory; the remedy is still the wizard.
  }
  return hostError(
    "model_missing",
    `Embedding model ${modelId} is not installed; the build will not download it automatically.`,
    `Run "/recall embedding connect" (or "haruyuki recall embedding setup") to download it${
      modelDir === null ? "" : ` into ${modelDir}`
    }, then start the build again. A manual import works too.`,
  );
}

function lockHeldError(
  inspection: EmbeddingBuildLockInspection,
): EmbeddingBuildHostError {
  const owner = inspection.record;
  const who =
    owner === null ? "another process" : `pid ${owner.pid} on ${owner.host}`;
  return hostError(
    "lock_held",
    `Another embedding build owns this index space (${who}).`,
    "Wait for it to finish, or cancel it first (/recall embedding cancel).",
  );
}

/** Maps A3's fatal run codes onto the host's coarse classification. */
function mapRunnerError(
  error: EmbeddingRunError | undefined,
): EmbeddingBuildHostError {
  const message =
    error?.message ??
    "The embedding build failed before it could report a reason.";
  if (error?.code === "lock_held" || error?.code === "lock_busy") {
    return hostError("lock_held", message);
  }
  if (error?.code === "invalid_input") {
    return hostError("not_configured", message);
  }
  return hostError("worker_failed", message);
}

/** What the host did about C5's budget before starting the runner. */
export type EmbeddingBuildHostCalibration =
  | { status: "used"; budget: EmbeddingCalibrationBudget }
  | { status: "skipped"; reason: string }
  | { status: "failed"; message: string };

/**
 * Resolves the budget without ever failing the build. A live pass that throws
 * is reported and the build continues on A3's defaults, because a failed
 * 5-second measurement must not block a 5-minute index (48-1 §6.6).
 */
async function resolveCalibration(
  options: EmbeddingBuildHostOptions,
): Promise<EmbeddingBuildHostCalibration> {
  if (options.skipCalibration === true) {
    return { status: "skipped", reason: "calibration skipped by the caller" };
  }
  if (options.budget !== undefined) {
    return { status: "used", budget: options.budget };
  }
  if (options.calibrate === undefined) {
    return {
      status: "skipped",
      reason: "no calibration budget was provided; the runner's defaults apply",
    };
  }
  try {
    const budget = await options.calibrate();
    return budget === null
      ? { status: "skipped", reason: "calibration produced no budget" }
      : { status: "used", budget };
  } catch (error) {
    return {
      status: "failed",
      message: `Calibration failed and was skipped: ${getErrorMessage(error)}`,
    };
  }
}

// ── Embed adapters (C3 / C6 → A3) ───────────────────────────────────────────

export interface EmbeddingBuiltinEmbedSource {
  embedBatched(
    texts: readonly string[],
    options?: { batchSize?: number; signal?: AbortSignal },
  ): Promise<{ vectors: readonly (Float32Array | null)[]; cancelled: boolean }>;
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

export function createBuiltinEmbedAdapter(
  source: EmbeddingBuiltinEmbedSource,
  options: { batchSize?: number; signal?: AbortSignal } = {},
): EmbeddingEmbedCallback {
  return async (chunks) => {
    const output = await source.embedBatched(
      chunks.map((chunk) => chunk.text),
      options,
    );
    return assertVectors(
      output.vectors,
      chunks.length,
      output.cancelled,
      "The embedding worker",
    );
  };
}

// ── Host options ────────────────────────────────────────────────────────────

/** Units handed over materialised, or produced lazily right before the run. */
export type EmbeddingBuildUnitsSource =
  | Iterable<EmbeddingRunUnit>
  | (() => Iterable<EmbeddingRunUnit> | Promise<Iterable<EmbeddingRunUnit>>);

/** Timer seam so the exit-wait test does not sleep 200 ms. */
export interface EmbeddingBuildHostTimers {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

/** Everything one host run needs; all I/O seams default to production modules. */
export interface EmbeddingBuildHostOptions {
  /** Which lifetime owns the build; an unknown value is a typed `no_host`. */
  lifecycle: EmbeddingHostLifecycle;
  /** `(agentId, spaceId)`: the space whose lock/state/index live together. */
  identity: EmbeddingBuildIdentity;
  /** Model id recorded in the generation and checked against C4's marker. */
  modelId: string;
  /** `builtin` gates on C4's install marker; `endpoint` sends text out instead. */
  backend?: EmbeddingBackendKind;
  /** A3's adapter. Required for an in-process run. */
  embed?: EmbeddingEmbedCallback;
  /** Units to build. Required in-process; a detached child scans its own. */
  units?: EmbeddingBuildUnitsSource;
  mode?: EmbeddingBuildMode;
  dimensions?: number;
  /** Storage precision of the target space; defaults to `f32`. */
  quant?: EmbeddingIndexQuant;
  /** Recall-vectors root; defaults to B2's call-time resolver. */
  root?: string;
  /** Space directory; defaults to `<root>/<agentId>/<spaceId>`. */
  spaceDir?: string;
  /** Opt-in only: detach the build so it outlives this host. Default `false`. */
  keepAfterExit?: boolean;
  /** Required when `keepAfterExit` is true; this build's own re-entry command. */
  detachedCommand?: EmbeddingDetachedCommand;
  budget?: EmbeddingCalibrationBudget;
  calibrate?: () => Promise<EmbeddingCalibrationBudget | null>;
  skipCalibration?: boolean;
  /** A2 checkpoint passthrough; A5/D6 own the ≤0.5 Hz throttle. */
  onProgress?: (snapshot: EmbeddingBuildStateSnapshot) => void;
  lockEnvironment?: EmbeddingBuildLockEnvironment;
  clock?: () => number;
  timers?: EmbeddingBuildHostTimers;
  /** C4 seam: model-installed probe. Defaults to the real install marker check. */
  isModelInstalled?: (modelId: string) => Promise<boolean>;
  /** A2 seam: read-only lock preflight. Defaults to `inspectEmbeddingBuildLock`. */
  inspectLock?: (spaceDir: string) => Promise<EmbeddingBuildLockInspection>;
  /** A3 seam: the runner. Defaults to `runEmbeddingBuild`. */
  runBuild?: (options: EmbeddingRunnerOptions) => Promise<EmbeddingRunResult>;
  /** Spawn seam for the detached child. Defaults to the real `spawn`. */
  spawnDetached?: EmbeddingDetachedSpawner;
  /** Device facts of this run, forwarded to A2's checkpoint (48-4 D-02). */
  device?: EmbeddingBuildDeviceSnapshot;
  /** Space profile written once the lock is held (48-4 D-10). */
  profile?: EmbeddingProfile;
}

// ── Host state and results ──────────────────────────────────────────────────

/** A2's protocol vocabulary plus the host-only `detached` phase. */
export type EmbeddingBuildHostPhase = EmbeddingBuildState | "detached";

export interface EmbeddingBuildHostState {
  phase: EmbeddingBuildHostPhase;
  lifecycle: EmbeddingHostLifecycle | null;
  identity: EmbeddingBuildIdentity | null;
  spaceDir: string | null;
  modelId: string | null;
  backend: EmbeddingBackendKind | null;
  keepAfterExit: boolean;
  buildId: string | null;
  progress: EmbeddingBuildStateSnapshot | null;
  result: EmbeddingRunResult | null;
  error: EmbeddingBuildHostError | null;
  calibration: EmbeddingBuildHostCalibration | null;
  detachedPid: number | null;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface EmbeddingBuildHostOutcome {
  status: "completed" | "cancelled" | "failed" | "detached";
  error: EmbeddingBuildHostError | null;
  result: EmbeddingRunResult | null;
  progress: EmbeddingBuildStateSnapshot | null;
  calibration: EmbeddingBuildHostCalibration | null;
  detachedPid: number | null;
}

/** `startEmbeddingBuild`'s typed answer: either a refusal or a running build. */
export type EmbeddingBuildHostStartResult =
  | {
      ok: true;
      phase: "running" | "detached";
      buildId: string | null;
      detachedPid: number | null;
      /** In-process: resolves at the terminal checkpoint/failure. Detached: immediately. */
      outcome: Promise<EmbeddingBuildHostOutcome>;
    }
  | { ok: false; error: EmbeddingBuildHostError };

/** Options for {@link cancelEmbeddingBuild}. */
export interface EmbeddingBuildCancelOptions {
  /** Max time to wait for the runner's checkpoint. Default 200 ms (one batch). */
  timeoutMs?: number;
  reason?: string;
}

export interface EmbeddingBuildCancelResult {
  /** A run was in flight and this call left a cancellation in effect. */
  cancelled: boolean;
  /** The in-process runner reached a checkpoint inside the wait. */
  settled: boolean;
  phase: EmbeddingBuildHostPhase;
}

// ── Module state ────────────────────────────────────────────────────────────

interface RunningBuild {
  generation: number;
  controller: AbortController;
  detachedChild: EmbeddingDetachedChild | null;
  abortRequested: boolean;
  abortReason: string | null;
  finished: boolean;
  progress: EmbeddingBuildStateSnapshot | null;
  timers: EmbeddingBuildHostTimers;
  resolveOutcome: (outcome: EmbeddingBuildHostOutcome) => void;
  outcome: Promise<EmbeddingBuildHostOutcome>;
}

interface HostIdentity {
  identity: EmbeddingBuildIdentity;
  spaceDir: string;
  clock: () => number;
}

const REAL_TIMERS: EmbeddingBuildHostTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

let hostGeneration = 0;
let hostState = createIdleHostState();
let hostIdentity: HostIdentity | null = null;
let current: RunningBuild | null = null;

function createIdleHostState(): EmbeddingBuildHostState {
  return {
    phase: "idle",
    lifecycle: null,
    identity: null,
    spaceDir: null,
    modelId: null,
    backend: null,
    keepAfterExit: false,
    buildId: null,
    progress: null,
    result: null,
    error: null,
    calibration: null,
    detachedPid: null,
    startedAt: null,
    finishedAt: null,
  };
}

function patchHostState(patch: Partial<EmbeddingBuildHostState>): void {
  hostState = { ...hostState, ...patch };
}

function emptyOutcome(
  status: EmbeddingBuildHostOutcome["status"],
  patch: Partial<EmbeddingBuildHostOutcome> = {},
): EmbeddingBuildHostOutcome {
  return {
    status,
    error: null,
    result: null,
    progress: null,
    calibration: null,
    detachedPid: null,
    ...patch,
  };
}

function createRun(
  generation: number,
  detachedChild: EmbeddingDetachedChild | null,
  timers: EmbeddingBuildHostTimers,
): RunningBuild {
  let resolveOutcome: (outcome: EmbeddingBuildHostOutcome) => void = () => {};
  const outcome = new Promise<EmbeddingBuildHostOutcome>((resolve) => {
    resolveOutcome = resolve;
  });
  return {
    generation,
    controller: new AbortController(),
    detachedChild,
    abortRequested: false,
    abortReason: null,
    finished: false,
    progress: null,
    timers,
    resolveOutcome,
    outcome,
  };
}

// ── Public state ────────────────────────────────────────────────────────────

/** The current (or last) host state. A copy: callers cannot mutate host state. */
export function getEmbeddingBuildHostState(): EmbeddingBuildHostState {
  return { ...hostState };
}

// ── Start ───────────────────────────────────────────────────────────────────

async function resolveUnits(
  source: EmbeddingBuildUnitsSource,
): Promise<EmbeddingRunUnit[]> {
  const produced = typeof source === "function" ? await source() : source;
  return Array.from(produced);
}

/** Start one build under the caller's lifecycle, or refuse with a typed error. */
export async function startEmbeddingBuild(
  options: EmbeddingBuildHostOptions,
): Promise<EmbeddingBuildHostStartResult> {
  if (current !== null && !current.finished) {
    return refuse(
      "already_running",
      "An embedding build is already running in this process.",
      "Cancel it first (/recall embedding cancel), or wait for it to finish.",
    );
  }
  if (!isHostLifecycle(options.lifecycle)) {
    return refuse(
      "no_host",
      "No host lifecycle owns this build; nothing was started.",
      "Pass lifecycle tui, headless or websocket — a build with no owner would never be cancelled.",
    );
  }
  const identityInput: Partial<EmbeddingBuildIdentity> = options.identity ?? {};
  const { agentId, spaceId } = identityInput;
  if (
    typeof agentId !== "string" ||
    typeof spaceId !== "string" ||
    !SAFE_SEGMENT.test(agentId) ||
    !SAFE_SEGMENT.test(spaceId)
  ) {
    return refuse(
      "not_configured",
      "The build needs a safe non-empty agentId and spaceId.",
      "Resolve the active agent before starting the build.",
    );
  }
  if (typeof options.modelId !== "string" || options.modelId.length === 0) {
    return refuse(
      "not_configured",
      "The build needs a non-empty embedding model id.",
      "Pick a model in /recall embedding connect first.",
    );
  }

  const keepAfterExit = shouldKeepAfterExit(options.keepAfterExit);
  const backend = options.backend ?? "builtin";
  const clock = options.clock ?? Date.now;
  const timers = options.timers ?? REAL_TIMERS;
  const identity: EmbeddingBuildIdentity = { agentId, spaceId };
  const spaceDir =
    options.spaceDir ??
    join(
      options.root ?? getRecallVectorsRoot(),
      identity.agentId,
      identity.spaceId,
    );

  if (keepAfterExit) {
    if (options.detachedCommand === undefined) {
      return refuse(
        "not_configured",
        "keepAfterExit needs the detached entry command, but none was supplied.",
        "Pass detachedCommand (this build's own entry plus its keep-after-exit flags).",
      );
    }
  } else if (typeof options.embed !== "function") {
    return refuse(
      "not_configured",
      "The in-process build needs an embed callback.",
      "Use createBuiltinEmbedAdapter or createEndpointEmbedAdapter to adapt the runtime client.",
    );
  } else if (options.units === undefined) {
    return refuse(
      "not_configured",
      "The in-process build needs a units provider.",
      "Pass the conversations and memory files to index (or a function that scans them).",
    );
  }

  // ── C4: never download; only report an actionable missing model ──────────
  if (backend === "builtin") {
    const isInstalled =
      options.isModelInstalled ??
      ((modelId: string) => isEmbeddingModelInstalled({ modelId }));
    let installed: boolean;
    try {
      installed = await isInstalled(options.modelId);
    } catch (error) {
      return refuse(
        "not_configured",
        `The embedding model install could not be verified: ${getErrorMessage(error)}`,
        "Run /recall embedding connect to check or reinstall the model.",
      );
    }
    if (!installed) {
      return { ok: false, error: modelMissingError(options.modelId) };
    }
  }

  // ── A2: read-only lock preflight (A3 still owns the authoritative acquire) ─
  const inspectLock =
    options.inspectLock ??
    ((dir: string) =>
      options.lockEnvironment === undefined
        ? inspectEmbeddingBuildLock(dir)
        : inspectEmbeddingBuildLock(dir, options.lockEnvironment));
  try {
    const inspection = await inspectLock(spaceDir);
    if (inspection.status === "live") {
      return { ok: false, error: lockHeldError(inspection) };
    }
  } catch (error) {
    // A preflight read failure is advisory only; A3's acquire reports the truth.
    debugWarn(
      "embedding",
      `could not preflight the build lock: ${getErrorMessage(error)}`,
    );
  }

  hostIdentity = { identity, spaceDir, clock };
  if (keepAfterExit) {
    return startDetachedChild(
      options,
      identity,
      spaceDir,
      backend,
      clock,
      timers,
    );
  }

  // ── C5: a failed/skipped calibration never blocks the build ──────────────
  const calibration = await resolveCalibration(options);
  const generation = hostGeneration + 1;
  hostGeneration = generation;
  const run = createRun(generation, null, timers);
  current = run;
  const buildId = null;
  hostState = {
    ...createIdleHostState(),
    phase: "running",
    lifecycle: options.lifecycle,
    identity,
    spaceDir,
    modelId: options.modelId,
    backend,
    buildId,
    calibration,
    startedAt: clock(),
  };
  void executeInProcess(run, options, identity, spaceDir, calibration);
  return {
    ok: true,
    phase: "running",
    buildId,
    detachedPid: null,
    outcome: run.outcome,
  };
}

function startDetachedChild(
  options: EmbeddingBuildHostOptions,
  identity: EmbeddingBuildIdentity,
  spaceDir: string,
  backend: EmbeddingBackendKind,
  clock: () => number,
  timers: EmbeddingBuildHostTimers,
): EmbeddingBuildHostStartResult {
  const command = options.detachedCommand;
  if (command === undefined) {
    // Unreachable: startEmbeddingBuild checks this before calling.
    return refuse(
      "not_configured",
      "keepAfterExit needs a detached entry command.",
    );
  }
  const spawnDetached = options.spawnDetached ?? spawnDetachedBuildChild;
  const env: NodeJS.ProcessEnv = { ...process.env, ...(command.env ?? {}) };
  let child: EmbeddingDetachedChild;
  try {
    child = spawnDetached(command.command, command.args ?? [], {
      detached: true,
      windowsHide: true,
      stdio: "ignore",
      env,
      ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
    });
  } catch (error) {
    return refuse(
      "worker_failed",
      `The detached build process could not be started: ${getErrorMessage(error)}`,
    );
  }
  child.unref();

  // `spawn` reports ENOENT/EACCES as an async `error` event, not a throw, and
  // leaves `pid` undefined. Reporting "detached" there would tell the user a
  // build is running when nothing started.
  const detachedPid = child.pid ?? null;
  if (detachedPid === null) {
    return refuse(
      "worker_failed",
      `The detached build process "${command.command}" did not start (no pid was assigned).`,
      "Check that the command exists, or run the build in-process instead.",
    );
  }
  const generation = hostGeneration + 1;
  hostGeneration = generation;
  const run = createRun(generation, child, timers);
  const calibration: EmbeddingBuildHostCalibration = {
    status: "skipped",
    reason: "the detached child owns its own calibration",
  };
  current = run;
  hostState = {
    ...createIdleHostState(),
    phase: "detached",
    lifecycle: options.lifecycle,
    identity,
    spaceDir,
    modelId: options.modelId,
    backend,
    keepAfterExit: true,
    calibration,
    detachedPid,
    startedAt: clock(),
  };
  run.resolveOutcome(emptyOutcome("detached", { calibration, detachedPid }));
  return {
    ok: true,
    phase: "detached",
    buildId: null,
    detachedPid,
    outcome: run.outcome,
  };
}

async function executeInProcess(
  run: RunningBuild,
  options: EmbeddingBuildHostOptions,
  identity: EmbeddingBuildIdentity,
  spaceDir: string,
  calibration: EmbeddingBuildHostCalibration,
): Promise<void> {
  const clock = options.clock ?? Date.now;
  let units: EmbeddingRunUnit[];
  try {
    // The two are optional on the type only so a detached start can omit them.
    units = await resolveUnits(options.units as EmbeddingBuildUnitsSource);
  } catch (error) {
    completeBuild(
      run,
      emptyOutcome("failed", {
        error: hostError(
          "worker_failed",
          `The units provider failed before the run: ${getErrorMessage(error)}`,
        ),
        progress: run.progress,
        calibration,
      }),
    );
    return;
  }
  const runnerOptions: EmbeddingRunnerOptions = {
    identity,
    units,
    embed: options.embed as EmbeddingEmbedCallback,
    modelId: options.modelId,
    spaceDir,
    clock,
    signal: run.controller.signal,
    isAborted: () => run.abortRequested,
    onProgress: (snapshot) => {
      run.progress = snapshot;
      if (run.generation === hostGeneration) {
        patchHostState({ progress: snapshot });
      }
      try {
        options.onProgress?.(snapshot);
      } catch (error) {
        // A display callback must never fail a build.
        debugWarn(
          "embedding",
          `progress listener failed: ${getErrorMessage(error)}`,
        );
      }
    },
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    ...(options.dimensions === undefined
      ? {}
      : { dimensions: options.dimensions }),
    ...(options.quant === undefined ? {} : { quant: options.quant }),
    ...(calibration.status === "used" ? { budget: calibration.budget } : {}),
    ...(options.lockEnvironment === undefined
      ? {}
      : { lockEnvironment: options.lockEnvironment }),
    ...(options.device === undefined ? {} : { device: options.device }),
  };

  let result: EmbeddingRunResult;
  // The profile describes the space; writing it before the run makes the space
  // selectable even if the runner refuses (a lock held by a stale process).
  if (options.profile !== undefined) {
    await writeEmbeddingProfileBestEffort(spaceDir, options.profile);
  }
  try {
    result = await (options.runBuild ?? runEmbeddingBuild)(runnerOptions);
  } catch (error) {
    completeBuild(
      run,
      emptyOutcome("failed", {
        error: hostError(
          "worker_failed",
          `The embedding runner failed unexpectedly: ${getErrorMessage(error)}`,
        ),
        progress: run.progress,
        calibration,
      }),
    );
    return;
  }
  completeBuild(run, outcomeFromRunResult(run, result, calibration));
}

function outcomeFromRunResult(
  run: RunningBuild,
  result: EmbeddingRunResult,
  calibration: EmbeddingBuildHostCalibration,
): EmbeddingBuildHostOutcome {
  const patch: Partial<EmbeddingBuildHostOutcome> = {
    result,
    progress: result.state ?? run.progress,
    calibration,
  };
  if (result.status === "completed") return emptyOutcome("completed", patch);
  if (result.status === "aborted") {
    return emptyOutcome("cancelled", {
      ...patch,
      error: hostError(
        "aborted",
        "The build was cancelled; every committed checkpoint is kept and the next run resumes from it.",
      ),
    });
  }
  return emptyOutcome("failed", {
    ...patch,
    error: mapRunnerError(result.error),
  });
}

function completeBuild(
  run: RunningBuild,
  outcome: EmbeddingBuildHostOutcome,
): void {
  if (run.finished) return;
  run.finished = true;
  if (run.generation === hostGeneration) {
    patchHostState({
      phase: outcome.status,
      progress: outcome.progress ?? hostState.progress,
      result: outcome.result,
      error: outcome.error,
      calibration: outcome.calibration ?? hostState.calibration,
      finishedAt: (hostIdentity?.clock ?? Date.now)(),
    });
  }
  run.resolveOutcome(outcome);
}

// ── Cancel / teardown ───────────────────────────────────────────────────────

/**
 * Ask the running build to stop and wait up to one batch for its checkpoint.
 * Idempotent; after the wait expires the runner still stops at its next boundary
 * ("≤1 batch" is the worst case), so the caller may exit immediately. For a child
 * this process detached, the handle is signalled; orphans are A5/C7's problem.
 */
export async function cancelEmbeddingBuild(
  options: EmbeddingBuildCancelOptions = {},
): Promise<EmbeddingBuildCancelResult> {
  const run = current;
  const timeoutMs = options.timeoutMs ?? EMBEDDING_BUILD_HOST_EXIT_WAIT_MS;
  if (run === null || run.finished) {
    return { cancelled: false, settled: true, phase: hostState.phase };
  }

  if (run.detachedChild !== null) {
    let killed = false;
    try {
      killed = run.detachedChild.kill?.("SIGTERM") ?? false;
    } catch {
      killed = false;
    }
    run.finished = true;
    if (run.generation === hostGeneration) {
      patchHostState({
        phase: killed ? "cancelled" : "failed",
        error: killed
          ? null
          : hostError(
              "worker_failed",
              "The detached build process could not be signalled; it may still be running.",
              "Wait for the child to finish; A2's state.json is authoritative.",
            ),
        finishedAt: (hostIdentity?.clock ?? Date.now)(),
      });
    }
    return { cancelled: killed, settled: true, phase: hostState.phase };
  }

  if (!run.abortRequested) {
    run.abortRequested = true;
    run.abortReason = options.reason ?? "cancel";
    try {
      run.controller.abort(run.abortReason);
    } catch {
      // An already-aborted controller is the same outcome.
    }
    if (run.generation === hostGeneration) {
      patchHostState({ phase: "cancelling" });
    }
  }
  const settled = await waitForSettle(run, timeoutMs);
  return { cancelled: true, settled, phase: hostState.phase };
}

async function waitForSettle(
  run: RunningBuild,
  timeoutMs: number,
): Promise<boolean> {
  if (run.finished) return true;
  if (!(timeoutMs > 0)) return false;
  await new Promise<void>((resolve) => {
    let settled = false;
    let handle: unknown = null;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (handle !== null) run.timers.clearTimeout(handle);
      resolve();
    };
    handle = run.timers.setTimeout(finish, timeoutMs);
    run.outcome.then(finish, finish);
  });
  return run.finished;
}

/**
 * Drop this process's host bookkeeping (process teardown, tests). An in-flight
 * run is aborted so it stops at its next checkpoint but its late result no longer
 * touches host state; a detached child is not killed (that is the opt-in).
 */
export function resetEmbeddingBuildHost(): void {
  const run = current;
  current = null;
  hostGeneration += 1;
  hostIdentity = null;
  hostState = createIdleHostState();
  if (run === null || run.finished) return;
  run.finished = true;
  run.abortRequested = true;
  run.abortReason = "host_reset";
  try {
    run.controller.abort(run.abortReason);
  } catch {
    // Already aborted.
  }
  run.resolveOutcome(
    emptyOutcome("cancelled", {
      error: hostError(
        "aborted",
        "The host was torn down before the build finished.",
      ),
      progress: run.progress,
      detachedPid: run.detachedChild?.pid ?? null,
    }),
  );
}
