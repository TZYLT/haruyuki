// src/cli/app/pages/overview/overview-data.ts

/**
 * The overview page's data layer (W-12, T-10).
 *
 * This is the module the page shell (W-15) talks to. It owns the policy around
 * the three pieces below it:
 *
 * - `overview-fetch` performs the backend reads (one agent pass, one
 *   conversation aggregation pass, the per-agent `default` supplement, the
 *   per-conversation preview read);
 * - `overview-cache` keeps the last snapshot for 30 s and numbers the
 *   snapshots so a preview read that started before a refresh is dropped;
 * - this module exposes the async calls and the one error shape the page
 *   renders.
 *
 * The page owns its React state: a failed load rejects with
 * {@link OverviewDataError} (`retryable: true`), and the retry is another
 * `loadOverviewSnapshot({ force: true })`. Nothing here imports Ink or React,
 * so the whole data layer is exercised with a fake backend in the tests.
 *
 * ### Call shape W-15 consumes
 *
 * ```ts
 * const snapshot = await loadOverviewSnapshot();               // TTL-cached
 * const fresh = await refreshOverviewSnapshot();               // the `r` key
 * const result = await loadOverviewPreview(agentId, conversationId);
 * if (result.status === "loaded") {
 *   setSnapshot((prev) => applyOverviewPreview(prev, agentId, conversationId, result.preview));
 * }
 * if (result.status === "stale") ignore;                       // a refresh won
 * if (result.status === "error") show a retryable note;
 * ```
 *
 * A successful read with no agents is a snapshot with `agents: []`, not an
 * error — the empty-state copy belongs to the page (see `overview-types.ts`).
 * Preview results are patches, not snapshot replacements: {@link applyOverviewPreview}
 * merges the two snippet fields into the record the page already holds, and the
 * record's times and ordering never move when a preview lands.
 */
import { type Backend, getBackend } from "@/backend";
import {
  clearInFlightOverviewPreview,
  currentOverviewGeneration,
  overviewPreviewKey,
  readCachedOverviewPreview,
  readCachedOverviewSnapshot,
  readInFlightOverviewPreview,
  readInFlightOverviewSnapshot,
  resetOverviewCache,
  setInFlightOverviewPreview,
  setInFlightOverviewSnapshot,
  storeOverviewPreview,
  storeOverviewSnapshot,
} from "./overview-cache";
import {
  fetchConversationPreview,
  fetchOverviewSnapshot,
  type OverviewConversationPreview,
} from "./overview-fetch";
import type { OverviewSnapshot } from "./overview-types";

/** A load failed, and trying again is a reasonable response (R-10.9). */
export const OVERVIEW_SNAPSHOT_ERROR_NOTE = "Couldn't load the overview.";
export const OVERVIEW_PREVIEW_ERROR_NOTE = "Couldn't load the conversation.";

/**
 * The only failure the page sees: a read did not complete.
 *
 * It is deliberately one class for both levels and always retryable, so the
 * page can render one note and one retry key without inspecting the cause. The
 * cause is kept for `HARUYUKI_DEBUG` logs, not for display.
 */
export class OverviewDataError extends Error {
  readonly retryable = true;
  readonly detail: unknown;

  constructor(message: string, detail?: unknown) {
    super(message);
    this.name = "OverviewDataError";
    this.detail = detail;
  }
}

export function isOverviewDataError(
  value: unknown,
): value is OverviewDataError {
  return value instanceof OverviewDataError;
}

export interface LoadOverviewSnapshotOptions {
  /** Defaults to `getBackend()`; injected so tests never open a real store. */
  backend?: Backend;
  /** The clock both the TTL and `generatedAtMs` use. Defaults to `Date.now()`. */
  nowMs?: number;
  /** Skip the TTL cache — the page's `r` key. */
  force?: boolean;
}

/**
 * Read the overview snapshot, from the cache when it is younger than the TTL.
 *
 * Concurrent calls share one in-flight fetch, so a page remount while the first
 * read is running does not open a second pass. `force` bypasses the TTL (but
 * still joins an already-running fetch, which is what makes `r` while loading a
 * no-op instead of a duplicate read).
 *
 * Rejects with {@link OverviewDataError}.
 */
export async function loadOverviewSnapshot(
  options: LoadOverviewSnapshotOptions = {},
): Promise<OverviewSnapshot> {
  const nowMs = options.nowMs ?? Date.now();
  if (!options.force) {
    const cached = readCachedOverviewSnapshot(nowMs);
    if (cached) return cached;
  }

  const pending = readInFlightOverviewSnapshot();
  if (pending) return pending;

  const backend = options.backend ?? getBackend();
  const loading = fetchOverviewSnapshot(backend, { nowMs })
    .then((snapshot) => {
      storeOverviewSnapshot(snapshot);
      return snapshot;
    })
    .catch((error: unknown): never => {
      throw wrapOverviewError(error, OVERVIEW_SNAPSHOT_ERROR_NOTE);
    })
    .finally(() => {
      setInFlightOverviewSnapshot(null);
    });

  setInFlightOverviewSnapshot(loading);
  return loading;
}

