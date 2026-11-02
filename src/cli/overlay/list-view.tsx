import { Box, type DOMElement, measureElement } from "ink";
import {
  type ReactElement,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
} from "react";
import { colors } from "@/cli/components/colors";
import { Text } from "@/cli/components/Text";
import {
  clearHoverIn,
  setHoverTarget,
  useRowHovered,
} from "@/cli/helpers/hover-store";
import { createClickTracker } from "@/cli/helpers/mouse-click";
import { registerMouseHandler } from "@/cli/helpers/mouse-router";
import type { MouseReport } from "@/cli/helpers/mouse-sequence";
import { acquireMouseHover } from "@/cli/helpers/mouse-tracking";
import {
  type ListAnchor,
  type OverlayListItem,
  visibleWindow,
} from "./list-model";

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
 *
 * **The pointer is the same list, aimed at.** The `mouse` controller (from
 * `useOverlayList`) turns this view into the one seam every selector shares:
 * hover paints the row the pointer is over (`surface.hoverBg`, and the cursor row
 * keeps its own signal instead — 《38》§19.3), a click moves the cursor and runs
 * that row's `Enter`, and a wheel notch is one `↑`/`↓` step so a windowed list
 * scrolls. The hit test measures **each row's own box** at event time, not a line
 * count: rows are not all one line (`/resume` and `/agent` draw a summary, a
 * preview and a timestamp), and a face that would have to hand over its row
 * heights would be doing the toolkit's job. Measuring also keeps what the user
 * aimed at and what is hit from drifting, because it is the layout tree's own
 * answer. The handler registers on the **chrome** layer because an overlay is
 * drawn in the bottom chrome — it claims only its own rectangle, so a wheel
 * outside the rows is declined and the page/transcript below still sees it
 * (《38》§19.4 `chrome > page > content`).
 *
 * `mouse` unset is not a degenerate case: it is the pre-pointer rendering, byte
 * for byte. A caller that has not been wired yet (the fifteen faces W-14 takes)
 * passes nothing and gets exactly the rows it had; the hover wrapper is only ever
 * inserted for a list that asked for the pointer, and it paints nothing until the
 * store says a row is hovered.
 */

/**
 * What the list view needs from the pointer side of the controller.
 *
 * `area` names the rows in the hover store; `activate`/`wheel` are the cursor and
 * confirm the hook owns. `blocked` is the stacking guard (a modal outranks an
 * overlay), read at event time so a modal opening above a still-mounted selector
 * cannot be clicked through.
 */
export interface OverlayListMouse {
  /** Unique hover area for this list instance (`useOverlayList` makes it). */
  area: string;
  /** A click is that row's Enter: move the cursor there, then confirm. */
  activate: (index: number) => void;
  /** One wheel notch: one cursor step in that direction, clamped. */
  wheel: (direction: "up" | "down") => void;
  /** Whether an exclusive modal currently outranks this list. */
  blocked: () => boolean;
}

export interface OverlayListViewProps {
  items: readonly OverlayListItem[];
  cursor: number;
  /** Window size. `undefined` renders the whole list. */
  rows?: number;
  /**
   * Where the window sits relative to the cursor. Defaults to `edge`, the model
   * lists' shape; `/resume` and `/search` pass `center`, and `/help` passes
   * `page`, which is what its own page arithmetic did. A face must pass the same
   * anchor it gave `useOverlayList`.
   */
  anchor?: ListAnchor;
  /**
   * Whether the `↑/↓ N more` rows are drawn for a windowed list. On by default.
   *
   * Off is for a face that already says the same thing somewhere it owns:
   * `/resume` prints `Showing 1-5 of 23+` in its footer and `/search` prints
   * `3/100 results`, so a second count in the toolkit's wording is the same fact
   * twice — and, because the rows are reserved even at an end, two rows taller.
   */
  indicators?: boolean;
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
  /**
   * The pointer seam, from `useOverlayList`. Unset renders exactly the rows this
   * view rendered before the pointer existed — no handler, no hover wrapper.
   */
  mouse?: OverlayListMouse;
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
        {isCurrent && (item.currentLabel ?? " (current)")}
      </Text>
      {item.description && <Text dimColor>{` · ${item.description}`}</Text>}
    </Box>
  );
}

/** The measured item rows, by full-list index, as the last commit laid them out. */
type RowRegistry = Map<number, DOMElement>;

/**
 * One row, with the pointer's highlight when the store says it is the hovered one.
 *
 * A component per row rather than a boolean in the parent: `useRowHovered` is a
 * boolean snapshot, so a pointer moving across the list re-renders the two rows
 * involved instead of the whole overlay on every cell the terminal reports
 * (《38》§19.3 5). The cursor row keeps `> ` + colour and does **not** also take the
 * background, so the two signals never stack (《38》§19.3 2).
 *
 * The row also registers its own element: the hit test measures rows rather than
 * counting lines, because a row may be several lines tall (`/resume`'s summary,
 * preview and timestamp) and only the layout tree knows how many. The index is
 * the *full-list* index, so a window scrolling under the pointer re-registers the
 * row under its new position without changing the identity the caller keyed it by.
 */
