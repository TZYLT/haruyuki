import { describe, expect, test } from "bun:test";
import {
  columns,
  ROW_SAFETY_COLUMNS,
  row,
  truncateToWidth,
  visibleWidth,
} from "./formatting";

/**
 * Column arithmetic, as the one thing every exact-width row depends on.
 *
 * A row is laid out to a number of columns and then written to a terminal that
 * has them. If the arithmetic says "one column" for a glyph the terminal draws in
 * two, the row is wider than the screen, the terminal wraps it, and a frame taller
 * than the alternate screen scrolls — the failure that cost the tab row on the
 * machine twice (2026-10-20). `…` is exactly that glyph there, so the ellipsis is
 * counted wide here and the width the arithmetic returns is the width a terminal
 * will give the text.
 *
 * The second lesson of the same day is that the arithmetic cannot be trusted to the
 * last column for *any* glyph: `⚡︎` and `·` were drawn wider than `string-width`
 * said, and Ink does not clip an over-wide row (a `width` + `overflow="hidden"`
 * box wraps it, verified on Ink 7.1). So a row that assembles segments ends
 * `ROW_SAFETY_COLUMNS` short of the edge, and that margin is what these tests pin.
 * A single segment is still allowed to use its whole budget — the margin is spent
 * once per row, not once per title.
 */
describe("visible width", () => {
  test("the truncation ellipsis is two columns", () => {
    expect(visibleWidth("…")).toBe(2);
    expect(visibleWidth("a…b")).toBe(4);
    // CJK is wide on every terminal this app targets.
    expect(visibleWidth("数据库")).toBe(6);
    // ANSI is not width.
    expect(visibleWidth("\u001B[31mab\u001B[0m")).toBe(2);
  });

  test("truncating spends the segment budget exactly", () => {
    for (const width of [2, 3, 5, 8, 12, 40]) {
      const cut = truncateToWidth("数据库迁移与回滚策略的完整评审记录", width);
      expect({ width, fits: visibleWidth(cut) <= width }).toEqual({
        width,
        fits: true,
      });
    }
    // The ellipsis is part of the budget, not on top of it.
    expect(truncateToWidth("abcdefghij", 5)).toBe("abc…");
    expect(visibleWidth(truncateToWidth("abcdefghij", 5))).toBe(5);
    // Nothing fits in a column narrower than the ellipsis itself.
    expect(truncateToWidth("abcdefghij", 1)).toBe("");
    expect(truncateToWidth("abcdefghij", 2)).toBe("…");
  });

  test("a row ends short of the columns it is given, never past them", () => {
    for (const width of [8, 20, 40, 108]) {
      expect(visibleWidth(row("left", "right", width))).toBe(
        width - ROW_SAFETY_COLUMNS,
      );
      expect(visibleWidth(columns(["a", "b", "c"], width))).toBeLessThanOrEqual(
        width - ROW_SAFETY_COLUMNS,
      );
      // With an ellipsis on the left side, the margin is still kept.
      expect(
        visibleWidth(row("数据库迁移与回滚策略的完整评审", "right", width)),
      ).toBeLessThanOrEqual(width - ROW_SAFETY_COLUMNS);
    }
  });
});
