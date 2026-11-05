/**
 * The vector-recall connect wizard's state machine (48-2 §4.9, D5).
 *
 * Four numbered steps — backend → configuration (GPU, precision, install check,
 * built-in download or endpoint test) → calibration → finish. Three properties
 * are why this lives apart from the component:
 *
 * - **Cancel writes nothing.** Answers stay here until the final step, whose
 *   `saveSettings` + `saveApiKey` + build start is the only write path.
 * - **A failed step keeps its answers.** A thrown download, refused URL, timed
 *   out calibration or failed settings write lands as state on that step.
 * - **The key is never rendered.** Only the env-var name is painted; the typed
 *   key is masked by the component and never enters a user-facing string.
 *
 * Transitions are pure; the async runners live in `embedding-wizard-actions`
 * and feed outcomes back through `applyEmbeddingWizardEvent`. The injected
 * dependency contract (`EmbeddingWizardDeps`) is declared here beside the state
 * it serves; nothing here reads the network, the model cache or settings.
 */

import {
  type EmbeddingSettingsPatch,
  validateEmbeddingModelInput,
} from "@/cli/app/pages/settings/embedding-settings";
import {
  type EmbeddingWizardStep,
  embeddingWizardModelOptions,
  isEmbeddingWizardEnvName,
  validateEmbeddingWizardEndpointUrl,
} from "@/cli/helpers/embedding-wizard-facts";
import {
  EMBEDDING_SETTING_DEFAULTS,
  type EmbeddingEndpointSettings,
  type ResolvedEmbeddingSettings,
} from "@/recall-settings";
import type {
  EmbeddingBackendKind,
  EmbeddingBuildMode,
  EmbeddingEndpointKind,
  EmbeddingGpuRole,
  EmbeddingQuantization,
} from "@/types/embedding-protocol";

// ── State ──────────────────────────────────────────────────────────────────

/** Which of step 2's two installs exist on disk, and where. */
export interface EmbeddingWizardInstallCheckState {
  phase: "idle" | "checking" | "done" | "failed";
  error: string | null;
  modelInstalled: boolean;
  runtimeInstalled: boolean;
  modelDir: string | null;
  runtimeDir: string | null;
}

/**
 * The download half of step 2. The built-in backend needs two installs — the
 * model weights and the onnxruntime closure — so this state tracks both and the
 * screen still prints one combined percentage.
 */
export interface EmbeddingWizardDownloadState {
  phase: "idle" | "running" | "done" | "failed";
  /** 0..1 across both transfers; the screen prints one percentage. */
  progress: number;
  error: string | null;
  /** Offered on failure: the offline-import hint, never a second write path. */
  hint: string | null;
  modelDir: string | null;
  runtimeDir: string | null;
  alreadyInstalled: boolean;
  /** Sub-transfer completion; the runner skips whatever is already done. */
  runtimeDone: boolean;
  modelDone: boolean;
}

/** One test-embed outcome, as the frame paints it. */
export interface EmbeddingWizardEndpointTest {
  phase: "idle" | "running" | "passed" | "failed";
  /** Model id the endpoint reported (may differ from the one typed). */
  model: string | null;
  dimensions: number | null;
  /** L2 norm of the returned vector; C6 validates it against 1 ± tolerance. */
  norm: number | null;
  latencyMs: number | null;
  error: string | null;
}

/** The endpoint half of step 2. */
export interface EmbeddingWizardEndpointState {
  kind: EmbeddingEndpointKind;
  baseUrl: string;
  model: string;
  /** Name of an environment variable holding the key; empty = not used. */
  apiKeyEnv: string;
  /** A key typed directly into the masked field; empty = not used. */
  apiKey: string;
  test: EmbeddingWizardEndpointTest;
  /** The verified endpoint form the finish step writes (null until tested). */
  verified: EmbeddingEndpointSettings | null;
}

/** The bounded-calibration result, in the shape the finish step paints. */
export interface EmbeddingWizardCalibration {
  fingerprint: string;
  measuredAt: string;
  p50Ms: number;
  p90Ms: number;
  throughputPerSec: number;
  gpuRole: EmbeddingGpuRole;
  threads: number;
  quantization: EmbeddingQuantization;
  /** False means the numbers are C5's documented defaults, not measurements. */
  calibrated: boolean;
  reason: string | null;
  tier: string;
  queryBudgetMs: number;
  rssBytes: number;
  diskFreeBytes: number;
  diskHeadroomOk: boolean;
}

