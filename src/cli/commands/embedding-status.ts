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
import type { EmbeddingCalibrationSettings } from "@/recall-settings";
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
    `  Chunks: ${compact(summary.chunksPerRound)} hits/round after parent aggregation · ${compact(summary.skipVectorPerRound)} skipped for having no prose`,
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
  lines.push(
    `  Degraded: ${summary.degradedRounds}/${summary.rounds} rounds (${reasons})`,
  );
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
  if (eta.remainingMs !== null) {
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
 * The stored C5 calibration, for a process where the runtime port is absent.
 *
 * The runtime's own line wins when it is present: it is the live measurement,
 * while this is the value written to settings at the last calibration.
 */
export function formatEmbeddingStoredCalibrationLine(
  calibration: EmbeddingCalibrationSettings | null,
): string[] {
  if (calibration === null) return [];
  return [
    `Calibration (stored): ${calibration.measuredAt} · p50 ${ms(calibration.queryLatencyP50Ms)} · p90 ${ms(calibration.queryLatencyP90Ms)} · ${compact(calibration.batchThroughputPerSec)}/s · ${calibration.gpuRole} gpu · ${calibration.threads} threads · ${calibration.quantization}`,
  ];
}
