import { describe, expect, test } from "bun:test";
import {
  countTextRows,
  inkStringWidth,
  paddedRows,
  wrappedRowCount,
  wrapText,
} from "@/cli/helpers/text-metrics";

describe("inkStringWidth", () => {
  test("counts ASCII as one column each", () => {
    expect(inkStringWidth("hello")).toBe(5);
  });

  test("counts CJK as two columns each", () => {
    expect(inkStringWidth("你好")).toBe(4);
  });

  test("counts an emoji as two columns", () => {
    expect(inkStringWidth("🙂")).toBe(2);
  });
});

describe("wrapText", () => {
  test("returns the text unchanged when it fits", () => {
    expect(wrapText("hello world", 20)).toEqual(["hello world"]);
  });

  test("wraps on spaces at the width", () => {
    expect(wrapText("hello world", 6)).toEqual(["hello", "world"]);
  });

  test("hard-wraps a word longer than the width", () => {
    expect(wrapText("abcdefgh", 3)).toEqual(["abc", "def", "gh"]);
  });

  test("returns a single empty row for empty text", () => {
    expect(wrapText("", 10)).toEqual([""]);
  });

  test("does not wrap when width is not positive", () => {
    expect(wrapText("hello world", 0)).toEqual(["hello world"]);
  });
});

describe("wrappedRowCount / countTextRows", () => {
  test("counts wrapped rows", () => {
    expect(wrappedRowCount("hello world", 6)).toBe(2);
  });

  test("fills a hard-wrapped word's last row with the words after it", () => {
    // Ink's wrapper (wrap-ansi, hard + trim:false) fills the tail of the long
    // token and continues on that row: 38 columns of `a`, then `aaa tail`.
    // Flushing the tail into a fresh row measured three rows for a two-row draw.
    expect(wrappedRowCount(`${"a".repeat(45)} tail`, 38)).toBe(2);
  });

  test("counts hard breaks and wraps together", () => {
    // "hello" / "world" / "x"
    expect(countTextRows("hello world\nx", 6)).toBe(3);
  });

  test("a blank segment still occupies a row", () => {
    expect(countTextRows("a\n\nb", 40)).toBe(3);
  });
});

describe("paddedRows", () => {
  test("pads a short row to the full width", () => {
    const rows = paddedRows([{ text: "ab" }], 4, 0);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.map((chunk) => chunk.text).join("")).toBe("ab  ");
  });

  test("splits an over-long row and indents the continuation", () => {
    const rows = paddedRows([{ text: "abcdef" }], 4, 2);
    expect(rows.map((row) => row.map((chunk) => chunk.text).join(""))).toEqual([
      "abcd",
      "  ef",
    ]);
  });

  test("splits by display width, not by code units", () => {
    // Four CJK characters are eight display columns. At four columns the first
    // row holds two characters; the two-column continuation indent then leaves
    // room for one character per row. Splitting by String.length would instead
    // emit one "row" of twice the requested width and force Ink to wrap it again.
    const rows = paddedRows([{ text: "你好世界" }], 4, 2);
    expect(rows.map((row) => row.map((chunk) => chunk.text).join(""))).toEqual([
      "你好",
      "  世",
      "  界",
    ]);
  });

  test("never emits a row wider than the requested columns", () => {
    const rows = paddedRows([{ text: "a你b好c世d界e" }], 5, 2);
    for (const row of rows) {
      expect(
        inkStringWidth(row.map((chunk) => chunk.text).join("")),
      ).toBeLessThanOrEqual(5);
    }
  });

  test("keeps chunks that fit together on one row", () => {
    const rows = paddedRows([{ text: "你" }, { text: "好" }], 4, 0);
    expect(rows.map((row) => row.map((chunk) => chunk.text).join(""))).toEqual([
      "你好",
    ]);
  });
});
