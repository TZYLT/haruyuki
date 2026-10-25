/**
 * The detail view's row projection (F-01, 《44-1》§5.3.6).
 *
 * Every branch here decides what the user sees for a stored message, so the
 * fixtures are wire-shaped and deliberately partial: the point of the projector is
 * that it tolerates the shapes the log actually holds (a call whose arguments are
 * unparsable, a return that arrived as `tool_returns`, a return that only has
 * `stdout`), and a fully typed fixture would test the SDK instead.
 *
 * The two rules the requirement states and these tests pin: a tool call is one
 * line with truncated arguments, a tool return is one folded line carrying its
 * status, and reasoning is absent unless the caller asks for it.
 */
import { describe, expect, test } from "bun:test";
import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import {
  collapseHiddenSessionLine,
  formatHiddenSessionRowTime,
  HIDDEN_SESSION_ARGUMENT_PREVIEW,
  HIDDEN_SESSION_RESULT_PREVIEW,
  projectHiddenSessionMessage,
  projectHiddenSessionRows,
} from "@/cli/helpers/hidden-session-rows";

const DATE = "2026-10-25T12:01:33.123Z";

/**
 * A stored message as the log holds it.
 *
 * The cast is the point: `Message` is a union of complete wire shapes and a log
 * row is routinely a *partial* one, so a fixture has to be built as data.
 */
function wire(id: string, fields: Record<string, unknown>): Message {
  const value: Record<string, unknown> = {
    id,
    date: DATE,
    message_type: "assistant_message",
    content: "",
    ...fields,
  };
  return value as unknown as Message;
}

function textOf(message: Message): string[] {
  return projectHiddenSessionMessage(message).map((row) => row.text);
}

describe("text rows", () => {
  test("a user message carries role, time and text", () => {
    const [row] = projectHiddenSessionMessage(
      wire("m1", { message_type: "user_message", content: "hello" }),
    );

    expect(row).toMatchObject({
      id: "m1",
      kind: "user",
      role: "user",
      time: "10-25 12:01",
      text: "hello",
      detail: "hello",
      collapsible: false,
    });
  });

  test("an assistant message joins its content parts", () => {
    const [row] = projectHiddenSessionMessage(
      wire("m2", {
        message_type: "assistant_message",
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      }),
    );

    expect(row?.kind).toBe("assistant");
    expect(row?.text).toBe("first\nsecond");
  });

  test("a non-text part still renders as something", () => {
    const [row] = projectHiddenSessionMessage(
      wire("m3", {
        message_type: "user_message",
        content: [{ type: "image", source: { type: "base64" } }],
      }),
    );

    expect(row?.text).toBe("[image]");
  });

  test("an empty message is marked, not blank", () => {
    expect(textOf(wire("m4", { message_type: "assistant_message" }))).toEqual([
      "(empty)",
    ]);
  });

  test("a system message renders as its own role", () => {
    const [row] = projectHiddenSessionMessage(
      wire("m5", { message_type: "system_message", content: "system text" }),
    );

    expect(row).toMatchObject({
      kind: "system",
      role: "system",
      text: "system text",
    });
  });

  test("a summary message renders as a summary row", () => {
    const [row] = projectHiddenSessionMessage(
      wire("m6", { message_type: "summary_message", summary: "compacted" }),
    );

    expect(row).toMatchObject({
      kind: "summary",
      role: "summary",
      text: "compacted",
    });
  });

  test("an event message names the event", () => {
    expect(
      textOf(
        wire("m7", {
          message_type: "event_message",
          event_type: "compaction",
          event_data: {},
        }),
      ),
    ).toEqual(["event: compaction"]);
  });

  test("an unknown type still produces a row", () => {
    const [row] = projectHiddenSessionMessage(
      wire("m8", {
        message_type: "approval_response_message",
        content: "approved",
      }),
    );

    expect(row).toMatchObject({
      kind: "other",
      role: "approval_response_message",
      text: "approved",
    });
  });

  test("an unknown type with no readable content is still a row", () => {
    expect(
      textOf(wire("m9", { message_type: "mystery_message", content: null })),
    ).toEqual(["(no content)"]);
  });
});

