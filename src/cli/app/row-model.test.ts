import { describe, expect, test } from "bun:test";
import { markdownRowCount, measureLineRows } from "@/cli/app/row-model";
import type { Line } from "@/cli/helpers/accumulator";

const OPTIONS = { columns: 40 };

describe("markdownRowCount", () => {
  test("counts a paragraph that fits as one row", () => {
    expect(markdownRowCount("hello world", 40)).toBe(1);
  });

  test("wraps a paragraph at the width", () => {
    expect(markdownRowCount("hello world", 6)).toBe(2);
  });

  test("counts a fenced code block by its body lines", () => {
    expect(markdownRowCount("```\nconst a = 1;\n```", 40)).toBe(1);
    expect(markdownRowCount("```\na\nb\nc\n```", 40)).toBe(3);
  });

  test("counts a list item and a header as single rows", () => {
    expect(markdownRowCount("- item", 40)).toBe(1);
    expect(markdownRowCount("# Title", 40)).toBe(1);
  });

  test("counts blank lines and table rows", () => {
    expect(markdownRowCount("a\n\nb", 40)).toBe(3);
    expect(markdownRowCount("| a | b |\n| --- | --- |\n| 1 | 2 |", 40)).toBe(3);
  });

  test("returns zero rows for empty text", () => {
    expect(markdownRowCount("", 40)).toBe(0);
  });
});

describe("measureLineRows", () => {
  test("a separator is one row", () => {
    expect(measureLineRows({ kind: "separator", id: "sep" }, OPTIONS)).toBe(1);
  });

  test("a status row counts its lines", () => {
    expect(
      measureLineRows({ kind: "status", id: "st", lines: ["a", "b"] }, OPTIONS),
    ).toBe(2);
  });

  test("a user row wraps at the prompt-adjusted width", () => {
    expect(
      measureLineRows({ kind: "user", id: "u", text: "hello world" }, OPTIONS),
    ).toBe(1);

    const long: Line = { kind: "user", id: "u", text: "x".repeat(100) };
    expect(measureLineRows(long, OPTIONS)).toBe(3);
  });

  test("an assistant row measures its markdown body", () => {
    const fits: Line = {
      kind: "assistant",
      id: "a",
      text: "hello",
      phase: "finished",
    };
    expect(measureLineRows(fits, OPTIONS)).toBe(1);

    const wraps: Line = {
      kind: "assistant",
      id: "a",
      text: "x".repeat(100),
      phase: "finished",
    };
    // 40 columns minus the 2-column bullet gutter.
    expect(measureLineRows(wraps, OPTIONS)).toBe(3);
  });

  test("collapsed reasoning is a single header row", () => {
    const header: Line = {
      kind: "reasoning",
      id: "r",
      text: "body",
      phase: "finished",
    };
    expect(measureLineRows(header, OPTIONS)).toBe(1);
  });

  test("a collapsed reasoning continuation is hidden", () => {
    const continuation: Line = {
      kind: "reasoning",
      id: "r",
      text: "body",
      phase: "finished",
      isContinuation: true,
    };
    expect(measureLineRows(continuation, OPTIONS)).toBe(0);
  });

  test("expanded reasoning adds the header, spacer and body", () => {
    const expanded: Line = {
      kind: "reasoning",
      id: "r",
      text: "body",
      phase: "finished",
    };
    expect(
      measureLineRows(expanded, { columns: 40, reasoningExpanded: true }),
    ).toBe(3);
  });

  test("a bare tool call is one header row", () => {
    const bare: Line = { kind: "tool_call", id: "t", phase: "finished" };
    expect(measureLineRows(bare, OPTIONS)).toBe(1);
  });

  test("a tool call adds its args and result rows", () => {
    const withBody: Line = {
      kind: "tool_call",
      id: "t",
      phase: "finished",
      argsText: "line1\nline2",
      resultText: "ok",
    };
    expect(measureLineRows(withBody, OPTIONS)).toBe(1 + 2 + 1);
  });

  test("tool args are capped", () => {
    const huge: Line = {
      kind: "tool_call",
      id: "t",
      phase: "finished",
      argsText: Array.from({ length: 20 }, (_, i) => `line-${i}`).join("\n"),
    };
    expect(measureLineRows(huge, OPTIONS)).toBe(1 + 5);
  });

  test("a command row counts its input and output", () => {
    const command: Line = {
      kind: "command",
      id: "c",
      input: "ls",
      output: "a\nb",
    };
    expect(measureLineRows(command, OPTIONS)).toBe(1 + 1 + 2);
  });
});
