import { describe, expect, test } from "bun:test";
import { terminalTextWidth } from "@/cli/helpers/char-width";
import { inkStringWidth } from "@/cli/helpers/text-metrics";
import {
  wrappedCellWidth,
  wrapRows,
  wrapRowsWithPrefix,
} from "@/cli/helpers/wrap-rows";

/**
 * The wrapper both fixed-height surfaces lean on (F-06 R-5.7.4 / C-32).
 *
 * Every assertion is about the two properties the frame depends on: no row is
 * wider than the budget under *either* width system, and a wrap never splits a
 * grapheme (an emoji sequence or a CJK cluster is never cut in half).
 */

function maxWidth(rows: readonly string[]): number {
  return Math.max(
    0,
    ...rows.map((row) => Math.max(terminalTextWidth(row), inkStringWidth(row))),
  );
}

describe("wrappedCellWidth", () => {
  test("is the larger of the terminal and Ink answers", () => {
    expect(wrappedCellWidth("abc")).toBe(3);
    expect(wrappedCellWidth("梦游")).toBe(4);
    // The ambiguous em dash is one column for Ink and (depending on the
    // terminal) two for the terminal's own table; the wrapper takes the larger.
    expect(wrappedCellWidth("—")).toBeGreaterThanOrEqual(1);
    expect(wrappedCellWidth("")).toBe(0);
  });
});

describe("wrapRows", () => {
  test("keeps every row inside the budget", () => {
    const text =
      "A long line about the dream run that kept going and would not stop until the terminal was narrow";
    for (const width of [8, 20, 40, 80]) {
      const rows = wrapRows(text, width);
      expect(maxWidth(rows)).toBeLessThanOrEqual(width);
      expect(rows.join(" ").replace(/\s+/g, " ").trim()).toBe(text);
    }
  });

  test("never breaks a word that fits on its own row", () => {
    const rows = wrapRows("alpha beta gamma", 10);
    expect(rows).toEqual(["alpha beta", "gamma"]);
    expect(rows.every((row) => !row.startsWith(" "))).toBe(true);
  });

  test("hard-splits a word longer than the width", () => {
    const rows = wrapRows("abcdefghijklmnop", 5);
    expect(rows).toEqual(["abcde", "fghij", "klmno", "p"]);
    expect(maxWidth(rows)).toBeLessThanOrEqual(5);
  });

  test("a CJK run breaks between clusters and stays inside the budget", () => {
    const rows = wrapRows("梦游会在夜里整理记忆和报告", 6);
    expect(rows.length).toBeGreaterThan(1);
    expect(maxWidth(rows)).toBeLessThanOrEqual(6);
    // Rejoining loses nothing: a break is a break, not a dropped glyph.
    expect(rows.join("")).toBe("梦游会在夜里整理记忆和报告");
  });

  test("an emoji sequence is one cluster and is not split", () => {
    const family = "👨‍👩‍👧";
    const rows = wrapRows(`${family}${family}`, 2);
    expect(rows.length).toBe(2);
    expect(rows[0]).toBe(family);
    expect(rows[1]).toBe(family);
  });

  test("a newline is a hard break and a blank line occupies a row", () => {
    expect(wrapRows("one\ntwo", 20)).toEqual(["one", "two"]);
    expect(wrapRows("one\n\ntwo", 20)).toEqual(["one", "", "two"]);
    expect(wrapRows("", 20)).toEqual([""]);
  });

  test("a zero or negative width still produces one column of content", () => {
    const rows = wrapRows("abc", 0);
    expect(rows.length).toBe(3);
    expect(rows.join("")).toBe("abc");
  });
});

describe("wrapRowsWithPrefix", () => {
  test("paints the prefix on every row and budgets its columns", () => {
    const rows = wrapRowsWithPrefix("    ", "one two three", 15);
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect(row.startsWith("    ")).toBe(true);
      expect(maxWidth([row])).toBeLessThanOrEqual(15);
    }
    expect(rows.map((row) => row.slice(4)).join(" ")).toBe("one two three");
  });

  test("a guttered code line keeps the gutter on the continuation", () => {
    const rows = wrapRowsWithPrefix("  > ", "a".repeat(8), 8);
    expect(rows.every((row) => row.startsWith("  > "))).toBe(true);
    expect(rows.map((row) => row.slice(4)).join("")).toBe("a".repeat(8));
  });
});
