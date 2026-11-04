/**
 * The wizard's production dependencies (48-2 §4.9 D5).
 *
 * Kept out of `EmbeddingWizard.tsx` for the same reason the runners live apart
 * from the reducer: the component is a view, and these are the real C4/C6/C5/D3
 * seams it would otherwise drag into every frame assertion. Tests inject fakes
 * through the component's `deps` prop and never execute anything here.
 *
 * Two defaults are deliberately conservative:
 *
 * - `calibrate` uses C5's `skipEmbeddingCalibration` with a redacted reason. C5's
 *   measurement needs a runtime probe (C3's worker / C6's client adapters), which
 *   is not wired in this build; the function is the documented-defaults path and
 *   is exactly what the wizard's "skip" step describes.
 * - `startBuild` is A4's `startEmbeddingBuild` seam
 *   (`cli/helpers/embedding-build-host`). Until that host is wired in the TUI it
 *   cannot run without an identity, embed adapter and units provider, so the
 *   default reports the actionable command instead of pretending a build started.
 */

import { cpus, totalmem } from "node:os";
import {
  type EmbeddingCalibrationEnvironment,
  skipEmbeddingCalibration,
} from "@/backend/local/embedding/calibration";
import { testEmbeddingEndpoint } from "@/backend/local/embedding/endpoint-client";
import {
  type EmbeddingModelDownloadProgress,
  fetchEmbeddingModel,
} from "@/backend/local/embedding/model-download";
import { isEmbeddingModelInstalled } from "@/backend/local/embedding/model-download-install";
import {
  fetchEmbeddingRuntime,
  readEmbeddingRuntimeManifest,
} from "@/backend/local/embedding/runtime-fetch";
import { resolveEmbeddingBuiltinAssets } from "@/backend/local/embedding-assets";
import {
  buildEmbeddingCalibrationEnvironment,
  createDirectMlCalibrationProbe,
  runEmbeddingCalibration,
} from "@/backend/local/embedding-calibration-probe";
import { EMBEDDING_INDEX_CHUNKER_VERSION } from "@/backend/local/embedding-format";
import { saveEmbeddingApiKey } from "@/cli/app/pages/settings/embedding-secrets";
import { updateEmbeddingSettings } from "@/cli/app/pages/settings/embedding-settings";
import { buildEmbeddingFromSettings } from "@/cli/helpers/embedding-runtime";
import {
  embeddingWizardCalibrationFromResult,
  runtimeFetchFraction,
} from "@/cli/helpers/embedding-wizard-actions";
import type {
  EmbeddingWizardCalibrationRequest,
  EmbeddingWizardDeps,
} from "@/cli/helpers/embedding-wizard-state";
import {
  type ResolvedEmbeddingSettings,
  readEmbeddingSettings,
} from "@/recall-settings";

// ── Production seams ───────────────────────────────────────────────────────

/** One progress tick as 0..1; byte counts first, file counts as the fallback. */
function downloadFraction(progress: EmbeddingModelDownloadProgress): number {
  if (
    typeof progress.bytesWritten === "number" &&
    typeof progress.totalBytes === "number" &&
    progress.totalBytes > 0
  ) {
    return Math.min(1, progress.bytesWritten / progress.totalBytes);
  }
  if (
    typeof progress.filesCompleted === "number" &&
    typeof progress.filesTotal === "number" &&
    progress.filesTotal > 0
  ) {
    return Math.min(1, progress.filesCompleted / progress.filesTotal);
  }
  return 0;
}

/** The static facts C5's fingerprint is derived from (no measurement taken). */
function calibrationEnvironment(
  modelId: string,
): EmbeddingCalibrationEnvironment {
  const processors = cpus();
  return {
    platform: process.platform,
    arch: process.arch,
    cpuModel: processors[0]?.model ?? "unknown",
    cores: Math.max(1, processors.length),
    totalMemoryBytes: totalmem(),
    // DirectML/CoreML probing belongs to the runtime (C7/C8); this build's
    // calibration default is the CPU-only documented budget.
    executionProviders: ["cpu"],
    runtime:
      typeof Bun === "undefined"
        ? `node-${process.version}`
        : `bun-${Bun.version}`,
    modelId: modelId.length > 0 ? modelId : "unknown",
    quantization: "float32",
    chunkerVersion: EMBEDDING_INDEX_CHUNKER_VERSION,
  };
}

/**
 * Step 4's build start is A4's host through {@link buildEmbeddingFromSettings}:
 * the wizard has already written the settings by the time this runs, so the
 * build resolves the same space, asset gate and GPU decision as the command.
 */

/** Test seam: point the production checks at a fixture cache directory. */
export interface EmbeddingWizardDefaultDepsOptions {
  readonly modelsDir?: string;
}

/** The settings record a calibration step is measured against. */
function calibrationSettings(
  request: EmbeddingWizardCalibrationRequest,
): ResolvedEmbeddingSettings {
  const settings = readEmbeddingSettings();
  return {
    ...settings,
    backend: request.backend,
    model: request.modelId,
    endpoint: request.endpoint,
    gpu: request.gpuRole,
  };
}

