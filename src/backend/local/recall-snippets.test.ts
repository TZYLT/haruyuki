import { describe, expect, test } from "bun:test";
import {
  clipInjectionText,
  lineIndexAtChar,
  lineSpanWithinParent,
  MEMORY_TITLE_SEPARATOR,
  MEMORY_VECTOR_EXCERPT_MAX_CHARS,
  memorySectionTitle,
  memoryTitlePrefix,
  memoryVectorExcerpt,
} from "@/backend/local/recall-snippets";

/**
 * B4's line math and vector-memory excerpt.
 *
 * The excerpt is what the model receives for a vector memory hit, so two things
 * are pinned: the line the window is centred on comes from the chunk's
 * `focusChar` (48-2 §4.3) rather than from a query, and the
 * `文件路径 › 章节标题` prefix is paid for out of the same 400-character budget
 * (48-1 §6.2/§6.7).
 */

describe("lineIndexAtChar", () => {
  test("counts newlines before the offset", () => {
    const text = "line1\nline2\nline3";
    expect(lineIndexAtChar(text, 0)).toBe(0);
    expect(lineIndexAtChar(text, 4)).toBe(0);
    // The newline itself still belongs to the line it terminates.
    expect(lineIndexAtChar(text, 5)).toBe(0);
    expect(lineIndexAtChar(text, 6)).toBe(1);
    expect(lineIndexAtChar(text, text.length)).toBe(2);
  });

  test("clamps out-of-range and non-finite offsets", () => {
    const text = "a\nb\nc";
    expect(lineIndexAtChar(text, -5)).toBe(0);
    expect(lineIndexAtChar(text, 10_000)).toBe(2);
    expect(lineIndexAtChar(text, Number.NaN)).toBe(0);
    expect(lineIndexAtChar("", 3)).toBe(0);
  });
});

describe("lineSpanWithinParent", () => {
  const parentText = "第一行\n第二行\n第三行";
  const parentStartLine = 10;

  test("a whole-paragraph chunk spans every line", () => {
    expect(
      lineSpanWithinParent({
        parentText,
        startChar: 0,
        endChar: parentText.length,
        parentStartLine,
      }),
    ).toEqual({ startLine: 10, endLine: 12 });
  });

  test("a chunk inside one line reports that line only", () => {
    expect(
      lineSpanWithinParent({
        parentText,
        startChar: 1,
        endChar: 2,
        parentStartLine,
      }),
    ).toEqual({ startLine: 10, endLine: 10 });
    expect(
      lineSpanWithinParent({
        parentText,
        startChar: 4,
        endChar: 7,
        parentStartLine,
      }),
    ).toEqual({ startLine: 11, endLine: 11 });
  });
});

describe("memorySectionTitle", () => {
  const lines = [
    "# 顶层标题",
    "",
    "正文。",
    "",
    "## 部署步骤 ##",
    "第一步。",
    "",
    "### 子节",
    "细节。",
  ];

  test("returns the nearest heading at or before the line", () => {
    expect(memorySectionTitle(lines, 1)).toBe("顶层标题");
    expect(memorySectionTitle(lines, 4)).toBe("顶层标题");
    expect(memorySectionTitle(lines, 6)).toBe("部署步骤");
    expect(memorySectionTitle(lines, 9)).toBe("子节");
  });

  test("does not borrow a heading that follows the hit", () => {
    // Line 3 is before the first `##` heading.
    expect(memorySectionTitle(lines, 3)).toBe("顶层标题");
    // A line past the end still sees the last heading, not undefined.
    expect(memorySectionTitle(lines, 99)).toBe("子节");
    // Heading-less documents have no section.
    expect(memorySectionTitle([""], 1)).toBeUndefined();
    expect(memorySectionTitle([], 1)).toBeUndefined();
  });
});

describe("memoryTitlePrefix", () => {
  const lines = ["# 计划", "", "## 目标", "目标正文。"];

  test("is `path › section`", () => {
    expect(memoryTitlePrefix("notes/plan.md", lines, 4)).toBe(
      `notes/plan.md${MEMORY_TITLE_SEPARATOR}目标`,
    );
  });

  test("falls back to the bare path without a heading", () => {
    expect(memoryTitlePrefix("notes/plan.md", ["正文。"], 1)).toBe(
      "notes/plan.md",
    );
  });
});

