import { describe, expect, test } from "bun:test";
import {
  maxPageOffset,
  type PageRow,
  pageWindow,
  rowHeight,
  rowLineOffsets,
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
    // Both marker rows are reserved, so only one body row fits.
    expect(window.end - window.start).toBe(1);
  });
});

describe("a multi-line item", () => {
  const item = (id: string, lines?: readonly string[]): PageRow => ({
    kind: "item",
    id,
    label: id,
    lines,
  });

  test("is one line taller than its continuation lines", () => {
    expect(rowHeight(item("one"))).toBe(1);
    expect(rowHeight(item("empty", []))).toBe(1);
    expect(rowHeight(item("two", ["  description"]))).toBe(2);
    expect(rowHeight(item("three", ["  user", "  agent"]))).toBe(3);
    // Every other row kind is still one line: the old pages are untouched.
    expect(rowHeight({ kind: "header", text: "Agents" })).toBe(1);
    expect(rowHeight({ kind: "note", text: "empty" })).toBe(1);
    expect(rowHeight({ kind: "text", text: "  ██  " })).toBe(1);
  });

  test("rowLineOffsets maps every row to its first line, and gives the total", () => {
    const body: PageRow[] = [
      { kind: "header", text: "Agents" },
      item("alpha", ["  Alpha description", "  writes release notes"]),
      item("beta", ["  Beta description"]),
      { kind: "note", text: "no more agents" },
    ];
    // alpha draws lines 1–3, beta 4–5, the note 6; 7 is one past the body.
    expect(rowLineOffsets(body)).toEqual([0, 1, 4, 6, 7]);
    const offsets = rowLineOffsets(body);
    // The inverse is the same walk: a terminal line belongs to exactly one row.
    const rowAtLine = (line: number): number =>
      body.findIndex(
        (_, index) =>
          line >= (offsets[index] ?? 0) && line < (offsets[index + 1] ?? 0),
      );
    expect(rowAtLine(0)).toBe(0);
    expect(rowAtLine(1)).toBe(1);
    expect(rowAtLine(3)).toBe(1);
    expect(rowAtLine(4)).toBe(2);
    expect(rowAtLine(6)).toBe(3);
    expect(rowAtLine(7)).toBe(-1);
  });
});

describe("the window over multi-line items", () => {
  const twoLineItems = (count: number): PageRow[] =>
    Array.from({ length: count }, (_, index) => ({
      kind: "item" as const,
      id: `item-${index}`,
      label: `item ${index}`,
      lines: [`  description ${index}`],
    }));

  test("capacity is counted in terminal lines, not in rows", () => {
    const body = twoLineItems(5);
    const heights = body.map(rowHeight);
    // Ten lines into an eight-line body: the two marker rows leave six, so
    // three two-line items fit and the last two are hidden.
    expect(pageWindow({ count: 5, height: 8, offset: 0, heights })).toEqual({
      start: 0,
      end: 3,
      above: 0,
      below: 2,
      reserved: true,
    });
  });

  test("the last window starts on a row that still fits", () => {
    const body = twoLineItems(5);
    const heights = body.map(rowHeight);
    expect(maxPageOffset({ count: 5, height: 8, heights })).toBe(2);
    const window = pageWindow({ count: 5, height: 8, offset: 99, heights });
    expect(window.start).toBe(2);
    expect(window.end).toBe(5);
    expect(window.below).toBe(0);
    // Scrolling is clamped to the same row, so PgDn cannot over-scroll and
    // leave the page showing an empty window.
    expect(
      scrollPageOffset({ count: 5, height: 8, offset: 0, delta: 99, heights }),
    ).toBe(2);
    expect(
      scrollPageOffset({ count: 5, height: 8, offset: 2, delta: -99, heights }),
    ).toBe(0);
  });

  test("a row taller than the window is still reachable on its own", () => {
    const body: PageRow[] = [
      { kind: "item", id: "small", label: "small" },
      {
        kind: "item",
        id: "tall",
        label: "tall",
        lines: ["1", "2", "3", "4", "5"],
      },
      { kind: "item", id: "another", label: "another" },
    ];
    // One, six and one lines into a six-line body.
    const heights = body.map(rowHeight);
    expect(heights).toEqual([1, 6, 1]);
    expect(pageWindow({ count: 3, height: 6, offset: 1, heights })).toEqual({
      start: 1,
      end: 2,
      above: 1,
      below: 1,
      reserved: true,
    });
  });

  test("heights that are not positive count as one line", () => {
    expect(
      pageWindow({ count: 3, height: 3, offset: 0, heights: [0, -4, 2] }),
    ).toEqual(
      pageWindow({ count: 3, height: 3, offset: 0, heights: [1, 1, 2] }),
    );
  });
});

describe("the pre-T-10 identity", () => {
  /** The window arithmetic before `heights` existed, kept as the reference. */
  function legacyWindow(count: number, height: number, offset: number) {
    const reserved = count > height;
    const rows = reserved ? Math.max(1, height - 2) : height;
    const maxOffset = Math.max(0, count - rows);
    const start = Math.min(Math.max(0, offset), maxOffset);
    const end = Math.min(count, start + rows);
    return { start, end, above: start, below: count - end, reserved };
  }

  test("omitted or all-one heights give the old window, bit for bit", () => {
    for (let count = 0; count <= 20; count += 1) {
      const ones = Array.from({ length: count }, () => 1);
      for (let height = 0; height <= 12; height += 1) {
        const legacyMax = Math.max(
          0,
          count - (count > height ? Math.max(1, height - 2) : height),
        );
        for (let offset = -2; offset <= count + 2; offset += 1) {
          const legacy = legacyWindow(count, height, offset);
          expect(pageWindow({ count, height, offset })).toEqual(legacy);
          expect(pageWindow({ count, height, offset, heights: ones })).toEqual(
            legacy,
          );
          expect(maxPageOffset({ count, height })).toBe(legacyMax);
          expect(maxPageOffset({ count, height, heights: ones })).toBe(
            legacyMax,
          );
          expect(scrollPageOffset({ count, height, offset, delta: 3 })).toBe(
            Math.min(Math.max(0, offset + 3), legacyMax),
          );
          expect(
            scrollPageOffset({
              count,
              height,
              offset,
              delta: 3,
              heights: ones,
            }),
          ).toBe(Math.min(Math.max(0, offset + 3), legacyMax));
        }
      }
    }
  });
});
