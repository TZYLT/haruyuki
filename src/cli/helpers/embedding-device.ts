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
import type { EmbeddingChunk } from "@/backend/local/embedding-chunk-types";
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

export interface EmbeddingDeviceTestDeps {
  /** Encode-path factory; tests inject a fake so no worker starts. */
  createEmbed?: typeof createEmbeddingBuildEmbed;
}

/** Three ~200-character samples: enough to report a rate, not a benchmark. */
const THROUGHPUT_SAMPLES = [
  "The build writes one generation per unit and flips a single pointer, so a reader never observes a half-written index. ".repeat(
    2,
  ),
  "Memory files are chunked at paragraph boundaries; a hit maps back to the original line span so the injected excerpt is exact. ".repeat(
    2,
  ),
  "Queries are embedded once per turn and scored against the resident corpus; a late result is dropped by the turn deadline. ".repeat(
    2,
  ),
].map(
  (text, index): EmbeddingChunk => ({
    parentId: `device-test-${index}`,
    chunkIndex: 0,
    kind: "prose",
    text,
    startChar: 0,
    endChar: text.length,
    spans: [{ startChar: 0, endChar: text.length }],
    focusChar: Math.floor(text.length / 2),
    estimatedTokens: Math.ceil(text.length / 4),
  }),
);

/** One honest throughput line: texts actually encoded, wall time, rate. */
async function measureThroughput(
  embed: Awaited<ReturnType<typeof createEmbeddingBuildEmbed>>["embed"],
): Promise<string> {
  const startedAt = performance.now();
  const vectors = await embed(THROUGHPUT_SAMPLES);
  const elapsedMs = performance.now() - startedAt;
  const encoded = vectors.filter((vector) => vector !== null).length;
  if (encoded === 0 || elapsedMs <= 0) {
    return "Throughput: not measured (no vectors came back)";
  }
  return `Throughput: ${encoded}/${THROUGHPUT_SAMPLES.length} texts in ${Math.round(elapsedMs)} ms (${(
    (encoded * 1000) / elapsedMs
  ).toFixed(1)} texts/s)`;
}

/**
 * Initialise the configured encode path and report what it accepted, plus one
 * small throughput measurement. A build that would refuse (missing model, no
 * endpoint form) returns its own message instead of throwing.
 */
export async function runEmbeddingDeviceTest(
  settings: ResolvedEmbeddingSettings,
  deps: EmbeddingDeviceTestDeps = {},
): Promise<string> {
  let built: Awaited<ReturnType<typeof createEmbeddingBuildEmbed>>;
  try {
    built = await (deps.createEmbed ?? createEmbeddingBuildEmbed)(settings);
  } catch (error) {
    return `Could not initialise the embedding device: ${getErrorMessage(error)}`;
  }
  try {
    const throughput = await measureThroughput(built.embed).catch(
      (error: unknown) =>
        `Throughput: not measured (${getErrorMessage(error)})`,
    );
    return [
      "Device test (read-only; nothing was written or built):",
      formatEmbeddingDeviceFacts(built.device),
      throughput,
    ].join("\n");
  } finally {
    await built.dispose().catch(() => undefined);
  }
}
