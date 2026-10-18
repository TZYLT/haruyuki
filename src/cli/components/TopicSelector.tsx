/**
 * The topic picker (D-111): the overlay `/compact` opens when a conversation has
 * markers to choose between.
 *
 * Rows are built by a pure function so the copy, the ordering, and the cursor
 * default are testable without rendering Ink. The trailing row is always
 * "Cancel". Every block is selectable, including the first one: the compression
 * rate caps what any cut may keep, so "keep everything" resolves to the rate's
 * own cut instead of being a dead row. The row copy itself comes from
 * `helpers/topic-list.ts` so the picker and `/topics` describe a boundary the
 * same way.
 */
import { memo, useCallback, useMemo, useRef } from "react";
import type { TopicBlock } from "@/backend/local/topic-compaction";
import {
  CURRENT_TOPIC_LABEL,
  shortTimestamp,
  topicBlockBoundaryNote,
} from "@/cli/helpers/topic-list";
import type { TopicTrimRequest } from "@/cli/helpers/topic-trim-request";
import {
  type SingleSelectItem,
  SingleSelectPicker,
} from "@/cli/overlay/adapters";
import { OverlayFrame } from "@/cli/overlay/frame";

export const TOPIC_TRIM_CANCEL_KEY = "cancel";

/**
 * How many blocks the picker shows at once. A long conversation has a block per
 * topic, and this list used to render all of them: the frame grew past the
 * screen and pushed the hint line — and the composer behind it — out of view.
 * The toolkit's window keeps it at ten and says what is above and below, which
 * is the one visible change this face was signed off for.
 */
const TOPIC_WINDOW_ROWS = 10;

/**
 * The picker rows, oldest block first. Block 1 is selectable like any other: the
 * compression rate decides how much a cut may keep, so choosing "keep
 * everything" compresses to the same point the rate would have picked.
 */
export function buildTopicPickRows(
  blocks: readonly TopicBlock[],
): SingleSelectItem[] {
  return blocks.map((block, position) => ({
    key: String(block.index),
    label: `${block.index}. ${block.title ?? CURRENT_TOPIC_LABEL}`,
    description: `${block.messageCount} messages · ~${block.tokens} tokens · from ${shortTimestamp(block.startsAt)} · ${topicBlockBoundaryNote(block, blocks[position - 1])}`,
  }));
}

/** The full item list, cancel last. */
export function buildTopicPickItems(
  blocks: readonly TopicBlock[],
): SingleSelectItem[] {
  return [
    ...buildTopicPickRows(blocks),
    {
      key: TOPIC_TRIM_CANCEL_KEY,
      label: "Cancel",
      description: "keep the context as it is",
    },
  ];
}

/**
 * Cursor default: the suggested block, falling back to the oldest block when the
 * suggestion is unknown (an empty list still ends on Cancel).
 */
export function initialTopicPickIndex(
  items: readonly SingleSelectItem[],
  suggestionIndex: number,
): number {
  const suggested = items.findIndex(
    (item) => item.key === String(suggestionIndex),
  );
  if (suggested >= 0) return suggested;
  return 0;
}

interface TopicSelectorProps {
  request: TopicTrimRequest;
  onCancel: () => void;
}

export const TopicSelector = memo(function TopicSelector({
  request,
  onCancel,
}: TopicSelectorProps) {
  const items = useMemo(() => buildTopicPickItems(request.blocks), [request]);
  const initialCursorIndex = useMemo(
    () => initialTopicPickIndex(items, request.suggestionIndex),
    [items, request.suggestionIndex],
  );
  // One shot: the overlay unmounts on the first outcome, but a burst of Enter
  // keys inside one tick could otherwise run the handler twice — two trims, or a
  // trim after a cancel. A ref keeps it out of the render path.
  const settledRef = useRef(false);
  const settle = useCallback((action: () => void) => {
    if (settledRef.current) return;
    settledRef.current = true;
    action();
  }, []);
  // Dismissing means different things to the two flows that open this picker:
  // nothing for `/compact`, "send the message anyway" for the pre-send offer.
  const dismiss = useCallback(() => {
    settle(() => {
      request.onCancel?.();
      onCancel();
    });
  }, [settle, request, onCancel]);

  return (
    <OverlayFrame command="/compact" title="Choose the topic block to keep">
      <SingleSelectPicker
        items={items}
        initialCursorIndex={initialCursorIndex}
        rows={TOPIC_WINDOW_ROWS}
        onSelect={(key) => {
          if (key === TOPIC_TRIM_CANCEL_KEY) {
            dismiss();
            return;
          }
          settle(() => request.onPick(Number(key)));
        }}
        onCancel={dismiss}
        footer=" Enter trim · ↑↓/jk navigate · Esc cancel · a block that keeps more than the compression rate is cut down to it"
      />
    </OverlayFrame>
  );
});
