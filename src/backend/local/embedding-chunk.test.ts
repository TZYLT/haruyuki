import { describe, expect, test } from "bun:test";
import {
  buildEmbeddingChunkPlan,
  EMBEDDING_CHUNK_DEFAULTS,
  type EmbeddingChunk,
  type EmbeddingChunkPlan,
  estimateEmbeddingTokens,
  joinProseSpans,
  proseOffsetToOriginalOffset,
} from "@/backend/local/embedding-chunk";
import { EMBEDDING_FIXTURE_TEXTS } from "@/test-utils/embedding-fixture";

const parentId = "msg-1";

function planFor(
  text: string,
  options?: Parameters<typeof buildEmbeddingChunkPlan>[1],
): EmbeddingChunkPlan {
  return buildEmbeddingChunkPlan({ parentId, text }, options);
}

function chunkAt(plan: EmbeddingChunkPlan, index: number): EmbeddingChunk {
  const chunk = plan.chunks[index];
  if (chunk === undefined) {
    throw new Error(`expected chunk ${index} of ${plan.chunks.length}`);
  }
  return chunk;
}

/** Every chunk must map back onto the exact original text. */
function expectRoundTrip(plan: EmbeddingChunkPlan, original: string): void {
  for (const chunk of plan.chunks) {
    expect(chunk.parentId).toBe(parentId);
    expect(chunk.text).toBe(joinProseSpans(original, chunk.spans));
    expect(chunk.spans.length).toBeGreaterThan(0);
    const first = chunk.spans[0];
    const last = chunk.spans[chunk.spans.length - 1];
    if (first === undefined || last === undefined) throw new Error("no spans");
    expect(chunk.startChar).toBe(first.startChar);
    expect(chunk.endChar).toBe(last.endChar);
    expect(chunk.focusChar).toBeGreaterThanOrEqual(chunk.startChar);
    expect(chunk.focusChar).toBeLessThanOrEqual(chunk.endChar);
    expect(original.slice(chunk.startChar, chunk.endChar)).toContain(
      chunk.text.split("\n")[0] ?? "",
    );
  }
}

describe("estimateEmbeddingTokens", () => {
  test("CJK is one token per character", () => {
    expect(estimateEmbeddingTokens("你好世界")).toBe(4);
    expect(estimateEmbeddingTokens("汉字")).toBe(2);
  });

  test("ASCII is a quarter token per character", () => {
    expect(estimateEmbeddingTokens("abcdefgh")).toBe(2);
    expect(estimateEmbeddingTokens("a")).toBe(1);
  });

  test("punctuation is half a token", () => {
    expect(estimateEmbeddingTokens("....")).toBe(2);
    expect(estimateEmbeddingTokens("，。")).toBe(1);
    expect(estimateEmbeddingTokens("!?")).toBe(1);
  });

  test("mixed text sums the per-character costs and rounds up", () => {
    // 2 CJK (2) + "," (0.5) + " " (0.25) + "world" (1.25) + "!" (0.5) = 4.5
    expect(estimateEmbeddingTokens("你好, world!")).toBe(5);
  });

  test("empty text costs nothing", () => {
    expect(estimateEmbeddingTokens("")).toBe(0);
  });
});

describe("span helpers", () => {
  test("joinProseSpans joins original slices with newlines", () => {
    const text = "abcdef";
    expect(
      joinProseSpans(text, [
        { startChar: 1, endChar: 3 },
        { startChar: 4, endChar: 6 },
      ]),
    ).toBe("bc\nef");
  });

  test("proseOffsetToOriginalOffset maps embedded offsets back", () => {
    const spans = [
      { startChar: 10, endChar: 14 },
      { startChar: 20, endChar: 24 },
    ];
    expect(proseOffsetToOriginalOffset(spans, 0)).toBe(10);
    expect(proseOffsetToOriginalOffset(spans, 2)).toBe(12);
    expect(proseOffsetToOriginalOffset(spans, 4)).toBe(14);
    // index 4 is the "\n" separator; index 5 is the second span's first char
    expect(proseOffsetToOriginalOffset(spans, 5)).toBe(20);
    expect(proseOffsetToOriginalOffset(spans, 8)).toBe(23);
    expect(proseOffsetToOriginalOffset(spans, 999)).toBe(24);
    expect(proseOffsetToOriginalOffset([], 5)).toBe(0);
  });
});

