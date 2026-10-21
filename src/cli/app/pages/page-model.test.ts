import { describe, expect, test } from "bun:test";
import {
  maxPageOffset,
  type PageRow,
  pageWindow,
  scrollPageOffset,
  selectableRows,
  stepSelectableRow,
} from "@/cli/app/pages/page-model";

/**
 * The page's window and its cursor, as pure arithmetic.
 *
 * Both rules have a consequence the frame cannot show on its own: the window
 * reserves its two marker rows *whenever the body overflows*, even at an end, so
 * scrolling never changes the page's height (the band is measured chrome, and a
 * height that moves reflows the whole frame); and the cursor skips the rows it is
 * not allowed on, stopping at the ends instead of wrapping.
 */

const rows: PageRow[] = [
  { kind: "header", text: "上下文管理" },
  { kind: "item", id: "compaction", label: "压缩" },
  { kind: "item", id: "recall", label: "召回", disabled: true },
  { kind: "header", text: "模型与推理" },
  { kind: "item", id: "model", label: "默认模型" },
  { kind: "note", text: "只读说明" },
];

describe("the page window", () => {
  test("a body that fits spends no rows on markers", () => {
    const window = pageWindow({ count: 3, height: 10, offset: 0 });
    expect(window).toEqual({
      start: 0,
      end: 3,
      above: 0,
      below: 0,
      reserved: false,
    });
  });

  test("a body that overflows reserves both markers, end or not", () => {
    // Ten rows into a body of five: the markers cost two, so three rows are drawn.
    const first = pageWindow({ count: 10, height: 5, offset: 0 });
    expect(first).toEqual({
      start: 0,
      end: 3,
      above: 0,
      below: 7,
      reserved: true,
    });

    // At the end the height is the same — the "↓" row is still reserved, blank.
    const last = pageWindow({ count: 10, height: 5, offset: 7 });
    expect(last.start).toBe(7);
    expect(last.end).toBe(10);
    expect(last.above).toBe(7);
    expect(last.below).toBe(0);
    expect(last.end - last.start).toBe(first.end - first.start);
  });

  test("the offset is clamped, so a resize cannot leave the window past the end", () => {
    // The body grew to 20 rows while the offset was 7: nothing to scroll.
    expect(pageWindow({ count: 10, height: 20, offset: 7 })).toEqual({
      start: 0,
      end: 10,
      above: 0,
      below: 0,
      reserved: false,
    });
    expect(maxPageOffset({ count: 10, height: 5 })).toBe(7);
    expect(
      scrollPageOffset({ count: 10, height: 5, offset: 0, delta: -3 }),
    ).toBe(0);
    expect(
      scrollPageOffset({ count: 10, height: 5, offset: 6, delta: 100 }),
    ).toBe(7);
  });
});

describe("the page cursor", () => {
  test("only items that can be acted on are selectable", () => {
    expect(selectableRows(rows)).toEqual([1, 4]);
  });

  test("stepping skips headers, notes and disabled rows", () => {
    // From the first item, down lands on the *next* item: row 2 is disabled and
    // row 3 is a title.
    expect(stepSelectableRow(rows, 1, 1)).toBe(4);
    // …and up from there comes back.
    expect(stepSelectableRow(rows, 4, -1)).toBe(1);
  });

  test("the cursor stops at the ends instead of wrapping", () => {
    expect(stepSelectableRow(rows, 1, -1)).toBe(1);
    expect(stepSelectableRow(rows, 4, 1)).toBe(4);
  });

  test("a page with nothing selectable keeps the cursor where it was", () => {
    const prose: PageRow[] = [{ kind: "note", text: "nothing to do here" }];
    expect(selectableRows(prose)).toEqual([]);
    expect(stepSelectableRow(prose, 0, 1)).toBe(0);
  });
});

describe("a body that composes its own lines", () => {
  test("text rows are not selectable and do not move the cursor", () => {
    const body: PageRow[] = [
      { kind: "text", text: "  ██  " },
      { kind: "item", id: "only", label: "唯一一行" },
      { kind: "text", text: "  ░░  " },
    ];
    expect(selectableRows(body)).toEqual([1]);
    expect(stepSelectableRow(body, 1, 1)).toBe(1);
  });

  test("text rows still count toward the window", () => {
    const body: PageRow[] = [
      { kind: "text", text: "one" },
      { kind: "text", text: "two" },
      { kind: "text", text: "three" },
    ];
    const window = pageWindow({ count: body.length, height: 2, offset: 0 });
    expect(window.reserved).toBe(true);
    // Both marker rows are reserved, so only one body row fits.\r\n    expect(window.end - window.start).toBe(1);
  });
});