/**
 * Re-read the snapshot now, discarding the cached one (the page's `r` key).
 *
 * The new snapshot takes the next generation, which cancels every preview read
 * that was started against the old one.
 */
export function refreshOverviewSnapshot(
  options: Omit<LoadOverviewSnapshotOptions, "force"> = {},
): Promise<OverviewSnapshot> {
  return loadOverviewSnapshot({ ...options, force: true });
}

export interface LoadOverviewPreviewOptions {
  backend?: Backend;
  /**
   * The generation whose snapshot the caller is showing. Defaults to the
   * current generation; an old value means "this answer would be stale".
   */
  generation?: number;
}

/**
 * What one lazy preview read produced.
 *
 * `stale` is not a failure: the snapshot was refreshed while the read was in
 * flight, so the answer describes the previous snapshot and must be ignored.
 * `loaded` also comes from the per-conversation cache, so asking again for the
 * same conversation on a re-render costs no backend read (R-10.8: one read per
 * conversation).
 */
export type OverviewPreviewResult =
  | {
      status: "loaded";
      generation: number;
      preview: OverviewConversationPreview;
    }
  | { status: "stale" }
  | { status: "error"; error: OverviewDataError };

/**
 * Lazily read one conversation's message snippets.
 *
 * The read is per conversation, deduplicated while in flight, cached for the
 * current generation, and dropped if the generation moves before it lands —
 * the 代际号取消 from R-10.8.
 */
export async function loadOverviewPreview(
  agentId: string,
  conversationId: string,
  options: LoadOverviewPreviewOptions = {},
): Promise<OverviewPreviewResult> {
  const generation = options.generation ?? currentOverviewGeneration();
  if (generation !== currentOverviewGeneration()) {
    return { status: "stale" };
  }

  const cached = readCachedOverviewPreview(agentId, conversationId);
  if (cached) return { status: "loaded", generation, preview: cached };

  const key = overviewPreviewKey(agentId, conversationId);
  const existing = readInFlightOverviewPreview(key);
  const pending =
    existing ??
    fetchConversationPreview(
      options.backend ?? getBackend(),
      agentId,
      conversationId,
    );
  if (!existing) setInFlightOverviewPreview(key, pending);

  try {
    const preview = await pending;
    if (generation !== currentOverviewGeneration()) {
      return { status: "stale" };
    }
    storeOverviewPreview(generation, agentId, conversationId, preview);
    return { status: "loaded", generation, preview };
  } catch (error) {
    return {
      status: "error",
      error: wrapOverviewError(error, OVERVIEW_PREVIEW_ERROR_NOTE),
    };
  } finally {
    if (readInFlightOverviewPreview(key) === pending) {
      clearInFlightOverviewPreview(key);
    }
  }
}

/** Drop the cached snapshot and previews; the next read fetches again. */
export function resetOverviewData(): void {
  resetOverviewCache();
}

/**
 * Apply one lazy preview to the snapshot the page is showing.
 *
 * Returns a new snapshot so the page can pass the result straight to a state
 * setter; the conversation is replaced and the rest of the snapshot is reused.
 * An unknown agent or conversation returns the same reference, so a late
 * preview for a row that is no longer on screen cannot trigger a re-render.
 *
 * The preview carries snippets only: times are already on the record (listed
 * rows from the aggregation pass, the `default` row from its supplement read),
 * and the row ordering must not move under the cursor when a preview lands.
 */
export function applyOverviewPreview(
  snapshot: OverviewSnapshot,
  agentId: string,
  conversationId: string,
  preview: OverviewConversationPreview,
): OverviewSnapshot {
  const group = snapshot.conversations[agentId];
  if (!group) return snapshot;

  let changed = false;
  const nextGroup = group.map((record) => {
    if (record.conversationId !== conversationId) return record;
    changed = true;
    return {
      ...record,
      lastUserMessage: preview.lastUserMessage,
      lastAgentMessage: preview.lastAgentMessage,
    };
  });
  if (!changed) return snapshot;

  return {
    ...snapshot,
    conversations: { ...snapshot.conversations, [agentId]: nextGroup },
  };
}

export { currentOverviewGeneration };

function wrapOverviewError(error: unknown, message: string): OverviewDataError {
  if (error instanceof OverviewDataError) return error;
  return new OverviewDataError(message, error);
}