describe("prose packing", () => {
  test("a short Chinese message is one chunk and coverage is complete", () => {
    const text = EMBEDDING_FIXTURE_TEXTS.chineseProse;
    const plan = planFor(text);
    expect(plan.skipVector).toBe(false);
    expect(plan.chunks).toHaveLength(1);
    const chunk = chunkAt(plan, 0);
    expect(chunk.kind).toBe("prose");
    expect(chunk.text).toBe(text);
    expect(chunk.estimatedTokens).toBeLessThanOrEqual(
      EMBEDDING_CHUNK_DEFAULTS.maxTokens,
    );
    expect(plan.coverage.embeddedChars).toBe(text.length);
    expect(plan.coverage.recallableChars).toBe(text.length);
    expect(plan.coverage.ratio).toBe(1);
    expect(plan.truncatedByCap).toBe(false);
    expectRoundTrip(plan, text);
  });

  test("windows respect target/max and never cut a sentence", () => {
    const sentence = "甲乙丙丁戊己庚辛壬癸。";
    const text = Array.from({ length: 9 }, () => sentence).join("");
    const plan = planFor(text, { targetTokens: 24, maxTokens: 32 });
    expect(plan.chunks.length).toBeGreaterThan(1);
    for (const chunk of plan.chunks) {
      expect(chunk.estimatedTokens).toBeLessThanOrEqual(32);
      // A hard cut is not needed here, so every text ends on a terminator.
      expect(chunk.text.endsWith("。")).toBe(true);
    }
    expectRoundTrip(plan, text);
  });

  test("adjacent prose chunks share a 32-token-style overlap", () => {
    const sentence = "甲乙丙丁戊己庚辛壬癸。";
    const text = Array.from({ length: 9 }, () => sentence).join("");
    const plan = planFor(text, {
      targetTokens: 24,
      maxTokens: 32,
      overlapTokens: 8,
    });
    const first = chunkAt(plan, 0);
    const second = chunkAt(plan, 1);
    let overlap = 0;
    const maxOverlap = Math.min(first.text.length, second.text.length);
    for (let length = maxOverlap; length > 0; length -= 1) {
      if (first.text.endsWith(second.text.slice(0, length))) {
        overlap = length;
        break;
      }
    }
    expect(overlap).toBeGreaterThanOrEqual(4);
    // Overlap is budgeted into the max, never added on top of it.
    expect(second.estimatedTokens).toBeLessThanOrEqual(32);
    for (const chunk of plan.chunks) {
      expect(chunk.estimatedTokens).toBeLessThanOrEqual(32);
    }
    expectRoundTrip(plan, text);
  });

  test("English sentences split on terminator plus whitespace", () => {
    const text =
      "The deploy ran at 09:30 with zero errors. It was fast. 回滚脚本仍然可用。Next step is the canary check. 之后再看监控。";
    const plan = planFor(text, { targetTokens: 12, maxTokens: 18 });
    expect(plan.chunks.length).toBeGreaterThan(1);
    expectRoundTrip(plan, text);
  });

  test("a no-punctuation sentence over the cap is hard-cut, not dropped", () => {
    const text = "字".repeat(600);
    const plan = planFor(text, { targetTokens: 100, maxTokens: 100 });
    expect(plan.chunks).toHaveLength(6);
    for (const chunk of plan.chunks) {
      expect(chunk.text.length).toBe(100);
      expect(chunk.estimatedTokens).toBeLessThanOrEqual(100);
    }
    expect(plan.chunks.map((chunk) => chunk.text).join("")).toBe(text);
    expect(plan.coverage.ratio).toBe(1);
    expectRoundTrip(plan, text);
  });

  test("CRLF text keeps its original line endings inside spans", () => {
    const text = EMBEDDING_FIXTURE_TEXTS.crlf;
    const plan = planFor(text);
    expect(plan.chunks).toHaveLength(1);
    const chunk = chunkAt(plan, 0);
    expect(chunk.text).toContain("\r\n");
    expect(chunk.spans).toHaveLength(1);
    expect(chunk.text).toBe(text.slice(chunk.startChar, chunk.endChar));
    expect(chunk.focusChar).toBe(
      chunk.startChar + Math.floor(chunk.text.length / 2),
    );
    expectRoundTrip(plan, text);
  });

  test("full-width punctuation still ends sentences", () => {
    const text = EMBEDDING_FIXTURE_TEXTS.fullwidth;
    const plan = planFor(text, { targetTokens: 12, maxTokens: 16 });
    expect(plan.chunks.length).toBeGreaterThan(1);
    expect(plan.chunks[plan.chunks.length - 1]?.text.endsWith("。")).toBe(true);
    const terminators = ["！", "？", "；", "。"];
    for (const chunk of plan.chunks) {
      const lastCharacter = chunk.text.charAt(chunk.text.length - 1);
      expect(terminators).toContain(lastCharacter);
    }
    expectRoundTrip(plan, text);
  });

  test("chunking is deterministic", () => {
    const text = `${EMBEDDING_FIXTURE_TEXTS.mixedProse}\n\n${EMBEDDING_FIXTURE_TEXTS.table}`;
    const first = planFor(text);
    const second = planFor(text);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.parentId).toBe(parentId);
    expect(second.chunks.every((chunk) => chunk.parentId === parentId)).toBe(
      true,
    );
  });
});

