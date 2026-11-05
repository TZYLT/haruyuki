/**
 * The embedding status face's assembly helpers (48-1 §7.4, 48-2 §3.4 D6).
 *
 * `/recall embedding status` already paints the effective settings, the space
 * and the runtime's build/calibration through D4's handler. What D6 adds is the
 * evidence a user needs to tell "nothing matched" from "nothing worked"
 * (S-04): the two-arm counts from `embedding-metrics`, A2's `state.json`
 * snapshot (coverage, rate, skipped conversations) and the stored C5
 * calibration when no runtime port is wired in this process.
 *
 * Pure formatting on purpose — the caller owns the reads. That keeps the copy
 * assertable without a settings manager, a store or a runtime, and it is why
 * this file has no import from `cli/app` or `cli/components`.
 */

import type { EmbeddingBuildStateSnapshot } from "@/backend/local/embedding-build-state";
import type { EmbeddingConfigKey } from "@/cli/commands/embedding-command-parser";
import type {
  EmbeddingCalibrationSettings,
  ResolvedEmbeddingSettings,
} from "@/recall-settings";
import {
  EMBEDDING_DEGRADE_REASONS,
  type EmbeddingMetricsSnapshot,
  summarizeEmbeddingMetrics,
} from "@/reminders/embedding-metrics";

/** `1.2` for one decimal, `12` for whole numbers, `0.4` for small means. */
function compact(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 10) return String(Math.round(value));
  return String(Math.round(value * 10) / 10);
}

function ms(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0ms";
  // Sub-10 ms averages (encode/fusion) keep one decimal; a rounded `0ms` or a
  // doubled `2ms` would claim a precision the measurement does not have.
  if (value < 10) return `${Math.round(value * 10) / 10}ms`;
  return `${Math.round(value)}ms`;
}

function percent(fraction: number | null): string {
  return fraction === null ? "unknown" : `${Math.round(fraction * 100)}%`;
}

function plural(value: number, singular: string): string {
  return `${value} ${singular}${value === 1 ? "" : "s"}`;
}

/**
 * The two-arm / chunk / timing / degrade summary, or one honest line before the
 * first turn has run.
 *
 * Averages, not the last round: a status face is a trend readout, and the
 * window is what absorbs a single slow turn. The lifetime denominator is used
 * rather than the window's length so the figure does not move backwards when
 * the ring wraps.
 *
 * Degradation reads differently on purpose (48-4 D-02): the lifetime count is
 * background, while **the last round and the current streak are the answer** to
 * "is it broken right now". A lifetime-only counter never clears after a good
 * round, which is exactly what made the status face look stale on a real run.
 */
