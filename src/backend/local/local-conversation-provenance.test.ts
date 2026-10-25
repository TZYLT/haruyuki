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
    expect(forkContextMode(undefined)).toBe("inherited-history");
  });

  test("rejects inherited-context until F-03 can select context", () => {
    expect(() => forkContextMode("inherited-context")).toThrow(
      "not_supported: inherited-context requires F-03",
    );
  });

  test("passes standalone through", () => {
    expect(forkContextMode("standalone")).toBe("standalone");
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
