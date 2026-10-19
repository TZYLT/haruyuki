// src/cli/app/shell/tab-strip.tsx

import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { allTabs, type TabsState, useTabsState } from "@/cli/app/tabs";
import { colors } from "@/cli/components/colors";
import { solidRule } from "@/cli/helpers/rule-lines";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
import {
  layoutTabStrip,
  type TabStripItem,
  type TabStripLayout,
} from "./tab-strip-layout";

/**
 * The top bar: one row of tabs and the rule under it (《38》§2.2, §3).
 *
 * It reads the tab model itself (`useTabsState`) instead of being handed a
 * snapshot: a tab change must repaint this row and nothing else, and threading
 * the list through the conversation core would re-render the whole tree when a
 * title arrives. The row's geometry is `tab-strip-layout.ts` — the same function
 * the click hit-test resolves against, so the rectangle drawn and the rectangle
 * clicked are the same numbers.
 *
 * **Which tabs carry `×`** is the one judgement this file makes: a conversation
 * tab is closeable while another conversation tab exists. The last one is not,
 * because closing it would leave the main area with no conversation to show
 * (2026-10-19 ruling: closing the current tab hands over to the next one, and is
 * refused when there is none). Pages never close.
 *
 * The strip is drawn by the full-screen shell and by nothing else, so the
 * compatibility shell has no top bar by construction, not by a mode branch.
 */
export function tabStripItems(state: TabsState): TabStripItem[] {
  const closableConversation = state.conversations.length > 1;
  return allTabs(state).map((tab) => ({
    id: tab.id,
    kind: tab.kind,
    title: tab.title,
    active: tab.id === state.activeId,
    unread: tab.kind === "conversation" ? tab.unread : false,
    closeable: tab.kind === "conversation" && closableConversation,
  }));
}

/** The unread mark, with the blank that stands in for it on a read tab. */
const UNREAD_MARK = "• ";

/**
 * Split a tab's unread mark out of its name so the mark can carry its own colour.
 *
 * The strip reserves the marker's column on every conversation cell, so the name
 * either starts with the mark or with the blank standing in for it — the search is
 * for the mark followed by its space, which a title cannot fake at that offset.
 */
function withUnreadMark(text: string): ReactNode {
  const index = text.indexOf(UNREAD_MARK);
  if (index < 0) return text;
  return (
    <>
      {text.slice(0, index)}
      <Text color={colors.status.processing}>{UNREAD_MARK}</Text>
      {text.slice(index + UNREAD_MARK.length)}
    </>
  );
}

function segmentsForText(layout: TabStripLayout): ReactNode {
  return layout.segments.map((segment) => {
    const color = segment.active
      ? colors.command.selected
      : segment.part === "close" || segment.dim
        ? colors.text.dim
        : undefined;
    return (
      <Text
        key={segment.key}
        color={color}
        bold={segment.active}
        dimColor={segment.dim}
      >
        {segment.unread ? withUnreadMark(segment.text) : segment.text}
      </Text>
    );
  });
}

export function TabStrip() {
  const state = useTabsState();
  const columns = useTerminalWidth();
  const layout = layoutTabStrip(tabStripItems(state), columns);

  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text wrap="truncate">{segmentsForText(layout)}</Text>
      <Text color={colors.input.border} wrap="truncate">
        {solidRule(columns)}
      </Text>
    </Box>
  );
}