/** Step 3's lifecycle. */
export interface EmbeddingWizardCalibrationState {
  phase: "idle" | "running" | "done" | "skipped" | "failed";
  result: EmbeddingWizardCalibration | null;
  error: string | null;
}

/** Step 4's lifecycle. */
export interface EmbeddingWizardFinishState {
  /** The keep-building switch in step 4; off by default (48-2 §4.8, R-34). */
  keepAfterExit: boolean;
  /** The build request's mode; no settings key carries it (48-2 A4). */
  buildMode: EmbeddingBuildMode;
  phase: "ready" | "saving" | "failed" | "done";
  error: string | null;
  /** What the build start reported; the overlay prints it as the receipt. */
  buildReceipt: string | null;
}

/** The whole wizard state; every screen is a projection of this one value. */
export interface EmbeddingWizardState {
  step: EmbeddingWizardStep;
  /** The backend decided in step 1; `null` only before the picker is answered. */
  backend: EmbeddingBackendKind | null;
  /** The GPU role step 2 asks for, written to the settings patch. */
  gpu: EmbeddingGpuRole;
  /** Storage precision step 2 asks for, written to the settings patch. */
  precision: EmbeddingQuantization;
  builtin: {
    modelId: string;
    installCheck: EmbeddingWizardInstallCheckState;
    download: EmbeddingWizardDownloadState;
  };
  endpoint: EmbeddingWizardEndpointState;
  calibration: EmbeddingWizardCalibrationState;
  finish: EmbeddingWizardFinishState;
  /** A validation error for the current step (cleared when it advances). */
  error: string | null;
  outcome: "active" | "completed" | "cancelled";
}

// ── Events ─────────────────────────────────────────────────────────────────

/** Everything the component can tell the machine. */
export type EmbeddingWizardEvent =
  | { type: "choose-backend"; backend: EmbeddingBackendKind | "later" }
  | { type: "choose-gpu"; role: EmbeddingGpuRole }
  | { type: "choose-precision"; precision: EmbeddingQuantization }
  | { type: "choose-model"; modelId: string }
  | { type: "install-check-started" }
  | {
      type: "install-check-succeeded";
      result: EmbeddingWizardInstallCheckResult;
    }
  | { type: "install-check-failed"; error: string }
  | { type: "choose-endpoint-kind"; kind: EmbeddingEndpointKind }
  | {
      type: "update-endpoint";
      field: "baseUrl" | "model" | "apiKeyEnv" | "apiKey";
      value: string;
    }
  | { type: "next" }
  | { type: "back" }
  | { type: "cancel" }
  | { type: "download-started" }
  | { type: "download-progress"; progress: number }
  | { type: "runtime-downloaded"; runtimeDir: string }
  | { type: "download-succeeded"; result: EmbeddingWizardDownloadResult }
  | { type: "download-failed"; error: string; hint: string }
  | { type: "endpoint-test-started" }
  | {
      type: "endpoint-test-succeeded";
      result: EmbeddingWizardEndpointTestResult;
    }
  | { type: "endpoint-test-failed"; error: string }
  | { type: "calibration-started" }
  | { type: "calibration-succeeded"; result: EmbeddingWizardCalibration }
  | { type: "calibration-failed"; error: string }
  | { type: "calibration-skip" }
  | { type: "calibration-reset" }
  | { type: "toggle-keep-after-exit"; value?: boolean }
  | { type: "choose-build-mode"; mode: EmbeddingBuildMode }
  | { type: "finish-started" }
  | { type: "finish-succeeded"; receipt: string }
  | { type: "finish-failed"; error: string };

// ── Injected dependency contract ───────────────────────────────────────────

/** What the downloader is asked for (C4's fetch, restricted to the wizard). */
export interface EmbeddingWizardDownloadRequest {
  modelId: string;
  onProgress?: (progress: number) => void;
  signal?: AbortSignal;
}

export interface EmbeddingWizardDownloadResult {
  modelId: string;
  modelDir: string;
  alreadyInstalled: boolean;
  /** Where the onnxruntime closure landed; reports any cached install too. */
  runtimeDir: string;
}

/** What the runtime downloader is asked for (C2's fetch). */
export interface EmbeddingWizardRuntimeDownloadRequest {
  onProgress?: (progress: number) => void;
  signal?: AbortSignal;
}

