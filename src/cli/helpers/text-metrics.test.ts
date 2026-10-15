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
});
