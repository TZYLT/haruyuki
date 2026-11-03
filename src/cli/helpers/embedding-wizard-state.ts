/**
 * The first-run vector-recall setup wizard's state machine (48-2 §4.9, D5).
 *
 * The requirement fixes four steps — backend → built-in download **or** endpoint
 * test → calibration → finish — and three properties that are the reason this
 * module exists apart from the component:
 *
 * - **Cancel writes nothing.** Every answer lives here until the final step, and
 *   that step performs the only writes (`saveSettings` + `saveApiKey` + the build
 *   start) in one injected call. Leaving halfway cannot leave a half-configured
 *   agent behind; `outcome: "cancelled"` is the whole of a cancel.
 * - **A failed step keeps the current step.** A download that throws, a probe
 *   that refuses the URL, a calibration that times out and a settings write that
 *   fails all land as state on the step they happened, with every earlier answer
 *   intact, and `next`/the retry key resume from there.
 * - **The key is never rendered.** The endpoint form keeps the typed key and the
 *   environment-variable name in memory; only the latter is painted, and the
 *   former is painted masked by the component. `resolveEmbeddingWizardApiKey`
 *   and the finish path never put a key into a user-facing string.
 *
 * The transitions are pure: `applyEmbeddingWizardEvent(state, event)` is the
 * reducer, and the async runners that call the injected dependencies live in
 * `./embedding-wizard-actions`, feeding their outcomes back through this same
 * reducer. Both halves are tested without React
 * (`embedding-wizard-state.test.ts`); `EmbeddingWizard.tsx` only draws the state
 * and dispatches events.
 *
 * The injected dependency contract (`EmbeddingWizardDeps`) is declared here
 * beside the state it serves: `downloadModel` (C4), `probeEndpoint` (C6),
 * `calibrate` (C5), `startBuild` (A4's host), `saveSettings` (D3's single
 * writer) and `saveApiKey` (D3's secret store). Nothing here reads the network,
 * the model cache or the settings file by itself.
 */

import { normalizeEndpointBaseUrl } from "@/backend/local/embedding/endpoint-client";
import {
  BUILTIN_EMBEDDING_MODELS,
  type EmbeddingModelManifest,
} from "@/backend/local/embedding/model-manifest";
import {
  type EmbeddingSettingsPatch,
  validateEmbeddingModelInput,
} from "@/cli/app/pages/settings/embedding-settings";
import {
  EMBEDDING_SETTING_DEFAULTS,
  type EmbeddingEndpointSettings,
  type ResolvedEmbeddingSettings,
} from "@/recall-settings";
import type {
  EmbeddingBackendKind,
  EmbeddingEndpointKind,
  EmbeddingGpuRole,
  EmbeddingQuantization,
} from "@/types/embedding-protocol";
import { getErrorMessage } from "@/utils/error";

// ── Steps and titles ───────────────────────────────────────────────────────

/**
 * One screen of the wizard. The five endpoint-* screens and the two built-in
 * screens are sub-steps of the same numbered step, which is why the title
 * numbers come from {@link EMBEDDING_WIZARD_STEPS} rather than from an array
 * index — a sub-step must not invent its own count.
 */
export type EmbeddingWizardStep =
  | "backend"
  | "builtin-model"
  | "builtin-download"
  | "endpoint-kind"
  | "endpoint-url"
  | "endpoint-model"
  | "endpoint-key-env"
  | "endpoint-key"
  | "endpoint-test"
  | "calibrate"
  | "finish";

/** The requirement's four numbered steps (48-1 §7.2). */
export const EMBEDDING_WIZARD_STEP_COUNT = 4;

/** The command whose overlay frame names the wizard; the TUI seam reuses it. */
export const EMBEDDING_WIZARD_COMMAND = "/recall embedding setup";

/**
 * Every screen with the slot it is numbered by. `builtin-*` and `endpoint-*`
 * share slot 2 because step 2 is exactly "the backend you picked, configured";
 * the labels differ so the user still sees which half they are in.
 */
