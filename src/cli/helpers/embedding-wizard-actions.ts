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

import { resolveEmbeddingModelPaths } from "@/backend/local/embedding/model-download-install";
import type { EmbeddingSettingsPatch } from "@/cli/app/pages/settings/embedding-settings";
import {
  applyEmbeddingWizardEvent,
  type EmbeddingWizardCalibration,
  type EmbeddingWizardDeps,
  type EmbeddingWizardEvent,
  type EmbeddingWizardState,
  type EmbeddingWizardStateListener,
  embeddingWizardEndpointNeedsKey,
  resolveEmbeddingWizardApiKey,
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

/**
 * The D3 patch the finish step writes. Pure and exported so the test can pin the
 * exact record (including the "only one write" property) without a component.
 */
export function embeddingWizardSettingsPatch(state: EmbeddingWizardState): {
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
 * Download the selected built-in model (C4). Only called after the explicit
 * confirmation screen: an Enter on the picker alone never downloads.
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
  try {
    const result = await deps.downloadModel({
      modelId,
      onProgress: (progress) => {
        listener?.(
          applyEmbeddingWizardEvent(running, {
            type: "download-progress",
            progress,
          }),
        );
      },
    });
    return applyOutcome(
      running,
      {
        type: "download-succeeded",
        result,
      },
      listener,
      reader,
    );
  } catch (error) {
    return applyOutcome(
      running,
      {
        type: "download-failed",
        error: getErrorMessage(error),
        hint: embeddingWizardManualImportHint(modelId),
      },
      listener,
      reader,
    );
  }
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