describe("code stripping", () => {
  test("fenced code leaves the embedding text but stays in the original range", () => {
    const text = EMBEDDING_FIXTURE_TEXTS.codeHeavy;
    const plan = planFor(text, { targetTokens: 40, maxTokens: 64 });
    expect(plan.skipVector).toBe(false);
    expect(plan.chunks.length).toBeGreaterThan(0);
    for (const chunk of plan.chunks) {
      expect(chunk.text).not.toContain("set -euo pipefail");
      expect(chunk.text).not.toContain("```");
    }
    const covered = plan.chunks.map((chunk) => chunk.text).join("\n");
    expect(covered).toContain("清理临时目录");
    expect(covered).toContain("确认无误");
    // startChar/endChar cover the code in between (48-2 O-24).
    const spanning = plan.chunks.find((chunk) => chunk.spans.length > 1);
    if (spanning !== undefined) {
      const between = text.slice(
        spanning.spans[0]?.endChar ?? 0,
        spanning.spans[1]?.startChar ?? 0,
      );
      expect(between).toContain("```");
    }
    expect(plan.coverage.ratio).toBeLessThan(1);
    expect(plan.coverage.ratio).toBeGreaterThan(0);
    expectRoundTrip(plan, text);
  });

  test("a nested fence marker shorter than the opener is code content", () => {
    const text = [
      "开头正文，说明这次改动的背景、动机与影响范围，方便后来的人理解上下文。",
      "",
      "````md",
      "代码里出现了 ``` 三个反引号",
      "````",
      "",
      "结尾正文，确保被保留下来。这里再补一句，让散文长度稳稳超过阈值。",
    ].join("\n");
    const plan = planFor(text);
    const joined = plan.chunks.map((chunk) => chunk.text).join("\n");
    expect(joined).toContain("开头正文");
    expect(joined).toContain("结尾正文");
    expect(joined).not.toContain("三个反引号");
    expectRoundTrip(plan, text);
  });

  test("an unclosed fence swallows the rest of the text", () => {
    const text = `这是一段足够长的说明文字，用来确认代码围栏未闭合时会把后面的内容全部当作代码处理掉，不再参与嵌入。\n\`\`\`\n这一行是代码，不应该出现在嵌入文本里。\n后面这一行也一样。`;
    const plan = planFor(text);
    const joined = plan.chunks.map((chunk) => chunk.text).join("\n");
    expect(joined).toContain("足够长的说明文字");
    expect(joined).not.toContain("这一行是代码");
    expect(joined).not.toContain("后面这一行");
    expectRoundTrip(plan, text);
  });

  test("a pure-code message is lexical-only", () => {
    const plan = planFor(EMBEDDING_FIXTURE_TEXTS.codeOnly);
    expect(plan.skipVector).toBe(true);
    expect(plan.skipReason).toBe("code-only");
    expect(plan.chunks).toHaveLength(0);
    expect(plan.coverage.ratio).toBe(0);
    expect(plan.truncatedByCap).toBe(false);
  });

  test("mostly-code messages under the prose floor are lexical-only", () => {
    const text = [
      "短说明。",
      "",
      "```ts",
      "const a = 1;",
      "const b = 2;",
      "```",
    ].join("\n");
    const plan = planFor(text);
    expect(plan.skipVector).toBe(true);
    expect(plan.skipReason).toBe("prose-too-short");
    expect(plan.chunks).toHaveLength(0);
  });

  test("a short message without code is still chunked, not skipped", () => {
    const plan = planFor("短消息。");
    expect(plan.skipVector).toBe(false);
    expect(plan.chunks).toHaveLength(1);
  });

  test("empty and whitespace-only text is skipVector with reason empty", () => {
    for (const text of ["", "   \n\t\n"]) {
      const plan = planFor(text);
      expect(plan.skipVector).toBe(true);
      expect(plan.skipReason).toBe("empty");
      expect(plan.chunks).toHaveLength(0);
    }
  });
});

