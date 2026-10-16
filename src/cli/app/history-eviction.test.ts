import { describe, expect, test } from "bun:test";
import {
  countOnlyItems,
  type EvictableBlock,
  evictBlocksBefore,
} from "./history-eviction";

/** Page entries with a field the eviction has to carry across untouched. */
interface Page extends EvictableBlock {
  key: string;
  page: readonly string[];
  rows: number | null;
}

function page(
  key: string,
  itemCount: number,
  items: readonly unknown[] | null,
  rows: number | null = 100,
): Page {
  return { key, page: [`message of ${key}`], itemCount, items, rows };
}

const THREE: Page[] = [
  page("p0", 10, new Array(10).fill("i")),
  page("p1", 10, new Array(10).fill("i")),
  page("p2", 10, new Array(10).fill("i")),
];

describe("evicting the items of a page", () => {
  test("drops the oldest pages and reports the items to drop with them", () => {
    const { blocks, droppedItems } = evictBlocksBefore(THREE, 2);
    expect(droppedItems).toBe(20);
    expect(blocks.map((block) => block.items === null)).toEqual([
      true,
      true,
      false,
    ]);
    // The count, the messages and the measured height all survive: only the items go.
    expect(blocks.map((block) => block.itemCount)).toEqual([10, 10, 10]);
    expect(blocks[0]?.page).toEqual(["message of p0"]);
    expect(blocks[0]?.key).toBe("p0");
  });

  test("a second eviction of the same pages changes nothing", () => {
    const first = evictBlocksBefore(THREE, 2);
    const second = evictBlocksBefore(first.blocks, 2);
    // Same array, and nothing to drop: the caller publishes on identity, so this
    // must not look like a change.
    expect(second.blocks).toBe(first.blocks);
    expect(second.droppedItems).toBe(0);
  });

  test("counts what the count-only prefix accounts for", () => {
    expect(countOnlyItems(THREE)).toBe(0);
    const { blocks } = evictBlocksBefore(THREE, 2);
    // Two evicted pages of ten: a rendered index sits twenty below its walk index.
    expect(countOnlyItems(blocks)).toBe(20);
    expect(countOnlyItems([])).toBe(0);
  });

  test("never evicts a page whose height nobody measured", () => {
    const mixed = [
      page("p0", 10, new Array(10).fill("i"), 100),
      page("p1", 10, new Array(10).fill("i"), null),
      page("p2", 10, new Array(10).fill("i"), 300),
    ];
    // The clamp stops at the first page with no height: the walk can only skip a page
    // it has measured, so an unmeasured one has to stay materialized.
    const { blocks, droppedItems } = evictBlocksBefore(mixed, 3);
    expect(droppedItems).toBe(10);
    expect(blocks.map((block) => block.items === null)).toEqual([
      true,
      false,
      false,
    ]);

    // Nothing measured above it, so there is nothing to evict at all.
    const nothing = evictBlocksBefore(
      [page("p0", 10, new Array(10).fill("i"), null)],
      1,
    );
    expect(nothing.droppedItems).toBe(0);
    expect(nothing.blocks[0]?.items).not.toBeNull();
  });

  test("evicting nothing is not a change", () => {
    const none = evictBlocksBefore(THREE, 0);
    expect(none.blocks).toBe(THREE);
    expect(none.droppedItems).toBe(0);
    // The index is the first page to *keep*, so one past the end evicts every page.
    const all = evictBlocksBefore(THREE, 99);
    expect(all.droppedItems).toBe(30);
    expect(all.blocks.every((block) => block.items === null)).toBe(true);
  });
});
