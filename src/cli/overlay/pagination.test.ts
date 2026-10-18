import { describe, expect, test } from "bun:test";
import {
  appendNewItems,
  canLoadMore,
  emptyPageState,
  nextPageCursor,
  type PageState,
  pageReducer,
} from "./pagination";

interface Row {
  id: string;
  label: string;
}

const keyOf = (row: Row) => row.id;
const reduce = pageReducer<Row>(keyOf);

function row(id: string): Row {
  return { id, label: `Row ${id}` };
}

function rows(...ids: string[]): Row[] {
  return ids.map(row);
}

function loaded(items: Row[], nextCursor: string | null): PageState<Row> {
  return { items, status: "ready", nextCursor, error: null };
}

describe("appendNewItems", () => {
  test("appends the rows the list does not have and drops the repeats", () => {
    const merged = appendNewItems(
      rows("a", "b"),
      rows("b", "c", "a", "d"),
      keyOf,
    );

    // Order-preserving: a repeat is dropped where it would have appeared, so the
    // list still reads the way the source ordered it.
    expect(merged.map(keyOf)).toEqual(["a", "b", "c", "d"]);
  });

  test("does not mutate what it was given", () => {
    const existing = rows("a");
    const incoming = rows("b");

    const merged = appendNewItems(existing, incoming, keyOf);

    expect(existing).toHaveLength(1);
    expect(incoming).toHaveLength(1);
    expect(merged).toHaveLength(2);
  });

  test("a repeated page adds nothing", () => {
    const first = rows("a", "b");

    const again = appendNewItems(first, rows("a", "b"), keyOf);

    expect(again.map(keyOf)).toEqual(["a", "b"]);
  });
});

describe("nextPageCursor", () => {
  test("a full page hands the next fetch its last row", () => {
    expect(nextPageCursor(rows("a", "b", "c"), 3, keyOf)).toBe("c");
  });

  test("a short page ends the list, and an empty one too", () => {
    expect(nextPageCursor(rows("a", "b"), 3, keyOf)).toBeNull();
    expect(nextPageCursor([], 3, keyOf)).toBeNull();
    // A page that returns *more* than asked is still a full one.
    expect(nextPageCursor(rows("a", "b", "c"), 2, keyOf)).toBe("c");
  });

  test("a page size of zero cannot promise a next page", () => {
    expect(nextPageCursor(rows("a", "b"), 0, keyOf)).toBeNull();
  });

  test("the cursor can be a different field from the identity", () => {
    const page = [{ id: "row-1", label: "Row 1" }];

    expect(nextPageCursor(page, 1, (item) => item.id.toUpperCase())).toBe(
      "ROW-1",
    );
  });
});

describe("canLoadMore", () => {
  test("nothing loaded yet is not something to load more of", () => {
    expect(canLoadMore(emptyPageState<Row>())).toBe(false);
  });

  test("a full page can be followed, and a short one cannot", () => {
    expect(canLoadMore(loaded(rows("a", "b"), "b"))).toBe(true);
    expect(canLoadMore(loaded(rows("a"), null))).toBe(false);
  });

  test("a request in flight is not asked for again", () => {
    const state = reduce(loaded(rows("a", "b"), "b"), {
      type: "load-started",
      mode: "more",
    });

    expect(canLoadMore(state)).toBe(false);
  });

  test("a failed page can be retried, because the cursor is still there", () => {
    const state = reduce(loaded(rows("a", "b"), "b"), {
      type: "load-failed",
      error: "timed out",
    });

    expect(state.status).toBe("error");
    expect(state.error).toBe("timed out");
    expect(canLoadMore(state)).toBe(true);
  });
});

describe("pageReducer", () => {
  test("the first page replaces, and its prefix comes before its own rows", () => {
    const state = reduce(
      reduce(emptyPageState<Row>(), { type: "load-started", mode: "first" }),
      {
        type: "page-loaded",
        page: { items: rows("b", "c"), prefix: rows("default") },
        cursor: "c",
      },
    );

    expect(state.items.map(keyOf)).toEqual(["default", "b", "c"]);
    expect(state.status).toBe("ready");
    expect(state.nextCursor).toBe("c");
  });

  test("a later page appends rather than replacing", () => {
    const first = reduce(loaded(rows("a", "b"), "b"), {
      type: "load-started",
      mode: "more",
    });

    const state = reduce(first, {
      type: "page-loaded",
      page: { items: rows("c", "d") },
      cursor: null,
    });

    expect(state.items.map(keyOf)).toEqual(["a", "b", "c", "d"]);
    expect(state.nextCursor).toBeNull();
  });

  test("a page that repeats an existing row merges instead of duplicating", () => {
    // The source paged while rows were being written: page two starts one row
    // before page one ended.
    const state = reduce(loaded(rows("a", "b"), "b"), {
      type: "page-loaded",
      page: { items: rows("b", "c") },
      cursor: null,
    });

    expect(state.items.map(keyOf)).toEqual(["a", "b", "c"]);
  });

  test("an update applies to the rows as they are, not as the caller saw them", () => {
    // Two enrichments landing in one tick: the second must see the first's work.
    const first = reduce(loaded(rows("a", "b"), null), {
      type: "items-changed",
      update: (items) =>
        items.map((item) =>
          item.id === "a" ? { ...item, label: "enriched a" } : item,
        ),
    });
    const second = reduce(first, {
      type: "items-changed",
      update: (items) => items.filter((item) => item.id !== "a"),
    });

    expect(first.items[0]?.label).toBe("enriched a");
    expect(second.items.map(keyOf)).toEqual(["b"]);
  });

  test("a failure sets the error and keeps the rows that were there", () => {
    const state = reduce(loaded(rows("a", "b"), "b"), {
      type: "load-failed",
      error: "network",
    });

    expect(state.items.map(keyOf)).toEqual(["a", "b"]);
    expect(state.error).toBe("network");
  });

  test("a new first load clears the error it is replacing", () => {
    const failed = reduce(loaded(rows("a"), null), {
      type: "load-failed",
      error: "network",
    });

    const state = reduce(failed, { type: "load-started", mode: "first" });

    expect(state.error).toBeNull();
    expect(state.status).toBe("loading");
  });

  test("reset returns the machine to where it started", () => {
    const state = reduce(loaded(rows("a", "b"), "b"), { type: "reset" });

    expect(state).toEqual(emptyPageState<Row>());
  });
});
