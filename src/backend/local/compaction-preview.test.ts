/**
 * The pure shape helpers F-04's preview relies on: boundary validation (§5.9.2),
 * the overview / write-back rendering (§5.8.1), which topics a cut folds
 * (§5.8.2), the exact blocks the summarizer's topics imply (§5.6.5), and the
 * merge that makes a marker and a summarizer topic weigh the same (§5.5.1).
 */
import { describe, expect, test } from "bun:test";
import {
  COMPACTION_SECTION_MAX_CHARS,
  COMPACTION_TOPIC_TITLE_MAX_CHARS,
  type CompactionOverview,
  type CompactionTopicDraft,
  foldedCompactionTopics,
  mergeCompactionBlocks,
  renderCompactionOverview,
  renderCompactionSummary,
  topicBlocksFromDrafts,
  validateCompactionTopics,
} from "@/backend/local/compaction-preview";
import type { LocalMessage } from "@/backend/local/local-message";
import { listTopicBlocks } from "@/backend/local/topic-compaction";

function userMessage(id: string, text = `text ${id}`): LocalMessage {
  return {
    id,
    role: "user",
    content: [{ type: "text", text }],
    timestamp: 0,
  } as LocalMessage;
}

function assistantMessage(id: string): LocalMessage {
  return {
    id,
    role: "assistant",
    content: [{ type: "text", text: `reply ${id}` }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.5",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop",
    timestamp: 0,
  } as LocalMessage;
}

/** Three exchanges: `u1,a1,u2,a2,u3,a3`. */
function conversation(): LocalMessage[] {
  return [
    userMessage("u1"),
    assistantMessage("a1"),
    userMessage("u2"),
    assistantMessage("a2"),
    userMessage("u3"),
    assistantMessage("a3"),
  ];
}

function draft(
  title: string,
  startMessageId: string,
  section = `section: ${title}`,
): CompactionTopicDraft {
  return { title, startMessageId, section };
}

function overview(
  overrides: Partial<CompactionOverview> = {},
): CompactionOverview {
  return {
    restricted: {
      open: "finish the migration",
      errors: "tried the shortcut, it failed",
      relationship: "steady",
      memoryIndex: "notes/plan.md — the plan",
    },
    narrative: "They talked through the migration.",
    ...overrides,
  };
}

describe("validateCompactionTopics", () => {
  test("accepts a continuous cover that starts at the first message", () => {
    expect(
      validateCompactionTopics(conversation(), [
        draft("one", "u1"),
        draft("two", "u2"),
        draft("three", "u3"),
      ]),
    ).toEqual([]);
  });

  test("reports an empty topic list and an empty context separately", () => {
    expect(validateCompactionTopics(conversation(), [])[0]?.code).toBe("empty");
    // Nothing to cover, nothing to complain about.
    expect(validateCompactionTopics([], [])).toEqual([]);
  });

  test("rejects a first topic that skips the start of the input", () => {
    const issues = validateCompactionTopics(conversation(), [
      draft("two", "u2"),
    ]);
    expect(issues.map((issue) => issue.code)).toContain(
      "starts_after_first_message",
    );
  });

  test("rejects an unknown start id", () => {
    const issues = validateCompactionTopics(conversation(), [
      draft("one", "u1"),
      draft("ghost", "missing"),
    ]);
    expect(issues.map((issue) => issue.code)).toEqual([
      "unknown_start_message",
    ]);
  });

  test("rejects a hole or an overlap between topics", () => {
    const hole = validateCompactionTopics(conversation(), [
      draft("one", "u1"),
      draft("one-again", "u1"),
    ]);
    expect(hole.map((issue) => issue.code)).toContain("not_after_previous");
    // A hole is not detectable from ids alone (both are real messages), but a
    // repeated id is the same "not strictly advancing" failure.
    const backwards = validateCompactionTopics(conversation(), [
      draft("one", "u1"),
      draft("three", "u3"),
      draft("two", "u2"),
    ]);
    expect(backwards.map((issue) => issue.code)).toContain(
      "not_after_previous",
    );
  });

  test("rejects a missing or overlong section and an overlong title", () => {
    const issues = validateCompactionTopics(conversation(), [
      draft("ok", "u1", ""),
      draft("x".repeat(COMPACTION_TOPIC_TITLE_MAX_CHARS + 1), "u2"),
      draft("long section", "u3", "y".repeat(COMPACTION_SECTION_MAX_CHARS + 1)),
    ]);
    expect(issues.map((issue) => issue.code)).toContain("missing_section");
    expect(issues.map((issue) => issue.code)).toContain("section_too_long");
    expect(issues.map((issue) => issue.code)).toContain("title_too_long");
  });

  test("rejects a missing title", () => {
    const issues = validateCompactionTopics(conversation(), [
      draft("   ", "u1"),
    ]);
    expect(issues.map((issue) => issue.code)).toContain("missing_title");
  });
});

describe("renderCompactionOverview", () => {
  test("renders the four restricted sections before the narrative", () => {
    const text = renderCompactionOverview(overview());
    expect(text).toContain("## 未决与后续\nfinish the migration");
    expect(text).toContain("## 错误与修正\ntried the shortcut, it failed");
    expect(text).toContain("## 关系与情绪线\nsteady");
    expect(text).toContain("## 记忆文件索引\nnotes/plan.md — the plan");
    expect(text).toContain("## 故事梗概\nThey talked through the migration.");
  });

  test("omits empty fields entirely, headings included", () => {
    // The whole-section degradation carries its prose in `narrative` and leaves
    // the restricted fields blank; an empty heading would read as lost content.
    const text = renderCompactionOverview({
      restricted: { open: "", errors: "  ", relationship: "", memoryIndex: "" },
      narrative: "one whole-section summary",
    });
    expect(text).toBe("## 故事梗概\none whole-section summary");
  });

  test("renders nothing for a fully empty overview", () => {
    expect(
      renderCompactionOverview({
        restricted: { open: "", errors: "", relationship: "", memoryIndex: "" },
        narrative: "",
      }),
    ).toBe("");
  });
});

describe("renderCompactionSummary", () => {
  test("carries only the folded sections after the overview", () => {
    const text = renderCompactionSummary({
      overview: overview(),
      folded: [draft("one", "u1"), draft("two", "u2")],
    });
    expect(text.startsWith("## 未决与后续")).toBe(true);
    expect(text).toContain("## 折叠话题");
    expect(text).toContain("### one\nsection: one");
    expect(text).toContain("### two\nsection: two");
  });

  test("omits the folded-section block when nothing was folded", () => {
    const text = renderCompactionSummary({
      overview: overview(),
      folded: [],
    });
    expect(text).not.toContain("折叠话题");
    expect(text).toContain("## 故事梗概");
  });
});

describe("foldedCompactionTopics", () => {
  test("takes the drafts whose start falls inside the summarized region", () => {
    const messages = conversation();
    const topics = [
      draft("one", "u1"),
      draft("two", "u2"),
      draft("three", "u3"),
    ];
    // Cut at u2 (index 2): topic one starts before it, two and three do not.
    const folded = foldedCompactionTopics(messages, topics, 2);
    expect(folded.map((topic) => topic.title)).toEqual(["one"]);
  });

  test("counts a topic the cut lands inside", () => {
    const messages = conversation();
    const topics = [draft("one", "u1"), draft("two", "u2")];
    // Cut at a1 (index 1) is inside topic one.
    expect(
      foldedCompactionTopics(messages, topics, 1).map((topic) => topic.title),
    ).toEqual(["one"]);
  });
});

describe("topicBlocksFromDrafts", () => {
  test("projects exact boundaries with the section attached", () => {
    const messages = conversation();
    const blocks = topicBlocksFromDrafts(messages, [
      draft("one", "u1"),
      draft("two", "u2"),
      draft("three", "u3"),
    ]);

    expect(blocks.map((block) => block.title)).toEqual(["one", "two", "three"]);
    expect(blocks.map((block) => block.boundaryMessageId)).toEqual([
      "u1",
      "u2",
      "u3",
    ]);
    expect(blocks.map((block) => block.index)).toEqual([1, 2, 3]);
    expect(blocks.map((block) => block.startIndex)).toEqual([0, 2, 4]);
    expect(blocks.map((block) => block.endIndex)).toEqual([2, 4, 6]);
    expect(blocks.map((block) => block.summary)).toEqual([
      "section: one",
      "section: two",
      "section: three",
    ]);
    // A summarizer block is exact: no rewind, and its anchoring marker (once
    // written) lands on the next topic's first message.
    expect(blocks.every((block) => block.rewindTurns === 0)).toBe(true);
    expect(blocks.map((block) => block.anchorMessageId)).toEqual([
      "u2",
      "u3",
      null,
    ]);
    expect(blocks.every((block) => block.createdBy === "summarizer")).toBe(
      true,
    );
    expect(blocks.every((block) => block.markerId === null)).toBe(true);
  });
});

describe("mergeCompactionBlocks", () => {
  /**
   * §5.5.1: a summarizer topic weighs the same as a marker someone wrote. The
   * picker's table is the union of both, so neither can erase the other.
   */
  test("keeps both a human marker's boundary and the summarizer's", () => {
    const messages = conversation();
    // A user marker ending at u2. `rewindTurns: 0` keeps the boundary exact; a
    // rewind would pull it onto the start of the context and absorb the title.
    const markerTable = listTopicBlocks(
      messages,
      [
        {
          id: "m1",
          title: "the human's topic",
          createdBy: "user",
          anchorMessageId: "u2",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      { rewindTurns: 0 },
    );
    const draftTable = topicBlocksFromDrafts(messages, [
      draft("one", "u1"),
      draft("two", "u3"),
    ]);

    const merged = mergeCompactionBlocks(messages, [markerTable, draftTable]);

    // Three points, three blocks: the marker's boundary splits the summarizer's
    // first topic in two, and each half keeps the title that ends it.
    expect(merged.map((block) => block.title)).toEqual([
      "the human's topic",
      "one",
      "two",
    ]);
    expect(merged.map((block) => block.index)).toEqual([1, 2, 3]);
    expect(merged.map((block) => block.endIndex)).toEqual([2, 4, 6]);
  });

  test("splits a summarizer topic that spans a marker into two blocks", () => {
    const messages = conversation();
    const markerTable = listTopicBlocks(
      messages,
      [
        {
          id: "m1",
          title: "middle",
          createdBy: "agent",
          anchorMessageId: "a2",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      { rewindTurns: 0 },
    );
    // One topic covering everything: it crosses the marker, and the merge
    // resolves the conflict by letting the marker end a block — the overlap is
    // resolved by the table rather than by refusing the summarizer's answer.
    const draftTable = topicBlocksFromDrafts(messages, [draft("whole", "u1")]);

    const merged = mergeCompactionBlocks(messages, [markerTable, draftTable]);

    expect(merged.map((block) => block.title)).toEqual(["middle", "whole"]);
    // The marker's boundary snaps to the start of the user turn that holds its
    // anchor (`a2` is in the turn starting at `u2`, index 2).
    expect(merged.map((block) => block.startIndex)).toEqual([0, 2]);
    expect(merged.map((block) => block.endIndex)).toEqual([2, 6]);
    // The summarizer's own record still names the part after the marker.
    expect(merged[1]?.summary).toBe("section: whole");
  });

  test("a single table comes back unchanged (renumbered from 1)", () => {
    const messages = conversation();
    const draftTable = topicBlocksFromDrafts(messages, [
      draft("one", "u1"),
      draft("two", "u3"),
    ]);

    const merged = mergeCompactionBlocks(messages, [draftTable]);

    expect(merged.map((block) => block.title)).toEqual(["one", "two"]);
    expect(merged.map((block) => block.endIndex)).toEqual([4, 6]);
    expect(merged.map((block) => block.messageCount)).toEqual([4, 2]);
  });

  test("a table that ends before the context keeps the trailing current topic", () => {
    const messages = conversation();
    // Only block 1 of the marker table ends inside the context; the rest of the
    // messages are not covered by any boundary and must still be pickable.
    const markerTable = listTopicBlocks(
      messages,
      [
        {
          id: "m1",
          title: "early",
          createdBy: "user",
          anchorMessageId: "u2",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      { rewindTurns: 0 },
    );
    const partial = markerTable.slice(0, 1);

    const merged = mergeCompactionBlocks(messages, [partial]);

    expect(merged.map((block) => block.title)).toEqual(["early", null]);
    expect(merged.at(-1)?.endIndex).toBe(messages.length);
  });
});
