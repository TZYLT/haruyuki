// src/cli/app/shell/tab-strip.tsx

import { Box, Text, useStdout } from "ink";
import type { ReactNode } from "react";
import {
  allTabs,
  type TabsState,
  useActiveTabIsPage,
  useTabsState,
} from "@/cli/app/tabs";
import { colors } from "@/cli/components/colors";
import { ROW_SAFETY_COLUMNS } from "@/cli/display/statusline/formatting";
import { solidRule } from "@/cli/helpers/rule-lines";
import {
  useTerminalRows,
  useTerminalWidth,
} from "@/cli/hooks/use-terminal-width";
import { debugWarn } from "@/utils/debug";
import { sidebarWidth } from "./sidebar-sections";
import {
  layoutTabStrip,
  TAB_UNREAD_MARK,
  type TabStripItem,
  type TabStripLayout,
} from "./tab-strip-layout";
import type { TabStripProjection } from "./types";
import { useChromeClicks } from "./use-chrome-clicks";

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

/**
 * The width this row may occupy: never more than the width Ink lays out at.
 *
 * The row is *exactly* its column count, with the pages pinned to its right edge,
 * so a count one column too large does not clip — it **wraps**, costing a line
 * and, because a frame taller than the screen scrolls the alternate screen, the
 * tab row itself. That is what the first machine run showed: row 1 holding the
 * tail `gs` of `Settings`, the rule on row 2, and nothing clickable anywhere
 * (2026-10-20).
 *
 * `useTerminalWidth` queries the console, which on Windows answers with the
 * *screen buffer*; `stdout.columns` is what Ink wraps against. When they disagree
 * the smaller one is the only safe answer — a row two columns short is a slightly
 * wider gap, a row two columns long is a dead feature. The mismatch is reported
 * once per distinct pair, so the session log records which way the machine is
 * wrong instead of it being invisible.
 */
let reportedWidthMismatch: string | null = null;

export function tabStripColumns(
  queried: number,
  inkColumns: number | undefined,
): number {
  // A stream that cannot answer (a pipe, or a layout that has not run yet) leaves
  // the queried width alone; zero is not a width, it is a missing one.
  if (inkColumns === undefined || inkColumns <= 0) {
    return Math.max(0, queried - ROW_SAFETY_COLUMNS);
  }
  const mismatch = `${queried}->${inkColumns}`;
  if (queried !== inkColumns && reportedWidthMismatch !== mismatch) {
    reportedWidthMismatch = mismatch;
    debugWarn(
      "tab-strip",
      `console reports ${queried} columns, ink lays out ${inkColumns}; using ${Math.min(queried, inkColumns)}`,
    );
  }
  // This row is assembled from segments (marker, title, `×`, pages) and is the
  // row the alternate screen scrolls away, so it keeps the safety margin
  // (`ROW_SAFETY_COLUMNS`): a glyph the terminal draws wider than the width table
  // believes must land inside the terminal, not past its edge.
  return Math.max(0, Math.min(queried, inkColumns) - ROW_SAFETY_COLUMNS);
}

/**
 * The rule under the strip, with the rail's junction when the rail is drawn.
 *
 * `《38》§2.2`'s frame puts a `┬` where the rail's divider meets the rule: the
 * divider is a column, and a rule that runs straight through it reads as a line
 * the rail is lying on top of. The junction sits one past the gutter, which is
 * exactly where the sidebar block starts.
 */
export function ruleWithJunction(ruleWidth: number, railWidth: number): string {
  if (ruleWidth <= 0) return "";
  const ruler = solidRule(ruleWidth);
  if (railWidth <= 0 || railWidth >= ruleWidth) return ruler;
  const junction = ruleWidth - railWidth + 1;
  if (junction < 1 || junction > ruleWidth) return ruler;
  return `${ruler.slice(0, junction - 1)}┬${ruler.slice(junction)}`;
}

/**
 * Split a tab's unread mark out of its name so the mark can carry its own colour.
 *
 * The strip reserves the marker's column on every conversation cell, so the name
 * either starts with the mark or with the blank standing in for it — the search is
 * for the mark followed by its space, which a title cannot fake at that offset.
 * The mark itself comes from the layout (`TAB_UNREAD_MARK`), not from a copy here.
 */
function withUnreadMark(text: string): ReactNode {
  const index = text.indexOf(TAB_UNREAD_MARK);
  if (index < 0) return text;
  return (
    <>
      {text.slice(0, index)}
      <Text color={colors.status.processing}>{TAB_UNREAD_MARK}</Text>
      {text.slice(index + TAB_UNREAD_MARK.length)}
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

export function TabStrip({
  onSelect,
  onClose,
  frameColumns,
}: TabStripProjection & {
  /**
   * The width the shell laid the frame out at, when it knows it.
   *
   * The shell resolves `min(console, ink)` once and hands the same number to the
   * band, the rail and this row; without it the strip re-derives the width from
   * the live console while the band uses the debounced one, and during a resize
   * the `┬` and the rail's divider settle on different columns.
   */
  frameColumns?: number;
}) {
  const state = useTabsState();
  const pageActive = useActiveTabIsPage();
  const { stdout } = useStdout();
  const inkColumns =
    typeof stdout?.columns === "number" && stdout.columns > 0
      ? stdout.columns
      : undefined;
  const queried = useTerminalWidth();
  const columns =
    frameColumns !== undefined
      ? Math.max(0, frameColumns - ROW_SAFETY_COLUMNS)
      : tabStripColumns(queried, inkColumns);
  const layout = layoutTabStrip(tabStripItems(state), columns);
  // The rule is drawn to the full laid-out width, and the rail's divider meets it
  // at the last `railWidth` columns — the same arithmetic the band uses, so the
  // `┬` cannot end up beside the rail instead of on it.
  const ruleWidth = columns > 0 ? columns + ROW_SAFETY_COLUMNS : 0;
  const terminalRows = useTerminalRows();
  const railWidth = sidebarWidth(ruleWidth, terminalRows);

  useChromeClicks({
    regions: layout.regions,
    onSelect,
    onClose,
    pageActive,
  });

  return (
    <Box flexDirection="column" flexShrink={0}>
      {/* A fixed-width, clipping box: the row's segments are separate inline
          boxes, so Ink cannot truncate between them the way it truncates one
          string. Clipping keeps a miscounted glyph a clipped column instead of a
          wrapped line, which would cost the frame a row — and this row is the one
          the alternate screen scrolls away.

          The box is the row's own width (the terminal's, less the safety margin);
          the rule below is drawn to the *full* terminal width, because a repeated
          box-drawing glyph is the one row whose width can be checked by eye and
          because an edge-to-edge rule is what the design asks for (《36》N1). */}
      <Box
        width={columns > 0 ? columns : undefined}
        overflow="hidden"
        flexShrink={0}
      >
        {segmentsForText(layout)}
      </Box>
      <Text color={colors.input.border} wrap="truncate">
        {ruleWithJunction(ruleWidth, railWidth)}
      </Text>
    </Box>
  );
}
