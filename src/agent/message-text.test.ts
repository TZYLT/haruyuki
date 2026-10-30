/**
 * `agent/message-text.ts` — the shared "what a person saw" projection (F-06
 * C-36).
 *
 * The rules are the product contract `SessionRead` promises: user and assistant
 * text stays, reasoning and tool output go, injected harness blocks go, and a
 * row with nothing visible does not become an empty line. The tool's own tests
 * use this module; these cases pin the rule itself so a change to it is visible
 * independently of paging.
 */
import { describe, expect, test } from "bun:test";
import {
  cleanVisibleText,
  projectVisibleMessages,
  visibleMessageText,
  visibleTextFromContent,
} from "@/agent/message-text";

describe("cleanVisibleText", () => {
  test("normalizes line endings and trailing spaces", () => {
    expect(cleanVisibleText("a \r\nb\t\r\n\r\n\r\nc")).toBe("a\nb\n\nc");
  });

  test("strips paired reminder/alert/notification blocks but keeps the text", () => {
    const text =
      "before <system-reminder>internal note</system-reminder> " +
      "<system-alert>old alert</system-alert>after" +
      "<task-notification>done</task-notification>";
    expect(cleanVisibleText(text)).toBe("before  after");
  });

  test("keeps a quoted opening tag; only paired blocks go", () => {
    expect(cleanVisibleText("quote: <system-reminder> is a tag")).toBe(
      "quote: <system-reminder> is a tag",
    );
  });

  test("returns an empty string when only harness noise is left", () => {
    expect(
      cleanVisibleText("<system-reminder>only this</system-reminder>"),
    ).toBe("");
  });
});

describe("visibleTextFromContent", () => {
  test("joins the text parts of the SDK content union", () => {
    expect(
      visibleTextFromContent([
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ]),
    ).toBe("first\nsecond");
  });

  test("drops thinking, tool-call and image parts", () => {
    expect(
      visibleTextFromContent([
        { type: "thinking", thinking: "secret" },
        { type: "text", text: "kept" },
        { type: "toolCall", id: "t1", name: "Read" },
        { type: "image", source: { type: "base64", data: "..." } },
      ]),
    ).toBe("kept");
  });

  test("accepts a plain string and tolerates unknown shapes", () => {
    expect(visibleTextFromContent("plain")).toBe("plain");
    expect(visibleTextFromContent(undefined)).toBe("");
    expect(visibleTextFromContent([42, null])).toBe("");
  });
});

describe("visibleMessageText", () => {
  test("projects user and assistant text messages", () => {
    expect(
      visibleMessageText({
        message_type: "user_message",
        content: [{ type: "text", text: "hello" }],
      }),
    ).toEqual({ role: "user", text: "hello" });
    expect(
      visibleMessageText({
        message_type: "assistant_message",
        content: [{ type: "text", text: "hi" }],
      }),
    ).toEqual({ role: "assistant", text: "hi" });
  });

  test("drops reasoning, tool-call and tool-result rows whole", () => {
    for (const messageType of [
      "reasoning_message",
      "hidden_reasoning_message",
      "tool_call_message",
      "approval_request_message",
      "tool_return_message",
    ]) {
      expect(
        visibleMessageText({
          message_type: messageType,
          content: [{ type: "text", text: "machine output" }],
          reasoning: "why",
          tool_return: "stdout",
        }),
      ).toBeNull();
    }
  });

  test("keeps a compaction summary as visible text", () => {
    expect(
      visibleMessageText({
        message_type: "summary_message",
        summary: "Earlier: the user set up the project.",
      }),
    ).toEqual({
      role: "summary",
      text: "Earlier: the user set up the project.",
    });
  });

  test("drops a message left with no visible text", () => {
    expect(
      visibleMessageText({
        message_type: "assistant_message",
        content: [],
      }),
    ).toBeNull();
    expect(
      visibleMessageText({
        message_type: "user_message",
        content: "<system-reminder>only noise</system-reminder>",
      }),
    ).toBeNull();
  });

  test("falls back to `role` only when message_type is absent", () => {
    expect(
      visibleMessageText({
        role: "user",
        content: [{ type: "text", text: "fallback" }],
      }),
    ).toEqual({ role: "user", text: "fallback" });
    expect(visibleMessageText({ message_type: "event_message" })).toBeNull();
  });
});

describe("projectVisibleMessages", () => {
  test("keeps order and skips invisible rows", () => {
    expect(
      projectVisibleMessages([
        { message_type: "user_message", content: "one" },
        { message_type: "reasoning_message", reasoning: "why" },
        { message_type: "tool_return_message", tool_return: "out" },
        { message_type: "assistant_message", content: "two" },
      ]),
    ).toEqual([
      { role: "user", text: "one" },
      { role: "assistant", text: "two" },
    ]);
  });
});
