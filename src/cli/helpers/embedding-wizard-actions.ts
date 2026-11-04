/**
 * The async half of the first-run vector-recall setup wizard (48-2 §4.9 D5).
 *
 * Each runner performs exactly one injected dependency call and feeds its
 * outcome back through the pure reducer in `./embedding-wizard-state`. Keeping
 * them out of that module is what makes both halves testable without React and
 * without a component: the reducer pins "what the wizard does", the runners pin
 * "which dependency is called, with what, and what a dependency failure leaves
 * on screen". The component only chooses when to call a runner.
 *
 * Three properties are the requirement's (48-1 §7.2):
 *
 * - **Cancel writes nothing.** Only `runEmbeddingWizardFinish` writes, and it
 *   writes settings once, after the endpoint key (write-only) and before the
 *   build start.
 * - **A failed step keeps its step.** Every failure becomes a reducer event on
 *   the current screen; the earlier answers are untouched.
 * - **A late result is dropped.** The component hands the runners a state
 *   reader, so an outcome that lands after the user left its screen is applied
 *   to the *current* state and ignored by the reducer's stale-result guards.
 *
 * Layer: `cli/helpers/`. Imports the CLI's own state machine and backend public
 * APIs; never the network or the settings file directly.
 */

import {
  isEmbeddingModelInstalled,
  resolveEmbeddingModelPaths,
} from "@/backend/local/embedding/model-download-install";
import {
  DEFAULT_EMBEDDING_RUNTIME_VERSION,
  fetchEmbeddingRuntime,
  type RuntimeFetchProgress,
  readEmbeddingRuntimeManifest,
} from "@/backend/local/embedding/runtime-fetch";
import { getEmbeddingRuntimeDir } from "@/backend/local/embedding/secrets";
import type { EmbeddingSettingsPatch } from "@/cli/app/pages/settings/embedding-settings";
import {
  EMBEDDING_WIZARD_RUNTIME_BYTES,
  type EmbeddingWizardApiKeyResolution,
  embeddingWizardModelOption,
  resolveEmbeddingWizardApiKeyFrom,
} from "@/cli/helpers/embedding-wizard-facts";
import {
  applyEmbeddingWizardEvent,
  type EmbeddingWizardCalibration,
  type EmbeddingWizardDeps,
  type EmbeddingWizardEvent,
  type EmbeddingWizardInstallCheckResult,
  type EmbeddingWizardState,
  type EmbeddingWizardStateListener,
  embeddingWizardEndpointNeedsKey,
} from "@/cli/helpers/embedding-wizard-state";
import type { EmbeddingCalibrationSettings } from "@/recall-settings";
import type {
  EmbeddingGpuRole,
  EmbeddingQuantization,
} from "@/types/embedding-protocol";
import { getErrorMessage } from "@/utils/error";

/** The destination to point an offline user at when a download fails. */
export function embeddingWizardModelDir(modelId: string): string | null {
  try {
    // C4's resolver, never a hand-built path: the model directory is a C4 fact.
    return resolveEmbeddingModelPaths({ modelId }).modelDir;
  } catch {
    return null;
  }
}

/**
 * The failure notice for a refused download: actionable, names the directory the
 * downloader expects, and never offers a second write path the wizard does not
 * have. Offline import itself is C4's `importModelFromDirectory`; the wizard has
 * no screen for it in this build, which is why the text says so.
 */
export function embeddingWizardManualImportHint(modelId: string): string {
  const dir = embeddingWizardModelDir(modelId);
  const where = dir === null ? "the model cache" : dir;
  return `If downloads are blocked on this machine, import a copy of the model into ${where} with the offline importer and retry.`;
}

/** Where C2 installs the onnxruntime closure, or `null` when unresolvable. */
export function embeddingWizardRuntimeDir(): string | null {
  try {
    return getEmbeddingRuntimeDir(DEFAULT_EMBEDDING_RUNTIME_VERSION);
  } catch {
    return null;
  }
}

/**
 * {@link resolveEmbeddingWizardApiKeyFrom} against the wizard's own endpoint
 * form; the runners and the frame must agree on which two fields hold the key.
 */
export function resolveEmbeddingWizardApiKey(
  state: EmbeddingWizardState,
  readEnv: (name: string) => string | undefined = (name) => process.env[name],
): EmbeddingWizardApiKeyResolution {
  return resolveEmbeddingWizardApiKeyFrom(state.endpoint, readEnv);
}

/**
 * Whether step 2's two installs are already on disk. Both halves count: the
 * model without the runtime cannot embed, so a check that only looked at the
 * weights would skip the download screen and fail later at build time.
 *
 * The dependencies stay injectable (tests never touch a real cache); the
 * defaults are C4's cheap install check and C2's manifest read.
 */
