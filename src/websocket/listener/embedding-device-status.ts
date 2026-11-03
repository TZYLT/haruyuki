import { readEmbeddingBuildStatusSnapshot } from "@/cli/hooks/use-embedding-build-status";
import type { EmbeddingDeviceSummary } from "@/types/embedding-protocol";

/**
 * `device_status.embedding` summary (R-26 / D2, 48-2 §4.9).
 *
 * `device_status` is emitted on most turn and command transitions, while a
 * build's progress changes a few times per second at most. The summary
 * therefore needs a cache: a five-second TTL keeps a started/finished build
 * visible well within one client render cycle without paying a build-state read
 * on every emission.
 *
 * D2 owns this cache/TTL/dedup; A5 only feeds the progress (48-2 §3.4). The
 * read itself is injected through `setEmbeddingDeviceSummaryProvider` so the
 * listener can project the build state without importing the runner (the
 * provider is a `null` reader until A2/A5 land).
 */

/** How long one agent's embedding summary is reused by the status broadcast. */
export const EMBEDDING_DEVICE_SUMMARY_TTL_MS = 5_000;

/** One agent per entry; bounded because agents are few per listener. */
const EMBEDDING_SUMMARY_CACHE_LIMIT = 64;

/**
 * Where the build-state projection is plugged in (A2 `state.json` / A5
 * progress). `null` means "no embedding subsystem in this build".
 *
 * TODO(integration): A2/A5 wire the real reader here; until then the default
 * provider answers `null` and `device_status.embedding` reports nothing.
 */
export type EmbeddingDeviceSummaryProvider = (
  agentId: string,
) => EmbeddingDeviceSummary | null;

let summaryProvider: EmbeddingDeviceSummaryProvider = () => null;

type CachedEmbeddingSummary = {
  expiresAt: number;
  /** Serialized projection, used for the JSON dedup across a TTL boundary. */
  json: string;
  summary: EmbeddingDeviceSummary | null;
};

const summaryByAgent = new Map<string, CachedEmbeddingSummary>();

/**
 * Install (or clear, with `null`) the build-state reader.
 *
 * Clearing the cache on a provider change matters: a new reader may disagree
 * with the previous projection, and returning the stale summary for up to five
 * seconds would hide the new `state`/`failure`.
 */
export function setEmbeddingDeviceSummaryProvider(
  provider: EmbeddingDeviceSummaryProvider | null,
): void {
  summaryProvider = provider ?? (() => null);
  summaryByAgent.clear();
}

/**
 * The `device_status.embedding` summary, cached per agent.
 *
 * `now` is injectable so tests can step past the TTL without waiting.
 */
export function getEmbeddingDeviceSummary(
  agentId: string | null,
  now: number = Date.now(),
): EmbeddingDeviceSummary | null {
  if (!agentId) return null;
  const cached = summaryByAgent.get(agentId);
  if (cached && cached.expiresAt > now) return cached.summary;

  const summary = summaryProvider(agentId);
  const json = JSON.stringify(summary);
  // JSON dedup: an unchanged projection across the TTL boundary keeps the
  // cached object. The caller compares the whole `device_status` as JSON, so
  // reusing the object means a pure TTL refresh does not manufacture an
  // emission (or a render) for a summary that did not change.
  const deduped = cached && cached.json === json ? cached.summary : summary;
  if (
    summaryByAgent.size >= EMBEDDING_SUMMARY_CACHE_LIMIT &&
    !summaryByAgent.has(agentId)
  ) {
    summaryByAgent.clear();
  }
  summaryByAgent.set(agentId, {
    expiresAt: now + EMBEDDING_DEVICE_SUMMARY_TTL_MS,
    json,
    summary: deduped,
  });
  return deduped;
}

/**
 * A5's provider: project the current build status into D1's wire shape.
 *
 * Synchronous on purpose — D2's `getEmbeddingDeviceSummary` is called from the
 * `device_status` broadcast, which must not await a `state.json` read. The A5
 * cache answers immediately and refreshes itself at ≤0.5 Hz in the background
 * (`readEmbeddingBuildStatusSnapshot`), so the first emission after a cold
 * start can be `null` and the next one (inside the 5 s TTL) carries the build.
 *
 * Only a live or recently finished build is reported: a disabled feature or an
 * idle space returns `null`, so `device_status` omits the field entirely. No
 * timer is started here — the polling cadence belongs to the A5 hook; a
 * listener-only process gets its refresh from this call itself.
 */
export function readEmbeddingBuildDeviceSummary(
  agentId: string,
): EmbeddingDeviceSummary | null {
  const status = readEmbeddingBuildStatusSnapshot(agentId);
  if (status === null) return null;
  const build = status.build;
  if (build === null || build === undefined) return null;
  const running = build.state === "running" || build.state === "cancelling";
  const summary: EmbeddingDeviceSummary = {
    enabled: status.enabled,
    state: build.state,
    space_id: status.spaceId,
    model: status.model,
  };
  if (running) {
    if (build.progress !== null && build.progress !== undefined) {
      summary.progress = build.progress;
    }
    if (build.processedChunks !== undefined) {
      summary.processed_chunks = build.processedChunks;
    }
    if (build.totalChunks !== undefined) {
      summary.total_chunks = build.totalChunks;
    }
    summary.eta_ms = build.etaMs ?? null;
  }
  if (build.state === "failed") summary.failure = build.error ?? null;
  return summary;
}

// A5 wiring (48-2 §3.1/§4.9): the real projection replaces the null reader.
// Tests and alternate hosts may still override or clear it through
// `setEmbeddingDeviceSummaryProvider`; TTL/dedup remain D2's.
setEmbeddingDeviceSummaryProvider(readEmbeddingBuildDeviceSummary);

/** Drop every cached summary; used by tests after changing the provider. */
export function resetEmbeddingDeviceSummaryCache(): void {
  summaryByAgent.clear();
}