describe("reasoning rows", () => {
  test("reasoning is hidden by default", () => {
    expect(
      projectHiddenSessionMessage(
        wire("r1", {
          message_type: "reasoning_message",
          reasoning: "thinking",
        }),
      ),
    ).toEqual([]);
  });

  test("`r` shows reasoning as its own row", () => {
    const [row] = projectHiddenSessionMessage(
      wire("r1", { message_type: "reasoning_message", reasoning: "thinking" }),
      { showReasoning: true },
    );

    expect(row).toMatchObject({
      kind: "reasoning",
      role: "reasoning",
      text: "thinking",
    });
  });

  test("withheld reasoning says why it is empty", () => {
    const [row] = projectHiddenSessionMessage(
      wire("r2", {
        message_type: "hidden_reasoning_message",
        state: "redacted",
      }),
      { showReasoning: true },
    );

    expect(row?.text).toBe("(redacted reasoning)");
  });
});

describe("tool call rows", () => {
  test("a call is one line with its arguments, the detail holds the formatted JSON", () => {
    const [row] = projectHiddenSessionMessage(
      wire("t1", {
        message_type: "tool_call_message",
        tool_call: {
          name: "bash",
          arguments: '{"command":"ls -la"}',
          tool_call_id: "tc1",
        },
      }),
    );

    expect(row).toMatchObject({
      kind: "tool_call",
      role: "tool",
      text: '→ bash({"command":"ls -la"})',
      toolName: "bash",
      toolCallId: "tc1",
      collapsible: true,
    });
    expect(row?.detail).toBe('{\n  "command": "ls -la"\n}');
  });

  test("long arguments are cut on the collapsed line only", () => {
    const argumentsText = JSON.stringify({ command: "x".repeat(200) });
    const [row] = projectHiddenSessionMessage(
      wire("t2", {
        message_type: "tool_call_message",
        tool_call: { name: "bash", arguments: argumentsText },
      }),
    );

    expect(row?.text).toContain("...");
    expect(row?.text.length).toBeLessThan(argumentsText.length);
    expect(row?.text.length).toBeLessThanOrEqual(
      HIDDEN_SESSION_ARGUMENT_PREVIEW + "→ bash()".length,
    );
    expect(row?.detail).toBe(
      JSON.stringify(JSON.parse(argumentsText), null, 2),
    );
  });

  test("a message carrying several calls yields one row each", () => {
    const rows = projectHiddenSessionMessage(
      wire("t3", {
        message_type: "tool_call_message",
        tool_calls: [
          { name: "bash", arguments: "{}", tool_call_id: "a" },
          { name: "read", arguments: "{}", tool_call_id: "b" },
        ],
      }),
    );

    expect(rows.map((row) => row.toolName)).toEqual(["bash", "read"]);
    expect(rows.map((row) => row.toolCallId)).toEqual(["a", "b"]);
  });

  test("unparsable arguments render as written instead of throwing", () => {
    const [row] = projectHiddenSessionMessage(
      wire("t4", {
        message_type: "tool_call_message",
        tool_call: { name: "write", arguments: '{"path": "src/' },
      }),
    );

    expect(row?.text).toContain('{"path": "src/');
    expect(row?.detail).toBe('{"path": "src/');
  });

  test("a call with no payload is still a row", () => {
    expect(textOf(wire("t5", { message_type: "tool_call_message" }))).toEqual([
      "→ (no tool call payload)",
    ]);
  });
});

