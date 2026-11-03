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

/** Drop every cached summary; used by tests after changing the provider. */
export function resetEmbeddingDeviceSummaryCache(): void {
  summaryByAgent.clear();
}
