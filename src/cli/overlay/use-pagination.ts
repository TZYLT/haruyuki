import { useCallback, useReducer, useRef } from "react";
import {
  canLoadMore,
  emptyPageState,
  nextPageCursor,
  type PageSlice,
  type PageStatus,
  pageReducer,
} from "./pagination";

/**
 * Wiring the page machine to React.
 *
 * The state itself lives in `pagination.ts`; what this hook adds is the one thing
 * that cannot be data — a generation counter, so a response that a newer load has
 * already superseded is inert. A user who searches, clears the search and reloads
 * inside the window of one fetch would otherwise watch the first fetch's rows
 * land on top of the second one's.
 *
 * Three properties are load-bearing.
 *
 * - **The options are read through a ref, not captured.** `fetchPage` is a
 *   closure over the caller's state, so it has a new identity every render; the
 *   loader is created once and reads the latest one at call time. That is the
 *   same reason `use-overlay-list` reads its table from a ref: a key handler (or
 *   here, a resolved fetch) has to see the render that is on screen without the
 *   registration being rebuilt.
 * - **A first load supersedes; a further load waits.** Two overlapping
 *   `loadMore`s would append the same page twice, so a "more" load is refused
 *   while one is in flight. A `loadFirst` is a reset by definition and always
 *   wins, taking the generation with it.
 * - **State stays in the leaf.** Nothing here touches `AppCoordinator`/`AppView`
 *   state; the list belongs to the overlay that shows it.
 */

export interface UsePagedListOptions<Item> {
  /** Identity of an item, and the default page cursor. */
  keyOf: (item: Item) => string;
  /** The cursor a page's last row presents, when that is not the item's key. */
  cursorOf?: (item: Item) => string;
  /** Rows the source returns per page. Its own page length is the "more" signal. */
  pageSize: number;
  /** Fetch one page. `after` is the previous page's cursor; null is the first. */
  fetchPage: (after: string | null) => Promise<PageSlice<Item>>;
}

export interface PagedListController<Item> {
  items: Item[];
  /**
   * The machine's state, spelled out rather than flattened into booleans.
   *
   * A face that loads on mount renders `idle` as loading too — nothing has been
   * asked for yet, and the first paint must not be the empty state — while a face
   * whose list is optional does not. That is the face's call, and keeping
   * `status` here is what keeps the hook from guessing it.
   */
  status: PageStatus;
  error: string | null;
  /** Whether the source said another page exists, the request state aside. */
  hasMore: boolean;
  /** Whether asking for it right now would start a fetch. */
  canLoadMore: boolean;
  /**
   * Load the first page, replacing what is there. Resolves to the page's own rows
   * (the prefix is not part of them), or null when a newer load superseded this
   * one or it failed.
   */
  loadFirst: () => Promise<Item[] | null>;
  /** Load the next page and append it. Resolves as `loadFirst` does. */
  loadMore: () => Promise<Item[] | null>;
  /** Update the rows in place: enrichment, removal. */
  setItems: (update: (items: Item[]) => Item[]) => void;
}

export function usePagedList<Item>(
  options: UsePagedListOptions<Item>,
): PagedListController<Item> {
  const [state, dispatch] = useReducer(
    pageReducer(options.keyOf),
    undefined,
    () => emptyPageState<Item>(),
  );

  const optionsRef = useRef(options);
  optionsRef.current = options;
  const stateRef = useRef(state);
  stateRef.current = state;
  const generationRef = useRef(0);
  const inFlightRef = useRef(false);

  const load = useCallback(
    async (mode: "first" | "more"): Promise<Item[] | null> => {
      if (mode === "more") {
        if (inFlightRef.current) return null;
        if (stateRef.current.nextCursor === null) return null;
      }
      const generation =
        mode === "first" ? generationRef.current + 1 : generationRef.current;
      generationRef.current = generation;
      inFlightRef.current = true;
      dispatch({ type: "load-started", mode });

      try {
        const { fetchPage, pageSize, cursorOf, keyOf } = optionsRef.current;
        const after = mode === "first" ? null : stateRef.current.nextCursor;
        const page = await fetchPage(after);
        if (generation !== generationRef.current) return null;
        dispatch({
          type: "page-loaded",
          page,
          cursor: nextPageCursor(page.items, pageSize, cursorOf ?? keyOf),
        });
        return [...page.items];
      } catch (error) {
        if (generation !== generationRef.current) return null;
        dispatch({
          type: "load-failed",
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      } finally {
        // Only the load that still owns the list releases it: a superseding
        // `loadFirst` is in flight and its own finally is the one that clears.
        if (generation === generationRef.current) inFlightRef.current = false;
      }
    },
    [],
  );

  const loadFirst = useCallback(() => load("first"), [load]);
  const loadMore = useCallback(() => load("more"), [load]);
  const setItems = useCallback(
    (update: (items: Item[]) => Item[]) =>
      dispatch({ type: "items-changed", update }),
    [],
  );

  return {
    items: state.items,
    status: state.status,
    error: state.error,
    hasMore: state.nextCursor !== null,
    canLoadMore: canLoadMore(state),
    loadFirst,
    loadMore,
    setItems,
  };
}
