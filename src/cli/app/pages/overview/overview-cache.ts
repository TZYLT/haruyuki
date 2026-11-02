// src/cli/app/pages/overview/overview-cache.ts

/**
 * The overview's module-level store (W-12, T-10).
 *
 * Kept out of React on purpose: the page can remount (tab switch, page host
 * re-render) without paying for the snapshot again, and the store's two rules —
 * a 30 s TTL and a generation counter — are testable without a renderer.
 *
 * The two rules:
 *
 * - **TTL ({@link OVERVIEW_CACHE_TTL_MS}).** A snapshot is fresh for 30 s of
 *   wall time, measured against its own `generatedAtMs` — the same anchor the
 *   row builder uses for relative times, so the page never reads the clock
 *   inside a render. The page's `r` key asks for a forced refresh instead.
 * - **Generation.** Every stored snapshot takes the next generation number.
 *   A lazy preview read captures the generation it started under; when it
 *   lands, a newer generation means its data belongs to the previous snapshot
 *   and it is dropped rather than applied (W-12's 代际号取消). Writing a new
 *   snapshot also clears the preview cache, because a preview read before the
 *   refresh is not a read of the refreshed data.
 *
 * This module deliberately holds no backend and starts no timers: it is the
 * memory, `overview-data` is the policy, and `overview-fetch` is the I/O.
 */
import type { OverviewConversationPreview } from "./overview-fetch";
import type { OverviewSnapshot } from "./overview-types";

/** How long a snapshot serves without a backend read (R-10.8's cache). */
export const OVERVIEW_CACHE_TTL_MS = 30_000;

let cachedSnapshot: OverviewSnapshot | null = null;
let generation = 0;
const cachedPreviews = new Map<string, OverviewConversationPreview>();
const inFlightPreviews = new Map<
  string,
  Promise<OverviewConversationPreview>
>();
let inFlightSnapshot: Promise<OverviewSnapshot> | null = null;

/** The preview cache key: conversation ids are only unique within an agent. */
export function overviewPreviewKey(
  agentId: string,
  conversationId: string,
): string {
  return `${agentId}\u0000${conversationId}`;
}

/**
 * The cached snapshot if it is younger than the TTL, else `null`.
 *
 * An expired snapshot is left in place rather than dropped: a forced refresh
 * that fails should not destroy the data the page is still showing.
 */
export function readCachedOverviewSnapshot(
  nowMs: number,
): OverviewSnapshot | null {
  if (!cachedSnapshot) return null;
  const ageMs = nowMs - cachedSnapshot.generatedAtMs;
  return ageMs < OVERVIEW_CACHE_TTL_MS ? cachedSnapshot : null;
}

/**
 * Store a freshly fetched snapshot and open a new generation.
 *
 * Clearing the previews and the in-flight preview map is what cancels the
 * reads that were started against the previous snapshot; the callers awaiting
 * them see the generation move and report `stale`.
 */
export function storeOverviewSnapshot(snapshot: OverviewSnapshot): number {
  cachedSnapshot = snapshot;
  generation += 1;
  cachedPreviews.clear();
  inFlightPreviews.clear();
  return generation;
}

export function currentOverviewGeneration(): number {
  return generation;
}

export function readCachedOverviewPreview(
  agentId: string,
  conversationId: string,
): OverviewConversationPreview | null {
  return (
    cachedPreviews.get(overviewPreviewKey(agentId, conversationId)) ?? null
  );
}

/**
 * Store a preview read that started under `readGeneration`.
 *
 * Returns `false` when the generation has moved: the read is stale and its
 * data must not be applied (this is the 代际号取消 check, and the only place a
 * preview enters the cache).
 */
export function storeOverviewPreview(
  readGeneration: number,
  agentId: string,
  conversationId: string,
  preview: OverviewConversationPreview,
): boolean {
  if (readGeneration !== generation) return false;
  cachedPreviews.set(overviewPreviewKey(agentId, conversationId), preview);
  return true;
}

/**
 * The in-flight preview read for one conversation, so concurrent asks share
 * one backend round trip (R-10.8: each conversation is read at most once).
 */
export function readInFlightOverviewPreview(
  key: string,
): Promise<OverviewConversationPreview> | null {
  return inFlightPreviews.get(key) ?? null;
}

export function setInFlightOverviewPreview(
  key: string,
  promise: Promise<OverviewConversationPreview>,
): void {
  inFlightPreviews.set(key, promise);
}

export function clearInFlightOverviewPreview(key: string): void {
  inFlightPreviews.delete(key);
}

/** The snapshot fetch already running, so two callers do not read twice. */
export function readInFlightOverviewSnapshot(): Promise<OverviewSnapshot> | null {
  return inFlightSnapshot;
}

export function setInFlightOverviewSnapshot(
  promise: Promise<OverviewSnapshot> | null,
): void {
  inFlightSnapshot = promise;
}

/**
 * Drop everything and open a new generation.
 *
 * The page does not need this for `r` (a forced read replaces the snapshot and
 * bumps the generation itself); it exists for tests and for a future teardown
 * that wants in-flight reads to be refused.
 */
export function resetOverviewCache(): void {
  cachedSnapshot = null;
  generation += 1;
  cachedPreviews.clear();
  inFlightPreviews.clear();
  inFlightSnapshot = null;
}