describe("clipInjectionText", () => {
  test("cuts to the character count", () => {
    expect(clipInjectionText("abcdef", 3)).toBe("abc");
    expect(clipInjectionText("abc", 5)).toBe("abc");
    expect(clipInjectionText("abc", 0)).toBe("");
  });

  test("never leaves an unpaired surrogate behind", () => {
    // Each emoji is two UTF-16 code units; a cut at 1 would split it.
    expect(clipInjectionText("😀😀", 1)).toBe("");
    expect(clipInjectionText("😀😀", 2)).toBe("😀");
    expect(clipInjectionText("a😀", 2)).toBe("a");
  });
});

describe("memoryVectorExcerpt", () => {
  const lines = [
    "## 部署步骤",
    "第一步：确认目录存在。",
    "第二步：备份现有配置。",
    "第三步：执行迁移脚本。",
    "## 回滚步骤",
    "回滚前先停掉服务。",
  ];
  // The parent paragraph is the three `第…步` lines.
  const parentText = lines.slice(1, 4).join("\n");
  const parentStartLine = 2;

  test("centres the window on the line the focus offset falls in", () => {
    const excerpt = memoryVectorExcerpt({
      path: "notes/plan.md",
      parentText,
      parentStartLine,
      lines,
      focusChar: 0,
      excerptLines: 2,
    });
    expect(excerpt.hitLine).toBe(2);
    // Whole-document clamp, exactly like the lexical retriever: ±2 lines around
    // line 2 is lines 1–4, the heading included.
    expect(excerpt.startLine).toBe(1);
    expect(excerpt.endLine).toBe(4);
    expect(excerpt.titlePrefix).toBe(
      `notes/plan.md${MEMORY_TITLE_SEPARATOR}部署步骤`,
    );
    expect(excerpt.text.startsWith(`${excerpt.titlePrefix}\n`)).toBe(true);
    expect(excerpt.text).toContain("第二步：备份现有配置。");
  });

  test("maps an offset inside the paragraph to the right file line", () => {
    const offset = parentText.indexOf("第三步");
    const excerpt = memoryVectorExcerpt({
      path: "notes/plan.md",
      parentText,
      parentStartLine,
      lines,
      focusChar: offset,
      excerptLines: 1,
    });
    expect(excerpt.hitLine).toBe(4);
    expect(excerpt.startLine).toBe(3);
    expect(excerpt.endLine).toBe(5);
  });

  test("counts the title prefix inside the 400-character budget", () => {
    const longLines = [
      "## 长标题",
      "甲".repeat(300),
      "乙".repeat(300),
      "丙".repeat(300),
    ];
    const excerpt = memoryVectorExcerpt({
      path: "notes/long.md",
      parentText: longLines.slice(1, 3).join("\n"),
      parentStartLine: 2,
      lines: longLines,
      focusChar: 0,
      excerptLines: 2,
    });
    expect(excerpt.text.length).toBeLessThanOrEqual(
      MEMORY_VECTOR_EXCERPT_MAX_CHARS,
    );
    expect(excerpt.text.startsWith(excerpt.titlePrefix)).toBe(true);
  });

  test("excerptLines=0 keeps only the hit line", () => {
    const excerpt = memoryVectorExcerpt({
      path: "notes/plan.md",
      parentText,
      parentStartLine,
      lines,
      focusChar: 0,
      excerptLines: 0,
      includeTitlePrefix: false,
    });
    expect(excerpt.text).toBe("第一步：确认目录存在。");
    expect(excerpt.startLine).toBe(2);
    expect(excerpt.endLine).toBe(2);
    expect(excerpt.titlePrefix).toBe("");
    expect(excerpt.text).not.toContain(MEMORY_TITLE_SEPARATOR);
  });

  test("the prefix can be turned off (48-1 O-23)", () => {
    const excerpt = memoryVectorExcerpt({
      path: "notes/plan.md",
      parentText,
      parentStartLine,
      lines,
      focusChar: 0,
      includeTitlePrefix: false,
    });
    expect(excerpt.titlePrefix).toBe("");
    expect(excerpt.text.startsWith("## 部署步骤")).toBe(true);
  });

  test("a focus offset past the paragraph clamps to its last line", () => {
    const excerpt = memoryVectorExcerpt({
      path: "notes/plan.md",
      parentText,
      parentStartLine,
      lines,
      focusChar: 10_000,
      excerptLines: 0,
    });
    expect(excerpt.hitLine).toBe(4);
  });
});