/** The built-in assets a calibration probe reads (installed by step 2). */
function assetsForCalibration(
  request: EmbeddingWizardCalibrationRequest,
  options: EmbeddingWizardDefaultDepsOptions,
) {
  return resolveEmbeddingBuiltinAssets(request.modelId, {
    ...(options.modelsDir === undefined
      ? {}
      : { modelsDir: options.modelsDir }),
  });
}

/**
 * Step 3: the bounded calibration pass.
 *
 * A built-in model is measured through C3's worker (`runEmbeddingCalibration`),
 * with a DirectML trial on Windows when the user asked for a GPU role. Endpoint
 * backends keep C5's documented defaults: their latency is a network round trip,
 * not a local encode, and the encoder client owns its own timeout/breaker. The
 * probe is disposed either way; a failed measurement becomes C5's defaults, never
 * a blocked wizard step.
 */
async function defaultCalibrate(
  request: EmbeddingWizardCalibrationRequest,
  options: EmbeddingWizardDefaultDepsOptions,
) {
  if (request.backend !== "builtin") {
    const skipped = skipEmbeddingCalibration(
      calibrationEnvironment(request.modelId),
      {
        reason:
          "endpoint mode keeps the documented budget: the endpoint client owns its own timeout and breaker",
      },
    );
    return embeddingWizardCalibrationFromResult(skipped);
  }
  const settings = calibrationSettings(request);
  const assets = assetsForCalibration(request, options);
  const environment = buildEmbeddingCalibrationEnvironment(settings, assets);
  const gpuRole = request.gpuRole;
  const gpuProbe =
    process.platform === "win32" && gpuRole !== "off"
      ? createDirectMlCalibrationProbe({ assets })
      : undefined;
  let probe:
    | Awaited<ReturnType<typeof runEmbeddingCalibration>>["probe"]
    | null = null;
  try {
    const calibration = await runEmbeddingCalibration({
      settings,
      assets,
      ...(gpuProbe === undefined ? {} : { gpuProbe }),
    });
    probe = calibration.probe;
    return embeddingWizardCalibrationFromResult(calibration.result);
  } catch {
    // A measurement failure is not a wizard failure (48-1 §6.6): fall back to
    // the documented defaults and let the finish step record them as such.
    const skipped = skipEmbeddingCalibration(environment, {
      reason: "calibration measurement failed; documented defaults are used",
    });
    return embeddingWizardCalibrationFromResult(skipped);
  } finally {
    await probe?.dispose().catch(() => undefined);
  }
}

export function createEmbeddingWizardDefaultDeps(
  agentId: string,
  env: Record<string, string | undefined> | undefined,
  options: EmbeddingWizardDefaultDepsOptions = {},
): EmbeddingWizardDeps {
  return {
    downloadModel: async (request) => {
      const result = await fetchEmbeddingModel({
        modelId: request.modelId,
        // C4's manifest for bge-small carries sha256 for the weights but not
        // for the three non-LFS JSON files; the confirmation screen discloses
        // that before this runs, and the install marker records what landed.
        allowUnpinnedIntegrity: true,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        onProgress: (progress) => {
          request.onProgress?.(downloadFraction(progress));
        },
      });
      return {
        modelId: result.manifest.id,
        modelDir: result.modelDir,
        alreadyInstalled: result.alreadyInstalled,
        runtimeDir: "",
      };
    },
    isModelInstalled: async (modelId) =>
      isEmbeddingModelInstalled({
        modelId,
        ...(options.modelsDir === undefined
          ? {}
          : { modelsDir: options.modelsDir }),
      }),
    isRuntimeInstalled: async () =>
      (await readEmbeddingRuntimeManifest()) !== null,
    downloadRuntime: async (request) => {
      const result = await fetchEmbeddingRuntime({
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        onProgress: (progress) => {
          request.onProgress?.(runtimeFetchFraction(progress));
        },
      });
      return {
        runtimeDir: result.runtimeDir,
        alreadyInstalled: result.alreadyInstalled,
      };
    },
    probeEndpoint: async (request) => {
      const result = await testEmbeddingEndpoint({
        kind: request.kind,
        baseUrl: request.baseUrl,
        model: request.model,
        ...(request.apiKey === null ? {} : { apiKey: request.apiKey }),
      });
      return {
        kind: request.kind,
        model: result.model,
        dimensions: result.dimensions,
        norm: result.norm,
        latencyMs: result.latencyMs,
      };
    },
    calibrate: async (request) => defaultCalibrate(request, options),
    saveSettings: (patch) => {
      updateEmbeddingSettings(patch);
    },
    saveApiKey: async (value) => {
      await saveEmbeddingApiKey(value, agentId);
    },
    startBuild: async (request) =>
      await buildEmbeddingFromSettings({
        agentId,
        mode: request.mode,
        keepAfterExit: request.keepAfterExit,
        lifecycle: "tui",
      }),
    readEnv: (name) => (env ?? process.env)[name],
  };
}