export interface EmbeddingWizardRuntimeDownloadResult {
  runtimeDir: string;
  alreadyInstalled: boolean;
}

/** The cached-install answer step 2 starts from. */
export interface EmbeddingWizardInstallCheckResult {
  modelInstalled: boolean;
  runtimeInstalled: boolean;
  modelDir: string | null;
  runtimeDir: string | null;
}

/** What the endpoint probe is asked for; `apiKey` is null for keyless Oollama. */
export interface EmbeddingWizardEndpointProbeRequest {
  kind: EmbeddingEndpointKind;
  baseUrl: string;
  model: string;
  apiKey: string | null;
}

export interface EmbeddingWizardEndpointTestResult {
  kind: EmbeddingEndpointKind;
  model: string;
  dimensions: number;
  norm: number;
  latencyMs: number;
}

/** What calibration is asked for; the endpoint form is present when chosen. */
export interface EmbeddingWizardCalibrationRequest {
  backend: EmbeddingBackendKind;
  modelId: string;
  endpoint: EmbeddingEndpointSettings | null;
  /** The role step 2 chose; a probe-backed calibration reports its own answer. */
  gpuRole: EmbeddingGpuRole;
}

/** What the build start is asked for (A4's host owns the lifecycle). */
export interface EmbeddingWizardBuildRequest {
  backend: EmbeddingBackendKind;
  model: string;
  keepAfterExit: boolean;
  /** `full` rebuilds every chunk; `incremental` indexes new/changed ones. */
  mode: EmbeddingBuildMode;
}

/**
 * The wizard's side effects. Every one is injected: the component supplies the
 * production implementations, tests supply fakes, and this module never reaches
 * the network, the model cache or the settings file on its own.
 */
export interface EmbeddingWizardDeps {
  downloadModel(
    request: EmbeddingWizardDownloadRequest,
  ): Promise<EmbeddingWizardDownloadResult>;
  /** Whether the built-in model is already installed (C4's cheap check). */
  isModelInstalled?(modelId: string): Promise<boolean>;
  /** Whether the onnxruntime closure is already installed (C2's manifest). */
  isRuntimeInstalled?(runtimeVersion?: string): Promise<boolean>;
  /** Install the onnxruntime closure (C2); skipped when it is already there. */
  downloadRuntime?(
    request: EmbeddingWizardRuntimeDownloadRequest,
  ): Promise<EmbeddingWizardRuntimeDownloadResult>;
  probeEndpoint(
    request: EmbeddingWizardEndpointProbeRequest,
  ): Promise<EmbeddingWizardEndpointTestResult>;
  calibrate(
    request: EmbeddingWizardCalibrationRequest,
  ): Promise<EmbeddingWizardCalibration>;
  /** D3's only writer; a throw keeps the wizard on its step. */
  saveSettings(patch: EmbeddingSettingsPatch): void;
  /** D3's write-only secret store; called before settings, like D4's flags. */
  saveApiKey?(value: string): Promise<unknown>;
  /** Start the first build; the returned string is the receipt. */
  startBuild(request: EmbeddingWizardBuildRequest): Promise<string> | string;
  /** Environment lookup for the key-by-variable path; defaults to `process.env`. */
  readEnv?(name: string): string | undefined;
}

/** Progress sink for the async runners (the component writes it to state). */
export type EmbeddingWizardStateListener = (
  state: EmbeddingWizardState,
) => void;

// ── Construction ───────────────────────────────────────────────────────────

export interface EmbeddingWizardInitialOptions {
  /** Current settings, for `setup`'s "re-run with the current values". */
  settings?: ResolvedEmbeddingSettings;
}

function initialDownload(): EmbeddingWizardDownloadState {
  return {
    phase: "idle",
    progress: 0,
    error: null,
    hint: null,
    modelDir: null,
    runtimeDir: null,
    alreadyInstalled: false,
    runtimeDone: false,
    modelDone: false,
  };
}

function initialInstallCheck(): EmbeddingWizardInstallCheckState {
  return {
    phase: "idle",
    error: null,
    modelInstalled: false,
    runtimeInstalled: false,
    modelDir: null,
    runtimeDir: null,
  };
}

function initialEndpointTest(): EmbeddingWizardEndpointTest {
  return {
    phase: "idle",
    model: null,
    dimensions: null,
    norm: null,
    latencyMs: null,
    error: null,
  };
}

