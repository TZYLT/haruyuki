// src/cli/app/pages/page-frame.tsx

import { Box, type DOMElement, measureElement, Text, useStdout } from "ink";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { AppViewProps } from "@/cli/app/AppView";
import {
  CHROME_RESERVE_ROWS,
  useChromeHeight,
  useMeasuredChromeHeight,
} from "@/cli/app/chrome-height";
import {
  clampSelectableRow,
  type PageBody,
  type PageRow,
  pageWindow,
  scrollPageOffset,
  stepSelectableRow,
} from "@/cli/app/pages/page-model";
import { ContextSidebarSlot } from "@/cli/app/shell/context-sidebar";
import { useHasContextSidebar } from "@/cli/app/shell/sidebar-scope";
import { sidebarGeometry } from "@/cli/app/shell/sidebar-sections";
import { TAB_STRIP_ROWS } from "@/cli/app/shell/tab-strip-layout";
import { focusTab } from "@/cli/app/tabs";
import { ViewportPanel } from "@/cli/app/ViewportPanel";
import { colors } from "@/cli/components/colors";
import { useRowHovered } from "@/cli/helpers/hover-store";
import type { KeyBinding } from "@/cli/helpers/input-keys";
import { registerMouseHandler } from "@/cli/helpers/mouse-router";
import { useMouseRows } from "@/cli/helpers/use-mouse-rows";
import {
  useInputScopeClaim,
  useKeyBindings,
} from "@/cli/hooks/use-input-router";
import { useTerminalRows } from "@/cli/hooks/use-terminal-width";

/**
 * A page in the main area: the frame every page shares (P2).
 *
 * What a page is (《38》§3.6): **not** an overlay. It is a view that stays, it
 * replaces the transcript *band* and nothing else, and it owns the keyboard while
 * it is up — which is why this component claims the new `page` scope. The rail
 * stays beside it and the panel (a pinned approval, the running subagent group)
 * stays under it, because a tool that asks for permission while the user reads
 * Settings must still be answered: the input is disabled by then, so if the
 * approval were hidden too the session would be stopped with no visible question.
 *
 * Sizing follows the band's rule exactly (`ViewportTranscript`): the height is
 * `terminalRows - chrome - panel - top`, measured from the *previous* frame, and
 * the box is clipped to it. The box is also measured, and the smaller of the two
 * is used — the fix from `《39》§4.12`: when the chrome grows in one keystroke the
 * stale height would paint page rows over the composer, and the page is the one
 * rectangle here that can learn the truth about itself.
 *
 * Scrolling is the page's own, in rows: `↑↓` moves the cursor (skipping headers and
 * disabled rows), `PgUp`/`PgDn`/wheel scroll the window, and the cursor is always
 * kept in the window. Windowing reserves the two marker rows when the body
 * overflows, so the page's height never moves with the offset (`page-model.ts`).
 *
 * Mouse (《38》§19, P2's share): the wheel scrolls the page rather than the
 * transcript behind it, a click is the row's `Enter`, hover is the row's second
 * background — and a press on a blank row does nothing, exactly as `Enter` on it
 * does.
 */
export type PageFrameProps = {
  view: AppViewProps;
  body: PageBody;
  /** What the page does with its own keys (a group enters, a leaf edits). */
  actions?: PageActions;
  /**
   * What to draw instead of the page's title row.
   *
   * The band's height is owed to the frame, so a page cannot raise a second box
   * above itself without moving every row under it. The settings page's inline
   * editor therefore *is* the header row for as long as it is open — one row, the
   * same one, and the page behind it stays exactly where it was.
   */
  headerSlot?: ReactNode;
};

/**
 * What a page can do with the keys the frame owns.
 *
 * The frame keeps the keys that mean the same thing everywhere — `↑↓` move,
 * `PgUp`/`PgDn`/`Home`/`End` scroll, `Esc` leaves — and asks the page what
 * `Enter`, `Space` and `←→` mean, because those are the page's vocabulary: a
 * settings leaf toggles, cycles or opens an editor; a group row enters a
 * sub-screen. Adding a page means adding callbacks here, not a second frame.
 */
