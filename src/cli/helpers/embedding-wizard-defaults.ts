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
import { EMBEDDING_INDEX_CHUNKER_VERSION } from "@/backend/local/embedding-format";
import { saveEmbeddingApiKey } from "@/cli/app/pages/settings/embedding-secrets";
import { updateEmbeddingSettings } from "@/cli/app/pages/settings/embedding-settings";
import { embeddingWizardCalibrationFromResult } from "@/cli/helpers/embedding-wizard-actions";
import type {
  EmbeddingWizardBuildRequest,
  EmbeddingWizardDeps,
} from "@/cli/helpers/embedding-wizard-state";

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
 * Step 4's build start. A4 (`cli/helpers/embedding-build-host`) is the intended
 * owner of `startEmbeddingBuild`; this seam is the one place a Lead integration
 * swaps the default for it. Reporting the command is deliberate: telling the
 * user a build started when no host is wired would be the worse lie.
 */
function defaultStartBuild(request: EmbeddingWizardBuildRequest): string {
  const lifecycle = request.keepAfterExit
    ? "keep-after-exit is on"
    : "the build stops when you exit";
  return `Settings saved. Run /recall embedding build to start the index (${lifecycle}); the background build host is not wired in this build.`;
}

export function createEmbeddingWizardDefaultDeps(
  agentId: string,
  env: Record<string, string | undefined> | undefined,
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
    calibrate: async (request) => {
      const environment = calibrationEnvironment(request.modelId);
      const result = skipEmbeddingCalibration(environment, {
        reason:
          "calibration probe is not wired in this build; documented defaults are used",
      });
      return embeddingWizardCalibrationFromResult(result);
    },
    saveSettings: (patch) => {
      updateEmbeddingSettings(patch);
    },
    saveApiKey: async (value) => {
      await saveEmbeddingApiKey(value, agentId);
    },
    startBuild: (request) => defaultStartBuild(request),
    readEnv: (name) => (env ?? process.env)[name],
  };
}
