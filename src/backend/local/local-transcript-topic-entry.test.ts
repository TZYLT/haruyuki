/**
 * The topic-marker record's shape: the `createdBy` union F-04 extends, and the
 * guard's forward-compatibility rule (an unknown source is skipped, never
 * coerced).
 */
import { describe, expect, test } from "bun:test";
import {
  isLocalTranscriptTopicEntry,
  type LocalTranscriptTopicEntry,
} from "@/backend/local/local-transcript-topic-entry";

function topicRow(
  overrides: Partial<Record<keyof LocalTranscriptTopicEntry, unknown>> = {},
): Record<string, unknown> {
  return {
    type: "topic",
    id: "topic-1",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    title: "first",
    createdBy: "agent",
    anchorMessageId: "msg-1",
    turnsSincePrevious: 1,
    ...overrides,
  };
}

describe("isLocalTranscriptTopicEntry", () => {
  test("admits every createdBy source, the summarizer included", () => {
    for (const createdBy of ["agent", "user", "summarizer"]) {
      expect(isLocalTranscriptTopicEntry(topicRow({ createdBy }))).toBe(true);
    }
  });

  test("carries a section as the optional summary", () => {
    const row = topicRow({ createdBy: "summarizer", summary: "what happened" });
    expect(isLocalTranscriptTopicEntry(row)).toBe(true);
    expect((row as unknown as LocalTranscriptTopicEntry).summary).toBe(
      "what happened",
    );
    expect(isLocalTranscriptTopicEntry(topicRow({ summary: undefined }))).toBe(
      true,
    );
    expect(isLocalTranscriptTopicEntry(topicRow({ summary: 42 }))).toBe(false);
  });

  test("rejects an unknown source instead of guessing", () => {
    // An older build reading a newer row must skip it, not fold it into the
    // wrong source (requirement §7).
    expect(isLocalTranscriptTopicEntry(topicRow({ createdBy: "robot" }))).toBe(
      false,
    );
    expect(
      isLocalTranscriptTopicEntry(topicRow({ createdBy: undefined })),
    ).toBe(false);
  });

  test("requires the anchor and turn-count bookkeeping", () => {
    expect(
      isLocalTranscriptTopicEntry(topicRow({ anchorMessageId: null })),
    ).toBe(true);
    expect(isLocalTranscriptTopicEntry(topicRow({ anchorMessageId: 7 }))).toBe(
      false,
    );
    expect(
      isLocalTranscriptTopicEntry(topicRow({ turnsSincePrevious: "1" })),
    ).toBe(false);
    expect(isLocalTranscriptTopicEntry(topicRow({ title: 1 }))).toBe(false);
    expect(isLocalTranscriptTopicEntry(topicRow({ type: "message" }))).toBe(
      false,
    );
  });
});
