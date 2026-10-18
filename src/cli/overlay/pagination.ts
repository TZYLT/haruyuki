/**
 * Incremental page fetching, as data.
 *
 * The overlay toolkit's lists are complete before they are rendered; a list that
 * arrives in pages — `/resume` fetches 20 conversations and asks for more when
 * the cursor nears the end — needs three things the toolkit did not state: what
 * "there is another page" is read from, what happens to a page that repeats rows
 * the list already has, and what a load that is superseded by a newer one must do
 * (nothing, because the newer one owns the list now).
 *
 * This module is the pure half: the state, the transitions, and the two
 * derivations. `use-pagination.ts` wires it to React and holds the one piece of
 * state that is not data — the generation counter that makes a stale response
 * inert. Keeping them apart is what lets the machine be tested without a
 * component, the way `list-model.ts` is.
 *
 * Two rules, both load-bearing:
 *
 * - **Identity is the item's `key`, never its index, and it is also the cursor.**
 *   A page that overlaps the previous one (the source paged while rows were being
 *   written) is merged, not duplicated — the same rule `list-model.ts` holds for
 *   a selection.
 * - **A short page ends the list; a full one does not promise more than it said.**
 *   `nextPageCursor` reads "more" from the page's own length, so a source that
 *   returns fewer rows than asked (or none) ends the sequence instead of leaving
 *   the list looping on an empty cursor.
 */

export type PageStatus =
  /** Nothing loaded yet, and nothing in flight. */
  | "idle"
  /** The first page is in flight. */
  | "loading"
  /** A later page is in flight. */
  | "loading-more"
  /** At least one page landed. `nextCursor` says whether another exists. */
  | "ready"
  /** The last attempt failed. `error` says why; the items that were there stay. */
  | "error";

export interface PageState<Item> {
  items: Item[];
  status: PageStatus;
  /** The cursor the next page starts after; null when there is no next page. */
  nextCursor: string | null;
  error: string | null;
}

/** One page as the source returned it. */
export interface PageSlice<Item> {
  items: readonly Item[];
  /**
   * Rows that belong *before* this page's own rows, and are not part of it.
   *
   * `/resume` has exactly one: the agent's `default` conversation is fetched
   * beside the first page and shown at its head, but it is not a page row and
   * must not become the cursor for page two.
   */
  prefix?: readonly Item[];
}

export function emptyPageState<Item>(
  initialItems: readonly Item[] = [],
): PageState<Item> {
  return {
    items: [...initialItems],
    status: "idle",
    nextCursor: null,
    error: null,
  };
}

/**
 * `existing` followed by the incoming rows whose key is not already there.
 *
 * Order-preserving and non-mutating: the page arrives newest-first and a repeat
 * is dropped where it would have appeared, so the list reads the way the source
 * ordered it.
 */
export function appendNewItems<Item>(
  existing: readonly Item[],
  incoming: readonly Item[],
  keyOf: (item: Item) => string,
): Item[] {
  const seen = new Set(existing.map(keyOf));
  const next = [...existing];
  for (const item of incoming) {
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(item);
  }
  return next;
}

/**
 * The cursor a page's last row presents to the next fetch, or null when the page
 * was not full — the page's own length is what says "there is more".
 */
export function nextPageCursor<Item>(
  items: readonly Item[],
  pageSize: number,
  cursorOf: (item: Item) => string,
): string | null {
  const size = Math.max(0, Math.trunc(pageSize));
  if (size === 0 || items.length < size) return null;
  const last = items[items.length - 1];
  if (last === undefined) return null;
  return cursorOf(last);
}

export function canLoadMore<Item>(state: PageState<Item>): boolean {
  return (
    state.nextCursor !== null &&
    state.status !== "loading" &&
    state.status !== "loading-more"
  );
}

export type PageAction<Item> =
  | { type: "load-started"; mode: "first" | "more" }
  | { type: "page-loaded"; page: PageSlice<Item>; cursor: string | null }
  | { type: "load-failed"; error: string }
  /**
   * Update the items in place. Carried as an updater rather than as the new
   * array, because two updates can land in one tick — every visible
   * conversation is enriched in parallel — and a computed array would make the
   * second one erase the first.
   */
  | { type: "items-changed"; update: (items: Item[]) => Item[] }
  | { type: "reset" };

/**
 * The transitions, parameterised by how an item is identified.
 *
 * Curried so the identity rule travels with the state machine instead of being
 * re-stated (or forgotten) at each dispatch site.
 */
export function pageReducer<Item>(keyOf: (item: Item) => string) {
  return function reduce(
    state: PageState<Item>,
    action: PageAction<Item>,
  ): PageState<Item> {
    switch (action.type) {
      case "load-started":
        return {
          ...state,
          status: action.mode === "first" ? "loading" : "loading-more",
          error: null,
        };
      case "page-loaded": {
        const incoming = [...(action.page.prefix ?? []), ...action.page.items];
        const items =
          state.status === "loading"
            ? appendNewItems([], incoming, keyOf)
            : appendNewItems(state.items, incoming, keyOf);
        return {
          ...state,
          items,
          status: "ready",
          nextCursor: action.cursor,
          error: null,
        };
      }
      case "load-failed":
        return { ...state, status: "error", error: action.error };
      case "items-changed":
        return { ...state, items: action.update(state.items) };
      case "reset":
        return emptyPageState<Item>();
    }
  };
}