describe("tables", () => {
  test("a table under the cap stays one atomic chunk", () => {
    const text = EMBEDDING_FIXTURE_TEXTS.table;
    const plan = planFor(text);
    expect(plan.chunks).toHaveLength(1);
    const chunk = chunkAt(plan, 0);
    expect(chunk.kind).toBe("table");
    expect(chunk.text).toBe(text);
    expect(plan.coverage.ratio).toBe(1);
    expectRoundTrip(plan, text);
  });

  test("an atomic table may exceed the target but not the cap", () => {
    const rows = Array.from(
      { length: 12 },
      (_unused, index) =>
        `| 键 ${index} | 这是一个比较长的单元格内容 ${index} |`,
    );
    const text = ["| 键 | 值 |", "| --- | --- |", ...rows].join("\n");
    const plan = planFor(text);
    expect(plan.chunks).toHaveLength(1);
    const chunk = chunkAt(plan, 0);
    expect(chunk.kind).toBe("table");
    expect(chunk.estimatedTokens).toBeGreaterThan(
      EMBEDDING_CHUNK_DEFAULTS.targetTokens,
    );
    expect(chunk.estimatedTokens).toBeLessThanOrEqual(
      EMBEDDING_CHUNK_DEFAULTS.maxTokens,
    );
  });

  test("an oversized table splits by rows and repeats the header", () => {
    const text = EMBEDDING_FIXTURE_TEXTS.longTable;
    const plan = planFor(text);
    expect(plan.chunks.length).toBeGreaterThan(1);
    const header = "| 键 | 说明 |\n| --- | --- |";
    for (const chunk of plan.chunks) {
      expect(chunk.kind).toBe("table");
      expect(chunk.text.startsWith(header)).toBe(true);
      expect(chunk.estimatedTokens).toBeLessThanOrEqual(
        EMBEDDING_CHUNK_DEFAULTS.maxTokens,
      );
    }
    const rowsSeen = new Set<string>();
    for (const chunk of plan.chunks) {
      const parts = chunk.text.split("\n");
      for (const part of parts.slice(2)) {
        if (part.startsWith("| key_")) rowsSeen.add(part);
      }
    }
    expect(rowsSeen.size).toBe(60);
    expect(plan.coverage.ratio).toBeGreaterThan(0.99);
    expectRoundTrip(plan, text);
  });
});

