/**
 * `/topic show`'s display tiers: a terminal budget is not a token budget, but it is
 * still a budget — a 40k-character topic printed whole is unreadable and pushes the
 * rest of the transcript off the screen.
 *
 * These are pure tests on a synthetic span so each tier can be reached without
 * building a forty-thousand-character conversation: the projection that produces the
 * text is covered in `backend/local/topic-recall.test.ts`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  renderTopicRecall,
  TOPIC_RECALL_FULL_MAX_CHARS,
  type TopicRecallMessage,
  type TopicRecallSpan,
} from "@/backend/local/topic-recall";
import {
  formatTopicShowOutput,
  TOPIC_SHOW_DISPLAY_MAX_CHARS,
  TOPIC_SHOW_EDGE_CHARS,
  TOPIC_SHOW_FULL_DISPLAY_MAX_CHARS,
  TOPIC_SHOW_OUTLINE_MESSAGE_PREVIEW_CHARS,
  topicShowDisplayBudget,
  writeTopicShowFile,
} from "@/cli/helpers/topic-show";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "topic-show-"));
  temporaryDirectories.push(directory);
  return directory;
}

const START = Date.parse("2026-10-27T09:00:00.000Z");

function makeSpan(input: {
  count: number;
  charsPerMessage: number;
}): TopicRecallSpan {
  const messages: TopicRecallMessage[] = [];
  for (let index = 1; index <= input.count; index += 1) {
    messages.push({
      position: index,
      role: index % 2 === 0 ? "assistant" : "user",
      text: `MESSAGE-${String(index).padStart(2, "0")} ${"z".repeat(
        input.charsPerMessage,
      )}`,
    });
  }
  return {
    topicId: "t1",
    conversationId: "default",
    title: "A very long topic",
    section: "How releases are cut.\nSecond line is dropped by the outline.",
    createdBy: "agent",
    createdAt: new Date(START).toISOString(),
    evicted: false,
    messages,
    estimatedTokens: input.count * 120,
    startsAt: new Date(START).toISOString(),
    endsAt: new Date(START + input.count * 60_000).toISOString(),
  };
}

function projectSpan(span: TopicRecallSpan) {
  return renderTopicRecall({
    span,
    tier: "full",
    maxChars: Number.POSITIVE_INFINITY,
  });
}

describe("topicShowDisplayBudget", () => {
  test("is 8k normally and 30k with --full", () => {
    expect(topicShowDisplayBudget(false)).toBe(TOPIC_SHOW_DISPLAY_MAX_CHARS);
    expect(topicShowDisplayBudget(true)).toBe(
      TOPIC_SHOW_FULL_DISPLAY_MAX_CHARS,
    );
    expect(TOPIC_SHOW_DISPLAY_MAX_CHARS).toBe(TOPIC_RECALL_FULL_MAX_CHARS);
  });
});

describe("formatTopicShowOutput", () => {
  test("prints a span under the ceiling verbatim", () => {
    const span = makeSpan({ count: 4, charsPerMessage: 40 });
    const result = projectSpan(span);

    const output = formatTopicShowOutput({ span, result, full: false });

    // The whole point of the shared projection: no wrapper, no decoration.
    expect(output).toBe(result.text);
  });

  test("head-and-tail a span between the ceiling and the outline threshold", () => {
    const span = makeSpan({ count: 20, charsPerMessage: 800 });
    const result = projectSpan(span);
    expect(result.chars).toBeGreaterThan(TOPIC_SHOW_DISPLAY_MAX_CHARS);

    const output = formatTopicShowOutput({
      span,
      result,
      full: false,
      overflowPath: "/tmp/topic-show-abc.txt",
    });

    expect(output).toContain("characters not shown");
    expect(output).toContain("/tmp/topic-show-abc.txt");
    expect(output).toContain(result.text.slice(0, TOPIC_SHOW_EDGE_CHARS));
    expect(output).toContain(result.text.slice(-TOPIC_SHOW_EDGE_CHARS));
    // The middle is genuinely gone — the point of cutting at all.
    expect(output).not.toContain("MESSAGE-10");
  });

  test("--full prints the same span whole", () => {
    const span = makeSpan({ count: 20, charsPerMessage: 800 });
    const result = projectSpan(span);

    const output = formatTopicShowOutput({ span, result, full: true });

    expect(result.chars).toBeLessThan(TOPIC_SHOW_FULL_DISPLAY_MAX_CHARS);
    expect(output).toBe(result.text);
  });

  test("an outline past the threshold, with the size, the span and both ends", () => {
    const span = makeSpan({ count: 40, charsPerMessage: 1000 });
    const result = projectSpan(span);
    expect(result.chars).toBeGreaterThan(TOPIC_SHOW_FULL_DISPLAY_MAX_CHARS);

    const output = formatTopicShowOutput({
      span,
      result,
      full: true,
      overflowPath: "/tmp/topic-show-big.txt",
    });

    expect(output).toContain(result.header);
    expect(output).toContain(`size: 40 messages · ~4800 tokens`);
    expect(output).toContain("span: 2026-10-27 09:00 → 2026-10-27 09:40 UTC");
    expect(output).toContain("section: How releases are cut.");
    expect(output).toContain("first messages:");
    expect(output).toContain("last messages:");
    expect(output).toContain("1. user: MESSAGE-01");
    expect(output).toContain("40. assistant: MESSAGE-40");
    expect(output).toContain("/tmp/topic-show-big.txt");
    // An outline quotes, it does not print: no message runs to its full length.
    expect(output).not.toContain(
      "z".repeat(TOPIC_SHOW_OUTLINE_MESSAGE_PREVIEW_CHARS),
    );
    expect(output).not.toContain("MESSAGE-20");
  });

  test("says why there is no file when overflow is switched off", () => {
    const span = makeSpan({ count: 20, charsPerMessage: 800 });
    const result = projectSpan(span);

    const output = formatTopicShowOutput({ span, result, full: false });

    expect(output).toContain("HARUYUKI_TOOL_OVERFLOW_TO_FILE=false");
    expect(output).not.toContain("topic-show-");
  });

  test("a span that fits never mentions a file", () => {
    const span = makeSpan({ count: 3, charsPerMessage: 20 });
    const result = projectSpan(span);

    const output = formatTopicShowOutput({ span, result, full: false });

    expect(output).not.toContain("overflow");
    expect(output).not.toContain("characters not shown");
  });
});

describe("writeTopicShowFile", () => {
  test("writes the complete text to the path it is given", () => {
    const directory = createTemporaryDirectory();
    const path = join(directory, "nested", "topic.txt");

    const written = writeTopicShowFile(path, "TOPIC BODY");

    expect(written).toBe(path);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("TOPIC BODY");
  });
});
