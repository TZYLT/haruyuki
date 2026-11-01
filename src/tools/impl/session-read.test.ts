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
import {
  runOutsideRuntimeContext,
  runWithRuntimeContext,
} from "@/runtime-context";
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

describe("session_read ownership", () => {
  function withAgent<T>(agentId: string, run: () => Promise<T>): Promise<T> {
    return runWithRuntimeContext({ agentId, conversationId: "conv-1" }, run);
  }

  test("reads a conversation owned by the calling agent", async () => {
    const backend = fakeBackend({
      record: { id: "conv-1", hidden: false, agent_id: "agent-1" },
      messages: MESSAGES,
    });
    const result = await withAgent("agent-1", () => read({}, backend));
    expect(result.status).toBe("success");
    expect(result.content).toContain("hi, here is the answer");
  });

  test("refuses a conversation that belongs to another agent", async () => {
    const backend = fakeBackend({
      record: { id: "conv-1", hidden: false, agent_id: "agent-1" },
      messages: MESSAGES,
    });
    const result = await withAgent("agent-2", () => read({}, backend));
    expect(result.status).toBe("error");
    expect(result.content).toContain("belongs to another agent");
    expect(result.content).not.toContain("hi, here is the answer");
  });

  test("allows a record with no agent_id, which cannot be checked", async () => {
    const backend = fakeBackend({
      record: { id: "conv-1", hidden: false },
      messages: MESSAGES,
    });
    const result = await withAgent("agent-2", () => read({}, backend));
    expect(result.status).toBe("success");
  });
});

describe("session_read scan cap", () => {
  function cappedBackend(all: unknown[]): SessionReadBackend {
    return {
      retrieveConversation: async () => ({ id: "conv-long", hidden: false }),
      listConversationMessages: async (_id, body) => {
        const limit = body?.limit ?? all.length;
        return { items: all.slice(0, limit) };
      },
    };
  }

  const LONG = Array.from({ length: 6_000 }, (_value, index) => ({
    message_type: "user_message",
    content: [{ type: "text", text: `message-${index + 1}` }],
  }));

  test("says when only the first 5,000 stored messages were scanned", async () => {
    const result = await read(
      { conversation_id: "conv-long" },
      cappedBackend(LONG),
    );
    expect(result.status).toBe("success");
    expect(result.content).toContain(
      "Only the first 5000 stored messages are scanned",
    );
    expect(result.content).toContain("message_start=5001");
  });

  test("a start past the scan window explains the cap, not a small count", async () => {
    const result = await read(
      { conversation_id: "conv-long", message_start: 5001 },
      cappedBackend(LONG),
    );
    expect(result.status).toBe("error");
    expect(result.content).toContain("scanned window");
    expect(result.content).toContain("scan cap");
    expect(result.content).not.toContain("only 5000 visible");
  });
});

describe("session_read page progress", () => {
  function longMessages(query: string): SessionReadBackend {
    return fakeBackend({
      record: { id: "conv-progress", hidden: false },
      messages: Array.from({ length: 3 }, () => ({
        message_type: "user_message",
        content: [{ type: "text", text: `${query} ${"body ".repeat(50)}` }],
      })),
    });
  }

  test("a tiny budget still advances instead of repeating an offset", async () => {
    const query = `needle ${"q".repeat(20)}`;
    const first = await read(
      {
        conversation_id: "conv-progress",
        query,
        max_chars: SESSION_READ_MIN_MAX_CHARS,
      },
      longMessages(query),
    );
    expect(first.status).toBe("success");
    const reported = /next offset=(\d+)/.exec(first.content)?.[1];
    expect(reported).toBeDefined();
    const nextOffset = Number(reported);
    expect(nextOffset).toBeGreaterThan(0);
    // The keyword echo is clamped so the header cannot eat the whole budget.
    const headerLine = first.content.split("\n")[1] ?? "";
    expect(headerLine.length).toBeLessThanOrEqual(100);

    const second = await read(
      {
        conversation_id: "conv-progress",
        query,
        max_chars: SESSION_READ_MIN_MAX_CHARS,
        offset: nextOffset,
      },
      longMessages(query),
    );
    expect(second.status).toBe("success");
    expect(second.content).not.toBe(first.content);
    expect(second.content).toContain("user:");
  });
});

const TIMED_MESSAGES: unknown[] = [
  {
    message_type: "user_message",
    content: [{ type: "text", text: "first user question" }],
    created_at: "2026-10-01T10:00:00.000Z",
  },
  {
    message_type: "assistant_message",
    content: [{ type: "text", text: "first answer" }],
    created_at: "2026-10-01T10:01:00.000Z",
  },
  {
    message_type: "summary_message",
    summary: "compacted so far",
    created_at: "2026-10-05T09:00:00.000Z",
  },
  {
    message_type: "user_message",
    content: [{ type: "text", text: "second user question" }],
    created_at: "2026-10-10T18:00:00.000Z",
  },
  {
    message_type: "assistant_message",
    content: [{ type: "text", text: "second answer" }],
    created_at: "2026-10-10T18:02:00.000Z",
  },
];

function timed(extra: Record<string, unknown> = {}): SessionReadBackend {
  return fakeBackend({
    record: { id: "conv-1", hidden: false, ...extra },
    messages: TIMED_MESSAGES,
  });
}