export type PageActions = {
  /** `Enter` on a row the cursor is on (and on the row a click landed on). */
  activate?: (row: PageRow) => void;
  /** `Space` on the cursor row: the settings page's toggle. */
  toggle?: (row: PageRow) => void;
  /**
   * `←` (`-1`) / `→` (`+1`) on the cursor row. Return `true` when the key meant
   * something; `false` lets it fall through — `←` then returns from a sub-screen,
   * the same key `Esc` is.
   */
  adjust?: (row: PageRow, direction: 1 | -1) => boolean;
  /**
   * Extra `page`-scope keys (the permission editor's `A` / `D`). A function of the
   * cursor row, because those keys act on *that* row and a table built during a
   * render would close over the cursor of a previous one.
   */
  bindings?: (cursor: PageRow | undefined) => readonly KeyBinding[];
  /** `Esc` before leaving the page: return `true` to stay (leave a sub-screen). */
  back?: () => boolean;
};

/** How many rows one wheel notch moves the page. */
export const PAGE_WHEEL_ROWS = 3;

/** The rows area's name in the hover store. */
const PAGE_AREA = "page";

export function PageFrame({ view, body, actions, headerSlot }: PageFrameProps) {
  const terminalRows = useTerminalRows();
  const chromeRows = useChromeHeight();
  const { ref: panelRef, rows: panelRows } = useMeasuredChromeHeight();
  const { ref: bandRef, rows: measuredBandRows } = useMeasuredChromeHeight();
  const height = Math.max(
    1,
    terminalRows -
      (chromeRows ?? CHROME_RESERVE_ROWS) -
      (panelRows ?? 0) -
      TAB_STRIP_ROWS,
  );
  const bandHeight = Math.min(height, measuredBandRows ?? height);

  // One row is the page's own header (title or breadcrumb); the rest is the body.
  const bodyHeight = Math.max(1, bandHeight - 1);

  const [offset, setOffset] = useState(0);
  const [cursorRow, setCursorRow] = useState(() => firstSelectable(body.rows));
  // A body whose rows changed under the cursor (a rule deleted, a value row gone)
  // must not leave the cursor past the end: `clampSelectableRow` moves it to the
  // nearest row the user could have meant.
  const cursor = clampSelectableRow(body.rows, cursorRow);
  const window = pageWindow({
    count: body.rows.length,
    height: bodyHeight,
    offset,
  });
  const visible = body.rows.slice(window.start, window.end);

  // A new screen (a settings group) starts at its own top with its own cursor:
  // row 4 of one screen has nothing to do with row 4 of the next. The rows are read
  // through a ref, so values moving under a *fixed* cursor — the normal state of a
  // page that writes settings — do not re-seat it.
  const latestRows = useRef(body.rows);
  latestRows.current = body.rows;
  const screen = body.screen;
  useEffect(() => {
    // `screen` is the trigger, not data: the rows come through the ref.
    void screen;
    setCursorRow(firstSelectable(latestRows.current));
    setOffset(0);
  }, [screen]);

  const scroll = (delta: number): void => {
    setOffset((current) =>
      scrollPageOffset({
        count: body.rows.length,
        height: bodyHeight,
        offset: current,
        delta,
      }),
    );
  };

  const moveCursor = (direction: 1 | -1): void => {
    setCursorRow((current) => {
      const next = stepSelectableRow(body.rows, current, direction);
      setOffset((currentOffset) =>
        offsetForCursor({
          rows: body.rows,
          height: bodyHeight,
          offset: currentOffset,
          cursor: next,
        }),
      );
      return next;
    });
  };

  const activateRow = (row: PageRow | undefined): void => {
    // A page that has nothing to activate still consumes the key: the row exists,
    // and falling through to the composer would type into a disabled input.
    if (!row || row.kind !== "item" || row.disabled) return;
    actions?.activate?.(row);
  };

  const cursorRowValue = (): PageRow | undefined => body.rows[cursor];

  const back = (): void => {
    // A sub-screen leaves first; the page only leaves when it is at its root.
    if (actions?.back?.()) return;
    const conversation = view.conversationId;
    if (conversation) focusTab(conversation);
  };

  // The page owns the keyboard while it is up (`modal > overlay > page > app`).
  useInputScopeClaim("page", true);
  useKeyBindings("page-frame", [
    {
      scope: "page",
      bindings: [
        {
          id: "page.back",
          chords: [{ key: "escape" }],
          label: "回会话",
          run: () => {
            back();
            return "consumed";
          },
        },
        {
          id: "page.up",
          chords: [{ key: "upArrow" }, { key: "k" }],
          run: () => {
            moveCursor(-1);
            return "consumed";
          },
        },
        {
          id: "page.down",
          chords: [{ key: "downArrow" }, { key: "j" }],
          run: () => {
            moveCursor(1);
            return "consumed";
          },
        },
        {
          id: "page.page-up",
          chords: [{ key: "pageUp" }],
          run: () => {
            scroll(-(bodyHeight - 1));
            return "consumed";
          },
        },
        {
          id: "page.page-down",
          chords: [{ key: "pageDown" }],
          run: () => {
            scroll(bodyHeight - 1);
            return "consumed";
          },
        },
        {
          id: "page.first",
          chords: [{ key: "home" }],
          run: () => {
            setOffset(0);
            return "consumed";
          },
        },
        {
          id: "page.last",
          chords: [{ key: "end" }],
          run: () => {
            scroll(Number.MAX_SAFE_INTEGER);
            return "consumed";
          },
        },
        {
          id: "page.enter",
          chords: [{ key: "return" }],
          run: () => {
            activateRow(cursorRowValue());
            return "consumed";
          },
        },
        {
          id: "page.left",
          chords: [{ key: "leftArrow" }],
          run: () => {
            // A leaf that adjusts (a select, a number) takes `←`; otherwise it means
            // "back one screen", which is the same key `Esc` is.
            const row = cursorRowValue();
            if (row && actions?.adjust?.(row, -1)) return "consumed";
            if (actions?.back?.()) return "consumed";
            return "declined";
          },
        },
        {
          id: "page.right",
          chords: [{ key: "rightArrow" }],
          run: () => {
            const row = cursorRowValue();
            return row && actions?.adjust?.(row, 1) ? "consumed" : "declined";
          },
        },
        {
          id: "page.space",
          chords: [{ key: "space" }],
          run: () => {
            const row = cursorRowValue();
            if (
              !actions?.toggle ||
              !row ||
              row.kind !== "item" ||
              row.disabled
            ) {
              return "declined";
            }
            actions.toggle(row);
            return "consumed";
          },
        },
        ...(actions?.bindings?.(cursorRowValue()) ?? []),
      ],
    },
  ]);

  // The wheel belongs to the page while it is up: a notch over the page must not
  // scroll the transcript, which is not even mounted. It claims the band, not the
  // row block, so a notch over a gap or the rail still scrolls. Registered once and
  // reading the fresh scroll through a ref — re-registering per render would reorder
  // the handler chain under a live gesture (`mouse-router.ts`).
  const scrollRef = useRef(scroll);
  scrollRef.current = scroll;
  useEffect(() => {
    return registerMouseHandler(
      (report) => {
        if (!report.wheel) return false;
        const node = bandRef.current;
        if (!node) return false;
        // Measured at event time for the same reason the rows are: the frame's
        // geometry changes with the chrome, and a stale row is the wrong page.
        const box = measureBox(node);
        if (!box) return false;
        if (report.row < box.top || report.row > box.bottom) return false;
        scrollRef.current(
          report.wheel === "up" ? -PAGE_WHEEL_ROWS : PAGE_WHEEL_ROWS,
        );
        return true;
      },
      { layer: "page", name: "page-wheel" },
    );
  }, [bandRef]);

  // The row block the pointer aims at. Its own ref, not the body's: the header
  // line sits above it, and `measureElement` would otherwise report row 0 as the
  // header (a click there would activate the first item).
  const rowsRef = useRef<DOMElement | null>(null);
  const activateAt = (index: number): void => {
    const rowIndex = window.start + index;
    const row = body.rows[rowIndex];
    if (!row || row.kind !== "item" || row.disabled) return;
    setCursorRow(rowIndex);
    activateRow(row);
  };
  useMouseRows({
    area: PAGE_AREA,
    ref: rowsRef,
    rowCount: visible.length,
    isInteractive: (index) => {
      const row = visible[index];
      return row?.kind === "item" && !row.disabled;
    },
    activate: activateAt,
    layer: "page",
    hoverable: visible.some((row) => row.kind === "item" && !row.disabled),
  });

  // `min(console, ink)` for the rail's columns — the same pair the strip, the
  // band and the rule resolve, so the divider lands in one column on every row.
  const { stdout } = useStdout();
  const inkColumns =
    typeof stdout?.columns === "number" && stdout.columns > 0
      ? stdout.columns
      : undefined;
  const frameColumns =
    inkColumns === undefined
      ? view.columns
      : Math.min(view.columns, inkColumns);
  const geometry = useHasContextSidebar()
    ? sidebarGeometry(frameColumns, terminalRows)
    : { railWidth: 0, bandColumns: frameColumns, junctionColumn: 0 };
  const railWidth = geometry.railWidth;
  const bandColumns = geometry.bandColumns;

  const header =
    body.breadcrumb && body.breadcrumb.length > 0
      ? body.breadcrumb.join(" / ")
      : body.title;

  return (
    <>
      <Box
        ref={bandRef}
        height={height}
        flexDirection={railWidth > 0 ? "row" : "column"}
        flexShrink={1}
        overflow="hidden"
      >
        <Box
          flexDirection="column"
          flexShrink={0}
          width={railWidth > 0 ? bandColumns : undefined}
          height={bandHeight}
          maxHeight="100%"
          overflow="hidden"
          paddingX={1}
        >
          {headerSlot ?? <Text bold>{header}</Text>}
          <Box ref={rowsRef} flexDirection="column" flexShrink={0}>
            {window.above > 0 && (
              <Text dimColor>{`↑ ${window.above} more`}</Text>
            )}
            {visible.map((row, index) => (
              <PageRowLine
                key={`${window.start + index}:${row.kind}`}
                row={row}
                index={index}
                focused={row.kind === "item" && window.start + index === cursor}
              />
            ))}
            {window.below > 0 && (
              <Text dimColor>{`↓ ${window.below} more`}</Text>
            )}
          </Box>
        </Box>
        {railWidth > 0 && (
          <ContextSidebarSlot
            view={view}
            height={bandHeight}
            width={railWidth}
          />
        )}
      </Box>
      <ViewportPanel
        panelRef={panelRef}
        approvalIsDrawn={false}
        approval={view}
      />
    </>
  );
}

