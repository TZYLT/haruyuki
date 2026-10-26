import { describe, expect, test } from "bun:test";
import {
  DEFAULT_FORK_CONTEXT_MODE,
  forkContextMode,
  forkedConversationProvenance,
} from "@/backend/local/local-conversation-provenance";
import type { StoredMessage } from "@/backend/local/local-types";

function storedMessage(id: string): StoredMessage {
  return {
    id,
    message_type: "user_message",
    date: "2026-01-01T00:00:00.000Z",
    agent_id: "agent-1",
    conversation_id: "local-conv-fork",
  } as StoredMessage;
}

describe("forkContextMode", () => {
  test("defaults a fork to inherited-history", () => {
    expect(DEFAULT_FORK_CONTEXT_MODE).toBe("inherited-history");
    expect(forkContextMode()).toBe("inherited-history");
    expect(forkContextMode({})).toBe("inherited-history");
  });

  test("accepts inherited-context, the F-03 context-only mode", () => {
    expect(forkContextMode({ contextMode: "inherited-context" })).toBe(
      "inherited-context",
    );
  });

  test("rejects a message cutoff combined with inherited-context", () => {
    // The two selections answer different questions: one copies the current
    // window, the other cuts the transcript at a projected row.
    expect(() =>
      forkContextMode({
        contextMode: "inherited-context",
        messageId: "local-msg-1",
      }),
    ).toThrow(
      "invalid_argument: context_mode inherited-context selects the current context",
    );
  });

  test("accepts a message cutoff for inherited-history", () => {
    expect(
      forkContextMode({
        contextMode: "inherited-history",
        messageId: "local-msg-1",
      }),
    ).toBe("inherited-history");
  });

  test("passes standalone through", () => {
    expect(forkContextMode({ contextMode: "standalone" })).toBe("standalone");
  });

  test("rejects an unknown mode", () => {
    expect(() => forkContextMode({ contextMode: "unknown" as never })).toThrow(
      "Unknown conversation context_mode: unknown",
    );
  });
});

describe("forkedConversationProvenance", () => {
  test("records the projected size and the last projected id", () => {
    expect(
      forkedConversationProvenance({
        projectedMessages: [storedMessage("a"), storedMessage("b")],
        sourceConversationId: "local-conv-source",
        contextMode: "inherited-history",
      }),
    ).toEqual({
      origin: "unknown",
      parent_conversation_id: "local-conv-source",
      context_mode: "inherited-history",
      inherited_message_count: 2,
      inherited_through_message_id: "b",
    });
  });

  test("an empty fork has no cursor but still names its parent", () => {
    expect(
      forkedConversationProvenance({
        projectedMessages: [],
        sourceConversationId: "local-conv-source",
        contextMode: "inherited-history",
      }),
    ).toEqual({
      origin: "unknown",
      parent_conversation_id: "local-conv-source",
      context_mode: "inherited-history",
      inherited_message_count: 0,
      inherited_through_message_id: null,
    });
  });

  test("honors an explicit origin and parent", () => {
    expect(
      forkedConversationProvenance({
        projectedMessages: [],
        sourceConversationId: "local-conv-source",
        parentConversationId: "local-conv-parent",
        origin: "reflection",
        contextMode: "standalone",
      }),
    ).toMatchObject({
      origin: "reflection",
      parent_conversation_id: "local-conv-parent",
      context_mode: "standalone",
    });
  });
});