describe("lists, JSON and logs", () => {
  test("a short list is one atomic chunk", () => {
    const text = [
      "- 第一项：说明",
      "- 第二项：说明",
      "  - 嵌套项也保留",
      "- 第三项：说明",
    ].join("\n");
    const plan = planFor(text);
    expect(plan.chunks).toHaveLength(1);
    const chunk = chunkAt(plan, 0);
    expect(chunk.kind).toBe("list");
    expect(chunk.text).toBe(text);
    expectRoundTrip(plan, text);
  });

  test("an oversized list splits between items, never inside one", () => {
    const text = Array.from(
      { length: 120 },
      (_unused, index) => `- 项目 ${index}：这是一个用于撑长列表的说明文本。`,
    ).join("\n");
    const plan = planFor(text);
    expect(plan.chunks.length).toBeGreaterThan(1);
    for (const chunk of plan.chunks) {
      expect(chunk.kind).toBe("list");
      expect(chunk.estimatedTokens).toBeLessThanOrEqual(
        EMBEDDING_CHUNK_DEFAULTS.maxTokens,
      );
      for (const line of chunk.text.split("\n")) {
        expect(line.startsWith("- 项目 ")).toBe(true);
      }
    }
    const items = new Set(
      plan.chunks.flatMap((chunk) => chunk.text.split("\n")),
    );
    expect(items.size).toBe(120);
    expectRoundTrip(plan, text);
  });

  test("JSON lines are split by line and tagged", () => {
    const text = EMBEDDING_FIXTURE_TEXTS.jsonLines;
    const plan = planFor(text);
    expect(plan.chunks.length).toBe(1);
    const chunk = chunkAt(plan, 0);
    expect(chunk.kind).toBe("json");
    expect(chunk.text).toBe(text);
    expectRoundTrip(plan, text);
  });

  test("log lines are split by line and tagged", () => {
    const text = EMBEDDING_FIXTURE_TEXTS.logLines;
    const plan = planFor(text, { targetTokens: 10, maxTokens: 12 });
    expect(plan.chunks.length).toBeGreaterThan(1);
    for (const chunk of plan.chunks) {
      expect(chunk.kind).toBe("log");
      expect(chunk.estimatedTokens).toBeLessThanOrEqual(12);
    }
    expectRoundTrip(plan, text);
  });
});

describe("hard cap and coverage", () => {
  test("the per-parent chunk cap truncates the tail and reports it", () => {
    const sentence =
      "这是一句用来撑出很多块的测试句子，内容本身没有意义但长度足够。";
    const text = Array.from({ length: 40 }, () => sentence).join("");
    const plan = planFor(text, {
      targetTokens: 20,
      maxTokens: 24,
      overlapTokens: 0,
      maxChunksPerParent: 5,
    });
    expect(plan.chunks).toHaveLength(5);
    expect(plan.truncatedByCap).toBe(true);
    expect(plan.skipVector).toBe(false);
    expect(plan.coverage.embeddedChars).toBeGreaterThan(0);
    expect(plan.coverage.embeddedChars).toBeLessThan(
      plan.coverage.recallableChars,
    );
    expect(plan.coverage.ratio).toBeLessThan(1);
    expectRoundTrip(plan, text);
  });

  test("an uncapped plan is not marked truncated", () => {
    const plan = planFor(EMBEDDING_FIXTURE_TEXTS.chineseProse);
    expect(plan.truncatedByCap).toBe(false);
  });

  test("coverage never exceeds the recallable characters", () => {
    for (const text of [
      EMBEDDING_FIXTURE_TEXTS.chineseProse,
      EMBEDDING_FIXTURE_TEXTS.mixedProse,
      EMBEDDING_FIXTURE_TEXTS.codeHeavy,
      EMBEDDING_FIXTURE_TEXTS.longTable,
      EMBEDDING_FIXTURE_TEXTS.jsonLines,
    ]) {
      const plan = planFor(text);
      expect(plan.coverage.recallableChars).toBe(text.length);
      expect(plan.coverage.embeddedChars).toBeGreaterThanOrEqual(0);
      expect(plan.coverage.embeddedChars).toBeLessThanOrEqual(text.length);
      expect(plan.coverage.ratio).toBeGreaterThanOrEqual(0);
      expect(plan.coverage.ratio).toBeLessThanOrEqual(1);
      expectRoundTrip(plan, text);
    }
  });
});