/** One body row: a group title, a selectable item, or a note. */
function PageRowLine({
  row,
  index,
  focused,
}: {
  row: PageRow;
  index: number;
  focused: boolean;
}) {
  const hovered = useRowHovered(PAGE_AREA, index);
  const background = hovered && !focused ? colors.surface.hoverBg : undefined;

  if (row.kind === "header") {
    return (
      <Text dimColor color={colors.sectionHeader}>
        {row.text}
      </Text>
    );
  }
  if (row.kind === "note") {
    return <Text dimColor>{row.text}</Text>;
  }
  return (
    <Box flexDirection="row" backgroundColor={background}>
      <Text color={focused ? colors.selector.itemHighlighted : undefined}>
        {focused ? "> " : "  "}
      </Text>
      <Text
        bold={focused}
        color={focused ? colors.selector.itemHighlighted : undefined}
      >
        {row.label}
      </Text>
      {row.value !== undefined && <Text>{`  ${row.value}`}</Text>}
      {row.key !== undefined && <Text dimColor>{`  ${row.key}`}</Text>}
    </Box>
  );
}

/** The first row the cursor may land on, or 0 when there is none. */
function firstSelectable(rows: readonly PageRow[]): number {
  const index = rows.findIndex((row) => row.kind === "item" && !row.disabled);
  return index < 0 ? 0 : index;
}

/**
 * The offset that puts `cursor` inside the window, leaving it alone when it
 * already is.
 *
 * Called while moving the cursor, so it must not scroll on every step: a cursor
 * that is visible stays visible, and only a step off an edge drags the window.
 */
export function offsetForCursor(input: {
  rows: readonly PageRow[];
  height: number;
  offset: number;
  cursor: number;
}): number {
  const window = pageWindow({
    count: input.rows.length,
    height: input.height,
    offset: input.offset,
  });
  if (input.cursor < window.start) return input.cursor;
  if (input.cursor >= window.end) {
    return Math.max(0, input.cursor - (window.end - window.start) + 1);
  }
  return window.start;
}

/** Absolute row/column bounds of a laid-out box, in mouse coordinates (1-based). */
function measureBox(node: DOMElement): {
  top: number;
  bottom: number;
} | null {
  // `measureElement` is 0-based on both axes (the layout tree's origin), while a
  // mouse report is 1-based: the conversion happens here, once.
  const box = measureElement(node);
  if (box.height <= 0) return null;
  return { top: box.y + 1, bottom: box.y + box.height };
}
