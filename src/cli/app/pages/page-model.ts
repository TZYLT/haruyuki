// src/cli/app/pages/page-model.ts

import type { PageTabId } from "@/cli/app/tabs";

/**
 * What a page in the main area is made of.
 *
 * A page replaces the transcript band (《38》§3.7) but not the shell: the rail
 * stays beside it, the composer stays below it, and the panel that carries a
 * pinned approval still hangs under it. So the *frame* is shared — height,
 * rail, panel, scrolling, keys (`page-frame.tsx`) — and a page supplies a title
 * and rows.
 *
 * The row vocabulary is deliberately small and is the one the settings page needs
 * (《38》§12.3bis): a **header** is a group title the cursor never lands on, an
 * **item** is a selectable row with a value and the key that changes it, and a
 * **note** is prose the pointer ignores. Keeping it this small is what lets P3
 * and P5 fill a page without touching the frame.
 */
export type PageRow =
  | { kind: "header"; text: string }
  | {
      kind: "item";
      /** Stable identity, so a re-read cannot move the cursor to another setting. */
      id: string;
      label: string;
      /** The effective value, already formatted for display. */
      value?: string;
      /** The key that acts on the row (`Space`, `←→`, `Enter`, `→`). */
      key?: string;
      /**
       * A short aside in its own column — the settings page puts the row's scope
       * here (`[Global]`, `[agent]`, `[conv]`).
       *
       * It is a column rather than the row's last cell because the first real run
       * reported the marker as missing: a narrow terminal cut it, and a value
       * pushed it to the edge.
       */
      hint?: string;
      /**
       * A dim-less aside after the value — painted in the command accent.
       *
       * The settings page puts "where to change this instead" here (`use /model`,
       * `start or /reload`), separate from the value so a read-only row still says
       * what its value is, and in the accent so it reads as an action rather than
       * as part of the value.
       */
      note?: string;
      /** Rows that exist but cannot be acted on (disabled, or read-only). */
      disabled?: boolean;
    }
  | { kind: "note"; text: string };

export type PageBody = {
  /** The page's own name, drawn in the frame's header row. */
  title: string;
  /** A path to show instead of the title (`Settings / 上下文管理 / compaction`). */
  breadcrumb?: readonly string[];
  /**
   * Which screen this body is, when one page has several (`Settings` does: the
   * root, a group, a permission bucket).
   *
   * The cursor and the scroll offset belong to a *screen*, not to a page: moving
   * to a sub-screen must put the cursor on that screen's first row instead of
   * leaving it at the row number the previous screen happened to have. A page
   * with one screen can omit it — the body then never changes identity, and the
   * cursor simply stays put while values change under it (which is what a value
   * edit needs).
   */
  screen?: string;
  rows: readonly PageRow[];
};

/** Where the body's window sits in a longer row list. */
export type PageWindow = {
  /** First row drawn. */
  start: number;
  /** One past the last row drawn. */
  end: number;
  /** Rows hidden above / below, for the `↑ N` markers. */
  above: number;
  below: number;
  /** Whether two rows are spent on the markers (so they never move the body). */
  reserved: boolean;
};

/**
 * Windowing for a page body.
 *
 * The same rule the overlay list uses (`overlay/list-view.tsx`): **when the list
 * overflows, both marker rows are reserved even at an end**, so scrolling cannot
 * change the page's height. A height that moves with the offset is a reflow of the
 * whole frame — the band is measured chrome — and it would make `PgDn` look like a
 * jump on screen as well as in the text.
 */
export function pageWindow(input: {
  count: number;
  /** Rows the body may draw, markers included. */
  height: number;
  offset: number;
}): PageWindow {
  const count = Math.max(0, Math.trunc(input.count));
  const height = Math.max(0, Math.trunc(input.height));
  const reserved = count > height;
  const rows = reserved ? Math.max(1, height - 2) : height;
  const maxOffset = Math.max(0, count - rows);
  const start = Math.min(Math.max(0, Math.trunc(input.offset)), maxOffset);
  const end = Math.min(count, start + rows);
  return { start, end, above: start, below: count - end, reserved };
}

/** The largest offset `pageWindow` will honour. */
export function maxPageOffset(input: {
  count: number;
  height: number;
}): number {
  const count = Math.max(0, Math.trunc(input.count));
  const height = Math.max(0, Math.trunc(input.height));
  const rows = count > height ? Math.max(1, height - 2) : height;
  return Math.max(0, count - rows);
}

/** Step the offset, clamped. `delta` is in rows. */
export function scrollPageOffset(input: {
  count: number;
  height: number;
  offset: number;
  delta: number;
}): number {
  const max = maxPageOffset(input);
  return Math.min(Math.max(0, Math.trunc(input.offset + input.delta)), max);
}

/** The rows the cursor may land on: items that are not disabled, in order. */
export function selectableRows(rows: readonly PageRow[]): number[] {
  const selectable: number[] = [];
  rows.forEach((row, index) => {
    if (row.kind === "item" && !row.disabled) selectable.push(index);
  });
  return selectable;
}

/**
 * The next selectable row index from `from` in `direction`.
 *
 * Returns `from` when there is nowhere to go, which is what makes the cursor stop
 * at the ends instead of wrapping — the settings page is a document, and wrapping
 * from the last row to the first would look like a scroll.
 */
export function stepSelectableRow(
  rows: readonly PageRow[],
  from: number,
  direction: 1 | -1,
): number {
  const selectable = selectableRows(rows);
  if (selectable.length === 0) return from;
  const current = selectable.indexOf(from);
  if (current < 0) {
    return direction === 1
      ? (selectable[0] ?? from)
      : (selectable.at(-1) ?? from);
  }
  const next = current + direction;
  if (next < 0 || next >= selectable.length) return from;
  return selectable[next] ?? from;
}

/**
 * The nearest selectable row to `index`, or 0 when there is none.
 *
 * A cursor outlives the rows it pointed at: deleting a permission rule, or
 * collapsing a group, leaves it past the end. Clamping at the *nearest* selectable
 * row (rather than at `rows.length - 1`, which may be a header) is what keeps the
 * next `Enter` from acting on a row the user never saw.
 */
export function clampSelectableRow(
  rows: readonly PageRow[],
  index: number,
): number {
  const selectable = selectableRows(rows);
  if (selectable.length === 0) return 0;
  if (selectable.includes(index)) return index;
  const after = selectable.find((row) => row > index);
  return after ?? selectable.at(-1) ?? 0;
}

/**
 * What the two pages hold **at P2**.
 *
 * Honest placeholders, not fake settings: the settings page (P3) and the usage
 * screens (P5) replace these rows with real values, and until then the page says
 * what is coming rather than showing a number nobody measured — `《38》§6.4`'s
 * "占位是显式的" applies to a whole page as much as to one rail line.
 */
export function pageBodyFor(pageId: PageTabId): PageBody {
  if (pageId === "usage") {
    return {
      title: "Usage",
      rows: [
        { kind: "header", text: "Usage" },
        { kind: "note", text: "概览：用量与成本 · 明细：上下文拆分" },
        { kind: "note", text: "用量台账在 P4 落盘，两屏在 P5 接线。" },
      ],
    };
  }
  return {
    title: "Settings",
    rows: [
      { kind: "header", text: "Settings" },
      { kind: "note", text: "通用 · 模型 · 权限 · 连接" },
      {
        kind: "note",
        text: "设置页在 P3 接线：单页缩进树，读生效值，写复用各自命令。",
      },
    ],
  };
}
