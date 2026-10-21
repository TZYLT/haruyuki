import { afterEach, describe, expect, test } from "bun:test";
import {
  ROW_SAFETY_COLUMNS,
  truncateToWidth,
  visibleWidth,
} from "@/cli/display/statusline/formatting";
import {
  getAmbiguousWidth,
  getAmbiguousWidthMode,
  getAmbiguousWidthSource,
  isAmbiguousCharacter,
  resetAmbiguousWidthForTests,
  setAmbiguousWidth,
  setAmbiguousWidthMode,
  terminalCharWidth,
  terminalTextWidth,
} from "@/cli/helpers/char-width";

/**
 * The width table the whole tree lays rows out with.
 *
 * The one judgement in it: Unicode's **ambiguous** class (`— … ≥ → ·`) has no
 * width of its own, and this machine proved both answers exist in the wild on the
 * same day — Consolas draws them one column, 等宽楷体 two (2026-10-21). So the
 * number is a runtime value, and every test here is written to pass under both.
 */
afterEach(() => {
  resetAmbiguousWidthForTests();
});

const AMBIGUOUS = ["—", "…", "≥", "→", "·", "“", "”", "±", "×", "÷", "°", "①"];

describe("the ambiguous class", () => {
  test("every character in the class is one column when unresolved", () => {
    expect(getAmbiguousWidth()).toBe(1);
    expect(getAmbiguousWidthSource()).toBe("default");
    for (const character of AMBIGUOUS) {
      expect(isAmbiguousCharacter(character)).toBe(true);
      expect(terminalCharWidth(character)).toBe(1);
    }
  });

  test("the class is exactly what the resolved number says", () => {
    setAmbiguousWidth(2);
    expect(getAmbiguousWidthSource()).toBe("probe");
    for (const character of AMBIGUOUS) {
      expect(terminalCharWidth(character)).toBe(2);
    }
    // ASCII, CJK and an emoji are *not* the terminal's decision: the same width
    // in both modes, so a wrong number can never move them.
    for (const character of ["A", "z", "1", " ", "压", "缩", "😀"]) {
      setAmbiguousWidth(1);
      const narrow = terminalCharWidth(character);
      setAmbiguousWidth(2);
      const wide = terminalCharWidth(character);
      expect(narrow).toBe(wide);
    }
    expect(terminalCharWidth("压")).toBe(2);
    expect(terminalCharWidth("A")).toBe(1);
  });

  test("a mode fixes the number without a probe, and auto keeps it", () => {
    setAmbiguousWidthMode("wide");
    expect(getAmbiguousWidth()).toBe(2);
    expect(getAmbiguousWidthSource()).toBe("mode");
    expect(getAmbiguousWidthMode()).toBe("wide");
    // `auto` asks for the probe but must not throw away a number it already has:
    // a terminal that was resolved stays resolved while the new probe runs.
    setAmbiguousWidthMode("auto");
    expect(getAmbiguousWidthMode()).toBe("auto");
    expect(getAmbiguousWidth()).toBe(2);
    expect(getAmbiguousWidthSource()).toBe("mode");
    setAmbiguousWidthMode("narrow");
    expect(getAmbiguousWidth()).toBe(1);
  });
});

describe("measuring a string", () => {
  test("sums the class, and the rest of the table, per mode", () => {
    const text = "ctx 66% · 84k / 128k";
    setAmbiguousWidth(1);
    expect(terminalTextWidth(text)).toBe(text.length);
    setAmbiguousWidth(2);
    // One `·` in the line, so exactly one column more.
    expect(terminalTextWidth(text)).toBe(text.length + 1);
  });

  test("strips ANSI before measuring, colours and links alike", () => {
    const painted = "\u001B[31mred\u001B[0m";
    const linked =
      "\u001B]8;;https://example.com\u001B\\link\u001B]8;;\u001B\\";
    expect(terminalTextWidth(painted)).toBe(3);
    expect(terminalTextWidth(linked)).toBe(4);
    expect(visibleWidth(painted)).toBe(3);
  });

  test("a grapheme cluster is one glyph however many code points it has", () => {
    // ZWJ family, and `e` plus a combining acute: the per-code-point table would
    // answer 10 and 2; the terminal draws 2 and 1.
    expect(terminalTextWidth("👨\u200D👩\u200D👧")).toBe(2);
    expect(terminalTextWidth("e\u0301")).toBe(1);
    // A bare emoji needs no clustering: it is Wide in the table itself.
    expect(terminalTextWidth("😀")).toBe(2);
  });
});

describe("rows built on the table", () => {
  test("truncation counts the class, whichever way the terminal draws it", () => {
    setAmbiguousWidth(1);
    expect(truncateToWidth("abcdef", 4)).toBe("abc…");
    setAmbiguousWidth(2);
    // `…` is two columns here, so the budget for text is `width - 2`.
    expect(truncateToWidth("abcdef", 4)).toBe("ab…");
    // A one-column-width budget cannot hold the ellipsis at all.
    expect(truncateToWidth("abcdef", 1)).toBe("");
    setAmbiguousWidth(1);
    expect(truncateToWidth("abcdef", 1)).toBe("…");
  });

  test("a truncated line plus the margin still fits the terminal", () => {
    // What the rail, the strip and the status line all rely on: a row laid out to
    // `width - ROW_SAFETY_COLUMNS` and truncated there never exceeds `width`.
    setAmbiguousWidth(2);
    const width = 30;
    const line = truncateToWidth(
      "today — (ledger pending) — cache read · uncached",
      width - ROW_SAFETY_COLUMNS,
    );
    expect(visibleWidth(line)).toBeLessThanOrEqual(width - ROW_SAFETY_COLUMNS);
  });
});
