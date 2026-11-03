import { describe, expect, test } from "bun:test";
import { buildEmbeddingChunkPlan } from "@/backend/local/embedding-chunk";
import { hashEmbeddingText } from "@/backend/local/embedding-format";
import type { EmbeddingSearchHit } from "@/backend/local/embedding-search";
import type { RecallMessageText } from "@/backend/local/recall-index";
import { lineSpanWithinParent } from "@/backend/local/recall-snippets";
import {
  buildMemoryVectorCandidate,
  buildTranscriptVectorCandidate,
  buildTranscriptVectorCandidates,
  createTranscriptVectorParentReader,
  VECTOR_INJECTION_FOCUS_CHARS,
  VECTOR_INJECTION_MAX_CHARS,
  VECTOR_INJECTION_NEIGHBOR_CHARS,
  vectorFocusWindow,
  verifyVectorHitText,
} from "@/reminders/recall-sources";

/**
 * B4's vector-hit injection mapping (48-1 §6.7 / 48-2 §4.3).
 *
 * Nothing here runs an encoder: the vector arm is E2's job in a later wave, and
 * this package only defines how a B2 parent-level hit becomes an injectable
 * candidate. The invariants pinned below are the ones the requirement budgeted
 * for: focus 300 + neighbour 100 inside a hard 400, the previous user message
 * preferred as neighbour, original (code-included) characters, and a hit whose
 * parent text drifted being dropped instead of guessed at.
 */

function message(
  id: string,
  role: "user" | "assistant",
  text: string,
  second = 0,
): RecallMessageText {
  return {
    id,
    role,
    ts: `2026-01-01T00:00:${String(second).padStart(2, "0")}.000Z`,
    text,
  };
}

function transcriptHit(
  messageId: string,
  text: string,
  chunkIndex = 0,
): EmbeddingSearchHit {
  const plan = buildEmbeddingChunkPlan({ parentId: messageId, text });
  const chunk = plan.chunks[chunkIndex];
  if (chunk === undefined) {
    throw new Error(`fixture has no chunk ${chunkIndex}`);
  }
  return {
    parentId: messageId,
    chunkIndex,
    score: 0.87,
    startChar: chunk.startChar,
    endChar: chunk.endChar,
    focusChar: chunk.focusChar,
    textHash: hashEmbeddingText(chunk.text),
  };
}

function memoryHit(input: {
  parentId: string;
  parentText: string;
  parentStartLine: number;
  chunkIndex?: number;
  includeLineSpan?: boolean;
}): EmbeddingSearchHit {
  const plan = buildEmbeddingChunkPlan({
    parentId: input.parentId,
    text: input.parentText,
  });
  const chunkIndex = input.chunkIndex ?? 0;
  const chunk = plan.chunks[chunkIndex];
  if (chunk === undefined) {
    throw new Error(`fixture has no chunk ${chunkIndex}`);
  }
  return {
    parentId: input.parentId,
    chunkIndex,
    score: 0.72,
    startChar: chunk.startChar,
    endChar: chunk.endChar,
    focusChar: chunk.focusChar,
    textHash: hashEmbeddingText(chunk.text),
    ...(input.includeLineSpan === false
      ? {}
      : {
          parentLineSpan: lineSpanWithinParent({
            parentText: input.parentText,
            startChar: chunk.startChar,
            endChar: chunk.endChar,
            parentStartLine: input.parentStartLine,
          }),
        }),
  };
}

// A long unpunctuated CJK message: the chunker hard-cuts it, so several chunks
// exist and chunk 0's focus is well inside the message.
const LONG_MESSAGE = "零一二三四五六七八九".repeat(50);
const USER_TEXT = "这是用户的问题。".repeat(20);

describe("vectorFocusWindow", () => {
  test("is a 300-character window centred on the focus offset", () => {
    const window = vectorFocusWindow(LONG_MESSAGE, 300);
    expect(window).toHaveLength(VECTOR_INJECTION_FOCUS_CHARS);
    expect(window).toBe(LONG_MESSAGE.slice(150, 450));
  });

  test("shifts at the ends instead of shortening", () => {
    expect(vectorFocusWindow(LONG_MESSAGE, 0)).toBe(
      LONG_MESSAGE.slice(0, VECTOR_INJECTION_FOCUS_CHARS),
    );
    expect(vectorFocusWindow(LONG_MESSAGE, LONG_MESSAGE.length)).toBe(
      LONG_MESSAGE.slice(-VECTOR_INJECTION_FOCUS_CHARS),
    );
  });

  test("a short parent is returned whole", () => {
    expect(vectorFocusWindow("短消息", 0)).toBe("短消息");
  });
});