export function formatEmbeddingMetricsLines(
  snapshot: EmbeddingMetricsSnapshot | null,
): string[] {
  if (snapshot === null || snapshot.totals.rounds === 0) {
    return ["Arms: no recall rounds recorded yet"];
  }
  const summary = summarizeEmbeddingMetrics(snapshot);
  const lines = [
    `Arms: ${plural(summary.rounds, "round")} · lexical ${compact(summary.lexicalPerRound)} · vector ${compact(summary.vectorPerRound)} candidates/round · ${compact(summary.injectedPerRound)} injected · both arms ${compact(summary.bothArmsPerRound)}/round`,
    `  Chunks: ${compact(summary.chunksPerRound)} hits/round before parent aggregation · ${compact(summary.skipVectorPerRound)} skipped for having no prose`,
    `  Timing: lexical ${ms(summary.averageTimings.lexicalMs)} · vector ${ms(summary.averageTimings.vectorMs)} · fusion ${ms(summary.averageTimings.fusionMs)} · total ${ms(summary.averageTimings.totalMs)} per round`,
  ];
  if (summary.degradedRounds === 0) {
    lines.push("  Degraded: no round was degraded");
    return lines;
  }
  const reasons = EMBEDDING_DEGRADE_REASONS.map(
    (reason) => [reason, summary.degrade[reason]] as const,
  )
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${reason} ×${count}`)
    .join(", ");
  const rounds = snapshot.rounds;
  const last = rounds[rounds.length - 1];
  const lastDegrade = last?.degrade ?? [];
  let streak = 0;
  for (let index = rounds.length - 1; index >= 0; index -= 1) {
    if ((rounds[index]?.degrade.length ?? 0) === 0) break;
    streak += 1;
  }
  const background = `${summary.degradedRounds}/${summary.rounds} rounds since start (${reasons})`;
  if (lastDegrade.length === 0) {
    lines.push(`  Degraded: last round clean · ${background}`);
  } else {
    lines.push(
      `  Degraded: ${plural(streak, "round")} in a row · last: ${lastDegrade.join(", ")} · ${background}`,
    );
  }
  return lines;
}

/**
 * A2's `state.json` projection, as the status face needs it.
 *
 * The runtime port's `build` field is the same build's progress, so a caller
 * should pass this only when that port is absent (or has no build); otherwise
 * the same numbers print twice.
 */
export function formatEmbeddingBuildSnapshotLines(
  snapshot: EmbeddingBuildStateSnapshot | null,
): string[] {
  if (snapshot === null) return [];
  const { progress, coverage, rate, eta, failures } = snapshot;
  const coveragePart =
    coverage.ratio === null
      ? "coverage unknown"
      : `coverage ${percent(coverage.ratio)}`;
  const ratePart =
    rate.chunksPerSecond === null
      ? "rate unknown"
      : `${compact(rate.chunksPerSecond)} chunks/s`;
  const lines = [
    `Build (state.json): ${snapshot.phase} · ${progress.embeddedChunks}/${progress.totalChunks} chunks · ${progress.processedConversations}/${progress.totalConversations} conversations · ${coveragePart} · ${ratePart}`,
  ];
  const deviceLine = formatEmbeddingDeviceLine(snapshot);
  if (deviceLine !== null) lines.push(deviceLine);
  // A finished build has nothing left to wait for; an ETA of "1m" next to
  // "Remaining: 0 chunks" was a real status-face bug (48-4 P0-4).
  const active =
    snapshot.phase === "running" || snapshot.phase === "cancelling";
  if (active && eta.remainingChunks > 0 && eta.remainingMs !== null) {
    const minutes = Math.max(1, Math.round(eta.remainingMs / 60_000));
    lines.push(
      `  Remaining: ${plural(eta.remainingChunks, "chunk")} · ETA ${minutes}m`,
    );
  }
  if (failures.length > 0) {
    const shown = failures
      .slice(0, 3)
      .map((failure) => `${failure.conversationId} (${failure.code})`)
      .join(", ");
    const more = failures.length > 3 ? `, +${failures.length - 3} more` : "";
    lines.push(
      `  Skipped: ${plural(failures.length, "conversation")} — ${shown}${more}`,
    );
  }
  return lines;
}

/**
 * `/recall embedding config` output (48-4 D-16).
 *
 * One table for the six build keys. The ones that create a new space say so, so
 * a user changing `chunk-target` is not surprised by an empty index.
 */
export function formatEmbeddingConfigLines(
  settings: ResolvedEmbeddingSettings,
  key?: EmbeddingConfigKey,
): string {
  const rows: Record<EmbeddingConfigKey, string> = {
    "chunk-target": `${settings.chunkTarget} tokens (new space)`,
    "chunk-max": `${settings.chunkMax} tokens (new space)`,
    "chunk-overlap": `${settings.chunkOverlap} tokens (new space)`,
    "max-chunks": `${settings.maxChunksPerMessage} /message (new space)`,
    threads: settings.threads === 0 ? "auto" : `${settings.threads}`,
    gpu:
      settings.gpu === "off"
        ? "off"
        : "auto (tries DirectML on Windows for index builds)",
  };
  const keys: readonly EmbeddingConfigKey[] = [
    "chunk-target",
    "chunk-max",
    "chunk-overlap",
    "max-chunks",
    "threads",
    "gpu",
  ];
  if (key !== undefined) {
    return `${key}: ${rows[key]}\nSet it with /recall embedding config ${key} <value>.`;
  }
  const width = Math.max(...keys.map((name) => name.length));
  const lines = ["Embedding config"];
  for (const name of keys) lines.push(`  ${name.padEnd(width)}  ${rows[name]}`);
  lines.push("Set one with /recall embedding config <key> <value>.");
  return lines.join("\n");
}

/**
 * The one durable answer to "what did the build actually run on" (48-4 D-02).
 *
 * `requested` is the plan; `initialized` is what the worker accepted. A
 * per-node ONNX fallback can still put work on the CPU, so this line reports
 * both instead of claiming the requested provider was used.
 */
export function formatEmbeddingDeviceLine(
  snapshot: EmbeddingBuildStateSnapshot,
): string | null {
  const device = snapshot.device;
  if (device === null) return null;
  const providers =
    device.initialized.length === 0 ? "unknown" : device.initialized.join("+");
  const state = device.gpu
    ? "gpu"
    : device.degraded
      ? `cpu fallback: ${device.degradedReason ?? "gpu refused"}`
      : "cpu";
  const threads =
    device.threads === 0 ? "threads auto" : `${device.threads} threads`;
  const warmup = device.warmupMs > 0 ? ` · warmup ${ms(device.warmupMs)}` : "";
  const requested =
    device.requested.join("+") === providers
      ? ""
      : ` · requested ${device.requested.join("+")}`;
  return `  Device: ${device.backend} · ${providers} (${state})${requested} · ${threads}${warmup} · ${device.measuredAt}`;
}

/**
 * Whether a calibration record carries real measurements.
 *
 * C5's documented-defaults path (a skipped or failed measurement) records zeros,
 * and a zero latency is never a measurement: a status line that printed
 * `p50 0ms · 0/s` would claim the opposite of what happened. The wizard's step 3
 * paints "not measured" for exactly this case (48-2 R-43); every face that shows
 * these numbers uses the same rule.
 */
export function embeddingCalibrationMeasured(input: {
  readonly p50Ms: number;
  readonly throughputPerSecond: number;
}): boolean {
  return (
    Number.isFinite(input.p50Ms) &&
    input.p50Ms > 0 &&
    Number.isFinite(input.throughputPerSecond) &&
    input.throughputPerSecond > 0
  );
}

/**
 * The stored C5 calibration, for a process where the runtime port is absent.
 *
 * The runtime's own line wins when it is present: it is the live measurement,
 * while this is the value written to settings at the last calibration.
 */
export function formatEmbeddingStoredCalibrationLine(
  calibration: EmbeddingCalibrationSettings | null,
): string[] {
  if (calibration === null) return [];
  const measured = embeddingCalibrationMeasured({
    p50Ms: calibration.queryLatencyP50Ms,
    throughputPerSecond: calibration.batchThroughputPerSec,
  });
  if (!measured) {
    return [
      `Calibration (stored): not measured — the documented default budget is in use (recorded ${calibration.measuredAt})`,
    ];
  }
  return [
    `Calibration (stored): ${calibration.measuredAt} · p50 ${ms(calibration.queryLatencyP50Ms)} · p90 ${ms(calibration.queryLatencyP90Ms)} · ${compact(calibration.batchThroughputPerSec)}/s · ${calibration.gpuRole} gpu · ${calibration.threads} threads · ${calibration.quantization}`,
  ];
}
