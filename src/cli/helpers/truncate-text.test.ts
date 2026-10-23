import { afterEach, describe, expect, test } from "bun:test";
import {
  resetAmbiguousWidthForTests,
  setAmbiguousWidth,
  terminalTextWidth,
} from "@/cli/helpers/char-width";
import { truncateText } from "@/cli/helpers/truncate-text";

afterEach(() => {
  resetAmbiguousWidthForTests();
});

/** A CJK console face draws `—` in two columns; a Western one, one. */
function withAmbiguousWidth(width: 1 | 2): void {
  setAmbiguousWidth(width);
}

describe("truncateText", () => {
  test("text that fits is returned unchanged", () => {
    expect(truncateText("hello", 5)).toBe("hello");
    expect(truncateText("hello", 9)).toBe("hello");
    expect(truncateText("中文", 4)).toBe("中文");
  });

  test("zero or negative width is empty", () => {
    expect(truncateText("hello", 0)).toBe("");
    expect(truncateText("hello", -3)).toBe("");
  });

  test("a budget too small for the ellipsis is dots", () => {
    expect(truncateText("hello", 3)).toBe("...");
    expect(truncateText("hello", 1)).toBe(".");
  });

  test("truncation appends exactly three dots", () => {
    expect(truncateText("abcdefgh", 6)).toBe("abc...");
    expect(truncateText("abcdefgh", 4)).toBe("a...");
  });

  test("the result never exceeds the requested columns", () => {
    const text = "settings · appearance — theme · language";
    for (const maxWidth of [1, 2, 3, 4, 5, 8, 13, 21, 34]) {
      withAmbiguousWidth(2);
      expect(
        terminalTextWidth(truncateText(text, maxWidth)),
      ).toBeLessThanOrEqual(maxWidth);
      withAmbiguousWidth(1);
      expect(
        terminalTextWidth(truncateText(text, maxWidth)),
      ).toBeLessThanOrEqual(maxWidth);
    }
  });

  test("ambiguous characters are counted as the terminal draws them", () => {
    // "theme — dark": 12 columns narrow, 13 wide. The same budget therefore cuts in
    // a different place, and both answers fit.
    const text = "theme \u2014 dark";
    withAmbiguousWidth(1);
    expect(truncateText(text, 12)).toBe(text);
    withAmbiguousWidth(2);
    const wide = truncateText(text, 12);
    expect(wide).not.toBe(text);
    expect(terminalTextWidth(wide)).toBeLessThanOrEqual(12);
    expect(wide.endsWith("...")).toBe(true);
  });

  test("wide CJK glyphs still take two columns each", () => {
    withAmbiguousWidth(1);
    const result = truncateText("中文测试", 6);
    expect(result.endsWith("...")).toBe(true);
    expect(terminalTextWidth(result)).toBeLessThanOrEqual(6);
  });
});

/**
 * The row shape `app/pages/page-frame.tsx` composes: two leading cells, a fixed
 * label column, a fixed scope column, then the value clipped to what is left. The
 * value is where a `—`/`·` used to drift the row one column past the frame.
 */
describe("a page row built with truncateText", () => {
  const WIDTH = 80;
  const LABEL_COLUMN = 26;
  const SCOPE_COLUMN = 11;

  function pageRow(value: string): string {
    const label = truncateText("Appearance", LABEL_COLUMN - 1).padEnd(
      LABEL_COLUMN,
    );
    const hint = truncateText("type a path", SCOPE_COLUMN).padEnd(SCOPE_COLUMN);
    const available = Math.max(0, WIDTH - 2 - LABEL_COLUMN - SCOPE_COLUMN);
    return `  ${label}${hint}${truncateText(value, available)}`;
  }

  const value =
    "dark \u2014 light \u00b7 auto \u2014 theme \u00b7 font \u2014 wide \u00b7 layout \u2014 compact \u00b7 border";

  test("stays inside the frame when ambiguous characters are two columns", () => {
    withAmbiguousWidth(2);
    expect(terminalTextWidth(pageRow(value))).toBeLessThanOrEqual(WIDTH);
  });

  test("stays inside the frame when they are one column", () => {
    withAmbiguousWidth(1);
    expect(terminalTextWidth(pageRow(value))).toBeLessThanOrEqual(WIDTH);
  });
});