function RowHoverBox({
  area,
  index,
  cursor,
  registerRow,
  children,
}: {
  area: string;
  index: number;
  cursor: boolean;
  registerRow: (index: number, node: DOMElement | null) => void;
  children: ReactNode;
}) {
  const hovered = useRowHovered(area, index);
  const nodeRef = useRef<DOMElement | null>(null);
  useEffect(() => {
    registerRow(index, nodeRef.current);
    return () => {
      registerRow(index, null);
    };
  }, [index, registerRow]);
  return (
    <Box
      ref={nodeRef}
      backgroundColor={hovered && !cursor ? colors.surface.hoverBg : undefined}
    >
      {children}
    </Box>
  );
}

/** The geometry one pointer report is resolved against. */
type ListMouseRows = {
  mouse: OverlayListMouse | undefined;
  /** The box the rows were drawn in; measured at event time. */
  ref: RefObject<DOMElement | null>;
  /** The visible rows, by full-list index, as last committed. */
  registry: RefObject<RowRegistry>;
  /** How many item rows are drawn (what makes an empty list pointerless). */
  rowCount: number;
  /** Whether a row may be hovered (a blocked one never lights). */
  hoverable: (index: number) => boolean;
};

function measuredBox(
  ref: RefObject<DOMElement | null>,
): { x: number; y: number; width: number; height: number } | null {
  const node = ref.current;
  if (!node) return null;
  const box = measureElement(node);
  if (box.height <= 0 || box.width <= 0) return null;
  return box;
}

/**
 * Which line of the measured box a screen cell is on, or null when outside it.
 *
 * `measureElement` is 0-based (the layout tree's origin) while a mouse report is
 * 1-based, which is the off-by-one that has gone wrong in both directions in this
 * tree; the conversion lives here once.
 */
function lineInBox(
  box: { x: number; y: number; width: number; height: number },
  point: { row: number; column: number },
): number | null {
  if (point.column < box.x + 1 || point.column > box.x + box.width) return null;
  const line = point.row - 1 - box.y;
  return line >= 0 && line < box.height ? line : null;
}

/**
 * The visible item whose own measured box contains `point`, or null.
 *
 * Indicators and the blank lines between rows resolve to null here: they are not
 * item rows, so a press on one is declined — the same refusal `↑↓` has for a line
 * that is not an item. A multi-line row answers on every one of its lines.
 */
function itemIndexAtPoint(
  rows: ListMouseRows,
  point: { row: number; column: number },
): number | null {
  const root = measuredBox(rows.ref);
  if (!root) return null;
  if (lineInBox(root, point) === null) return null;
  const screenLine = point.row - 1;
  for (const [index, node] of rows.registry.current) {
    const box = measureElement(node);
    if (box.height <= 0 || box.width <= 0) continue;
    if (screenLine >= box.y && screenLine < box.y + box.height) return index;
  }
  return null;
}

/**
 * Register this list's rectangle with the mouse router, on the chrome layer.
 *
 * One handler does all three pointer verbs, because they must agree about the
 * same rectangle and the same rows: a wheel outside the rows returns `false` so
 * the page/transcript below keeps its scroll; a press inside is claimed even
 * before it is known to be a click (the release decides, `mouse-click.ts`); a
 * move inside clears/places the one hover target. Motion while a press is pending
 * belongs to that gesture and is spent, never offered to the selection below.
 */