/**
 * The opening state. A re-entered `setup` starts on step 1 with the current
 * backend already selected, so the picker's cursor sits on the answer the user
 * gave last time without Enter silently re-answering it.
 */
export function createEmbeddingWizardState(
  options: EmbeddingWizardInitialOptions = {},
): EmbeddingWizardState {
  const settings = options.settings ?? EMBEDDING_SETTING_DEFAULTS;
  const models = embeddingWizardModelOptions();
  const modelId = models.some((option) => option.id === settings.model)
    ? settings.model
    : (models[0]?.id ?? settings.model);
  const endpoint = settings.endpoint;
  return {
    step: "backend",
    backend: settings.backend,
    gpu: settings.gpu === "index-only" ? "auto" : settings.gpu,
    precision: settings.quantization,
    builtin: {
      modelId,
      installCheck: initialInstallCheck(),
      download: initialDownload(),
    },
    endpoint: {
      kind: endpoint?.kind ?? "openai",
      baseUrl: endpoint?.baseUrl ?? "",
      model: endpoint?.model ?? "",
      apiKeyEnv: "",
      apiKey: "",
      test: initialEndpointTest(),
      // An existing endpoint form is shown pre-filled, but it is never trusted
      // as verified: 48-1 §7.2 accepts an endpoint only after a test-embed.
      verified: null,
    },
    calibration: { phase: "idle", result: null, error: null },
    finish: {
      keepAfterExit: false,
      buildMode: "incremental",
      phase: "ready",
      error: null,
      buildReceipt: null,
    },
    error: null,
    outcome: "active",
  };
}

// ── Shared questions ───────────────────────────────────────────────────────

/** Whether this endpoint kind needs a credential (Ollama usually does not). */
export function embeddingWizardEndpointNeedsKey(
  state: EmbeddingWizardState,
): boolean {
  return state.endpoint.kind === "openai";
}

// ── Navigation ─────────────────────────────────────────────────────────────

/** True when both halves of step 2's built-in install are present on disk. */
export function builtinInstalled(state: EmbeddingWizardState): boolean {
  return (
    state.builtin.installCheck.modelInstalled &&
    state.builtin.installCheck.runtimeInstalled
  );
}

/**
 * Where Escape goes from the current screen, or `null` when the current screen is
 * the root (Escape then cancels). Step 2's two halves are walked back through
 * their own sub-steps; step 3 returns to whichever configuration produced it.
 */
export function embeddingWizardBackStep(
  state: EmbeddingWizardState,
): EmbeddingWizardStep | null {
  switch (state.step) {
    case "backend":
      return null;
    case "gpu-role":
      return "backend";
    case "precision":
      return "gpu-role";
    case "builtin-model":
      return "precision";
    case "builtin-check":
      return "builtin-model";
    case "builtin-download":
      return "builtin-model";
    case "endpoint-kind":
      return "precision";
    case "endpoint-url":
      return "endpoint-kind";
    case "endpoint-model":
      return "endpoint-url";
    case "endpoint-key-env":
      return "endpoint-model";
    case "endpoint-key":
      return "endpoint-key-env";
    case "endpoint-test":
      return "endpoint-key";
    case "calibrate":
      if (state.backend === "endpoint") return "endpoint-test";
      return builtinInstalled(state) ? "builtin-check" : "builtin-download";
    case "finish":
      return "calibrate";
  }
}

/** Whether an async action is in flight; Escape/back wait for it to settle. */
export function isEmbeddingWizardBusy(state: EmbeddingWizardState): boolean {
  if (state.builtin.installCheck.phase === "checking") return true;
  if (state.builtin.download.phase === "running") return true;
  if (state.endpoint.test.phase === "running") return true;
  if (state.calibration.phase === "running") return true;
  return state.finish.phase === "saving";
}

// ── Reducer ────────────────────────────────────────────────────────────────

function clearTransient(state: EmbeddingWizardState): EmbeddingWizardState {
  return { ...state, error: null };
}

function resetEndpointTest(
  endpoint: EmbeddingWizardEndpointState,
): EmbeddingWizardEndpointState {
  return { ...endpoint, test: initialEndpointTest(), verified: null };
}

/** Keep a result event for the operation it belongs to; drop stale ones. */
function isCurrentDownload(state: EmbeddingWizardState): boolean {
  return (
    state.step === "builtin-download" &&
    state.builtin.download.phase === "running"
  );
}