export const EMBEDDING_WIZARD_STEPS: readonly {
  readonly id: EmbeddingWizardStep;
  readonly slot: number;
  readonly label: string;
}[] = [
  { id: "backend", slot: 1, label: "Backend" },
  { id: "builtin-model", slot: 2, label: "Built-in model" },
  { id: "builtin-download", slot: 2, label: "Download" },
  { id: "endpoint-kind", slot: 2, label: "Endpoint" },
  { id: "endpoint-url", slot: 2, label: "Endpoint URL" },
  { id: "endpoint-model", slot: 2, label: "Endpoint model" },
  { id: "endpoint-key-env", slot: 2, label: "Endpoint key" },
  { id: "endpoint-key", slot: 2, label: "Endpoint key" },
  { id: "endpoint-test", slot: 2, label: "Endpoint test" },
  { id: "calibrate", slot: 3, label: "Calibration" },
  { id: "finish", slot: 4, label: "Finish" },
];

/** `3/4 Calibration` — the title line for a screen. */
export function embeddingWizardStepTitle(step: EmbeddingWizardStep): string {
  const entry = EMBEDDING_WIZARD_STEPS.find(
    (candidate) => candidate.id === step,
  );
  if (entry === undefined) return "";
  return `${entry.slot}/${EMBEDDING_WIZARD_STEP_COUNT} ${entry.label}`;
}

// ── Built-in model facts ───────────────────────────────────────────────────

/** What the download confirmation paints for one built-in model. */
export interface EmbeddingWizardModelOption {
  readonly id: string;
  readonly displayName: string;
  readonly dimensions: number;
  /** Sum of the required files' pinned sizes, or `0` when none are pinned. */
  readonly totalBytes: number;
  readonly licenseId: string;
  readonly licenseName: string;
  readonly licenseNotice: string;
  readonly licenseUrl: string;
  /** False means "some required files are verified by size only". */
  readonly integrityPinned: boolean;
}

function modelOption(
  manifest: EmbeddingModelManifest,
): EmbeddingWizardModelOption {
  const totalBytes = manifest.files.reduce(
    (sum, file) => sum + (file.bytes ?? 0),
    0,
  );
  return {
    id: manifest.id,
    displayName: manifest.displayName,
    dimensions: manifest.dimensions,
    totalBytes,
    licenseId: manifest.license.id,
    licenseName: manifest.license.name,
    licenseNotice: manifest.license.notice,
    licenseUrl: manifest.license.url,
    integrityPinned: manifest.integrityPinned,
  };
}

/** The built-in models this build can download (C4's append-only table). */
export function embeddingWizardModelOptions(): EmbeddingWizardModelOption[] {
  return BUILTIN_EMBEDDING_MODELS.map(modelOption);
}

/** One model's facts, or `undefined` when the id is not a built-in. */
export function embeddingWizardModelOption(
  modelId: string,
): EmbeddingWizardModelOption | undefined {
  return embeddingWizardModelOptions().find((option) => option.id === modelId);
}

/** `24.5 MB` — decimal units, the way weight sizes are quoted. */
export function formatEmbeddingWizardBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown";
  if (bytes < 1_000) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1_000;
  let unit = 0;
  while (value >= 1_000 && unit < units.length - 1) {
    value /= 1_000;
    unit += 1;
  }
  const rounded =
    value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

// ── State ──────────────────────────────────────────────────────────────────

/** The download half of step 2. */
export interface EmbeddingWizardDownloadState {
  phase: "idle" | "running" | "done" | "failed";
  /** 0..1 when the downloader reports byte counts. */
  progress: number;
  error: string | null;
  /** Offered on failure: the offline-import hint, never a second write path. */
  hint: string | null;
  modelDir: string | null;
  alreadyInstalled: boolean;
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
  /** The one switch in step 4; off by default (48-2 §4.8, R-34). */
  keepAfterExit: boolean;
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
  builtin: {
    modelId: string;
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
  | { type: "choose-model"; modelId: string }
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
}

/** What the build start is asked for (A4's host owns the lifecycle). */
export interface EmbeddingWizardBuildRequest {
  backend: EmbeddingBackendKind;
  model: string;
  keepAfterExit: boolean;
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
    alreadyInstalled: false,
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
    builtin: {
      modelId,
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
      phase: "ready",
      error: null,
      buildReceipt: null,
    },
    error: null,
    outcome: "active",
  };
}

