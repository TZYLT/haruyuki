import { Box, type Key } from "ink";
import {
  memo,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { colors } from "@/cli/components/colors";
import { Text } from "@/cli/components/Text";
import type { KeyBinding } from "@/cli/helpers/input-keys";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
import {
  type OverlayListItem,
  orderedKeys,
  swapWithin,
  toggleSelection,
} from "./list-model";
import { OverlayListView } from "./list-view";
import { useOverlayList } from "./use-overlay-list";

/**
 * `SingleSelectPicker` and `MultiSelectPicker`, rewritten onto the toolkit.
 *
 * Their props, their exported names and their markup are unchanged on purpose:
 * eight components use them across the tree, and this batch is the one that must
 * not be visible. What changed is where the keys live — the navigation table is
 * the toolkit's, the cursor is the toolkit's, and the list is rendered by
 * `OverlayListView` — so from here on there is one place where "how an overlay
 * list behaves" is written down.
 *
 * Two differences are deliberate and both are visible only where nothing can see
 * them:
 *
 * - **PageUp/PageDown/Home/End now navigate a single-select.** They proxy to the
 *   caller through `onUnhandledKey`, which no caller passes (checked: it has no
 *   call sites), and the list's keys are the toolkit's; `Enter` on an empty list
 *   likewise reaches `onUnhandledKey` where the picker used to swallow it.
 * - **Ctrl+C cancels the multi-select.** `SingleSelectPicker` already did, so
 *   this is the two pickers agreeing rather than a new key: an overlay the user
 *   cannot leave with the conventional key is the trap the toolkit inherited.
 *
 * The wrappers keep their own quirks too, because a rewrite that silently fixes
 * them is not a rewrite: the multi-select seeds its checkbox state from `selected`
 * once and does not follow later prop changes, and it re-seeds the list order
 * whenever the `items` prop changes identity.
 */

export type SingleSelectItem = OverlayListItem;

export interface SingleSelectPickerProps {
  items: SingleSelectItem[];
  /** Start cursor at this index (default 0) */
  initialCursorIndex?: number;
  /** Called when user presses Enter on an item */
  onSelect: (key: string) => void;
  /** Called when user presses Escape or Ctrl-C */
  onCancel: () => void;
  /**
   * Override item rendering. When provided, the picker uses this
   * instead of its default label + description rendering.
   * The picker still handles cursor state and input. Return `null` for
   * nothing — a raw string would be rendered outside `<Text>`, which Ink
   * rejects, so the type does not allow one.
   */
  renderItem?: (
    item: SingleSelectItem,
    index: number,
    isSelected: boolean,
  ) => ReactElement | null;
  /**
   * Called for keys the picker doesn't handle itself
   * (anything that isn't the list's own navigation or confirm keys).
   * Useful for pagination (←→), shortcuts (N), etc.
   *
   * The key is *declined*, not consumed: the router hands it on to the legacy
   * `useInput` handlers after this returns, so a caller with its own listener
   * receives it either way.
   */
  onUnhandledKey?: (input: string, key: Key) => void;
  /**
   * Override the footer content. When provided, replaces the default
   * "Enter select · ↑↓/jk navigate · Esc cancel" hint. A plain string is
   * wrapped in `<Text>` for you — Ink rejects a string child inside `<Box>`,
   * so passing one raw would crash the whole overlay.
   */
  footer?: ReactNode;
}

/**
 * Ink only accepts text that sits inside `<Text>`, but `footer` is a
 * `ReactNode`: a caller handing the hint over as a plain string (TopicSelector
 * does) would otherwise throw during commit. `null`/`undefined` means "use the
 * default hint". The return type is what keeps this site safe — everything
 * leaves here as an element.
 */
function resolvePickerFooter(footer: ReactNode): ReactElement {
  if (footer == null) {
    return <Text dimColor> Enter select · ↑↓/jk navigate · Esc cancel</Text>;
  }
  if (typeof footer === "string" || typeof footer === "number") {
    return <Text dimColor>{footer}</Text>;
  }
  // Anything else (element, array of them, conditional `false`) renders as it
  // would have; the fragment keeps the return type an element.
  return <>{footer}</>;
}

export const SingleSelectPicker = memo(function SingleSelectPicker({
  items,
  initialCursorIndex = 0,
  onSelect,
  onCancel,
  renderItem,
  onUnhandledKey,
  footer,
}: SingleSelectPickerProps) {
  // A catch-all, which the table only reaches after every chord it does declare
  // has either not matched or declined — the same order the picker's own
  // `handleInput` had. It forwards and then declines, so the key still travels.
  const extra = useMemo<KeyBinding[]>(
    () =>
      onUnhandledKey
        ? [
            {
              id: "single-select-picker.unhandled",
              run: (event) => {
                onUnhandledKey(event.input, event.key);
                return "declined";
              },
            },
          ]
        : [],
    [onUnhandledKey],
  );

  const list = useOverlayList({
    owner: "single-select-picker",
    items,
    initialCursorIndex,
    onConfirm: (key, index) => {
      // A blocked row confirms nothing — but it still consumes Enter, which is
      // what the picker did.
      if (items[index]?.disabled) return;
      onSelect(key);
    },
    onCancel,
    extra,
  });

  return (
    <Box flexDirection="column">
      <OverlayListView
        items={items}
        cursor={list.cursor}
        renderRow={renderItem}
      />

      {/* Footer */}
      <Box marginTop={footer == null ? 1 : 0}>
        {resolvePickerFooter(footer)}
      </Box>
    </Box>
  );
});

export interface MultiSelectItem {
  key: string;
  label: string;
  description: string;
  /** When true, Space does not toggle this item and it renders dimmed. */
  disabled?: boolean;
}

export interface MultiSelectPickerProps {
  items: MultiSelectItem[];
  selected: Set<string>;
  onConfirm: (selectedKeys: string[]) => void;
  onCancel: () => void;
  onSelectionChange?: (selectedKeys: string[]) => void;
  preview?: string;
  enableOrdering?: boolean;
}

export const MultiSelectPicker = memo(function MultiSelectPicker({
  items,
  selected,
  onConfirm,
  onCancel,
  onSelectionChange,
  preview,
  enableOrdering = false,
}: MultiSelectPickerProps) {
  const columns = useTerminalWidth();
  const [orderedItems, setOrderedItems] = useState<MultiSelectItem[]>(items);
  const [selectedSet, setSelectedSet] = useState<Set<string>>(
    () => new Set(selected),
  );

  useEffect(() => {
    setOrderedItems(items);
  }, [items]);

  const selectedKeysInOrder = useMemo(
    () => orderedKeys(orderedItems, selectedSet),
    [orderedItems, selectedSet],
  );

  // The latest controller, written during render the way `useKeyBindings`
  // writes its table ref: a key handler needs the closure of the render that is
  // on screen, and a reorder moves the cursor with the item it swapped, so the
  // swap and the move have to be in the same callback.
  const controllerRef = useRef<{ setCursor: (index: number) => void } | null>(
    null,
  );

  const moveItem = useCallback(
    (direction: "up" | "down", index: number) => {
      if (!enableOrdering) return;
      const nextIndex = direction === "up" ? index - 1 : index + 1;
      setOrderedItems((prev) => {
        if (index < 0 || index >= prev.length) return prev;
        if (nextIndex < 0 || nextIndex >= prev.length) return prev;
        return swapWithin(prev, index, nextIndex);
      });
      if (nextIndex >= 0 && nextIndex < orderedItems.length) {
        controllerRef.current?.setCursor(nextIndex);
      }
    },
    [enableOrdering, orderedItems.length],
  );

  // Propagate selection/order changes to parent in a separate render cycle
  useEffect(() => {
    onSelectionChange?.(selectedKeysInOrder);
  }, [selectedKeysInOrder, onSelectionChange]);

  const list = useOverlayList({
    owner: "multi-select-picker",
    items: orderedItems,
    // Enter confirms the selection from wherever the cursor stands, a blocked row
    // included: this picker's answer is the checkbox set, not the row under the
    // cursor, and a list whose every row is blocked still has to be closable.
    onConfirm: () => onConfirm(selectedKeysInOrder),
    onCancel,
    onToggle: (key, index) => {
      // Space is about the row, so a blocked one does not toggle.
      if (orderedItems[index]?.disabled) return;
      setSelectedSet((prev) => toggleSelection(prev, key));
    },
    onMoveItem: enableOrdering ? moveItem : undefined,
  });
  controllerRef.current = list;

  return (
    <Box flexDirection="column">
      {/* Items */}
      <Box flexDirection="column">
        <OverlayListView
          items={orderedItems}
          cursor={list.cursor}
          renderRow={(item, _index, isCursor) => {
            const isChecked = selectedSet.has(item.key);
            const isDisabled = item.disabled ?? false;
            const color = isDisabled
              ? undefined
              : isCursor
                ? colors.approval.header
                : undefined;

            return (
              <Box flexDirection="row">
                {/* Cursor indicator */}
                <Box width={2} flexShrink={0}>
                  <Text color={color}>{isCursor ? "›" : " "}</Text>
                </Box>
                {/* Checkbox */}
                <Box width={4} flexShrink={0}>
                  <Text
                    color={isDisabled ? undefined : isChecked ? "green" : color}
                    dimColor={isDisabled}
                  >
                    [{isChecked ? "✓" : " "}]{" "}
                  </Text>
                </Box>
                {/* Label + description */}
                <Box flexGrow={1} width={Math.max(0, columns - 6)}>
                  <Text
                    color={color}
                    bold={isCursor && !isDisabled}
                    dimColor={isDisabled}
                    wrap="truncate-end"
                  >
                    {item.label}
                    {item.description && (
                      <Text dimColor> · {item.description}</Text>
                    )}
                  </Text>
                </Box>
              </Box>
            );
          }}
        />
      </Box>

      {/* Preview */}
      {preview !== undefined && (
        <>
          <Box height={1} />
          <Text bold>{preview}</Text>
        </>
      )}

      {/* Hint */}
      <Box marginTop={1}>
        <Text dimColor>
          Space to toggle · ↑↓ to navigate · Enter to confirm · Esc to cancel
          {enableOrdering ? " · ←→ to reorder" : ""}
        </Text>
      </Box>
    </Box>
  );
});
