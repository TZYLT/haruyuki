import { Box } from "ink";
import type { ReactElement } from "react";
import { colors } from "@/cli/components/colors";
import { Text } from "@/cli/components/Text";
import { type OverlayListItem, visibleWindow } from "./list-model";

/**
 * Rendering a list of overlay items.
 *
 * One row per item, the "(current)" marker, and — only when the caller asked for a
 * window — the "N more" indicators. The default row is the markup
 * `SingleSelectPicker` painted, character for character, because that is what
 * every selector in this tree shows today; a caller with its own row (the worktree
 * diff list is the one) passes `renderRow` and gets it wrapped exactly the way the
 * picker wrapped `renderItem`.
 *
 * **Windowing is opt-in and the height it costs is constant.** With `rows` unset
 * the whole list renders, which is what every overlay did before this module
 * existed. With `rows` set and a longer list, two indicator rows are always
 * reserved — even while the cursor is at one end and the indicator would be "0
 * more" — so scrolling a long list cannot change the overlay's height and shove
 * the rows above it around. The overlay's height is measured chrome
 * (`chrome-height.ts`), so a height that varies with the cursor is a layout jitter
 * the whole frame pays for.
 */

export interface OverlayListViewProps {
  items: readonly OverlayListItem[];
  cursor: number;
  /** Window size. `undefined` renders the whole list. */
  rows?: number;
  /**
   * Custom row renderer, in the picker's `renderItem` signature so a rewrite can
   * pass its renderer straight through. `index` is the item's index in the *full*
   * list, not in the window.
   */
  renderRow?: (
    item: OverlayListItem,
    index: number,
    isCursor: boolean,
  ) => ReactElement | null;
  /** Shown instead of the rows when there is nothing to list. */
  emptyLabel?: string;
}

/** The default row: cursor bar, label, `(current)`, description. */
function defaultRow(item: OverlayListItem, isCursor: boolean, key: string) {
  const isCurrent = item.isCurrent ?? false;
  const isDisabled = item.disabled ?? false;
  const isDimLabel = item.dimLabel ?? false;

  const cursorColor = isDisabled
    ? undefined
    : isCursor
      ? colors.selector.itemHighlighted
      : undefined;
  const labelColor = isDisabled
    ? undefined
    : isCursor
      ? colors.selector.itemHighlighted
      : isCurrent
        ? colors.selector.itemCurrent
        : undefined;

  return (
    <Box key={key} flexDirection="row">
      <Text color={cursorColor}>{isCursor ? "> " : "  "}</Text>
      <Text
        color={labelColor}
        bold={isCursor && !isDisabled}
        dimColor={isDisabled || isDimLabel}
      >
        {item.label}
        {isCurrent && " (current)"}
      </Text>
      {item.description && <Text dimColor>{` · ${item.description}`}</Text>}
    </Box>
  );
}

export function OverlayListView({
  items,
  cursor,
  rows,
  renderRow,
  emptyLabel,
}: OverlayListViewProps) {
  if (items.length === 0) {
    return emptyLabel ? (
      <Box flexDirection="column">
        <Text dimColor>{emptyLabel}</Text>
      </Box>
    ) : null;
  }

  const window = visibleWindow({ count: items.length, cursor, rows });
  const visible = items.slice(window.start, window.end);
  const windowed = rows !== undefined && window.total > rows;

  return (
    <Box flexDirection="column">
      {windowed && (
        <Text dimColor>
          {window.above > 0 ? ` ↑ ${window.above} more` : " "}
        </Text>
      )}

      {visible.map((item, offset) => {
        const index = window.start + offset;
        const isCursor = index === cursor;
        if (renderRow) {
          return <Box key={item.key}>{renderRow(item, index, isCursor)}</Box>;
        }
        return defaultRow(item, isCursor, item.key);
      })}

      {windowed && (
        <Text dimColor>
          {window.below > 0 ? ` ↓ ${window.below} more` : " "}
        </Text>
      )}
    </Box>
  );
}
