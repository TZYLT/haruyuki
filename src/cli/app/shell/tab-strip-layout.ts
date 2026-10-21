// src/cli/app/shell/tab-strip-layout.ts

import {
  truncateToWidth,
  visibleWidth,
} from "@/cli/display/statusline/formatting";
import { CLI_GLYPHS } from "@/cli/helpers/glyphs";

/**
 * The tab row's geometry: what goes on it, at which columns, and which columns
 * are clickable.
 *
 * Pure on purpose. The row is the one piece of the M6 shell whose correctness is
 * a *layout* question — a title truncating at 12 columns, tabs collapsing into
 * `+N` from the right, the current tab never collapsing, `Usage` and `Settings`
 * pinned to the right end — and a layout question is answerable without mounting
 * Ink. `use-chrome-clicks` then hit-tests the same `regions` this returns, so the
 * rectangle the user sees and the rectangle the click resolves to cannot drift
 * apart: they are the same numbers.
 *
 * Conventions, all from 《38》§2–§4:
 *
 * - **`> ` marks the current tab and `•` the unread one**; the marker column is
 *   reserved on every conversation cell so the names line up whether the tab is
 *   current or not.
 * - **Titles truncate to `TAB_TITLE_COLUMNS`**, with the shared helper's ellipsis
 *   (so 12 columns is 11 characters plus `…`, and a wide character is never cut
 *   in half).
 * - **Only a closeable tab carries `×`**, and its two columns are part of the
 *   layout: the `×` hot zone is ` ×`, one column wider than the glyph, because a
 *   one-column mouse target is a coin flip.
 * - **Collapsing drops tabs from the right** and reports the count as `+N`, which
 *   is written after the last surviving conversation tab. The current tab is
 *   never dropped, even when it is the rightmost one: it is pulled back in and
 *   the tabs between are dropped instead.
 * - **The pages are admitted from the right**: `Settings` first, then `Usage`
 *   when it still fits beside the current conversation tab. A terminal too narrow
 *   for all of that keeps the conversation tabs (and loses `Usage`, which is the
 *   order 《38》§3.4 gives).
 *
 * Region columns are 1-based and inclusive, the same space the mouse reports use.
 */

/**
 * Rows the strip occupies: the tab row and the rule under it.
 *
 * The band's position and its height both depend on this number (`ViewportTranscript`
 * reserves it; the selection layer will not start a drag on it), so it lives here,
 * next to the row it describes, rather than being counted twice.
 */
export const TAB_STRIP_ROWS = 2;

/** Columns a conversation title may occupy before the ellipsis. */
export const TAB_TITLE_COLUMNS = 12;

/** Spaces between two tabs, and between the conversation tabs and the pages. */
export const TAB_GAP = 2;

/** Marker column every conversation cell reserves: `> ` for the current tab. */
const MARKER = "> ";
const MARKER_BLANK = "  ";

/** The close hot zone, glyph included. */
const CLOSE = ` ${CLI_GLYPHS.close}`;

/**
 * The unread mark, drawn before the title.
 *
 * Exported because the strip has to find it again in the painted name to give it
 * its own colour, and a second copy of the string in the component would drift:
 * the search would simply stop matching, and the mark would lose its colour with
 * no error. One constant, two readers.
 */
export const TAB_UNREAD_MARK = `${CLI_GLYPHS.bullet} `;

export type TabStripItem = {
  id: string;
  kind: "conversation" | "page";
  title: string;
  active: boolean;
  unread: boolean;
  /** Whether this tab can be closed, so whether the strip draws its `×`. */
  closeable: boolean;
};

export type TabStripSegment = {
  /** Stable identity: a tab's `id:part`, or the column a spacer starts at. */
  key: string;
  text: string;
  /** The tab this segment belongs to; absent for spacers and the `+N` marker. */
  id?: string;
  /** Which part of the tab the segment is: its name, its close hot zone, or the `+N` marker. */
  part?: "name" | "close" | "overflow";
  active?: boolean;
  unread?: boolean;
  /** Rendered with `dimColor` (inactive page tabs). */
  dim?: boolean;
};

/**
 * The id the collapsed `+N` marker is clickable under.
 *
 * Not a tab id: the marker stands for the tabs that are *not* drawn, so there is
 * no single id it could carry. The click handler treats this one value as "open
 * the tab list" (《38》§3.8).
 */