describe("tool result rows", () => {
  test("a result folds to one line with its status", () => {
    const [row] = projectHiddenSessionMessage(
      wire("t6", {
        message_type: "tool_return_message",
        tool_returns: [
          {
            tool_call_id: "tc1",
            status: "success",
            tool_return: "line one\nline two",
          },
        ],
      }),
    );

    expect(row).toMatchObject({
      kind: "tool_result",
      role: "tool",
      status: "success",
      text: "← success · line one",
      toolCallId: "tc1",
      collapsible: true,
    });
    expect(row?.detail).toBe("line one\nline two");
  });

  test("a short single-line result is not collapsible", () => {
    const [row] = projectHiddenSessionMessage(
      wire("t7", {
        message_type: "tool_return_message",
        tool_returns: [{ status: "error", tool_return: "boom" }],
      }),
    );

    expect(row).toMatchObject({
      status: "error",
      text: "← error · boom",
      collapsible: false,
    });
  });

  test("a long first line is cut on the collapsed line", () => {
    const output = "y".repeat(300);
    const [row] = projectHiddenSessionMessage(
      wire("t8", {
        message_type: "tool_return_message",
        tool_returns: [{ status: "success", tool_return: output }],
      }),
    );

    expect(row?.text.endsWith("...")).toBe(true);
    expect(row?.text.length).toBeLessThanOrEqual(
      HIDDEN_SESSION_RESULT_PREVIEW + "← success · ".length,
    );
    expect(row?.detail).toBe(output);
  });

  test("the deprecated single shape still reports its status", () => {
    const [row] = projectHiddenSessionMessage(
      wire("t9", {
        message_type: "tool_return_message",
        status: "error",
        tool_call_id: "tc9",
        tool_return: "failed hard",
      }),
    );

    expect(row).toMatchObject({
      status: "error",
      text: "← error · failed hard",
      toolCallId: "tc9",
    });
  });

  test("stdout and stderr are both behind the folded line", () => {
    const [row] = projectHiddenSessionMessage(
      wire("t10", {
        message_type: "tool_return_message",
        stdout: ["out line"],
        stderr: ["err line"],
      }),
    );

    expect(row?.text).toBe("← success · out line");
    expect(row?.detail).toBe("out line\nerr line");
  });

  test("a return with no payload is still a row", () => {
    expect(
      textOf(wire("t11", { message_type: "tool_return_message" })),
    ).toEqual(["← (no tool return payload)"]);
  });
});

describe("row list projection", () => {
  test("keeps message order and drops reasoning unless asked", () => {
    const messages = [
      wire("m1", { message_type: "user_message", content: "hi" }),
      wire("m2", { message_type: "reasoning_message", reasoning: "think" }),
      wire("m3", { message_type: "assistant_message", content: "hello" }),
    ];

    expect(projectHiddenSessionRows(messages).map((row) => row.id)).toEqual([
      "m1",
      "m3",
    ]);
    expect(
      projectHiddenSessionRows(messages, { showReasoning: true }).map(
        (row) => row.id,
      ),
    ).toEqual(["m1", "m2", "m3"]);
  });

  test("non-messages are skipped rather than projected", () => {
    const messages = [null, "nope", { id: 5 }] as unknown as Message[];

    expect(projectHiddenSessionRows(messages)).toEqual([]);
  });
});

describe("pure formatting helpers", () => {
  test("collapseHiddenSessionLine folds whitespace", () => {
    expect(collapseHiddenSessionLine("  a\n\n   b  ")).toBe("a b");
  });

  test("collapseHiddenSessionLine cuts past the limit with three dots", () => {
    expect(collapseHiddenSessionLine("abcdefghijklmnop", 10)).toBe(
      "abcdefg...",
    );
    expect(collapseHiddenSessionLine("short", 10)).toBe("short");
  });

  test("time is read off the stored string, not a timezone", () => {
    expect(formatHiddenSessionRowTime("2026-10-25T12:01:33.123Z")).toBe(
      "10-25 12:01",
    );
    expect(formatHiddenSessionRowTime("2026-10-25 12:01:33")).toBe(
      "10-25 12:01",
    );
    expect(formatHiddenSessionRowTime("")).toBe("");
    expect(formatHiddenSessionRowTime(null)).toBe("");
    expect(formatHiddenSessionRowTime("yesterday")).toBe("yesterday");
  });
});