// ── Shared questions ───────────────────────────────────────────────────────

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Validate and normalise the endpoint base URL through C6's allow-list, so the
 * wizard, the settings page and the runtime cannot disagree about what a legal
 * endpoint is.
 */
export function validateEmbeddingWizardEndpointUrl(raw: string): {
  url: string | null;
  error: string | null;
} {
  try {
    return { url: normalizeEndpointBaseUrl(raw), error: null };
  } catch (error) {
    return { url: null, error: getErrorMessage(error) };
  }
}

/** Whether this endpoint kind needs a credential (Ollama usually does not). */
export function embeddingWizardEndpointNeedsKey(
  state: EmbeddingWizardState,
): boolean {
  return state.endpoint.kind === "openai";
}

/** How the wizard resolves the endpoint credential, and what the UI may say. */
export interface EmbeddingWizardApiKeyResolution {
  apiKey: string | null;
  source: "env" | "typed" | "none";
  /** User-facing text; never contains the key itself. */
  error: string | null;
}

/**
 * Resolve the key from the named environment variable, else from the masked
 * field. The returned error is safe to paint: it names the variable, never the
 * value. Exported because the test-embed and finish runners — and the frame —
 * must all agree on what key the wizard is about to use.
 */
export function resolveEmbeddingWizardApiKey(
  state: EmbeddingWizardState,
  readEnv: (name: string) => string | undefined = (name) => process.env[name],
): EmbeddingWizardApiKeyResolution {
  const envName = state.endpoint.apiKeyEnv.trim();
  const typed = state.endpoint.apiKey.trim();
  if (envName.length > 0) {
    if (!ENV_NAME_PATTERN.test(envName)) {
      return {
        apiKey: null,
        source: "env",
        error: `"${envName}" is not an environment variable name.`,
      };
    }
    const value = readEnv(envName)?.trim();
    if (value === undefined || value === "") {
      return {
        apiKey: null,
        source: "env",
        error: `Environment variable ${envName} is empty or unset; set it before testing the endpoint.`,
      };
    }
    return { apiKey: value, source: "env", error: null };
  }
  if (typed.length > 0) return { apiKey: typed, source: "typed", error: null };
  return { apiKey: null, source: "none", error: null };
}

// ── Navigation ─────────────────────────────────────────────────────────────

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
    case "builtin-model":
      return "backend";
    case "builtin-download":
      return "builtin-model";
    case "endpoint-kind":
      return "backend";
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
      return state.backend === "endpoint"
        ? "endpoint-test"
        : "builtin-download";
    case "finish":
      return "calibrate";
  }
}

/** Whether an async action is in flight; Escape/back wait for it to settle. */
export function isEmbeddingWizardBusy(state: EmbeddingWizardState): boolean {
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
      if (event.backend === "builtin") {
        return {
          ...state,
          backend: "builtin",
          step: "builtin-model",
          error: null,
          builtin: { ...state.builtin, download: initialDownload() },
        };
      }
      return {
        ...state,
        backend: "endpoint",
        step: "endpoint-kind",
        error: null,
        endpoint: resetEndpointTest(state.endpoint),
      };
    }
    case "choose-model": {
      if (state.step !== "builtin-model") return state;
      return {
        ...state,
        step: "builtin-download",
        error: null,
        builtin: {
          modelId: event.modelId,
          download: initialDownload(),
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
      return {
        ...state,
        error: null,
        endpoint:
          event.field === "baseUrl" || event.field === "model"
            ? resetEndpointTest(endpoint)
            : endpoint,
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
            alreadyInstalled: event.result.alreadyInstalled,
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
      if (name.length > 0 && !ENV_NAME_PATTERN.test(name)) {
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
