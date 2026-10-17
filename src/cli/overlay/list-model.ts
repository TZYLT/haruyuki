/**
 * The overlay toolkit's list model.
 *
 * Pure functions over an item list, a cursor and a row budget: no React, no Ink,
 * no I/O, so "how a list behaves" is answerable without mounting anything.
 *
 * Two rules this module exists to hold:
 *
 * - **Identity is the item's `key`, never its index.** An index is only
 *   meaningful inside one render of one list; anything that outlives a render —
 *   a selection, a reorder, a window anchor — is expressed as a key. The paged
 *   transcript learned this the expensive way (an anchor keyed by index is not
 *   an anchor).
 * - **A window is a view, not a slice the caller has to remember.** `rows:
 *   undefined` means the whole list, which is what every overlay in this tree
 *   rendered before the toolkit existed, so a caller that does not ask for
 *   windowing gets exactly the list it had. Windowing is opt-in per overlay: a
 *   migration must not change what a long list shows as a side effect.
 */

export interface OverlayListItem {
  /** Stable identity. Never an index — see the note above. */
  key: string;
  label: string;
  description?: string;
  /** The active value; rendered as `(current)`. */
  isCurrent?: boolean;
  /**
   * What the active row says instead of `(current)`, when that is not the whole
   * story. The toolset list is the one that needs it: its `Auto` row names the
   * preset the preference resolves to (`Auto (current - Claude)`), so the marker
   * varies by row and by state. Defaults to `" (current)"` — what every other
   * list in this tree shows — and is ignored while `isCurrent` is false.
   */
  currentLabel?: string;
  /** Rendered dimmed, and a confirm on it is a no-op. */
  disabled?: boolean;
  /** Rendered dimmed but still selectable (the picker's original distinction). */
  dimLabel?: boolean;
}

/** Which part of a list is on screen, and how much is hidden on either side. */
export interface ListWindow {
  start: number;
  end: number;
  above: number;
  below: number;
  total: number;
}

const EMPTY_WINDOW: ListWindow = {
  start: 0,
  end: 0,
  above: 0,
  below: 0,
  total: 0,
};

/** The cursor is always a valid index into the current list, or 0 when empty. */
export function clampCursor(cursor: number, count: number): number {
  if (count <= 0) return 0;
  if (!Number.isFinite(cursor)) return 0;
  return Math.min(Math.max(0, Math.trunc(cursor)), count - 1);
}

/**
 * First index of the window that shows `cursor` inside `rows` rows.
 *
 * The window only moves once the cursor reaches its edge, and the last window is
 * the list's tail rather than a shorter one — the shape both hand-written window
 * calculations in this tree already had (`MessageSearch`, `profile-selection`),
 * now stated once.
 */
export function windowStart(options: {
  count: number;
  cursor: number;
  rows: number;
}): number {
  const count = Math.max(0, Math.trunc(options.count));
  const rows = Math.trunc(options.rows);
  if (rows <= 0 || count <= rows) return 0;
  const cursor = clampCursor(options.cursor, count);
  return Math.max(0, Math.min(cursor - rows + 1, count - rows));
}

export function visibleWindow(options: {
  count: number;
  cursor: number;
  rows?: number;
}): ListWindow {
  const count = Math.max(0, Math.trunc(options.count));
  if (count === 0) return EMPTY_WINDOW;
  const cursor = clampCursor(options.cursor, count);
  if (options.rows === undefined) {
    return { start: 0, end: count, above: 0, below: 0, total: count };
  }
  const rows = Math.max(1, Math.trunc(options.rows));
  const start = windowStart({ count, cursor, rows });
  const end = Math.min(count, start + rows);
  return { start, end, above: start, below: count - end, total: count };
}

/**
 * Where the cursor goes for one navigation step.
 *
 * `wrap` is the autocomplete popup's behaviour (it cycles); the pickers clamp.
 * Both are real, so both are here rather than chosen for everyone.
 */
export function moveCursor(options: {
  cursor: number;
  count: number;
  delta: number;
  wrap?: boolean;
}): number {
  const count = Math.max(0, Math.trunc(options.count));
  if (count <= 0) return 0;
  const cursor = clampCursor(options.cursor, count);
  const delta = Math.trunc(options.delta);
  if (!Number.isFinite(delta) || delta === 0) return cursor;
  const next = cursor + delta;
  if (options.wrap) return ((next % count) + count) % count;
  return clampCursor(next, count);
}

/** `home`/`end`: the first or last item, safely on an empty list. */
export function edgeCursor(count: number, edge: "start" | "end"): number {
  const total = Math.max(0, Math.trunc(count));
  if (total === 0) return 0;
  return edge === "start" ? 0 : total - 1;
}

export function itemAt(
  items: readonly OverlayListItem[],
  cursor: number,
): OverlayListItem | undefined {
  return items[clampCursor(cursor, items.length)];
}

/** Case-insensitive substring match over the label and the description. */
export function matchesQuery(item: OverlayListItem, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  if (item.label.toLowerCase().includes(needle)) return true;
  return (item.description ?? "").toLowerCase().includes(needle);
}

export function filterItems(
  items: readonly OverlayListItem[],
  query: string,
): OverlayListItem[] {
  const needle = query.trim();
  if (needle === "") return [...items];
  return items.filter((item) => matchesQuery(item, needle));
}

export function toggleSelection(
  selected: ReadonlySet<string>,
  key: string,
): Set<string> {
  const next = new Set(selected);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  return next;
}

/**
 * The selection in **list order**, which is what a multi-select reports: reorder
 * the list and the answer reorders with it.
 */
export function orderedKeys(
  items: readonly OverlayListItem[],
  selected: ReadonlySet<string>,
): string[] {
  return items.filter((item) => selected.has(item.key)).map((item) => item.key);
}

/** Swap two positions. Out-of-range indices are a no-op, not a throw. */
export function swapWithin<T>(
  items: readonly T[],
  from: number,
  to: number,
): T[] {
  if (from === to) return [...items];
  if (from < 0 || to < 0 || from >= items.length || to >= items.length) {
    return [...items];
  }
  const next = [...items];
  const a = next[from];
  const b = next[to];
  if (a === undefined || b === undefined) return [...items];
  next[from] = b;
  next[to] = a;
  return next;
}
