/**
 * The embedding segment of the product-status line (48-1 §7.4, 48-2 §3.4 D6).
 *
 * This is the frozen seam between whatever polls the embedding subsystem and
 * the line the TUI paints: the poller reads the snapshot, this module renders
 * it, and neither side knows about the other's I/O. Everything here is pure —
 * no settings read, no file, no timer, no `process.env` — and the only styling
 * input is the caller's `chalk`, so a styled caller and a test strip the same
 * bytes.
 *
 * The requirement's shape (48-1 §7.4) is `embedding 34% 1.2k/3.6k · ETA ≈8m`
 * while a build runs, and **no row at all when nothing is happening**: idle
 * does not occupy the status line. The same module paints the two states a
 * missing feature would hide (S-04):
 *
 * - `failed`  — the build stopped; the redacted reason is shown, not a spinner;
 * - `degraded` — the last recall turn ran without the vector arm, so "no hit"
 *   and "not working" stay distinguishable.
 *
 * Narrow widths drop the tail of the field list (ETA, then chunk counts, then
 * the model, then the percentage), mirroring `dream.ts`'s R-01.4 rule, and the
 * segment gives way entirely when even the label does not fit.
 */

import type { ChalkInstance } from "chalk";
import { colors } from "@/cli/components/colors";
import { terminalTextWidth } from "@/cli/helpers/char-width";
import type { EmbeddingBuildState } from "@/types/embedding-protocol";

/** The separator between the segment's fields (`default.ts` uses the same one). */
export const EMBEDDING_SEGMENT_SEPARATOR = " · ";

/** Build progress as the status line paints it; injectable, not read here. */
export interface EmbeddingProductBuildStatus {
  state: EmbeddingBuildState;
  /** 0..1, or `null` while the total is unknown. */
  progress: number | null;
  processedChunks?: number;
  totalChunks?: number;
  /** Wall-clock estimate; `null` until the runner has a rate. */
  etaMs?: number | null;
  /** Redacted, actionable failure text; only read while `state === "failed"`. */
  error?: string | null;
}

/**
 * The two-arm summary of the last recall turn.
 *
 * Counts, never passages: `lexical`/`vector` are candidate counts, `injected`
 * is the number of passages that actually entered the prompt.
 */
export interface EmbeddingProductArmSummary {
  lexical: number;
  vector: number;
  injected: number;
  /** At least one arm reported a degrade reason on the last round. */
  degraded: boolean;
}

/** Everything the segment needs; the caller owns how it was obtained. */
export interface EmbeddingProductStatusSnapshot {
  /** The segment only exists while the feature is on. */
  enabled: boolean;
  backend: "builtin" | "endpoint";
  /** The effective model id, or `null` when the endpoint was never configured. */
  model: string | null;
  build?: EmbeddingProductBuildStatus | null;
  /** Vector coverage of the recallable corpus (0..1), or `null` if unknown. */
  coverage?: number | null;
  arms?: EmbeddingProductArmSummary | null;
  /** Last degrade reason code, or `null` when the last turn ran fully. */
  degrade?: string | null;
}

const DEGRADED_LABEL = "degraded";
const FAILED_LABEL = "failed";