function isCurrentEndpointTest(state: EmbeddingWizardState): boolean {
  return (
    state.step === "endpoint-test" && state.endpoint.test.phase === "running"
  );
}

function isCurrentCalibration(state: EmbeddingWizardState): boolean {
  return state.step === "calibrate" && state.calibration.phase === "running";
}

function isCurrentFinish(state: EmbeddingWizardState): boolean {
  return state.step === "finish" && state.finish.phase === "saving";
}

function isCurrentInstallCheck(state: EmbeddingWizardState): boolean {
  return (
    state.step === "builtin-check" &&
    state.builtin.installCheck.phase === "checking"
  );
}

/**
 * The transition function. Every branch is a pure state-to-state change; async
 * outcomes arrive as their own events, and each one is ignored when the screen
 * it belongs to is no longer showing it (a result that arrives after the user
 * walked back must not yank them forward again).
 */
export function applyEmbeddingWizardEvent(
  state: EmbeddingWizardState,
  event: EmbeddingWizardEvent,
): EmbeddingWizardState {
  if (state.outcome !== "active") return state;
  switch (event.type) {
    case "choose-backend": {
      if (state.step !== "backend") return state;
      if (event.backend === "later") {
        return { ...state, outcome: "cancelled", error: null };
      }
      // Step 2 opens on the GPU role whichever backend was picked: the answer
      // is a settings-level fact, not a built-in-only one.
      return {
        ...state,
        backend: event.backend,
        step: "gpu-role",
        error: null,
        builtin: {
          ...state.builtin,
          installCheck: initialInstallCheck(),
          download: initialDownload(),
        },
        endpoint:
          event.backend === "endpoint"
            ? resetEndpointTest(state.endpoint)
            : state.endpoint,
      };
    }
    case "choose-gpu": {
      if (state.step !== "gpu-role") return state;
      return {
        ...state,
        gpu: event.role,
        step: "precision",
        error: null,
      };
    }
    case "choose-precision": {
      if (state.step !== "precision") return state;
      return {
        ...state,
        precision: event.precision,
        step: state.backend === "endpoint" ? "endpoint-kind" : "builtin-model",
        error: null,
      };
    }
    case "choose-model": {
      if (state.step !== "builtin-model") return state;
      return {
        ...state,
        step: "builtin-check",
        error: null,
        builtin: {
          modelId: event.modelId,
          installCheck: initialInstallCheck(),
          download: initialDownload(),
        },
      };
    }
    case "install-check-started": {
      if (state.step !== "builtin-check") return state;
      return {
        ...state,
        error: null,
        builtin: {
          ...state.builtin,
          installCheck: { ...initialInstallCheck(), phase: "checking" },
        },
      };
    }
    case "install-check-succeeded": {
      if (!isCurrentInstallCheck(state)) return state;
      const result = event.result;
      const installed = result.modelInstalled && result.runtimeInstalled;
      const download: EmbeddingWizardDownloadState = {
        ...initialDownload(),
        runtimeDone: result.runtimeInstalled,
        modelDone: result.modelInstalled,
        runtimeDir: result.runtimeDir,
        modelDir: result.modelDir,
        alreadyInstalled: installed,
        ...(installed ? { phase: "done" as const, progress: 1 } : {}),
      };
      return {
        ...state,
        // Both halves cached: skip the download screen entirely and move to
        // calibration. Either one missing: the confirmation screen shows what
        // still has to be fetched (runtime first).
        step: installed ? "calibrate" : "builtin-download",
        error: null,
        builtin: {
          ...state.builtin,
          installCheck: { phase: "done", error: null, ...result },
          download,
        },
        ...(installed
          ? {
              calibration: {
                phase: "idle" as const,
                result: null,
                error: null,
              },
            }
          : {}),
      };
    }
    case "install-check-failed": {
      if (!isCurrentInstallCheck(state)) return state;
      return {
        ...state,
        builtin: {
          ...state.builtin,
          installCheck: {
            ...initialInstallCheck(),
            phase: "failed",
            error: event.error,
          },
        },
      };
    }
    case "choose-endpoint-kind": {
      if (state.step !== "endpoint-kind") return state;
      return {
        ...state,
        step: "endpoint-url",
        error: null,
        endpoint: resetEndpointTest({
          ...state.endpoint,
          kind: event.kind,
        }),
      };
    }
    case "update-endpoint": {
      if (!state.step.startsWith("endpoint")) return state;
      const endpoint: EmbeddingWizardEndpointState = {
        ...state.endpoint,
        [event.field]: event.value,
      };
      // Every field invalidates a previous test-embed, the credential included:
      // the verified form records a round trip made with the old URL, model and
      // key, and 48-1 §7.2 only accepts an endpoint after a successful test of
      // the values that will be written. Editing the key and walking forward
      // again must therefore re-test instead of reusing the old pass.
      return {
        ...state,
        error: null,
        endpoint: resetEndpointTest(endpoint),
      };
    }
    case "next":
      return advance(state);
    case "back": {
      if (isEmbeddingWizardBusy(state)) return state;
      const target = embeddingWizardBackStep(state);
      if (target === null)
        return { ...state, outcome: "cancelled", error: null };
      return { ...state, step: target, error: null };
    }
    case "cancel": {
      if (isEmbeddingWizardBusy(state)) return state;
      return { ...state, outcome: "cancelled", error: null };
    }
    case "download-started": {
      if (state.step !== "builtin-download") return state;
      return {
        ...state,
        error: null,
        builtin: {
          ...state.builtin,
          download: {
            ...state.builtin.download,
            phase: "running",
            progress: 0,
            error: null,
            hint: null,
          },
        },
      };
    }
    case "download-progress": {
      if (!isCurrentDownload(state)) return state;
      const progress = Math.min(1, Math.max(0, event.progress));
      return {
        ...state,
        builtin: {
          ...state.builtin,
          download: { ...state.builtin.download, progress },
        },
      };
    }
    case "runtime-downloaded": {
      if (!isCurrentDownload(state)) return state;
      return {
        ...state,
        builtin: {
          ...state.builtin,
          download: {
            ...state.builtin.download,
            runtimeDir: event.runtimeDir,
            runtimeDone: true,
          },
        },
      };
    }
    case "download-succeeded": {
      if (!isCurrentDownload(state)) return state;
      return {
        ...state,
        step: "calibrate",
        error: null,
        builtin: {
          ...state.builtin,
          download: {
            ...state.builtin.download,
            phase: "done",
            progress: 1,
            error: null,
            hint: null,
            modelDir: event.result.modelDir,
            runtimeDir: event.result.runtimeDir,
            alreadyInstalled: event.result.alreadyInstalled,
            runtimeDone: true,
            modelDone: true,
          },
        },
        calibration: { phase: "idle", result: null, error: null },
      };
    }
    case "download-failed": {
      if (!isCurrentDownload(state)) return state;
      return {
        ...state,
        builtin: {
          ...state.builtin,
          download: {
            ...state.builtin.download,
            phase: "failed",
            error: event.error,
            hint: event.hint,
          },
        },
      };
    }
    case "endpoint-test-started": {
      if (state.step !== "endpoint-test") return state;
      return {
        ...state,
        error: null,
        endpoint: {
          ...state.endpoint,
          verified: null,
          test: { ...initialEndpointTest(), phase: "running" },
        },
      };
    }
    case "endpoint-test-succeeded": {
      if (!isCurrentEndpointTest(state)) return state;
      const result = event.result;
      const verified: EmbeddingEndpointSettings = {
        kind: result.kind,
        baseUrl: state.endpoint.baseUrl,
        model: result.model,
        dimensions: result.dimensions,
      };
      return {
        ...state,
        endpoint: {
          ...state.endpoint,
          verified,
          test: {
            phase: "passed",
            model: result.model,
            dimensions: result.dimensions,
            norm: result.norm,
            latencyMs: result.latencyMs,
            error: null,
          },
        },
      };
    }
    case "endpoint-test-failed": {
      if (state.step !== "endpoint-test") return state;
      return {
        ...state,
        endpoint: {
          ...state.endpoint,
          verified: null,
          test: {
            ...initialEndpointTest(),
            phase: "failed",
            error: event.error,
          },
        },
      };
    }
    case "calibration-started": {
      if (state.step !== "calibrate") return state;
      return {
        ...state,
        error: null,
        calibration: { phase: "running", result: null, error: null },
      };
    }
    case "calibration-succeeded": {
      if (!isCurrentCalibration(state)) return state;
      return {
        ...state,
        calibration: { phase: "done", result: event.result, error: null },
      };
    }
    case "calibration-failed": {
      if (!isCurrentCalibration(state)) return state;
      return {
        ...state,
        calibration: {
          phase: "failed",
          result: state.calibration.result,
          error: event.error,
        },
      };
    }
    case "calibration-skip": {
      if (state.step !== "calibrate") return state;
      // Skipping while the measurement is still in flight is allowed: "≤5s,
      // skippable" means the user may stop waiting. A late result is dropped by
      // `isCurrentCalibration` because this event moves off the calibrate step.
      return {
        ...state,
        step: "finish",
        error: null,
        calibration: {
          phase: "skipped",
          result: state.calibration.result,
          error: null,
        },
      };
    }
    case "calibration-reset": {
      if (state.step !== "calibrate") return state;
      if (state.calibration.phase === "running") return state;
      return {
        ...state,
        error: null,
        calibration: { phase: "idle", result: null, error: null },
      };
    }
    case "toggle-keep-after-exit": {
      if (state.step !== "finish") return state;
      const value = event.value ?? !state.finish.keepAfterExit;
      return { ...state, finish: { ...state.finish, keepAfterExit: value } };
    }
    case "choose-build-mode": {
      if (state.step !== "finish") return state;
      return { ...state, finish: { ...state.finish, buildMode: event.mode } };
    }
    case "finish-started": {
      if (state.step !== "finish") return state;
      return {
        ...state,
        error: null,
        finish: { ...state.finish, phase: "saving", error: null },
      };
    }
    case "finish-succeeded": {
      if (!isCurrentFinish(state)) return state;
      return {
        ...state,
        outcome: "completed",
        finish: {
          ...state.finish,
          phase: "done",
          buildReceipt: event.receipt,
        },
      };
    }
    case "finish-failed": {
      if (!isCurrentFinish(state)) return state;
      return {
        ...state,
        finish: { ...state.finish, phase: "failed", error: event.error },
      };
    }
  }
}

