import { describe, expect, test } from "bun:test";
import {
  isCodeFenceClose,
  isTableStart,
  LIST_ITEM_RE,
} from "@/cli/helpers/markdown-blocks";

describe("isCodeFenceClose", () => {
  test("matches a fence of the same character and length", () => {
    expect(isCodeFenceClose("```", "```")).toBe(true);
    expect(isCodeFenceClose("~~~~", "~~~")).toBe(true);
  });

  test("rejects a shorter or different fence", () => {
    expect(isCodeFenceClose("``", "```")).toBe(false);
    expect(isCodeFenceClose("~~~", "```")).toBe(false);
  });

  test("rejects a plain line", () => {
    expect(isCodeFenceClose("const a = 1;", "```")).toBe(false);
  });
});

describe("isTableStart", () => {
  test("requires a row followed by a separator", () => {
    expect(isTableStart(["| a | b |", "| --- | --- |"], 0)).toBe(true);
    expect(isTableStart(["| a | b |", "text"], 0)).toBe(false);
    expect(isTableStart(["| a | b |"], 0)).toBe(false);
  });
});

describe("LIST_ITEM_RE", () => {
  test("matches bullet and ordered items", () => {
    expect("- item".match(LIST_ITEM_RE)?.[3]).toBe("item");
    expect("1. item".match(LIST_ITEM_RE)?.[3]).toBe("item");
  });
});
