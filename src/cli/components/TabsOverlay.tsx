import { Box, type DOMElement } from "ink";
import { useMemo, useRef } from "react";
import { allTabs, isPageTabId, useTabsState } from "@/cli/app/tabs";
import type { TabStripProjection } from "@/cli/app/types";
import { colors } from "@/cli/components/colors";
import { useRowHovered } from "@/cli/helpers/hover-store";
import { useMouseRows } from "@/cli/helpers/use-mouse-rows";
import { OverlayFrame } from "@/cli/overlay/frame";
import type { OverlayListItem } from "@/cli/overlay/list-model";
import { OverlayListView } from "@/cli/overlay/list-view";
import { useOverlayList } from "@/cli/overlay/use-overlay-list";
import { Text } from "./Text";

/**
 * `/tabs`: the keyboard's door to the tab strip.
 *
 * The strip is operated by the mouse, and between P0 and this face the three
 * commands its own hint line printed (`/tabs`, `/close`, `/settings`) did not
 * exist — so a keyboard user had no way to change tabs at all (《39》§2 #8). This is
 * that way: it lists what the strip draws, in the same order, and every row does
 * exactly what clicking the row does.
 *
 * **A face, not a page**: it is raised over the conversation for a moment, takes
 * the keyboard while it is up, and leaves nothing behind (《38》§13.2). It goes
 * through the overlay toolkit for the same reason every other face does — cursor,
 * windowing and keys are one implementation (`overlay/`) — and `useOverlayList`
 * is what claims the `overlay` scope, so the composer behind it does not also
 * answer the arrows.
 *
 * **The two actions are the strip's own** (`TabStripProjection`): switching is a
 * conversation switch, which the core decides (and refuses while a turn runs), and
 * closing is a view decision with a ruling behind it. This face never touches the
 * runtime; it asks.
 *
 * Enter also dismisses: the row it targeted is now the main area, and a selector
 * that stayed up over its own result would need a second dismissal. `D` stays
 * open, so closing several tabs is one command.
 */
export interface TabsOverlayProps {
  /** The strip's actions, shared with the top bar so both do the same thing. */
  actions: TabStripProjection;
  /** Dismiss without doing anything (Escape / Ctrl+C). */
  onDismiss: () => void;
}

/** A list row plus the strip's own fact: whether it can be closed. */
type TabItem = OverlayListItem & { closeable: boolean };

export function TabsOverlay({ actions, onDismiss }: TabsOverlayProps) {
  const state = useTabsState();
  const items = useMemo<TabItem[]>(() => {
    return allTabs(state).map((tab) => {
      const page = isPageTabId(tab.id);
      return {
        key: tab.id,
        label: tab.title,
        description: page ? "page" : undefined,
        isCurrent: tab.id === state.activeId,
        closeable: !page,
      };
    });
  }, [state]);

  const activeIndex = Math.max(
    0,
    items.findIndex((item) => item.isCurrent === true),
  );

  const select = (index: number): void => {
    const item = items[index];
    if (!item) return;
    if (!item.isCurrent) actions.onSelect(item.key);
    onDismiss();
  };

  const close = (index: number): void => {
    const item = items[index];
    // A page tab is not closeable: `×` is not drawn on one, and `D` here answers
    // the same way — the only thing it could mean is "go back to the
    // conversation", which is what Escape does, so it would close the face too.
    if (!item || !item.closeable) return;
    actions.onClose(item.key);
  };

  // The cursor the `D` handler reads. A key binding is registered once and runs
  // later, so it must not close over a cursor that belongs to an earlier render.
  const cursorRef = useRef(activeIndex);

  const list = useOverlayList({
    owner: "tabs-overlay",
    items,
    initialCursorIndex: activeIndex,
    onConfirm: (_key, index) => select(index),
    onCancel: onDismiss,
    extra: [
      {
        id: "tabs-overlay.close",
        label: "Close tab",
        chords: [{ key: "d" }],
        run: () => {
          close(cursorRef.current);
          return "consumed";
        },
      },
    ],
  });
  cursorRef.current = list.cursor;

  // The rows the pointer aims at are the rows the list drew, in the same order:
  // no window (a session has a handful of tabs) and no indicator rows, so row `n`
  // of the box is row `n` of the list. `chrome` layer, because the face is drawn
  // in the bottom chrome and the wheel below must not see its press.
  const listRef = useRef<DOMElement | null>(null);
  useMouseRows({
    area: "tabs",
    ref: listRef,
    rowCount: items.length,
    activate: select,
    layer: "chrome",
  });

  return (
    <OverlayFrame
      command="/tabs"
      title="Tabs"
      footer="↑↓ select · Enter switch · D close · Esc cancel"
    >
      <Box ref={listRef} flexDirection="column">
        <OverlayListView
          items={items}
          cursor={list.cursor}
          indicators={false}
          renderRow={(item, index, isCursor) => (
            <TabLine
              key={item.key}
              area="tabs"
              index={index}
              label={item.label}
              current={item.isCurrent === true}
              cursor={isCursor}
            />
          )}
        />
      </Box>
    </OverlayFrame>
  );
}

/**
 * One row, with its own hover subscription.
 *
 * A row rather than a loop in the parent: `useRowHovered` is a boolean snapshot
 * per row, so a pointer moving across the list re-renders the two rows involved
 * instead of the whole face on every cell the terminal reports (《38》§19.3 5).
 */
function TabLine({
  area,
  index,
  label,
  current,
  cursor,
}: {
  area: string;
  index: number;
  label: string;
  current: boolean;
  cursor: boolean;
}) {
  const hovered = useRowHovered(area, index);
  return (
    <Box
      flexDirection="row"
      // Selection wins (《38》§19.3.2): the cursor row keeps its `> ` + colour and
      // does not also take the hover background, so the two signals never stack.
      backgroundColor={hovered && !cursor ? colors.surface.hoverBg : undefined}
    >
      <Text color={cursor ? colors.selector.itemHighlighted : undefined}>
        {cursor ? "> " : "  "}
      </Text>
      <Text
        bold={cursor}
        color={
          cursor
            ? colors.selector.itemHighlighted
            : current
              ? colors.selector.itemCurrent
              : undefined
        }
      >
        {label}
        {current ? " (current)" : ""}
      </Text>
    </Box>
  );
}