describe("buildTranscriptVectorCandidate", () => {
  test("injects focus 300 + the previous user message, capped at 400", () => {
    const messages = [
      message("m0", "user", USER_TEXT, 1),
      message("m1", "assistant", LONG_MESSAGE, 2),
    ];
    const hit = transcriptHit("m1", LONG_MESSAGE);
    const candidate = buildTranscriptVectorCandidate({
      hit,
      conversationKey: "conv-1",
      messages,
      readParent: createTranscriptVectorParentReader(messages),
    });
    expect(candidate).toBeDefined();
    if (candidate === undefined) return;

    const focus = vectorFocusWindow(LONG_MESSAGE, hit.focusChar);
    expect(focus).toHaveLength(VECTOR_INJECTION_FOCUS_CHARS);
    const focusBlock = `助手：${focus}`;
    const neighborBudget =
      VECTOR_INJECTION_MAX_CHARS - focusBlock.length - 2 - "用户：".length;
    // 300 + labels/separator leaves exactly 92 characters for the neighbour.
    expect(neighborBudget).toBe(92);
    expect(neighborBudget).toBeLessThanOrEqual(VECTOR_INJECTION_NEIGHBOR_CHARS);
    expect(candidate.text).toBe(
      `${focusBlock}\n\n用户：${USER_TEXT.slice(-neighborBudget)}`,
    );
    expect(candidate.text.length).toBe(VECTOR_INJECTION_MAX_CHARS);
  });

  test("prefers the previous user over the next assistant", () => {
    const messages = [
      message("m0", "user", USER_TEXT, 1),
      message("m1", "assistant", LONG_MESSAGE, 2),
      message("m2", "assistant", "后续回答不该被选中。", 3),
    ];
    const candidate = buildTranscriptVectorCandidate({
      hit: transcriptHit("m1", LONG_MESSAGE),
      conversationKey: "conv-1",
      messages,
      readParent: createTranscriptVectorParentReader(messages),
    });
    expect(candidate?.text).toContain("用户：");
    expect(candidate?.text).not.toContain("后续回答不该被选中。");
  });

  test("falls back to the next assistant when there is no previous user", () => {
    const nextAnswer = "后续回答。".repeat(40);
    const messages = [
      message("m1", "assistant", LONG_MESSAGE, 1),
      message("m2", "assistant", nextAnswer, 2),
    ];
    const candidate = buildTranscriptVectorCandidate({
      hit: transcriptHit("m1", LONG_MESSAGE),
      conversationKey: "conv-1",
      messages,
      readParent: createTranscriptVectorParentReader(messages),
    });
    expect(candidate).toBeDefined();
    if (candidate === undefined) return;
    expect(candidate.text).toContain("\n\n助手：");
    expect(candidate.text.endsWith(nextAnswer.slice(0, 92))).toBe(true);
    expect(candidate.text.length).toBeLessThanOrEqual(
      VECTOR_INJECTION_MAX_CHARS,
    );
  });

  test("keeps the lexical fingerprint and the vector arm marker", () => {
    const messages = [message("m1", "assistant", LONG_MESSAGE)];
    const candidate = buildTranscriptVectorCandidate({
      hit: transcriptHit("m1", LONG_MESSAGE),
      conversationKey: "conv-1",
      messages,
      readParent: createTranscriptVectorParentReader(messages),
    });
    expect(candidate).toMatchObject({
      source: "transcript",
      arm: "vector",
      fingerprint: "transcript:conv-1:m1",
      file: "conv-1",
      conversationKey: "conv-1",
      messageId: "m1",
      timestamp: "2026-01-01T00:00:00.000Z",
      score: 0.87,
      chunkIndex: 0,
    });
  });

  test("injects original characters across a fenced code block", () => {
    const proseBefore = "说明文字。".repeat(20);
    const proseAfter = "后续说明。".repeat(20);
    const messageText = `${proseBefore}\n\n\`\`\`ts\nconst answer = 42;\n\`\`\`\n\n${proseAfter}`;
    const messages = [message("m1", "assistant", messageText)];
    const hit = transcriptHit("m1", messageText);
    const window = vectorFocusWindow(messageText, hit.focusChar);
    // The chunker strips code from the embedded text; the injection window is
    // cut from the original, so the fence and its body are still there.
    expect(window).toContain("```ts");
    expect(window).toContain("const answer = 42;");
    const candidate = buildTranscriptVectorCandidate({
      hit,
      conversationKey: "conv-1",
      messages,
      readParent: createTranscriptVectorParentReader(messages),
    });
    expect(candidate?.text).toContain("const answer = 42;");
  });

  test("drops the hit when the matched chunk's text drifted", () => {
    const messages = [message("m1", "assistant", LONG_MESSAGE)];
    const hit = transcriptHit("m1", LONG_MESSAGE);
    // Editing the part of the message chunk 0 covers changes its embedded text.
    const drifted = `改写的开头。${LONG_MESSAGE}`;
    expect(verifyVectorHitText(LONG_MESSAGE, hit)).toBe(true);
    expect(verifyVectorHitText(drifted, hit)).toBe(false);
    expect(
      buildTranscriptVectorCandidate({
        hit,
        conversationKey: "conv-1",
        messages,
        readParent: () => ({ text: drifted }),
      }),
    ).toBeUndefined();
  });

  test("a change after the matched chunk is not drift for that chunk", () => {
    const hit = transcriptHit("m1", LONG_MESSAGE);
    // Chunk 0 is a hard-cut window of the long message; appending text does not
    // move or alter it, so the window is still exactly placeable.
    expect(verifyVectorHitText(`${LONG_MESSAGE}补写的一段。`, hit)).toBe(true);
  });

  test("drops the hit when the message is gone or the hash is wrong", () => {
    const messages = [message("m1", "assistant", LONG_MESSAGE)];
    const hit = transcriptHit("m1", LONG_MESSAGE);
    expect(
      buildTranscriptVectorCandidate({
        hit,
        conversationKey: "conv-1",
        messages: [message("m2", "user", "换了内容", 1)],
        readParent: createTranscriptVectorParentReader(messages),
      }),
    ).toBeUndefined();
    expect(
      buildTranscriptVectorCandidate({
        hit: { ...hit, textHash: "0".repeat(32) },
        conversationKey: "conv-1",
        messages,
        readParent: createTranscriptVectorParentReader(messages),
      }),
    ).toBeUndefined();
    expect(
      buildTranscriptVectorCandidate({
        hit,
        conversationKey: "conv-1",
        messages,
        readParent: () => undefined,
      }),
    ).toBeUndefined();
  });

  test("batch form preserves hit order and drops drifted hits", () => {
    const messages = [message("m1", "assistant", LONG_MESSAGE)];
    const hit = transcriptHit("m1", LONG_MESSAGE);
    const candidates = buildTranscriptVectorCandidates({
      hits: [
        hit,
        { ...hit, parentId: "missing" },
        { ...hit, textHash: "f".repeat(32) },
        { ...hit, score: 0.5 },
      ],
      conversationKey: "conv-1",
      messages,
      readParent: createTranscriptVectorParentReader(messages),
    });
    expect(candidates.map((candidate) => candidate.score)).toEqual([0.87, 0.5]);
    expect(candidates.every((candidate) => candidate.arm === "vector")).toBe(
      true,
    );
  });
});