export const TAB_OVERFLOW_ID = "tabs:overflow";

/** A clickable rectangle: 1-based, inclusive, in screen columns. */
export type TabStripRegion = {
  id: string;
  part: "name" | "close" | "overflow";
  from: number;
  to: number;
};

export type TabStripLayout = {
  /** The columns the row has to fill. */
  columns: number;
  segments: readonly TabStripSegment[];
  regions: readonly TabStripRegion[];
};

type Cell = {
  item: TabStripItem;
  /** The name part, marker and unread mark included. */
  name: string;
  close: string | null;
};

function cellFor(item: TabStripItem): Cell {
  const marker = item.active ? MARKER : MARKER_BLANK;
  const title = truncateToWidth(item.title, TAB_TITLE_COLUMNS);
  const unread = item.unread ? TAB_UNREAD_MARK : "";
  return {
    item,
    name: `${marker}${unread}${title}`,
    close: item.closeable ? CLOSE : null,
  };
}

function cellWidth(cell: Cell): number {
  return visibleWidth(cell.name) + (cell.close ? visibleWidth(cell.close) : 0);
}

/** Total width of `count` cells laid out with `TAB_GAP` between them. */
function rowWidth(widths: readonly number[], count: number): number {
  let used = 0;
  for (let index = 0; index < count; index += 1) {
    used += (index === 0 ? 0 : TAB_GAP) + (widths[index] ?? 0);
  }
  return used;
}

/** How many leading cells fit in `budget`. */
function fitCount(widths: readonly number[], budget: number): number {
  let count = 0;
  for (let index = 0; index < widths.length; index += 1) {
    if (rowWidth(widths, index + 1) > budget) break;
    count = index + 1;
  }
  return count;
}

/** A segment before it has an identity: everything but `key`. */
type DraftSegment = Omit<TabStripSegment, "key">;

function segmentsFor(cell: Cell): DraftSegment[] {
  const segments: DraftSegment[] = [
    {
      text: cell.name,
      id: cell.item.id,
      part: "name",
      active: cell.item.active,
      unread: cell.item.unread,
      dim: cell.item.kind === "page" && !cell.item.active,
    },
  ];
  if (cell.close) {
    segments.push({ text: cell.close, id: cell.item.id, part: "close" });
  }
  return segments;
}

/**
 * Give every spacer a unique key, from the column it starts at.
 *
 * The row is positional text: two gaps are not the same segment, and their column
 * is what distinguishes them. Keys also keep React from reusing a gap for a tab
 * when the collapse count changes.
 */
function keyed(segments: readonly DraftSegment[]): TabStripSegment[] {
  let column = 1;
  return segments.map((segment) => {
    const key =
      segment.part && segment.id
        ? `${segment.id}:${segment.part}`
        : `at:${column}`;
    column += visibleWidth(segment.text);
    return { ...segment, key };
  });
}

function regionsFor(segments: readonly TabStripSegment[]): TabStripRegion[] {
  const regions: TabStripRegion[] = [];
  let column = 1;
  for (const segment of segments) {
    const width = visibleWidth(segment.text);
    if (segment.id && segment.part) {
      regions.push({
        id: segment.id,
        part: segment.part,
        from: column,
        to: column + width - 1,
      });
    }
    column += width;
  }
  return regions;
}

/**
 * Lay the strip out for a terminal `columns` wide.
 *
 * `items` is in strip order: conversations in open order, then `Usage` and
 * `Settings`. Items whose kind the caller does not want drawn (a page tab before
 * its page exists) are simply not passed in.
 */
