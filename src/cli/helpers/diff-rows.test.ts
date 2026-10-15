import { describe, expect, test } from "bun:test";
import type { AdvancedDiffSuccess } from "@/cli/helpers/diff";
import {
  advancedDiffRowCount,
  buildDiffLineChunks,
  diffGutterWidth,
  diffLineRowCount,
  editRendererRowCount,
  multiEditRendererRowCount,
  writeRendererRowCount,
} from "@/cli/helpers/diff-rows";

describe("buildDiffLineChunks", () => {
  test("lays out indent, gutter, sign, gap and body", () => {
    const { chunks, contIndent } = buildDiffLineChunks(
      { kind: "add", displayNo: 7, text: "const a = 1;" },
      { indent: "    ", gutterWidth: 2 },
    );
    expect(chunks.map((chunk) => [chunk.role, chunk.text])).toEqual([
      ["indent", "    "],
      ["gutter", " 7 "],
      ["symbol", "+"],
      ["gap", " "],
      ["content", "const a = 1;"],
    ]);
    // indent + gutter + sign + gap
    expect(contIndent).toBe(4 + 3 + 1 + 1);
  });

  test("uses the caller's gutter text and gap for the simple renderers", () => {
    const { chunks, contIndent } = buildDiffLineChunks(
      { kind: "remove", displayNo: 3, text: "x" },
      { indent: "    ", gutterWidth: 0, gutter: "3 ", gap: "  " },
    );
    expect(chunks.map((chunk) => [chunk.role, chunk.text])).toEqual([
      ["indent", "    "],
      ["gutter", "3 "],
      ["symbol", "-"],
      ["gap", "  "],
      ["content", "x"],
    ]);
    expect(contIndent).toBe(4 + 2 + 1 + 2);
  });

  test("expands tabs and keeps syntax spans as separate chunks", () => {
    const { chunks } = buildDiffLineChunks(
      {
        kind: "context",
        displayNo: 1,
        text: "ignored",
        syntaxSpanTexts: ["\tconst", " a"],
      },
      { indent: "", gutterWidth: 1 },
    );
    expect(chunks.slice(-2)).toEqual([
      { text: "    const", role: "content", syntaxIndex: 0 },
      { text: " a", role: "content", syntaxIndex: 1 },
    ]);
  });
});

describe("diffLineRowCount", () => {
  const layout = { indent: "    ", gutterWidth: 2 };

  test("a short line occupies one row", () => {
    expect(
      diffLineRowCount({ kind: "add", displayNo: 1, text: "x" }, layout, 40),
    ).toBe(1);
  });

  test("a long line wraps and indents its continuation", () => {
    // 20 columns: 4 indent + 3 gutter + 1 sign + 1 gap = 9, so 11 columns of body.
    expect(
      diffLineRowCount(
        { kind: "add", displayNo: 1, text: "x".repeat(25) },
        layout,
        20,
      ),
    ).toBe(3);
  });

  test("counts wide characters by display width", () => {
    // 14 CJK characters are 28 columns; at 9 + 11 = 20 columns the body wraps.
    expect(
      diffLineRowCount(
        { kind: "add", displayNo: 1, text: "你".repeat(14) },
        layout,
        20,
      ),
    ).toBe(3);
  });
});

describe("diffGutterWidth", () => {
  test("fits the largest display number", () => {
    expect(diffGutterWidth([1, 9])).toBe(1);
    expect(diffGutterWidth([1, 10])).toBe(2);
    expect(diffGutterWidth([])).toBe(1);
  });
});

function makeDiff(lines: string[]): AdvancedDiffSuccess {
  return {
    mode: "advanced",
    fileName: "example.ts",
    oldStr: "",
    newStr: "",
    hunks: [
      {
        oldStart: 1,
        newStart: 1,
        lines: lines.map((raw) => ({ raw })),
      },
    ],
  };
}

describe("advancedDiffRowCount", () => {
  test("counts a headerless diff as one row per diff line", () => {
    const result = makeDiff([
      " const a = 1;",
      "-const b = 2;",
      "+const b = 3;",
    ]);
    expect(
      advancedDiffRowCount(result, {
        columns: 80,
        showHeader: false,
        kind: "edit",
        filePath: "src/example.ts",
      }),
    ).toBe(3);
  });

  test("adds the header pair when the renderer shows it", () => {
    const result = makeDiff(["+const b = 3;"]);
    expect(
      advancedDiffRowCount(result, {
        columns: 80,
        showHeader: true,
        kind: "edit",
        filePath: "src/example.ts",
      }),
    ).toBe(3);
  });

  test("skips meta lines and counts an empty diff as the no-changes pair", () => {
    const empty = makeDiff(["\\ No newline at end of file"]);
    expect(
      advancedDiffRowCount(empty, {
        columns: 80,
        showHeader: true,
        kind: "edit",
        filePath: "src/example.ts",
      }),
    ).toBe(2);
    expect(
      advancedDiffRowCount(empty, {
        columns: 80,
        showHeader: false,
        kind: "edit",
        filePath: "src/example.ts",
      }),
    ).toBe(1);
  });

  test("wraps a long diff line", () => {
    const result = makeDiff([`+${"x".repeat(120)}`]);
    expect(
      advancedDiffRowCount(result, {
        columns: 40,
        showHeader: false,
        kind: "edit",
        filePath: "src/example.ts",
      }),
    ).toBeGreaterThan(1);
  });
});

describe("simple renderer counts", () => {
  test("WriteRenderer counts its header plus one row per content line", () => {
    expect(writeRendererRowCount("a\nb\nc", "src/example.ts", 80)).toBe(4);
  });

  test("WriteRenderer wraps long content lines", () => {
    const rows = writeRendererRowCount("x".repeat(200), "src/example.ts", 80);
    // header + wrapped body
    expect(rows).toBeGreaterThan(2);
  });

  test("EditRenderer counts the header plus remove and add blocks", () => {
    expect(editRendererRowCount("src/example.ts", "old", "new", 80)).toBe(3);
  });

  test("EditRenderer honours hidden line numbers", () => {
    const withNumbers = editRendererRowCount(
      "src/example.ts",
      "old",
      "new",
      80,
      { showLineNumbers: true },
    );
    const withoutNumbers = editRendererRowCount(
      "src/example.ts",
      "old",
      "new",
      80,
      { showLineNumbers: false },
    );
    expect(withNumbers).toBeGreaterThan(0);
    expect(withoutNumbers).toBeGreaterThan(0);
  });

  test("MultiEditRenderer sums every edit's blocks", () => {
    expect(
      multiEditRendererRowCount(
        "src/example.ts",
        [
          { old_string: "a", new_string: "b" },
          { old_string: "c", new_string: "d" },
        ],
        80,
      ),
    ).toBe(5);
  });
});