describe("buildMemoryVectorCandidate", () => {
  const lines = [
    "# 规划",
    "",
    "## 部署步骤",
    "第一步：确认目录存在。",
    "第二步：备份现有配置。",
    "第三步：执行迁移脚本。",
    "## 回滚步骤",
    "回滚前先停掉服务。",
  ];
  const parentStartLine = 4;
  const parentEndLine = 6;
  const parentText = lines.slice(parentStartLine - 1, parentEndLine).join("\n");
  const parentId = "memory:notes/plan.md#L4-L6";

  test("injects the title prefix and the best-line window", () => {
    const hit = memoryHit({ parentId, parentText, parentStartLine });
    const candidate = buildMemoryVectorCandidate({
      hit,
      file: "notes/plan.md",
      readParent: () => ({
        text: parentText,
        lines,
        startLine: parentStartLine,
      }),
    });
    expect(candidate).toBeDefined();
    if (candidate === undefined) return;
    expect(candidate.source).toBe("memory");
    expect(candidate.arm).toBe("vector");
    // The fingerprint is the lexical one, so the dedup window is unchanged.
    expect(candidate.fingerprint).toBe("memory:notes/plan.md");
    expect(candidate.file).toBe("notes/plan.md");
    expect(candidate.text.startsWith("notes/plan.md › 部署步骤\n")).toBe(true);
    // The parent's only chunk covers the whole paragraph, so its prose midpoint
    // lands on the second line (line 5); ±2 lines clamp against the document.
    expect(candidate.startLine).toBe(3);
    expect(candidate.endLine).toBe(7);
    expect(candidate.text.length).toBeLessThanOrEqual(
      VECTOR_INJECTION_MAX_CHARS,
    );
  });

  test("honours the prefix off switch and the excerptLines setting", () => {
    const hit = memoryHit({ parentId, parentText, parentStartLine });
    const candidate = buildMemoryVectorCandidate({
      hit,
      file: "notes/plan.md",
      readParent: () => ({
        text: parentText,
        lines,
        startLine: parentStartLine,
      }),
      excerptLines: 0,
      includeTitlePrefix: false,
    });
    expect(candidate?.text).toBe("第二步：备份现有配置。");
    expect(candidate?.startLine).toBe(5);
    expect(candidate?.endLine).toBe(5);
  });

  test("counts a long title prefix inside the 400-character budget", () => {
    const longLines = [
      "## 很长很长的一节标题",
      "甲".repeat(300),
      "乙".repeat(300),
      "丙".repeat(300),
    ];
    const longParent = longLines.slice(1, 3).join("\n");
    const hit = memoryHit({
      parentId: "memory:notes/long.md#L2-L3",
      parentText: longParent,
      parentStartLine: 2,
    });
    const candidate = buildMemoryVectorCandidate({
      hit,
      file: "notes/long.md",
      readParent: () => ({ text: longParent, lines: longLines, startLine: 2 }),
    });
    expect(candidate).toBeDefined();
    expect(candidate?.text.length).toBeLessThanOrEqual(
      VECTOR_INJECTION_MAX_CHARS,
    );
    expect(candidate?.text.startsWith("notes/long.md › ")).toBe(true);
  });

  test("drops a hit whose stored line span no longer matches the file", () => {
    const hit = memoryHit({ parentId, parentText, parentStartLine });
    const driftedHit: EmbeddingSearchHit = {
      ...hit,
      parentLineSpan: {
        startLine: (hit.parentLineSpan?.startLine ?? 4) + 7,
        endLine: (hit.parentLineSpan?.endLine ?? 4) + 7,
      },
    };
    expect(
      buildMemoryVectorCandidate({
        hit: driftedHit,
        file: "notes/plan.md",
        readParent: () => ({
          text: parentText,
          lines,
          startLine: parentStartLine,
        }),
      }),
    ).toBeUndefined();
  });

  test("drops a hit whose parent text or parent lookup disagrees", () => {
    const hit = memoryHit({ parentId, parentText, parentStartLine });
    const read = () => ({
      text: parentText,
      lines,
      startLine: parentStartLine,
    });
    expect(
      buildMemoryVectorCandidate({
        hit,
        file: "notes/plan.md",
        readParent: read,
      }),
    ).toBeDefined();
    // A parent reader that only has the text (no document lines) cannot render
    // a memory injection; the hit is dropped rather than given a fake prefix.
    expect(
      buildMemoryVectorCandidate({
        hit,
        file: "notes/plan.md",
        readParent: () => ({ text: parentText }),
      }),
    ).toBeUndefined();
    expect(
      buildMemoryVectorCandidate({
        hit,
        file: "notes/plan.md",
        readParent: () => ({
          text: `${parentText}改动`,
          lines,
          startLine: parentStartLine,
        }),
      }),
    ).toBeUndefined();
    expect(
      buildMemoryVectorCandidate({
        hit,
        file: "notes/plan.md",
        readParent: () => undefined,
      }),
    ).toBeUndefined();
  });

  test("accepts a hit without parentLineSpan (legacy index) but still verifies text", () => {
    const hit = memoryHit({
      parentId,
      parentText,
      parentStartLine,
      includeLineSpan: false,
    });
    expect(
      buildMemoryVectorCandidate({
        hit,
        file: "notes/plan.md",
        readParent: () => ({
          text: parentText,
          lines,
          startLine: parentStartLine,
        }),
      }),
    ).toBeDefined();
  });
});