export function layoutTabStrip(
  items: readonly TabStripItem[],
  columns: number,
): TabStripLayout {
  const width = Math.max(0, Math.floor(columns));
  if (width === 0 || items.length === 0) {
    return { columns: width, segments: [], regions: [] };
  }

  const conversations = items
    .filter((item) => item.kind === "conversation")
    .map(cellFor);
  const pages = items.filter((item) => item.kind === "page").map(cellFor);
  const activeCell = conversations.find((cell) => cell.item.active);
  const activeWidth = activeCell ? cellWidth(activeCell) : 0;

  // The pages are admitted from the right while the current conversation tab
  // still fits beside them: both, then `Settings` alone, then neither.
  let admittedPages = pages;
  const pagesFit = (candidate: readonly Cell[]): boolean => {
    const total = rowWidth(candidate.map(cellWidth), candidate.length);
    return width - total - (candidate.length > 0 ? TAB_GAP : 0) >= activeWidth;
  };
  if (!pagesFit(pages)) {
    admittedPages = pages.filter((cell) => cell.item.id === "settings");
    if (!pagesFit(admittedPages)) admittedPages = [];
  }

  const pageWidths = admittedPages.map(cellWidth);
  const pageWidth = rowWidth(pageWidths, pageWidths.length);
  const conversationBudget = Math.max(
    0,
    width - pageWidth - (admittedPages.length > 0 ? TAB_GAP : 0),
  );

  const widths = conversations.map(cellWidth);
  let admitted = Array.from(
    { length: fitCount(widths, conversationBudget) },
    (_, index) => index,
  );
  const activeIndex = conversations.findIndex((cell) => cell.item.active);

  // The current tab is never the one dropped: when it did not survive the greedy
  // fit, it is pulled in and the tabs after it give way instead.
  if (activeIndex >= 0 && !admitted.includes(activeIndex)) {
    const forced = [activeIndex];
    let used = widths[activeIndex] ?? 0;
    for (let index = 0; index < conversations.length; index += 1) {
      if (index === activeIndex) continue;
      const next = used + TAB_GAP + (widths[index] ?? 0);
      if (next > conversationBudget) break;
      forced.push(index);
      used = next;
    }
    admitted = forced.sort((a, b) => a - b);
  }

  /** The admitted cells' own width, before the marker. */
  const admittedWidth = (): number =>
    rowWidth(
      admitted.map((index) => widths[index] ?? 0),
      admitted.length,
    );
  let dropped = conversations.length - admitted.length;
  let marker = dropped > 0 ? `+${dropped}` : null;

  // Room for the marker: an admitted non-current tab gives way one at a time, and
  // when only the current tab is left the count is not drawn at all — the current
  // tab's row is the one thing that always survives.
  while (marker) {
    const used =
      admittedWidth() +
      (admitted.length > 0 ? TAB_GAP : 0) +
      visibleWidth(marker);
    if (used <= conversationBudget) break;
    const lastAdmitted = admitted[admitted.length - 1];
    if (admitted.length <= 1 || lastAdmitted === activeIndex) {
      marker = null;
      break;
    }
    admitted = admitted.slice(0, -1);
    dropped += 1;
    marker = `+${dropped}`;
  }

  const segments: DraftSegment[] = [];
  const pushCell = (cell: Cell, index: number): void => {
    if (index > 0) segments.push({ text: " ".repeat(TAB_GAP) });
    segments.push(...segmentsFor(cell));
  };
  admitted.forEach((index, position) => {
    const cell = conversations[index];
    if (cell) pushCell(cell, position);
  });
  if (marker) {
    if (admitted.length > 0) segments.push({ text: " ".repeat(TAB_GAP) });
    segments.push({
      text: marker,
      id: TAB_OVERFLOW_ID,
      part: "overflow",
      dim: true,
    });
  }

  const leftText = segments.map((segment) => segment.text).join("");
  const rightSegments: DraftSegment[] = [];
  admittedPages.forEach((cell) => {
    if (rightSegments.length > 0) {
      rightSegments.push({ text: " ".repeat(TAB_GAP) });
    }
    rightSegments.push(...segmentsFor(cell));
  });
  const rightText = rightSegments.map((segment) => segment.text).join("");

  // No floor of one: the row must never be wider than `columns`. On a row that
  // already fills the terminal exactly, a forced pad column pushes the last tab's
  // final column past the edge — clipped by the paint, and its click region
  // unreachable. The pages' gap is not at risk: `conversationBudget` already
  // subtracted it, so admitted pages always leave `TAB_GAP` columns of slack.
  const pad = Math.max(
    0,
    width - visibleWidth(leftText) - visibleWidth(rightText),
  );
  segments.push({ text: " ".repeat(pad) });
  segments.push(...rightSegments);

  const drawn = keyed(segments.filter((segment) => segment.text.length > 0));
  return {
    columns: width,
    segments: drawn,
    regions: regionsFor(drawn),
  };
}
