/**
 * The topic picker (D-111): the overlay `/compact` opens when a conversation has
 * markers to choose between.
 *
 * Rows are built by a pure function so the copy, the ordering, and the cursor
 * default are testable without rendering Ink. The trailing row is always
 * "Cancel". Every block is selectable, including the first one: the compression
 * rate caps what any cut may keep, so "keep everything" resolves to the rate's
 * own cut instead of being a dead row. The row copy itself comes from
 * `helpers/topic-list.ts` so the picker and `/topic list` describe a boundary the
 * same way.
 *
 * **One line per row, and the summary on it.** F-04 puts the summarizer's
 * per-topic section on the row — "look at the summary, then decide what to cut"
 * is the whole point of the face (§5.1 step 3, Q-09). The description used to be
 * allowed to wrap, which cost a line on a long boundary note and made the
 * window's height depend on the data: ten rows could paint as twenty lines, the
 * footer moved, and the composer behind it moved with it (route C-21). The row
 * renderer therefore clips title and description to the terminal's width and
 * pins the row at one line, and `TOPIC_WINDOW_ROWS` counts that line.
 */
import { Box } from "ink";
import { memo, useCallback, useMemo, useRef } from "react";
import type { TopicBlock } from "@/backend/local/topic-compaction";
import { colors } from "@/cli/components/colors";
import { terminalTextWidth } from "@/cli/helpers/char-width";
import {
  CURRENT_TOPIC_LABEL,
  topicBlockBoundaryNote,
} from "@/cli/helpers/topic-list";
import { topicBlockMeta } from "@/cli/helpers/topic-panel";
import type { TopicTrimRequest } from "@/cli/helpers/topic-trim-request";
import { truncateText } from "@/cli/helpers/truncate-text";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
import {
  type SingleSelectItem,
  SingleSelectPicker,
} from "@/cli/overlay/adapters";
import { OverlayFrame } from "@/cli/overlay/frame";
import { Text } from "./Text";

export const TOPIC_TRIM_CANCEL_KEY = "cancel";

/**
 * How many blocks the picker shows at once. A long conversation has a block per
 * topic, and this list used to render all of them: the frame grew past the
 * screen and pushed the hint line — and the composer behind it — out of view.
 * The toolkit's window keeps it at ten and says what is above and below, which
 * is the one visible change this face was signed off for. Each row is exactly
 * one line (see `TopicPickRow`), so the window plus its two indicator rows is a
 * constant twelve lines whatever the summaries say.
 */
const TOPIC_WINDOW_ROWS = 10;

/**
 * The picker rows, oldest block first. Block 1 is selectable like any other: the
 * compression rate decides how much a cut may keep, so choosing "keep
 * everything" compresses to the same point the rate would have picked.
 *
 * The summarizer's section comes first in the description when there is one: it
 * is what the user is deciding on, while the message/token counts and the
 * boundary note are how they check it.
 */
export function buildTopicPickRows(
  blocks: readonly TopicBlock[],
): SingleSelectItem[] {
  return blocks.map((block, position) => {
    const summary = block.summary?.replace(/\s+/g, " ").trim() ?? "";
    const meta = `${topicBlockMeta(block)} · ${topicBlockBoundaryNote(block, blocks[position - 1])}`;
    return {
      key: String(block.index),
      label: `${block.index}. ${block.title ?? CURRENT_TOPIC_LABEL}`,
      description: summary.length > 0 ? `${summary} · ${meta}` : meta,
    };
  });
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

/**
 * One row, exactly one line: cursor bar, label, then as much of the description
 * as the terminal has left.
 *
 * The description is clipped *separately* from the label rather than truncating
 * the joined string, because it is the dim half of the row: joining first would
 * either lose the dimming or let Ink wrap the row. `descBudget` subtracts the
 * three columns of the `" · "` separator, and a row with no room left for the
 * description simply shows the label.
 */
function TopicPickRow({
  item,
  width,
  isCursor,
}: {
  item: SingleSelectItem;
  width: number;
  isCursor: boolean;
}) {
  const color = isCursor ? colors.selector.itemHighlighted : undefined;
  const available = Math.max(1, width - 2);
  const label = truncateText(item.label, available);
  const descBudget = available - terminalTextWidth(label) - 3;
  const description =
    item.description && descBudget > 3
      ? truncateText(item.description, descBudget)
      : null;

  return (
    <Box flexDirection="row">
      <Text color={color}>{isCursor ? "> " : "  "}</Text>
      <Text bold={isCursor} color={color}>
        {label}
      </Text>
      {description !== null && <Text dimColor>{` · ${description}`}</Text>}
    </Box>
  );
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
  // The terminal's width, read in the component body so the row renderer is a
  // function of this render (`src/cli/AGENTS.md`: a row that pre-computes its
  // line has to ask the width, not assume one).
  const terminalWidth = useTerminalWidth();
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
        renderItem={(item, _index, isCursor) => (
          <TopicPickRow item={item} width={terminalWidth} isCursor={isCursor} />
        )}
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