export async function runEmbeddingWizardInstallCheck(
  state: EmbeddingWizardState,
  deps: EmbeddingWizardDeps,
  listener?: EmbeddingWizardStateListener,
  reader?: EmbeddingWizardStateReader,
): Promise<EmbeddingWizardState> {
  if (state.step !== "builtin-check") return state;
  if (state.builtin.installCheck.phase !== "idle") return state;
  const modelId = state.builtin.modelId;
  const checking = notify(
    listener,
    applyEmbeddingWizardEvent(state, { type: "install-check-started" }),
  );
  try {
    const modelInstalled = deps.isModelInstalled
      ? await deps.isModelInstalled(modelId)
      : await isEmbeddingModelInstalled({ modelId });
    const runtimeInstalled = deps.isRuntimeInstalled
      ? await deps.isRuntimeInstalled()
      : (await readEmbeddingRuntimeManifest()) !== null;
    const result: EmbeddingWizardInstallCheckResult = {
      modelInstalled,
      runtimeInstalled,
      modelDir: modelInstalled ? embeddingWizardModelDir(modelId) : null,
      runtimeDir: runtimeInstalled ? embeddingWizardRuntimeDir() : null,
    };
    return applyOutcome(
      checking,
      { type: "install-check-succeeded", result },
      listener,
      reader,
    );
  } catch (error) {
    return applyOutcome(
      checking,
      { type: "install-check-failed", error: getErrorMessage(error) },
      listener,
      reader,
    );
  }
}

// ── Calibration mapping ────────────────────────────────────────────────────

/**
 * Map C5's result onto the wizard's display shape. C5's `budget` is the source
 * of the derived numbers; `snapshot` is the persisted part (48-2 §4.5's note that
 * `calibrated`/`gpu_reason` stay out of the settings shape).
 */
export function embeddingWizardCalibrationFromResult(result: {
  snapshot: {
    fingerprint: string;
    measured_at: string;
    query_latency_p50_ms: number;
    query_latency_p90_ms: number;
    batch_throughput_per_s: number;
    gpu_role: EmbeddingGpuRole;
    threads: number;
    quantization: EmbeddingQuantization;
  };
  budget: {
    tier: string;
    calibrated: boolean;
    reason?: string;
    queryBudgetMs: number;
    rssBytes: number;
    diskFreeBytes: number;
    diskHeadroomOk: boolean;
  };
}): EmbeddingWizardCalibration {
  return {
    fingerprint: result.snapshot.fingerprint,
    measuredAt: result.snapshot.measured_at,
    p50Ms: result.snapshot.query_latency_p50_ms,
    p90Ms: result.snapshot.query_latency_p90_ms,
    throughputPerSec: result.snapshot.batch_throughput_per_s,
    gpuRole: result.snapshot.gpu_role,
    threads: result.snapshot.threads,
    quantization: result.snapshot.quantization,
    calibrated: result.budget.calibrated,
    reason: result.budget.reason ?? null,
    tier: result.budget.tier,
    queryBudgetMs: result.budget.queryBudgetMs,
    rssBytes: result.budget.rssBytes,
    diskFreeBytes: result.budget.diskFreeBytes,
    diskHeadroomOk: result.budget.diskHeadroomOk,
  };
}

/** The settings record for a measured/skipped calibration (C5 -> D3 shape). */
export function embeddingCalibrationSettings(
  calibration: EmbeddingWizardCalibration,
): EmbeddingCalibrationSettings {
  return {
    fingerprint: calibration.fingerprint,
    measuredAt: calibration.measuredAt,
    queryLatencyP50Ms: calibration.p50Ms,
    queryLatencyP90Ms: calibration.p90Ms,
    batchThroughputPerSec: calibration.throughputPerSec,
    gpuRole: calibration.gpuRole,
    threads: calibration.threads,
    quantization: calibration.quantization,
  };
}

// ── Calibration display thresholds ─────────────────────────────────────────

/** The calibration values the display thresholds look at. */
export interface EmbeddingWizardCalibrationDisplay {
  readonly calibrated: boolean;
  readonly p50Ms: number;
  readonly p90Ms: number;
  readonly throughputPerSec: number;
}

/**
 * Whether a calibration result carries real measurements. C5's skipped/defaults
 * path reports zeros and `calibrated: false`; a zero latency is never a
 * measurement, so the frame says "not measured" rather than `p50 0ms · 0/s`.
 */
