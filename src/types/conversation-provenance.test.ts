import { describe, expect, test } from "bun:test";
import {
  isConversationContextMode,
  isConversationOrigin,
  readContextMessageCount,
  readConversationProvenance,
} from "@/types/conversation-provenance";

describe("readConversationProvenance", () => {
  test("defaults a legacy record to unknown and adds nothing else", () => {
    const provenance = readConversationProvenance({
      id: "local-conv-legacy",
      agent_id: "agent-1",
    });

    expect(provenance).toEqual({ origin: "unknown" });
  });

  test("canonicalizes a persisted record", () => {
    expect(
      readConversationProvenance({
        origin: "reflection",
        parent_conversation_id: "local-conv-parent",
        context_mode: "inherited-history",
        inherited_message_count: 12,
        inherited_through_message_id: "local-msg-3:assistant:1",
      }),
    ).toEqual({
      origin: "reflection",
      parent_conversation_id: "local-conv-parent",
      context_mode: "inherited-history",
      inherited_message_count: 12,
      inherited_through_message_id: "local-msg-3:assistant:1",
    });
  });

  test("drops unrecognized values instead of guessing", () => {
    const provenance = readConversationProvenance({
      origin: "sleeptime",
      context_mode: "inherited-everything",
      parent_conversation_id: 7,
      inherited_message_count: -3,
      inherited_through_message_id: "",
    });

    expect(provenance).toEqual({ origin: "unknown" });
  });

  test("keeps explicit nulls, which mark a standalone create", () => {
    expect(
      readConversationProvenance({
        origin: "external",
        parent_conversation_id: null,
        inherited_message_count: null,
        inherited_through_message_id: null,
      }),
    ).toEqual({
      origin: "external",
      parent_conversation_id: null,
      inherited_message_count: null,
      inherited_through_message_id: null,
    });
  });

  test("truncates a fractional count and ignores non-records", () => {
    expect(
      readConversationProvenance({ inherited_message_count: 4.9 }),
    ).toMatchObject({ inherited_message_count: 4 });
    expect(readConversationProvenance(null)).toEqual({ origin: "unknown" });
    expect(readConversationProvenance("reflection")).toEqual({
      origin: "unknown",
    });
  });
});

describe("provenance guards", () => {
  test("accept every declared value and reject anything else", () => {
    for (const origin of [
      "reflection",
      "dream",
      "background",
      "external",
      "unknown",
    ]) {
      expect(isConversationOrigin(origin)).toBe(true);
    }
    expect(isConversationOrigin("sleeptime")).toBe(false);
    expect(isConversationOrigin(undefined)).toBe(false);

    for (const mode of [
      "inherited-context",
      "inherited-history",
      "standalone",
    ]) {
      expect(isConversationContextMode(mode)).toBe(true);
    }
    expect(isConversationContextMode("inherited-everything")).toBe(false);
  });
});

describe("readContextMessageCount", () => {
  test("counts the in-context list and tolerates a missing one", () => {
    expect(
      readContextMessageCount({ in_context_message_ids: ["a", "b"] }),
    ).toBe(2);
    expect(readContextMessageCount({ in_context_message_ids: [] })).toBe(0);
    expect(readContextMessageCount({ id: "local-conv-1" })).toBe(0);
    expect(readContextMessageCount(undefined)).toBe(0);
  });
});