function useOverlayListMouse(options: {
  mouse: OverlayListMouse | undefined;
  ref: RefObject<DOMElement | null>;
  registry: RefObject<RowRegistry>;
  rowCount: number;
  hoverable: (index: number) => boolean;
}): void {
  const latest = useRef(options);
  latest.current = options;
  const area = options.mouse?.area;
  const enabled = options.mouse !== undefined && options.rowCount > 0;

  useEffect(() => {
    if (!enabled || area === undefined) return undefined;
    const tracker = createClickTracker();
    // Any-motion (`1003`) is asked for only while a hoverable surface is up and
    // given back with it; `Ctrl+X m` is honoured inside `mouse-tracking.ts`, so a
    // claim cannot leave the mode on (《38》§19.3 4).
    const giveBack = acquireMouseHover();

    const unregister = registerMouseHandler(
      (report: MouseReport) => {
        const current = latest.current;
        const subject = current.mouse;
        if (!subject) return false;

        // A modal owns the keyboard and the pointer: the whole frame is refused
        // before anything is measured (《38》§19.4; P0's overlay/modal ruling).
        // Declining rather than consuming also leaves the wheel to whatever is
        // still legitimately below.
        if (subject.blocked()) {
          clearHoverIn(subject.area);
          return false;
        }

        const root = measuredBox(current.ref);
        if (!root) return false;
        if (lineInBox(root, report) === null) {
          // A move outside the list takes the highlight with it (《38》§19.3 3);
          // the report is declined so whatever the pointer is actually over —
          // a page row, the transcript — still sees it.
          if (report.kind === "move") clearHoverIn(subject.area);
          return false;
        }

        if (report.wheel) {
          // Horizontal notches are not this list's: decline so a surface that
          // has a meaning for them can have it.
          if (report.wheel !== "up" && report.wheel !== "down") return false;
          subject.wheel(report.wheel);
          return true;
        }

        if (report.kind === "press") {
          if (report.button !== "left") return false;
          // An indicator/blank line is not a row; leave the press to the layer
          // below, exactly as `↑↓` cannot land on it.
          if (itemIndexAtPoint(current, report) === null) return false;
          tracker.press(report, Date.now());
          return true;
        }

        if (report.kind === "move") {
          if (tracker.isPending()) {
            // A claim this block made owns the motion of its own gesture.
            tracker.move(report);
            return true;
          }
          const index = itemIndexAtPoint(current, report);
          if (index === null) {
            // Inside the list but on chrome: nothing may stay lit.
            clearHoverIn(subject.area);
            return true;
          }
          if (current.hoverable(index)) {
            setHoverTarget({ area: subject.area, index });
          } else {
            // A blocked row does not light, and the row the pointer left must
            // not stay lit either (《38》§19.3 3).
            clearHoverIn(subject.area);
          }
          return true;
        }

        // Release: the press cell is what a click resolves to, so a drag that
        // ended elsewhere cannot activate a row.
        const wasPending = tracker.isPending();
        const point = tracker.release(report, Date.now());
        if (!point) return wasPending;
        const index = itemIndexAtPoint(current, point);
        if (index !== null) subject.activate(index);
        return true;
      },
      { layer: "chrome", name: area },
    );

    return () => {
      unregister();
      giveBack();
      // A surface going away while hovered must not leave a row lit underneath
      // whatever replaces it.
      clearHoverIn(area);
    };
  }, [enabled, area]);
}

export function OverlayListView({
  items,
  cursor,
  rows,
  anchor,
  indicators = true,
  renderRow,
  emptyLabel,
  mouse,
}: OverlayListViewProps) {
  const bodyRef = useRef<DOMElement | null>(null);
  // The rows' own elements, by full-list index. A ref, not state: the mouse
  // handler reads it at event time and registration must never re-render.
  const rowRegistry = useRef<RowRegistry>(new Map());
  const registerRow = useCallback((index: number, node: DOMElement | null) => {
    if (node) rowRegistry.current.set(index, node);
    else rowRegistry.current.delete(index);
  }, []);

  // The window is computed before the empty-list return so the pointer hook is
  // called on every render in the same order (a list that becomes empty must not
  // change the hook count).
  const window = visibleWindow({ count: items.length, cursor, rows, anchor });
  // A window that hides rows is the only case that reserves the two indicator
  // lines; those lines are measured as chrome, never as rows.
  const windowed = indicators && rows !== undefined && window.total > rows;
  const visible = items.slice(window.start, window.end);

  useOverlayListMouse({
    mouse,
    ref: bodyRef,
    registry: rowRegistry,
    rowCount: visible.length,
    hoverable: (index) => !(items[index]?.disabled ?? false),
  });

  if (items.length === 0) {
    return emptyLabel ? (
      <Box flexDirection="column">
        <Text dimColor>{emptyLabel}</Text>
      </Box>
    ) : null;
  }

  return (
    <Box ref={bodyRef} flexDirection="column">
      {windowed && (
        <Text dimColor>
          {window.above > 0 ? ` ↑ ${window.above} more` : " "}
        </Text>
      )}

      {visible.map((item, offset) => {
        const index = window.start + offset;
        const isCursor = index === cursor;
        const row = renderRow
          ? renderRow(item, index, isCursor)
          : defaultRow(item, isCursor, item.key);
        if (!mouse) {
          return renderRow ? <Box key={item.key}>{row}</Box> : row;
        }
        return (
          <RowHoverBox
            key={item.key}
            area={mouse.area}
            index={index}
            cursor={isCursor}
            registerRow={registerRow}
          >
            {row}
          </RowHoverBox>
        );
      })}

      {windowed && (
        <Text dimColor>
          {window.below > 0 ? ` ↓ ${window.below} more` : " "}
        </Text>
      )}
    </Box>
  );
}