function formatPercent(fraction: number | null | undefined): string | null {
  if (
    fraction === null ||
    fraction === undefined ||
    !Number.isFinite(fraction)
  ) {
    return null;
  }
  return `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
}

/**
 * `1.2k` / `950`: chunk counters are large and only need two significant digits
 * on one line; the full number stays in `/recall embedding status`.
 */
export function formatEmbeddingCount(count: number | null | undefined): string {
  if (count === null || count === undefined || !Number.isFinite(count)) {
    return "0";
  }
  const value = Math.max(0, Math.trunc(count));
  if (value < 1_000) return String(value);
  if (value < 1_000_000) {
    const thousands = value / 1_000;
    // `1.2k` for 1,200 but `12k` for 12,000 — one decimal only while it reads
    // as a fraction, which keeps the field at most five columns.
    return `${thousands < 10 ? thousands.toFixed(1) : Math.round(thousands)}k`;
  }
  return `${Math.round(value / 1_000_000)}M`;
}

/** `8m` / `32s`; `null` when there is no estimate yet. */
export function formatEmbeddingEta(
  etaMs: number | null | undefined,
): string | null {
  if (etaMs === null || etaMs === undefined || !Number.isFinite(etaMs)) {
    return null;
  }
  const ms = Math.max(0, etaMs);
  if (ms < 60_000) return `ETA ${Math.max(1, Math.round(ms / 1_000))}s`;
  return `ETA ${Math.max(1, Math.round(ms / 60_000))}m`;
}

function formatChunkCounts(
  processed: number | undefined,
  total: number | undefined,
): string | null {
  if (processed === undefined && total === undefined) return null;
  return `${formatEmbeddingCount(processed)}/${formatEmbeddingCount(total)}`;
}

function isRunningBuild(state: EmbeddingBuildState): boolean {
  return state === "running" || state === "cancelling";
}

interface SegmentParts {
  /** `embedding` with its state colour. */
  head: string;
  /** Optional fields, display order = degradation order's reverse. */
  fields: string[];
}

function buildRunningParts(
  snapshot: EmbeddingProductStatusSnapshot,
  build: EmbeddingProductBuildStatus,
  chalk: ChalkInstance,
): SegmentParts {
  const head = chalk.hex(colors.state.info)("embedding");
  const fields: string[] = [];
  const percent = formatPercent(build.progress);
  if (percent !== null) fields.push(chalk.dim(percent));
  if (snapshot.model !== null) fields.push(chalk.dim(snapshot.model));
  // The backend token only carries information for an endpoint: it is the
  // egress case (query text leaves the machine), while `builtin` is implied by
  // a local model id and would spend columns saying nothing.
  if (snapshot.backend === "endpoint") fields.push(chalk.dim("endpoint"));
  const counts = formatChunkCounts(build.processedChunks, build.totalChunks);
  if (counts !== null) fields.push(chalk.dim(counts));
  const eta = formatEmbeddingEta(build.etaMs);
  if (eta !== null) fields.push(chalk.dim(eta));
  return { head, fields };
}

function buildFailureParts(
  build: EmbeddingProductBuildStatus,
  chalk: ChalkInstance,
): SegmentParts {
  const head = `${chalk.hex(colors.state.error)("embedding")} ${chalk.hex(colors.state.error)(FAILED_LABEL)}`;
  const reason = build.error?.trim();
  return { head, fields: reason ? [chalk.dim(reason)] : [] };
}

function buildDegradedParts(
  reason: string | null | undefined,
  chalk: ChalkInstance,
): SegmentParts {
  const head = `${chalk.hex(colors.state.warning)("embedding")} ${chalk.hex(colors.state.warning)(DEGRADED_LABEL)}`;
  const detail = reason?.trim();
  return { head, fields: detail ? [chalk.dim(detail)] : [] };
}

function buildArmsParts(
  snapshot: EmbeddingProductStatusSnapshot,
  arms: EmbeddingProductArmSummary,
  chalk: ChalkInstance,
): SegmentParts {
  const completed = snapshot.build?.state === "completed";
  const head = chalk.hex(completed ? colors.state.success : colors.state.info)(
    completed ? "✓ embedding" : "embedding",
  );
  const fields: string[] = [];
  // The model is the one configuration field worth a column here: it is what
  // the arm counts are about, and it is dropped after the counts when narrow.
  if (snapshot.model !== null) fields.push(chalk.dim(snapshot.model));
  fields.push(chalk.dim(`${arms.injected} in`));
  fields.push(chalk.dim(`lex ${arms.lexical}`));
  fields.push(chalk.dim(`vec ${arms.vector}`));
  if (snapshot.backend === "endpoint") fields.push(chalk.dim("endpoint"));
  const coverage = formatPercent(snapshot.coverage);
  if (coverage !== null) fields.push(chalk.dim(`cov ${coverage}`));
  return { head, fields };
}

function buildCoverageParts(
  coverage: number | null | undefined,
  chalk: ChalkInstance,
): SegmentParts {
  const rendered = formatPercent(coverage);
  if (rendered === null) return { head: "", fields: [] };
  return {
    head: chalk.hex(colors.state.info)("embedding"),
    fields: [chalk.dim(`built · ${rendered} coverage`)],
  };
}

/**
 * Pick the one state the line is about — build beats arm counts, failure beats
 * everything, and "nothing happening" renders an empty string.
 */
function buildSegmentParts(
  snapshot: EmbeddingProductStatusSnapshot,
  chalk: ChalkInstance,
): SegmentParts {
  const build = snapshot.build ?? null;
  if (build !== null && build.state === "failed") {
    return buildFailureParts(build, chalk);
  }
  if (build !== null && isRunningBuild(build.state)) {
    return buildRunningParts(snapshot, build, chalk);
  }
  if (
    snapshot.degrade !== null &&
    snapshot.degrade !== undefined &&
    snapshot.degrade.trim() !== ""
  ) {
    return buildDegradedParts(snapshot.degrade, chalk);
  }
  const arms = snapshot.arms ?? null;
  if (arms !== null) {
    if (arms.degraded) {
      // The last round degraded but the caller only has the flag: say so
      // without inventing a reason code.
      return buildDegradedParts(null, chalk);
    }
    return buildArmsParts(snapshot, arms, chalk);
  }
  const coverageParts = buildCoverageParts(snapshot.coverage, chalk);
  if (coverageParts.head !== "") return coverageParts;
  // Enabled, but there is no build, no round and no coverage yet: 48-1 §7.4
  // says an idle feature does not occupy the status line.
  return { head: "", fields: [] };
}

/**
 * Render the `embedding …` segment, or `""` when it must not be shown.
 *
 * `width` is the columns the line has left for this segment. The field list is
 * dropped from the tail until the remaining text fits, and a segment whose
 * label alone does not fit gives way entirely.
 */
export function renderEmbeddingSegment(
  snapshot: EmbeddingProductStatusSnapshot | null | undefined,
  width: number,
  chalk: ChalkInstance,
): string {
  if (width <= 0 || snapshot === null || snapshot === undefined) return "";
  if (!snapshot.enabled) return "";
  const parts = buildSegmentParts(snapshot, chalk);
  if (parts.head === "") return "";
  const ordered = [parts.head, ...parts.fields];
  for (let count = ordered.length; count >= 1; count -= 1) {
    const candidate = ordered.slice(0, count).join(EMBEDDING_SEGMENT_SEPARATOR);
    if (terminalTextWidth(candidate) <= width) return candidate;
  }
  return "";
}

/**
 * The rendered segment's plain text length is not the whole story on a mixed
 * line, so the caller may want the model label separately; this helper keeps
 * that decision out of the renderer.
 */
export function embeddingModelLabel(
  snapshot: EmbeddingProductStatusSnapshot,
): string {
  if (snapshot.model !== null) return snapshot.model;
  return snapshot.backend === "endpoint" ? "endpoint" : "builtin";
}