export function embeddingWizardCalibrationMeasured(
  calibration: EmbeddingWizardCalibrationDisplay | null,
): boolean {
  if (calibration === null) return false;
  if (!calibration.calibrated) return false;
  return (
    Number.isFinite(calibration.p50Ms) &&
    calibration.p50Ms > 0 &&
    Number.isFinite(calibration.throughputPerSec) &&
    calibration.throughputPerSec > 0
  );
}

function formatMs(value: number): string {
  if (!Number.isFinite(value)) return "n/a";
  return Number.isInteger(value) ? `${value}ms` : `${value.toFixed(1)}ms`;
}

/** Step 3's latency line: numbers only when there is a measurement. */
export function embeddingWizardCalibrationLatencyLine(
  calibration: EmbeddingWizardCalibrationDisplay | null,
): string {
  if (
    calibration === null ||
    !embeddingWizardCalibrationMeasured(calibration)
  ) {
    return "Query latency: not measured / not applicable (default budget used)";
  }
  return `Query latency: p50 ${formatMs(calibration.p50Ms)} · p90 ${formatMs(
    calibration.p90Ms,
  )} · ${calibration.throughputPerSec}/s`;
}

/** Step 4's one-line recap: the same rule, in the summary's wording. */
export function embeddingWizardCalibrationSummary(
  calibration:
    | (EmbeddingWizardCalibrationDisplay & { readonly queryBudgetMs: number })
    | null,
): string {
  if (calibration === null) {
    return "Calibration: skipped (documented defaults)";
  }
  if (!embeddingWizardCalibrationMeasured(calibration)) {
    return "Calibration: not measured (documented defaults)";
  }
  return `Calibration: p50 ${formatMs(calibration.p50Ms)} · p90 ${formatMs(
    calibration.p90Ms,
  )} · query budget ${calibration.queryBudgetMs}ms`;
}

/**
 * The D3 patch the finish step writes. Pure and exported so the test can pin the
 * exact record (including the "only one write" property) without a component.
 */ export function embeddingWizardSettingsPatch(state: EmbeddingWizardState): {
  patch: EmbeddingSettingsPatch | null;
  error: string | null;
} {
  const calibration = state.calibration.result;
  const calibrationPatch =
    calibration === null
      ? {}
      : { calibration: embeddingCalibrationSettings(calibration) };
  if (state.backend === "builtin") {
    return {
      patch: {
        enabled: true,
        backend: "builtin",
        model: state.builtin.modelId,
        gpu: state.gpu,
        ...calibrationPatch,
      },
      error: null,
    };
  }
  if (state.backend === "endpoint") {
    const endpoint = state.endpoint.verified;
    if (endpoint === null) {
      return {
        patch: null,
        error: "Test the endpoint before finishing; nothing was written.",
      };
    }
    return {
      patch: {
        enabled: true,
        backend: "endpoint",
        endpoint,
        gpu: state.gpu,
        ...calibrationPatch,
      },
      error: null,
    };
  }
  return {
    patch: null,
    error: "Choose a backend before finishing; nothing was written.",
  };
}

/** The model id the finish step reports to the build host. */
export function embeddingWizardBuildModel(
  state: EmbeddingWizardState,
): string | null {
  if (state.backend === "builtin") return state.builtin.modelId;
  const verified = state.endpoint.verified;
  return verified === null ? null : verified.model;
}

// ── Async orchestration ────────────────────────────────────────────────────

/** Reads the component's latest state, so a late outcome applies to *it*. */
export type EmbeddingWizardStateReader = () => EmbeddingWizardState;

function notify(
  listener: EmbeddingWizardStateListener | undefined,
  state: EmbeddingWizardState,
): EmbeddingWizardState {
  listener?.(state);
  return state;
}

/**
 * Apply an outcome to wherever the wizard is *now*.
 *
 * A slow dependency can finish after the user skipped calibration or moved on;
 * the reducer's stale-result guards drop that event, so the reader is what keeps
 * a late result from rewinding the screen. Without it the runner would commit
 * its own pre-navigation snapshot.
 */
function applyOutcome(
  fallback: EmbeddingWizardState,
  event: EmbeddingWizardEvent,
  listener: EmbeddingWizardStateListener | undefined,
  reader: EmbeddingWizardStateReader | undefined,
): EmbeddingWizardState {
  const target = reader?.() ?? fallback;
  const next = applyEmbeddingWizardEvent(target, event);
  listener?.(next);
  return next;
}

/**
 * Download the selected built-in model and the onnxruntime closure (C4 + C2).
 * Only called after the explicit confirmation screen: an Enter on the picker
 * alone never downloads. The runtime goes first because it is the larger
 * transfer and the model cannot be embedded with without it; either transfer is
 * skipped when the install check already found it on disk.
 */
