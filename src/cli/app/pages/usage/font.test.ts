import { describe, expect, test } from "bun:test";
import {
  BLOCK_FONT_HEIGHT,
  blockGlyph,
  blockGlyphWidth,
  blockText,
  blockTextWidth,
  blockWordmark,
} from "./font";

describe("block font", () => {
  test("every glyph is five rows of one width", () => {
    for (const character of "0123456789AHIKMRUYk.?") {
      const glyph = blockGlyph(character);
      expect(glyph).toHaveLength(BLOCK_FONT_HEIGHT);
      const width = blockGlyphWidth(character);
      expect(width).toBeGreaterThan(0);
      for (const row of glyph) {
        expect(row.length).toBe(width);
      }
    }
  });

  test("digits match the table in docs/38 §14.6", () => {
    expect(blockGlyph("0")).toEqual(["███", "█ █", "█ █", "█ █", "███"]);
    expect(blockGlyph("1")).toEqual([" █ ", "██ ", " █ ", " █ ", "███"]);
    expect(blockGlyph("5")).toEqual(["███", "█  ", "███", "  █", "███"]);
    expect(blockGlyph("7")).toEqual(["███", "  █", "  █", "  █", "  █"]);
    expect(blockGlyph("9")).toEqual(["███", "█ █", "███", "  █", "███"]);
  });

  test("M is five wide because three columns cannot tell it from A", () => {
    expect(blockGlyphWidth("M")).toBe(5);
    expect(blockGlyphWidth("A")).toBe(3);
  });

  test("the dot is one column", () => {
    expect(blockGlyph(".")).toEqual([" ", " ", " ", " ", "█"]);
    expect(blockGlyphWidth(".")).toBe(1);
  });

  test("the hero number is 23 columns, as the spec sizes it", () => {
    expect(blockTextWidth("339.4M")).toBe(23);
    expect(blockText("339.4M")[0]).toHaveLength(23);
    expect(blockText("339.4M")).toHaveLength(BLOCK_FONT_HEIGHT);
  });

  test("the wordmark is 31 columns", () => {
    const wordmark = blockWordmark();
    expect(wordmark).toHaveLength(BLOCK_FONT_HEIGHT);
    for (const row of wordmark) {
      expect(row).toHaveLength(31);
    }
    expect(wordmark.join("\n")).toContain("█ █ █ █");
  });

  test("unknown characters keep the layout predictable", () => {
    expect(blockTextWidth("1x")).toBe(7);
    expect(blockText("x")[0]).toHaveLength(3);
  });

  test("an empty string still returns five rows", () => {
    expect(blockText("")).toEqual(["", "", "", "", ""]);
    expect(blockTextWidth("")).toBe(0);
  });

  test("the gap is configurable and counted in the width", () => {
    expect(blockText("11", 2)[0]).toBe(" █    █ ");
    expect(blockTextWidth("11", 2)).toBe(8);
  });
});
