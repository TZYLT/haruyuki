/**
 * One-shot handoff from `/compact` to the topic picker.
 *
 * `/compact` runs inside the submit handler; the picker is rendered by the
 * "compaction" overlay slot in `AppView`. Those two live in different React
 * trees — the submit handler can open an overlay, but it cannot pass it props —
 * so the request travels through this bridge, exactly like
 * `@/utils/message-queue-bridge` carries background-task messages into the
 * transcript queue.
 *
 * It is deliberately single-consumer and one-shot: `takeTopicTrimRequest`
 * hands the request to the picker and clears it, so the picker that mounts for
 * `/compact config` (mode settings) cannot render a stale topic list. Every
 * `/compact` clears the slot before it decides, which covers the only remaining
 * case — a request parked by a run that never opened the overlay.
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

let pending: TopicTrimRequest | null = null;

export function setTopicTrimRequest(request: TopicTrimRequest): void {
  pending = request;
}

/** Hand the request to the picker, once. */
export function takeTopicTrimRequest(): TopicTrimRequest | null {
  const request = pending;
  pending = null;
  return request;
}

/** Drop a request that was never shown (cancelled, or replaced). */
export function clearTopicTrimRequest(): void {
  pending = null;
}