describe("session_read roles filter", () => {
  test("keeps only the requested roles and preserves message numbers", async () => {
    const result = await read({ roles: ["user"] }, timed());
    expect(result.status).toBe("success");
    expect(result.content).toContain("first user question");
    expect(result.content).toContain("second user question");
    expect(result.content).not.toContain("first answer");
    expect(result.content).not.toContain("second answer");
    // Summaries are excluded by the user-only channel too.
    expect(result.content).not.toContain("compacted so far");
    // Numbers still refer to the cleaned conversation, not to the filtered list.
    expect(result.content).toContain("[1] user:");
    expect(result.content).toContain("[4] user:");
    expect(result.content).toContain("filters: roles=user");
  });

  test("can select summaries alone", async () => {
    const result = await read({ roles: ["summary"] }, timed());
    expect(result.status).toBe("success");
    expect(result.content).toContain("compacted so far");
    expect(result.content).not.toContain("user question");
    expect(result.content).toContain("[3] summary:");
  });

  test("combines with message_start/message_end and query", async () => {
    const ranged = await read({ roles: ["user"], message_start: 2 }, timed());
    expect(ranged.content).toContain("second user question");
    expect(ranged.content).not.toContain("first user question");

    const queried = await read({ roles: ["user"], query: "second" }, timed());
    expect(queried.content).toContain("second user question");
    expect(queried.content).not.toContain("first user question");
  });

  test("refuses malformed roles instead of ignoring them", async () => {
    for (const roles of ["user", [], ["system"], ["user", 42]]) {
      const result = await read({ roles }, timed());
      expect(result.status).toBe("error");
      expect(result.content).toContain("roles");
    }
  });

  test("default behavior is unchanged: no filters and every role", async () => {
    const result = await read({}, timed());
    expect(result.content).toContain("first user question");
    expect(result.content).toContain("first answer");
    expect(result.content).toContain("compacted so far");
    expect(result.content).not.toContain("filters:");
  });
});

describe("session_read since/until filter", () => {
  test("since keeps later messages, at or after the bound", async () => {
    const result = await read({ since: "2026-10-05" }, timed());
    expect(result.status).toBe("success");
    expect(result.content).toContain("compacted so far");
    expect(result.content).toContain("second user question");
    expect(result.content).not.toContain("first user question");
    expect(result.content).toContain("filters: since=2026-10-05T00:00:00.000Z");
  });

  test("until is inclusive and keeps earlier messages", async () => {
    const result = await read({ until: "2026-10-01T10:01:00.000Z" }, timed());
    expect(result.status).toBe("success");
    expect(result.content).toContain("first user question");
    expect(result.content).toContain("first answer");
    expect(result.content).not.toContain("compacted so far");
    expect(result.content).not.toContain("second user question");
  });

  test("accepts epoch milliseconds", async () => {
    const since = Date.UTC(2026, 9, 10);
    const result = await read({ since }, timed());
    expect(result.status).toBe("success");
    expect(result.content).toContain("second user question");
    expect(result.content).not.toContain("first user question");
    expect(result.content).toContain("second answer");
  });

  test("filters on the stored `date` field when created_at is absent", async () => {
    const backend = fakeBackend({
      messages: [
        {
          message_type: "user_message",
          content: [{ type: "text", text: "old row" }],
          date: "2026-09-01T00:00:00.000Z",
        },
        {
          message_type: "user_message",
          content: [{ type: "text", text: "new row" }],
          date: "2026-10-20T00:00:00.000Z",
        },
      ],
    });
    const result = await read({ since: "2026-10-01" }, backend);
    expect(result.content).toContain("new row");
    expect(result.content).not.toContain("old row");
  });

  test("combines a window with roles and a keyword", async () => {
    const result = await read(
      {
        roles: ["assistant"],
        since: "2026-10-10T00:00:00.000Z",
        until: "2026-10-10T23:59:59.999Z",
        query: "answer",
      },
      timed(),
    );
    expect(result.status).toBe("success");
    expect(result.content).toContain("second answer");
    expect(result.content).not.toContain("first answer");
    expect(result.content).not.toContain("second user question");
  });

  test("says so when the filters match nothing", async () => {
    const result = await read({ since: "2027-01-01" }, timed());
    expect(result.status).toBe("success");
    expect(result.content).toContain("no message");
    expect(result.content).toContain("matches the requested filters");
  });

  test("refuses an inverted window", async () => {
    const result = await read(
      { since: "2026-10-10", until: "2026-10-01" },
      timed(),
    );
    expect(result.status).toBe("error");
    expect(result.content).toContain("must not be inverted");
  });

  test("refuses unparseable or wrongly-typed bounds", async () => {
    for (const args of [
      { since: "not-a-date" },
      { until: "not-a-date" },
      { since: "" },
      { until: 1 / 0 },
      { since: { at: "2026-10-01" } },
      { until: ["2026-10-01"] },
    ]) {
      const result = await read(args as SessionReadArgs, timed());
      expect(result.status).toBe("error");
    }
  });

  test("a message with no readable time cannot pass a time filter", async () => {
    const result = await read({ since: "2026-01-01" });
    expect(result.status).toBe("success");
    expect(result.content).toContain("matches the requested filters");
    expect(result.content).not.toContain("hello  there");
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