export async function runEmbeddingWizardDownload(
  state: EmbeddingWizardState,
  deps: EmbeddingWizardDeps,
  listener?: EmbeddingWizardStateListener,
  reader?: EmbeddingWizardStateReader,
): Promise<EmbeddingWizardState> {
  if (state.step !== "builtin-download") return state;
  if (state.builtin.download.phase === "running") return state;
  const modelId = state.builtin.modelId;
  const running = notify(
    listener,
    applyEmbeddingWizardEvent(state, { type: "download-started" }),
  );
  // The runner threads its own working state so a caller without a reader (and
  // every state written between here and the outcome) still sees the runtime
  // sub-transfer as done; the listener/reader only add late-navigation safety.
  let current = running;
  const modelBytes = embeddingWizardModelOption(modelId)?.totalBytes ?? 0;
  const needsRuntime = !state.builtin.download.runtimeDone;
  const runtimeBytes = needsRuntime ? EMBEDDING_WIZARD_RUNTIME_BYTES : 0;
  const totalBytes = runtimeBytes + modelBytes;
  const runtimeShare = totalBytes > 0 ? runtimeBytes / totalBytes : 0;
  let lastProgress = 0;
  const emit = (fraction: number) => {
    const progress = Math.min(1, Math.max(lastProgress, fraction));
    lastProgress = progress;
    listener?.(
      applyEmbeddingWizardEvent(current, {
        type: "download-progress",
        progress,
      }),
    );
  };
  let phase: "runtime" | "model" = needsRuntime ? "runtime" : "model";
  let runtimeDir = state.builtin.download.runtimeDir;
  try {
    if (needsRuntime) {
      const runtime = deps.downloadRuntime
        ? await deps.downloadRuntime({
            onProgress: (fraction) => emit(runtimeShare * fraction),
          })
        : await fetchEmbeddingRuntime({
            onProgress: (progress) =>
              emit(runtimeShare * runtimeFetchFraction(progress)),
          });
      runtimeDir = runtime.runtimeDir;
      current = applyEmbeddingWizardEvent(current, {
        type: "runtime-downloaded",
        runtimeDir,
      });
      listener?.(current);
      emit(runtimeShare);
    }
    phase = "model";
    const result = await deps.downloadModel({
      modelId,
      onProgress: (fraction) =>
        emit(runtimeShare + (1 - runtimeShare) * fraction),
    });
    return applyOutcome(
      current,
      {
        type: "download-succeeded",
        result: {
          ...result,
          runtimeDir: runtimeDir ?? embeddingWizardRuntimeDir() ?? "",
        },
      },
      listener,
      reader,
    );
  } catch (error) {
    return applyOutcome(
      current,
      {
        type: "download-failed",
        error:
          phase === "runtime"
            ? `Runtime install failed: ${getErrorMessage(error)}`
            : getErrorMessage(error),
        hint:
          phase === "runtime"
            ? "The embedding runtime could not be installed; check that this machine can reach an npm registry or its mirror, then press Enter to retry."
            : embeddingWizardManualImportHint(modelId),
      },
      listener,
      reader,
    );
  }
}

/** Map a C2 progress tick onto 0..1, so the two transfers share one bar. */
export function runtimeFetchFraction(progress: RuntimeFetchProgress): number {
  if (progress.phase === "metadata") return 0.05;
  if (progress.phase === "download") {
    const written = progress.bytesWritten;
    const total = progress.totalBytes;
    if (typeof written === "number" && typeof total === "number" && total > 0) {
      return 0.1 + 0.75 * Math.min(1, written / total);
    }
    return 0.5;
  }
  if (progress.phase === "verify") return 0.9;
  if (progress.phase === "extract") return 0.92;
  return 0.98;
}

/**
 * Send the test embedding (C6). A refused URL, a missing environment variable
 * and a dead endpoint all end as the same visible failure with its own message.
 */