/** `next`: validate the current text screen, or move on from a result screen. */
function advance(state: EmbeddingWizardState): EmbeddingWizardState {
  switch (state.step) {
    case "builtin-check": {
      // A failed check retries (the component's effect re-runs on `idle`); a
      // successful installed check only reaches here when the user walked back.
      if (state.builtin.installCheck.phase === "failed") {
        return {
          ...state,
          builtin: { ...state.builtin, installCheck: initialInstallCheck() },
        };
      }
      if (
        state.builtin.installCheck.phase === "done" &&
        builtinInstalled(state)
      ) {
        return clearTransient({
          ...state,
          step: "calibrate",
          calibration: { phase: "idle", result: null, error: null },
        });
      }
      return state;
    }
    case "endpoint-url": {
      const { url, error } = validateEmbeddingWizardEndpointUrl(
        state.endpoint.baseUrl,
      );
      if (url === null) return { ...state, error };
      return clearTransient({
        ...state,
        step: "endpoint-model",
        endpoint: { ...state.endpoint, baseUrl: url },
      });
    }
    case "endpoint-model": {
      const error = validateEmbeddingModelInput(state.endpoint.model);
      if (error !== null) return { ...state, error };
      return clearTransient({ ...state, step: "endpoint-key-env" });
    }
    case "endpoint-key-env": {
      const name = state.endpoint.apiKeyEnv.trim();
      if (name.length > 0 && !isEmbeddingWizardEnvName(name)) {
        return {
          ...state,
          error: `"${name}" is not an environment variable name.`,
        };
      }
      return clearTransient({ ...state, step: "endpoint-key" });
    }
    case "endpoint-key": {
      const missing =
        state.endpoint.apiKeyEnv.trim() === "" &&
        state.endpoint.apiKey.trim() === "";
      if (missing && embeddingWizardEndpointNeedsKey(state)) {
        return {
          ...state,
          error:
            "This endpoint needs an API key: type it here or name the environment variable that holds it.",
        };
      }
      return clearTransient({ ...state, step: "endpoint-test" });
    }
    case "endpoint-test": {
      if (state.endpoint.test.phase !== "passed") return state;
      if (state.endpoint.verified === null) return state;
      return clearTransient({
        ...state,
        step: "calibrate",
        calibration: { phase: "idle", result: null, error: null },
      });
    }
    case "calibrate": {
      if (
        state.calibration.phase === "running" ||
        state.calibration.phase === "idle"
      ) {
        return state;
      }
      return clearTransient({ ...state, step: "finish" });
    }
    case "finish":
      // The finish step's action is async and owned by the runner.
      return state;
    default:
      // Picker screens advance through their own selection events.
      return state;
  }
}
