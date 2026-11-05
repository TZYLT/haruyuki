/**
 * `/recall embedding device --test` (48-4 D-03).
 *
 * Read-only: it initialises the build worker exactly as a build would, reports
 * the execution providers the worker **accepted**, then disposes it. It writes
 * no settings, no state and no index, so it is safe to run at any time and it is
 * the only honest way to answer "is the GPU really being used".
 *
 * Layer: `cli/helpers/`; `backend/local/embedding*` is a leaf and the CLI may
 * import it.
 */

import { createEmbeddingBuildEmbed } from "@/backend/local/embedding-build-embed";
import type { EmbeddingBuildDeviceSnapshot } from "@/backend/local/embedding-build-state";
import type { ResolvedEmbeddingSettings } from "@/recall-settings";
import { getErrorMessage } from "@/utils/error";

/** One line per fact; the requested providers stay visible on a fallback. */
export function formatEmbeddingDeviceFacts(
  device: EmbeddingBuildDeviceSnapshot,
): string {
  const providers =
    device.initialized.length === 0 ? "unknown" : device.initialized.join("+");
  const state = device.gpu
    ? "gpu accepted"
    : device.degraded
      ? `cpu fallback: ${device.degradedReason ?? "the GPU was refused"}`
      : "cpu only";
  return [
    `Backend: ${device.backend}`,
    `Providers: requested ${device.requested.join("+")} · initialized ${providers}`,
    `Device: ${state}`,
    `Threads: ${device.threads === 0 ? "auto" : device.threads}`,
    `Warmup: ${device.warmupMs > 0 ? `${Math.round(device.warmupMs)} ms` : "not reported"}`,
    `Measured: ${device.measuredAt}`,
  ].join("\n");
}

/**
 * Initialise the configured encode path and report what it accepted. A build
 * that would refuse (missing model, no endpoint form) returns its own message
 * instead of throwing.
 */
export async function runEmbeddingDeviceTest(
  settings: ResolvedEmbeddingSettings,
): Promise<string> {
  let built: Awaited<ReturnType<typeof createEmbeddingBuildEmbed>>;
  try {
    built = await createEmbeddingBuildEmbed(settings);
  } catch (error) {
    return `Could not initialise the embedding device: ${getErrorMessage(error)}`;
  }
  try {
    return [
      "Device test (read-only; nothing was written or built):",
      formatEmbeddingDeviceFacts(built.device),
    ].join("\n");
  } finally {
    await built.dispose().catch(() => undefined);
  }
}
