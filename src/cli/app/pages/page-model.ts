// src/cli/app/pages/page-model.ts

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
      /**
       * Continuation lines drawn under the item's composed first line (T-10).
       *
       * The first line stays the label/value row the frame composes; each entry
       * here is one extra terminal line the page has already formatted and
       * clipped. `rowHeight` is therefore `1 + lines.length`, so an item with no
       * `lines` is exactly the one-row item every pre-T-10 page draws. The
       * multi-line rendering itself is W-05's; W-01 freezes the field so the
       * window arithmetic and the mouse mapping can be written against it.
       */
      lines?: readonly string[];
    }
  | { kind: "note"; text: string }
  /**
   * A pre-composed line the page drew itself: block art, a heatmap row, a table
   * row. Drawn verbatim (the page already clipped it to the width it was given),
   * never truncated by the frame, never selectable by the cursor or the pointer.
   *
   * This is what lets the Usage screens keep the frame — header, scrolling, mouse
   * band — without expressing themselves as label/value rows.
   */
  | {
      kind: "text";
      text: string;
      /**
       * Draw it dimmed: captions, units and the wordmark sit behind the numbers
       * instead of competing with them. Text is the only row kind a page styles
       * itself, so it is the only one that needs the flag.
       */
      dim?: boolean;
    };

/** The room a page body has, handed to a body that lays itself out. */
export type PageBodyGeometry = {
  /** Usable columns inside the frame's padding. */
  width: number;
  /** Rows the body may draw (markers included when it overflows). */
  height: number;
};

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
  /**
   * Rows to draw, or a function that builds them from the room available.
   *
   * A function because the Usage screens lay themselves out to the terminal
   * (docs/38 §14.6's three tiers are width and height conditions); the frame
   * owns the geometry, so it is the frame that has to hand it over.
   */
  rows:
    | readonly PageRow[]
    | ((geometry: PageBodyGeometry) => readonly PageRow[]);
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
 * How many terminal lines a row occupies.
 *
 * Every row kind but a multi-line item is one line. An item is `1 +
 * lines.length`: the composed first line plus its continuation lines. This is
 * the single place the page-row → terminal-line conversion is defined; the
 * frame's window and the mouse mapping both read it instead of re-deriving it.
 */
export function rowHeight(row: PageRow): number {
  if (row.kind !== "item") return 1;
  const lines = row.lines;
  if (lines === undefined || lines.length === 0) return 1;
  return 1 + lines.length;
}

/**
 * The terminal-line offset of every row, plus the body's total line count.
 *
 * `offsets[i]` is the first line of row `i`, and `offsets[rows.length]` is the
 * line after the last row (the total). One extra entry so a line position can be
 * mapped back to the row that owns it without a second sum.
 */
export function rowLineOffsets(rows: readonly PageRow[]): readonly number[] {
  const offsets: number[] = [0];
  let total = 0;
  for (const row of rows) {
    total += rowHeight(row);
    offsets.push(total);
  }
  return offsets;
}

/** One entry per row, each at least one line; missing/heights absent → 1. */
function normalizedHeights(
  count: number,
  heights: readonly number[] | undefined,
): readonly number[] {
  const result = new Array<number>(count);
  for (let index = 0; index < count; index += 1) {
    const value = heights?.[index];
    result[index] =
      typeof value === "number" && Number.isFinite(value)
        ? Math.max(1, Math.trunc(value))
        : 1;
  }
  return result;
}

/** The furthest first row that still fills the window from the bottom. */
function lastWindowStart(heights: readonly number[], capacity: number): number {
  const count = heights.length;
  let start = count;
  let used = 0;
  while (start > 0) {
    const lines = heights[start - 1] ?? 1;
    if (used + lines > capacity) break;
    used += lines;
    start -= 1;
  }
  // A single row taller than the window still has to be reachable: show it
  // alone rather than an empty page.
  return Math.min(start, Math.max(0, count - 1));
}

/**
 * Windowing for a page body.
 *
 * The same rule the overlay list uses (`overlay/list-view.tsx`): **when the list
 * overflows, both marker rows are reserved even at an end**, so scrolling cannot
 * change the page's height. A height that moves with the offset is a reflow of the
 * whole frame — the band is measured chrome — and it would make `PgDn` look like a
 * jump on screen as well as in the text.
 *
 * `offset` stays a **row index**, not a line index: ↑↓ move by item (R-10.6) and
 * the frame stores the cursor the same way. `heights` only decides how many rows
 * fit; omitting it is the all-one-line arithmetic every pre-T-10 page uses.
 */
export function pageWindow(input: {
  count: number;
  /** Rows the body may draw, markers included. */
  height: number;
  /** First row drawn. */
  offset: number;
  /** Terminal lines each row occupies, one entry per row (`rowHeight`). */
  heights?: readonly number[];
}): PageWindow {
  const count = Math.max(0, Math.trunc(input.count));
  const height = Math.max(0, Math.trunc(input.height));
  const heights = normalizedHeights(count, input.heights);
  const totalLines = heights.reduce((sum, rowLines) => sum + rowLines, 0);
  const reserved = totalLines > height;
  const capacity = reserved ? Math.max(1, height - 2) : height;
  const maxOffset = lastWindowStart(heights, capacity);
  const start = Math.min(Math.max(0, Math.trunc(input.offset)), maxOffset);
  let end = start;
  let used = 0;
  while (
    end < count &&
    (end === start || used + (heights[end] ?? 1) <= capacity)
  ) {
    used += heights[end] ?? 1;
    end += 1;
  }
  return { start, end, above: start, below: count - end, reserved };
}

/**
 * The largest offset `pageWindow` will honour.
 *
 * The capacity is in **terminal lines**, so a body of multi-line items has a
 * smaller maximum than its row count: `heights` is what makes `End` stop on the
 * last window that still fits. Omitting it is the one-line-per-row arithmetic
 * every pre-T-10 page uses.
 */
export function maxPageOffset(input: {
  count: number;
  height: number;
  /** Terminal lines each row occupies, one entry per row (`rowHeight`). */
  heights?: readonly number[];
}): number {
  const count = Math.max(0, Math.trunc(input.count));
  const height = Math.max(0, Math.trunc(input.height));
  const heights = normalizedHeights(count, input.heights);
  const totalLines = heights.reduce((sum, rowLines) => sum + rowLines, 0);
  // Same reservation rule as `pageWindow`: when the body overflows, two of the
  // height's rows are the markers, even at an end.
  const capacity = totalLines > height ? Math.max(1, height - 2) : height;
  return lastWindowStart(heights, capacity);
}

/**
 * Step the offset, clamped. `delta` is in rows.
 *
 * `heights` is passed through so the step lands on a window that exists (the
 * clamp is in lines); the offset itself stays a row index (R-10.6).
 */
export function scrollPageOffset(input: {
  count: number;
  height: number;
  offset: number;
  delta: number;
  /** Terminal lines each row occupies, one entry per row (`rowHeight`). */
  heights?: readonly number[];
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