export async function runEmbeddingWizardEndpointTest(
  state: EmbeddingWizardState,
  deps: EmbeddingWizardDeps,
  listener?: EmbeddingWizardStateListener,
  reader?: EmbeddingWizardStateReader,
): Promise<EmbeddingWizardState> {
  if (state.step !== "endpoint-test") return state;
  if (state.endpoint.test.phase === "running") return state;
  const running = notify(
    listener,
    applyEmbeddingWizardEvent(state, { type: "endpoint-test-started" }),
  );
  const resolution = resolveEmbeddingWizardApiKey(state, deps.readEnv);
  if (resolution.error !== null) {
    return applyOutcome(
      running,
      {
        type: "endpoint-test-failed",
        error: resolution.error,
      },
      listener,
      reader,
    );
  }
  if (resolution.apiKey === null && embeddingWizardEndpointNeedsKey(state)) {
    return applyOutcome(
      running,
      {
        type: "endpoint-test-failed",
        error:
          "This endpoint needs an API key: type it or name the environment variable that holds it.",
      },
      listener,
      reader,
    );
  }
  try {
    const result = await deps.probeEndpoint({
      kind: state.endpoint.kind,
      baseUrl: state.endpoint.baseUrl,
      model: state.endpoint.model.trim(),
      apiKey: resolution.apiKey,
    });
    return applyOutcome(
      running,
      {
        type: "endpoint-test-succeeded",
        result,
      },
      listener,
      reader,
    );
  } catch (error) {
    return applyOutcome(
      running,
      {
        type: "endpoint-test-failed",
        error: getErrorMessage(error),
      },
      listener,
      reader,
    );
  }
}

/** Run the bounded calibration pass. C5 itself degrades; a throw is still shown. */
export async function runEmbeddingWizardCalibration(
  state: EmbeddingWizardState,
  deps: EmbeddingWizardDeps,
  listener?: EmbeddingWizardStateListener,
  reader?: EmbeddingWizardStateReader,
): Promise<EmbeddingWizardState> {
  if (state.step !== "calibrate") return state;
  if (state.calibration.phase !== "idle") return state;
  const running = notify(
    listener,
    applyEmbeddingWizardEvent(state, { type: "calibration-started" }),
  );
  const backend = state.backend ?? "builtin";
  const modelId =
    backend === "endpoint"
      ? (state.endpoint.verified?.model ?? state.endpoint.model)
      : state.builtin.modelId;
  try {
    const result = await deps.calibrate({
      backend,
      modelId,
      endpoint: state.endpoint.verified,
      gpuRole: state.gpu,
    });
    return applyOutcome(
      running,
      {
        type: "calibration-succeeded",
        result,
      },
      listener,
      reader,
    );
  } catch (error) {
    return applyOutcome(
      running,
      {
        type: "calibration-failed",
        error: getErrorMessage(error),
      },
      listener,
      reader,
    );
  }
}

/**
 * The only write path. Order matters and matches D4's flag path: the key is
 * stored first (it is write-only and harmless on its own), then the settings
 * patch lands in one call, then the build is asked to start. A build-start
 * failure does **not** roll back the settings — they are valid, and the receipt
 * tells the user the command that starts the index.
 */
export async function runEmbeddingWizardFinish(
  state: EmbeddingWizardState,
  deps: EmbeddingWizardDeps,
  listener?: EmbeddingWizardStateListener,
  reader?: EmbeddingWizardStateReader,
): Promise<EmbeddingWizardState> {
  if (state.step !== "finish") return state;
  if (state.finish.phase === "saving") return state;
  const saving = notify(
    listener,
    applyEmbeddingWizardEvent(state, { type: "finish-started" }),
  );
  const { patch, error } = embeddingWizardSettingsPatch(saving);
  if (patch === null || error !== null) {
    return applyOutcome(
      saving,
      {
        type: "finish-failed",
        error: error ?? "Nothing was written.",
      },
      listener,
      reader,
    );
  }
  try {
    if (saving.backend === "endpoint") {
      const resolution = resolveEmbeddingWizardApiKey(saving, deps.readEnv);
      if (resolution.error !== null) {
        return applyOutcome(
          saving,
          {
            type: "finish-failed",
            error: resolution.error,
          },
          listener,
          reader,
        );
      }
      if (resolution.apiKey !== null && deps.saveApiKey !== undefined) {
        await deps.saveApiKey(resolution.apiKey);
      }
    }
    deps.saveSettings(patch);
  } catch (caught) {
    return applyOutcome(
      saving,
      {
        type: "finish-failed",
        error: `Could not save embedding settings: ${getErrorMessage(caught)}`,
      },
      listener,
      reader,
    );
  }
  const model = embeddingWizardBuildModel(saving) ?? "";
  let receipt: string;
  try {
    receipt = await deps.startBuild({
      backend: saving.backend ?? "builtin",
      model,
      keepAfterExit: saving.finish.keepAfterExit,
      mode: saving.finish.buildMode,
    });
  } catch (caught) {
    receipt = `Settings saved, but the build could not be started: ${getErrorMessage(caught)}. Run /recall embedding build to start it.`;
  }
  return applyOutcome(
    saving,
    { type: "finish-succeeded", receipt },
    listener,
    reader,
  );
}
