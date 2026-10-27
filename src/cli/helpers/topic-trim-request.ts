/**
 * The one-shot handoff from `/compact` (and the pre-send pressure check) to the
 * compaction overlay.
 *
 * The submit handler can open an overlay, but it cannot pass it props, so the
 * request travels through this bridge — the same reason
 * `@/utils/message-queue-bridge` carries background-task messages into the
 * transcript queue. `CompactionOverlay` is the single reader.
 *
 * Two states, one slot, because one compaction runs at a time:
 *
 * - **`preparing`** — the summarizer is running and has no answer yet. The face
 *   exists so the user can watch the elapsed time and press Esc: §5.2.6 sets no
 *   wall-clock timeout, so the user *is* the only exit from a call that hangs
 *   (Q-38).
 * - **`trim`** — the preview is ready and the picker offers its rows.
 *
 * The slot is observable rather than strictly one-shot: the overlay has to
 * re-render from `preparing` into the picker **without remounting**, because a
 * remount would drop the frame between them (and changing the mount's key is the
 * double-print risk `src/cli/AGENTS.md` warns about). `takeTopicTrimRequest` is
 * kept for callers that answer synchronously, and every settle path clears the
 * slot so a stale request cannot outlive the run that parked it.
 */
import type { TopicBlock } from "@/backend/local/topic-compaction";

export interface TopicTrimRequest {
  /** The blocks the picker offers, oldest first. */
  blocks: readonly TopicBlock[];
  /** 1-based block index the cursor starts on (the ratio suggestion). */
  suggestionIndex: number;
  /**
   * Runs when the user confirms a block. The submit handler closes the overlay
   * itself; this callback owns the trim, its receipt, and the post-compaction
   * bookkeeping, because only the submit handler has that environment.
   */
  onPick: (blockIndex: number) => void;
  /**
   * Runs when the picker is dismissed instead of answered. `/compact` has
   * nothing to do here, but the pre-send interception must still send the
   * message the user typed (D-112).
   */
  onCancel?: () => void;
}

/**
 * The summarizer is running. `startedAt` is a `Date.now()` stamp, so the face
 * computes "Ns" from the clock instead of storing a tick count.
 */
export interface CompactionPreparingRequest {
  startedAt: number;
  /** Esc / Ctrl+C: abort the call; the preview is dropped whole (§5.9.1). */
  onCancel: () => void;
}

export type CompactionOverlayRequest =
  | { kind: "preparing"; request: CompactionPreparingRequest }
  | { kind: "trim"; request: TopicTrimRequest };

let pending: CompactionOverlayRequest | null = null;
const listeners = new Set<() => void>();

function publish(next: CompactionOverlayRequest | null): void {
  pending = next;
  for (const listener of listeners) listener();
}

/** The slot's current value, for `useSyncExternalStore`. */
export function compactionOverlayRequest(): CompactionOverlayRequest | null {
  return pending;
}

/** Subscribe to slot changes; the overlay re-renders in place, never remounts. */
export function subscribeCompactionOverlayRequest(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setTopicTrimRequest(request: TopicTrimRequest): void {
  publish({ kind: "trim", request });
}

export function setCompactionPreparingRequest(
  request: CompactionPreparingRequest,
): void {
  publish({ kind: "preparing", request });
}

/** Read the parked trim request and clear the slot. */
export function takeTopicTrimRequest(): TopicTrimRequest | null {
  const current = pending;
  publish(null);
  return current?.kind === "trim" ? current.request : null;
}

/** Drop whatever is parked: cancelled, replaced, or already answered. */
export function clearTopicTrimRequest(): void {
  publish(null);
}
