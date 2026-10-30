/**
 * `SessionRead` (F-06 R-5.4.2, Q-33 / Q-50).
 *
 * The contract has three parts: the text is cleaned (visible body only), the
 * page respects the character budget and reports how to continue, and a hidden
 * conversation is refused rather than emptied. The backend is a narrow fake so
 * these cases test this tool, not the local store's projection.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { setConversationId } from "@/agent/context";
import { runOutsideRuntimeContext } from "@/runtime-context";
import {
  SESSION_READ_DEFAULT_MAX_CHARS,
  SESSION_READ_MAX_MAX_CHARS,
  SESSION_READ_MIN_MAX_CHARS,
  type SessionReadArgs,
  type SessionReadBackend,
  session_read,
} from "@/tools/impl/session-read";
import { TOOL_DEFINITIONS } from "@/tools/tool-definitions";

afterEach(() => {
  setConversationId(null);
});

function fakeBackend(options: {
  record?: unknown;
  messages?: unknown[];
  failRetrieve?: boolean;
  failMessages?: boolean;
}): SessionReadBackend {
  return {
    retrieveConversation: async () => {
      if (options.failRetrieve) throw new Error("not found");
      return options.record ?? { id: "conv-1", hidden: false };
    },
    listConversationMessages: async () => {
      if (options.failMessages) throw new Error("boom");
      return options.messages ?? [];
    },
  };
}

const MESSAGES: unknown[] = [
  {
    message_type: "user_message",
    content: [
      {
        type: "text",
        text: "hello <system-reminder>injected</system-reminder> there",
      },
    ],
  },
  {
    message_type: "reasoning_message",
    reasoning: "REASONING-SECRET",
  },
  {
    message_type: "assistant_message",
    content: [{ type: "text", text: "hi, here is the answer" }],
  },
  {
    message_type: "tool_call_message",
    tool_call: { name: "read_file", arguments: '{"path":"/etc/passwd"}' },
  },
  {
    message_type: "tool_return_message",
    tool_return: "TOOL-OUTPUT-SECRET",
  },
  {
    message_type: "summary_message",
    summary: "earlier text was compacted",
  },
];

function ordinary(extra: Record<string, unknown> = {}): SessionReadBackend {
  return fakeBackend({
    record: { id: "conv-1", hidden: false, ...extra },
    messages: MESSAGES,
  });
}

function read(
  args: SessionReadArgs,
  backend: SessionReadBackend = ordinary(),
): Promise<{ content: string; status: "success" | "error" }> {
  return session_read(args, { backend, conversationId: "conv-1" });
}

describe("session_read cleaning", () => {
  test("returns user and assistant text only", async () => {
    const result = await read({});
    expect(result.status).toBe("success");
    expect(result.content).toContain("hello  there");
    expect(result.content).toContain("hi, here is the answer");
    expect(result.content).toContain("earlier text was compacted");
    expect(result.content).not.toContain("REASONING-SECRET");
    expect(result.content).not.toContain("TOOL-OUTPUT-SECRET");
    expect(result.content).not.toContain("injected");
    expect(result.content).not.toContain("read_file");
  });

  test("numbers visible messages from 1", async () => {
    const result = await read({});
    expect(result.content).toContain("[1] user:");
    expect(result.content).toContain("[2] assistant:");
    expect(result.content).toContain("[3] summary:");
  });
});

describe("session_read hidden refusal", () => {
  test("refuses a hidden conversation with an explicit message", async () => {
    const result = await read(
      { conversation_id: "dream-conv" },
      fakeBackend({
        record: { id: "dream-conv", hidden: true, origin: "dream" },
        messages: MESSAGES,
      }),
    );
    expect(result.status).toBe("error");
    expect(result.content).toContain("hidden");
    expect(result.content).toContain("only ordinary conversations");
  });

  test("refuses subagent and reflection records even without hidden:true", async () => {
    for (const record of [
      { id: "sub", is_subagent: true },
      { id: "refl", origin: "reflection" },
      { id: "dream", origin: "dream" },
      { id: "bg", origin: "background" },
    ]) {
      const result = await read(
        { conversation_id: String(record.id) },
        fakeBackend({ record, messages: MESSAGES }),
      );
      expect(result.status).toBe("error");
      expect(result.content).toContain("hidden");
    }
  });

  test("an ordinary conversation is readable", async () => {
    const result = await read(
      { conversation_id: "ordinary" },
      ordinary({ origin: "unknown" }),
    );
    expect(result.status).toBe("success");
  });
});

describe("session_read range and query", () => {
  test("applies an inclusive message range", async () => {
    const result = await read({ message_start: 2, message_end: 2 });
    expect(result.status).toBe("success");
    expect(result.content).toContain("[2] assistant:");
    expect(result.content).not.toContain("[1] user:");
    expect(result.content).not.toContain("[3] summary:");
  });

  test("clamps message_end past the last visible message", async () => {
    const result = await read({ message_start: 3, message_end: 999 });
    expect(result.status).toBe("success");
    expect(result.content).toContain("[3] summary:");
  });

  test("rejects an inverted range", async () => {
    const result = await read({ message_start: 3, message_end: 1 });
    expect(result.status).toBe("error");
    expect(result.content).toContain("must not be inverted");
  });

  test("rejects a start past the last visible message", async () => {
    const result = await read({ message_start: 99 });
    expect(result.status).toBe("error");
    expect(result.content).toContain("only 3 visible messages");
  });

  test("filters by keyword case-insensitively", async () => {
    const result = await read({ query: "ANSWER" });
    expect(result.status).toBe("success");
    expect(result.content).toContain("hi, here is the answer");
    expect(result.content).not.toContain("hello  there");
    expect(result.content).toContain('keyword: "ANSWER"');
  });

  test("says so when the keyword matches nothing", async () => {
    const result = await read({ query: "no-such-word" });
    expect(result.status).toBe("success");
    expect(result.content).toContain("no message");
  });
});

describe("session_read budget and paging", () => {
  function longConversation(): SessionReadBackend {
    const messages = Array.from({ length: 30 }, (_, index) => ({
      message_type: index % 2 === 0 ? "user_message" : "assistant_message",
      content: [
        {
          type: "text",
          text: `message ${index + 1} ${"x".repeat(120)}`,
        },
      ],
    }));
    return fakeBackend({ messages });
  }

  test("respects max_chars and reports the next offset", async () => {
    const first = await read(
      { max_chars: SESSION_READ_MIN_MAX_CHARS },
      longConversation(),
    );
    expect(first.status).toBe("success");
    expect(first.content.length).toBeLessThanOrEqual(
      SESSION_READ_MIN_MAX_CHARS,
    );
    expect(first.content).toContain("next offset=");

    const nextOffset = Number(
      /next offset=(\d+)/.exec(first.content)?.[1] ?? Number.NaN,
    );
    expect(nextOffset).toBeGreaterThan(0);

    const second = await read(
      { max_chars: SESSION_READ_MIN_MAX_CHARS, offset: nextOffset },
      longConversation(),
    );
    expect(second.status).toBe("success");
    expect(second.content).not.toContain("[1] user:");
  });

  test("a single oversized message is cut at the budget", async () => {
    const backend = fakeBackend({
      messages: [
        {
          message_type: "user_message",
          content: [{ type: "text", text: "y".repeat(5_000) }],
        },
      ],
    });
    const result = await read(
      { max_chars: SESSION_READ_MIN_MAX_CHARS },
      backend,
    );
    expect(result.status).toBe("success");
    expect(result.content.length).toBeLessThanOrEqual(
      SESSION_READ_MIN_MAX_CHARS,
    );
    expect(result.content).toContain("cut at the character budget");
  });

  test("rejects an offset past the last matching message", async () => {
    const result = await read({ offset: 99 });
    expect(result.status).toBe("error");
    expect(result.content).toContain("offset");
  });

  test("defaults the budget", async () => {
    expect(SESSION_READ_DEFAULT_MAX_CHARS).toBe(8_000);
    expect(SESSION_READ_MAX_MAX_CHARS).toBe(20_000);
    const result = await read({ max_chars: 1_000 });
    expect(result.status).toBe("success");
  });

  test("rejects a budget outside the accepted range", async () => {
    for (const max_chars of [
      SESSION_READ_MIN_MAX_CHARS - 1,
      SESSION_READ_MAX_MAX_CHARS + 1,
      1.5,
    ]) {
      const result = await read({ max_chars });
      expect(result.status).toBe("error");
    }
  });
});

describe("session_read failures", () => {
  test("reports an unknown conversation", async () => {
    const result = await read(
      { conversation_id: "missing" },
      fakeBackend({ failRetrieve: true }),
    );
    expect(result.status).toBe("error");
    expect(result.content).toContain("was not found");
  });

  test("reports an unreadable transcript", async () => {
    const result = await read(
      {},
      fakeBackend({ record: { hidden: false }, failMessages: true }),
    );
    expect(result.status).toBe("error");
    expect(result.content).toContain("could not read");
  });

  test("an empty conversation is a success with a notice", async () => {
    const result = await read(
      {},
      fakeBackend({ record: { hidden: false }, messages: [] }),
    );
    expect(result.status).toBe("success");
    expect(result.content).toContain("no visible text messages");
  });

  test("refuses when there is no conversation to resolve", async () => {
    setConversationId(null);
    const result = await runOutsideRuntimeContext(() =>
      session_read({}, { backend: ordinary() }),
    );
    expect(result.status).toBe("error");
    expect(result.content).toContain("no conversation to read");
  });
});

describe("SessionRead declaration", () => {
  test("is registered and its description is distinct from Read's", () => {
    const description = TOOL_DEFINITIONS.SessionRead.description;
    // The model must not reach for the file tool to read a transcript, and must
    // not reach for this one to read a file.
    expect(description).toContain("conversation");
    expect(description).toContain("`Read` is a different tool");
    expect(description).toContain("Hidden conversations are never readable");
    expect(TOOL_DEFINITIONS.Read.description).not.toContain("SessionRead");
    expect(TOOL_DEFINITIONS.Read.description).toContain("file");
  });
});
