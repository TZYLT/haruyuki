import { describe, expect, test } from "bun:test";
import { columns, row, truncateToWidth, visibleWidth } from "./formatting";

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

  test("truncating never returns more columns than it was given", () => {
    for (const width of [2, 3, 5, 8, 12]) {
      const cut = truncateToWidth("数据库迁移与回滚策略的完整评审记录", width);
      expect({ width, fits: visibleWidth(cut) <= width }).toEqual({
        width,
        fits: true,
      });
    }
    // The ellipsis is part of the budget, not on top of it.
    expect(truncateToWidth("abcdefghij", 5)).toBe("abc…");
    expect(truncateToWidth("abcdefghij", 5)).toHaveLength(4);
    // Nothing fits in a column narrower than the ellipsis itself.
    expect(truncateToWidth("abc", 1)).toBe("");
  });

  test("a row fills exactly the columns it is given", () => {
    expect(visibleWidth(row("left", "right", 20))).toBe(20);
    expect(visibleWidth(columns(["a", "b", "c"], 20))).toBe(20);
    // With an ellipsis on the left side, the total still lands on the budget.
    expect(visibleWidth(row("数据库迁移与回滚策略", "right", 24))).toBe(24);
  });
});
