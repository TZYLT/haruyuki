import { afterEach, describe, expect, test } from "bun:test";
import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import { __testSetBackend } from "@/backend";
import {
  classifyDetailTone,
  HiddenSessionDetail,
} from "@/cli/components/HiddenSessionDetail";
import { terminalTextWidth } from "@/cli/helpers/char-width";
import {
  resetMouseHandlers,
  routeMouseReport,
} from "@/cli/helpers/mouse-router";
import { mountInkTty, resetInkTtyState } from "@/test-utils/ink-tty";
import type { HiddenConversationSummary } from "@/types/conversation-provenance";

/**
 * The read-only detail face, judged on the frame (`src/cli/AGENTS.md`).
 *
 * The component's job is layout and keys: which seam the record has, and what one
 * message looks like, belong to `hidden-session-history` / `hidden-session-rows`
 * and are tested there. So the fixture backend only answers the two reads the
 * detail issues, and every assertion here is about what the screen says after a
 * key — the header's counts, the hidden-segment rule, the folded tool result, `r`,
 * the scroll window and the two exits.
 */

const UP = "\u001B[A";
const DOWN = "\u001B[B";
const PAGE_DOWN = "\u001B[6~";
const ENTER = "\r";
const ESCAPE = "\u001B";

const CREATED_AT = "2026-10-01T10:00:00.000Z";
const OLDER_AT = "2026-10-01T09:00:00.000Z";
const NEWER_AT = "2026-10-01T11:00:00.000Z";

function message(
  id: string,
  messageType: string,
  fields: Record<string, unknown> = {},
): Message {
  return {
    id,
    message_type: messageType,
    date: NEWER_AT,
    ...fields,
  } as unknown as Message;
}

/** The two reads the detail makes, plus the page bodies it was asked for. */
class DetailBackend {
  /** The row `inherited_through_message_id` resolves to, when the fixture has one. */
  boundary: Message | null = null;
  /** The new segment, oldest first. */
  messages: Message[] = [];
  /** Ids deleted through `deleteConversation`, in order. */
  readonly deleted: string[] = [];
  /** Set to make the delete fail, for the failure state. */
  failDelete = false;
  readonly pages: Array<Record<string, unknown>> = [];

  async retrieveMessage(_messageId: string): Promise<unknown> {
    return this.boundary;
  }

  async deleteConversation(conversationId: string): Promise<void> {
    this.deleted.push(conversationId);
    if (this.failDelete) throw new Error("the file is in use");
  }

  async listConversationMessages(
    _conversationId: string,
    body: Record<string, unknown> = {},
  ): Promise<Message[]> {
    this.pages.push(body);
    const limit = typeof body.limit === "number" ? body.limit : 50;
    if (body.order === "desc") {
      return [...this.messages].reverse().slice(0, limit);
    }
    // The boundary path asks `after=<boundary>`; the fixture's new segment is
    // already exactly the rows after it.
    return this.messages.slice(0, limit);
  }
}

function sessionFixture(
  overrides: Partial<HiddenConversationSummary> = {},
): HiddenConversationSummary {
  return {
    id: "local-conv-hidden",
    agent_id: "agent-1",
    hidden: true,
    summary: "Reflection of the ledger bug",
    created_at: CREATED_AT,
    context_message_count: 3,
    ...overrides,
  } as unknown as HiddenConversationSummary;
}

interface Harness {
  tty: ReturnType<typeof mountInkTty>;
  backend: DetailBackend;
  backs: () => number;
  closes: () => number;
  deleted: () => number;
}

const settle = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));

function mount(
  fixture: HiddenConversationSummary,
  backend: DetailBackend,
  options: { columns?: number; rows?: number } = {},
): Harness {
  __testSetBackend(backend as never);
  let backs = 0;
  let closes = 0;
  let deleted = 0;
  const tty = mountInkTty(
    <HiddenSessionDetail
      session={fixture}
      onBack={() => {
        backs += 1;
      }}
      onClose={() => {
        closes += 1;
      }}
      onDeleted={() => {
        deleted += 1;
      }}
    />,
    { columns: options.columns ?? 80, rows: options.rows ?? 30 },
  );
  return {
    tty,
    backend,
    backs: () => backs,
    closes: () => closes,
    deleted: () => deleted,
  };
}

async function painted(tty: ReturnType<typeof mountInkTty>): Promise<string[]> {
  await settle();
  return tty.rows();
}

function frame(rows: string[]): string {
  return rows.join("\n");
}

afterEach(() => {
  resetInkTtyState();
  resetMouseHandlers();
  __testSetBackend(null);
});

describe("the hidden session detail", () => {
  test("shows the last inherited message, the hidden-segment rule, and the new rows", async () => {
    const backend = new DetailBackend();
    backend.boundary = message("b1", "user_message", {
      content: "inherited prompt",
      date: OLDER_AT,
    });
    backend.messages = [message("n1", "user_message", { content: "new work" })];
    const { tty } = mount(
      sessionFixture({
        origin: "reflection",
        parent_conversation_id: "local-conv-parent",
        context_mode: "inherited-history",
        inherited_through_message_id: "b1",
        inherited_message_count: 7,
      }),
      backend,
    );
    try {
      const rows = await painted(tty);
      const text = frame(rows);
      expect(text).toContain(
        "reflection · parent local-conv-parent · 7 inherited hidden · 1 new",
      );
      expect(text).toContain("user: inherited prompt");
      expect(text).toContain("── inherited context hidden · 7 messages ──");
      expect(text).toContain("user: new work");
      // Two reads: the boundary row, then the forward page.
      expect(backend.pages[0]).toMatchObject({
        after: "b1",
        order: "asc",
        include_out_of_context: true,
      });
      expect(text).toContain("Esc back");
    } finally {
      tty.stop();
    }
  });

  test("a standalone session shows every row, with no hidden-segment rule", async () => {
    const backend = new DetailBackend();
    backend.messages = [
      message("m1", "user_message", { content: "wander off" }),
      message("m2", "assistant_message", { content: "wandered" }),
    ];
    const { tty } = mount(
      sessionFixture({ origin: "dream", context_mode: "standalone" }),
      backend,
    );
    try {
      const text = frame(await painted(tty));
      expect(text).toContain("dream · standalone · 2 messages");
      expect(text).toContain("user: wander off");
      expect(text).toContain("assistant: wandered");
      expect(text).not.toContain("inherited context hidden");
    } finally {
      tty.stop();
    }
  });

  test("when the fork added nothing the rule is followed by no new messages", async () => {
    const backend = new DetailBackend();
    backend.boundary = message("b1", "user_message", {
      content: "inherited prompt",
      date: OLDER_AT,
    });
    const { tty } = mount(
      sessionFixture({
        origin: "background",
        context_mode: "inherited-history",
        inherited_through_message_id: "b1",
        inherited_message_count: 1,
      }),
      backend,
    );
    try {
      const text = frame(await painted(tty));
      expect(text).toContain("user: inherited prompt");
      expect(text).toContain("no new messages");
    } finally {
      tty.stop();
    }
  });

  test("an empty fork says no inherited context and draws no rule", async () => {
    const backend = new DetailBackend();
    backend.messages = [
      message("n1", "user_message", { content: "first ask" }),
    ];
    const { tty } = mount(
      sessionFixture({
        origin: "background",
        context_mode: "inherited-history",
        inherited_through_message_id: null,
        inherited_message_count: 0,
      }),
      backend,
    );
    try {
      const text = frame(await painted(tty));
      expect(text).toContain("no inherited context · 1 new");
      expect(text).toContain("user: first ask");
      expect(text).not.toContain("inherited context hidden");
    } finally {
      tty.stop();
    }
  });

  test("an unprovable seam shows every loaded row and says so", async () => {
    const backend = new DetailBackend();
    backend.messages = [
      message("m1", "user_message", { content: "old row", date: OLDER_AT }),
      message("m2", "user_message", { content: "new row" }),
    ];
    const { tty } = mount(
      // No created_at and no boundary: the legacy walk cannot prove a seam.
      sessionFixture({
        origin: "background",
        context_mode: "inherited-history",
        created_at: null,
      }),
      backend,
    );
    try {
      const text = frame(await painted(tty));
      expect(text).toContain("boundary unknown");
      expect(text).toContain("boundary unknown; showing every loaded message");
      expect(text).toContain("user: old row");
      expect(text).toContain("user: new row");
    } finally {
      tty.stop();
    }
  });

  test("Enter expands the folded tool result under the cursor", async () => {
    const backend = new DetailBackend();
    backend.messages = [
      message("m1", "user_message", { content: "run it" }),
      message("m2", "tool_return_message", {
        status: "success",
        tool_call_id: "call-1",
        tool_return: "line one\nline two",
      }),
    ];
    const { tty } = mount(
      sessionFixture({ origin: "background", context_mode: "standalone" }),
      backend,
    );
    try {
      const before = frame(await painted(tty));
      // Header, then `user: run it`, then the folded tool row.
      await tty.press(DOWN);
      await tty.press(DOWN);
      expect(frame(await painted(tty))).toContain("← success");
      expect(before).not.toContain("line two");

      await tty.press(ENTER);
      const expanded = frame(await painted(tty));
      expect(expanded).toContain("line one");
      expect(expanded).toContain("line two");
    } finally {
      tty.stop();
    }
  });

  test("r reveals reasoning and hides it again", async () => {
    const backend = new DetailBackend();
    backend.messages = [
      message("m1", "user_message", { content: "think" }),
      message("m2", "reasoning_message", { reasoning: "weighing options" }),
    ];
    const { tty } = mount(
      sessionFixture({ origin: "background", context_mode: "standalone" }),
      backend,
    );
    try {
      expect(frame(await painted(tty))).not.toContain("weighing options");

      await tty.press("r");
      expect(frame(await painted(tty))).toContain(
        "reasoning: weighing options",
      );

      await tty.press("r");
      expect(frame(await painted(tty))).not.toContain("weighing options");
    } finally {
      tty.stop();
    }
  });

  test("PgDn moves the window and the footer reports the range", async () => {
    const backend = new DetailBackend();
    backend.messages = Array.from({ length: 12 }, (_, index) =>
      message(`m${index + 1}`, "user_message", {
        content: `row number ${index + 1}`,
      }),
    );
    const { tty } = mount(
      sessionFixture({ origin: "background", context_mode: "standalone" }),
      backend,
      { rows: 18 },
    );
    try {
      const first = frame(await painted(tty));
      expect(first).toContain("lines 1-");

      await tty.press(PAGE_DOWN);
      const scrolled = frame(await painted(tty));
      expect(scrolled).not.toContain("lines 1-");
      expect(scrolled).toMatch(/lines \d+-\d+ of \d+/);
    } finally {
      tty.stop();
    }
  });

  test("Escape goes back to the list rather than closing the face", async () => {
    const backend = new DetailBackend();
    backend.messages = [message("m1", "user_message", { content: "hello" })];
    const { tty, backs, closes } = mount(
      sessionFixture({ origin: "background", context_mode: "standalone" }),
      backend,
    );
    try {
      await painted(tty);
      await tty.press(ESCAPE);
      expect(backs()).toBe(1);
      expect(closes()).toBe(0);
    } finally {
      tty.stop();
    }
  });

  test("d asks first with the inherited and new counts", async () => {
    const backend = new DetailBackend();
    backend.boundary = message("b1", "user_message", {
      content: "inherited prompt",
      date: OLDER_AT,
    });
    backend.messages = [message("n1", "user_message", { content: "new work" })];
    const { tty, deleted } = mount(
      sessionFixture({
        origin: "reflection",
        context_mode: "inherited-history",
        inherited_through_message_id: "b1",
        inherited_message_count: 7,
      }),
      backend,
    );
    try {
      await painted(tty);
      await tty.press("d");
      const confirm = frame(await painted(tty));
      expect(confirm).toContain("Delete this hidden session?");
      expect(confirm).toContain("7 inherited hidden · 1 new");
      expect(confirm).toContain("cannot be undone");

      // Cancel is the default row: Enter must not delete.
      await tty.press(ENTER);
      await painted(tty);
      expect(deleted()).toBe(0);
      expect(backend.deleted).toEqual([]);
      expect(frame(await tty.rows())).toContain("Esc back");
    } finally {
      tty.stop();
    }
  });

  test("confirming deletes and reports the deletion upward", async () => {
    const backend = new DetailBackend();
    backend.messages = [message("m1", "user_message", { content: "hello" })];
    const { tty, deleted } = mount(
      sessionFixture({
        origin: "background",
        context_mode: "standalone",
        id: "local-conv-doomed",
      }),
      backend,
    );
    try {
      await painted(tty);
      await tty.press("d");
      await painted(tty);
      await tty.press(UP);
      await tty.press(ENTER);
      await settle(300);

      expect(backend.deleted).toEqual(["local-conv-doomed"]);
      expect(deleted()).toBe(1);
    } finally {
      tty.stop();
    }
  });

  test("a failed delete stays in the confirmation with the error", async () => {
    const backend = new DetailBackend();
    backend.messages = [message("m1", "user_message", { content: "hello" })];
    backend.failDelete = true;
    const { tty, deleted } = mount(
      sessionFixture({ origin: "background", context_mode: "standalone" }),
      backend,
    );
    try {
      await painted(tty);
      await tty.press("d");
      await painted(tty);
      await tty.press(UP);
      await tty.press(ENTER);
      await settle(300);

      const confirm = frame(await painted(tty));
      expect(confirm).toContain("Delete failed: the file is in use");
      expect(confirm).toContain("Delete this hidden session?");
      expect(deleted()).toBe(0);

      await tty.press(ESCAPE);
      expect(frame(await painted(tty))).toContain("Esc back");
    } finally {
      tty.stop();
    }
  });

  test("a 40-column terminal keeps every painted row inside the frame", async () => {
    const backend = new DetailBackend();
    backend.boundary = message("b1", "user_message", {
      content: "a very long inherited prompt that would wrap without clipping",
      date: OLDER_AT,
    });
    backend.messages = [
      message("n1", "user_message", {
        content: "an equally long new message that must not wrap either",
      }),
    ];
    const { tty } = mount(
      sessionFixture({
        origin: "reflection",
        parent_conversation_id: "local-conv-parent-with-a-long-id",
        context_mode: "inherited-history",
        inherited_through_message_id: "b1",
        inherited_message_count: 12,
      }),
      backend,
      { columns: 40, rows: 20 },
    );
    try {
      const rows = await painted(tty);
      for (const row of rows) {
        expect(terminalTextWidth(row)).toBeLessThanOrEqual(40);
      }
    } finally {
      tty.stop();
    }
  });
});

describe("the readable detail (F-06 R-5.7.4)", () => {
  function messageWith(content: string, id = "m1"): Message {
    return message(id, "user_message", { content });
  }

  test("wraps a long line instead of clipping it, and the frame height is unchanged", async () => {
    const long = "the quick brown fox jumps over the lazy dog "
      .repeat(4)
      .trim();
    const heightFor = async (content: string, id: string): Promise<number> => {
      const backend = new DetailBackend();
      backend.messages = [messageWith(content, id)];
      const { tty } = mount(
        sessionFixture({ origin: "dream", context_mode: "standalone" }),
        backend,
        { columns: 40, rows: 20 },
      );
      try {
        await painted(tty);
        return (await tty.rows({ keepTrailingBlanks: true })).length;
      } finally {
        tty.stop();
      }
    };
    const shortHeight = await heightFor("short", "short");
    const longHeight = await heightFor(long, "long");
    expect(longHeight).toBe(shortHeight);
  });

  test("every wrapped row fits the columns, and words are not split mid-run", async () => {
    const backend = new DetailBackend();
    backend.messages = [
      messageWith(
        "a sentence with several ordinary words that must wrap on word boundaries",
      ),
    ];
    const { tty } = mount(
      sessionFixture({ origin: "dream", context_mode: "standalone" }),
      backend,
      { columns: 30, rows: 20 },
    );
    try {
      const rows = (await painted(tty)).filter((row) => row.length > 0);
      for (const row of rows) {
        expect(terminalTextWidth(row)).toBeLessThanOrEqual(30);
      }
      const text = rows.join(" ").replace(/\s+/g, " ");
      expect(text).toContain("a sentence with several ordinary words");
      // The wrap keeps whole words: no row is a fragment of "ordinary".
      expect(rows.some((row) => row.trimEnd().endsWith("ordina"))).toBe(false);
    } finally {
      tty.stop();
    }
  });

  test("CJK and emoji wrap without severing a grapheme cluster", async () => {
    const family = "👨‍👩‍👧";
    const backend = new DetailBackend();
    backend.messages = [
      messageWith(`梦游会在夜里整理记忆和报告，${family}${family}${family}`),
    ];
    const { tty } = mount(
      sessionFixture({ origin: "dream", context_mode: "standalone" }),
      backend,
      { columns: 20, rows: 20 },
    );
    try {
      const rows = (await painted(tty)).filter((row) => row.length > 0);
      for (const row of rows) {
        expect(terminalTextWidth(row)).toBeLessThanOrEqual(20);
      }
      // The cluster is never cut: it appears whole on some row (never as an
      // orphaned half). Counting the full sequences on the frame is enough.
      expect((rows.join("").match(new RegExp(family, "gu")) ?? []).length).toBe(
        3,
      );
    } finally {
      tty.stop();
    }
  });

  test("the wheel scrolls the window (page layer)", async () => {
    const backend = new DetailBackend();
    backend.messages = Array.from({ length: 20 }, (_, index) =>
      message(`m${index + 1}`, "user_message", {
        content: `row number ${index + 1}`,
      }),
    );
    const { tty } = mount(
      sessionFixture({ origin: "dream", context_mode: "standalone" }),
      backend,
      { rows: 18 },
    );
    try {
      const before = frame(await painted(tty));
      expect(before).toContain("lines 1-");
      // Each notch is its own input event in the real app, so each one sees the
      // cursor the previous notch left; a settled frame between them is what
      // makes that true here too.
      for (let notch = 0; notch < 3; notch += 1) {
        const claimed = routeMouseReport({
          kind: "press",
          button: "none",
          wheel: "down",
          column: 1,
          row: 1,
          modifiers: { shift: false, alt: false, ctrl: false },
        });
        expect(claimed).toBe(true);
        await settle(40);
      }
      const after = frame(await painted(tty));
      expect(after).not.toContain("lines 1-");
      expect(after).toMatch(/lines \d+-\d+ of \d+/);
    } finally {
      tty.stop();
    }
  });

  test("an expanded detail wraps its long lines and keeps the frame inside the width", async () => {
    const backend = new DetailBackend();
    backend.messages = [
      message("m1", "user_message", { content: "run it" }),
      message("m2", "tool_return_message", {
        status: "success",
        tool_call_id: "call-1",
        tool_return: `line one ${"x".repeat(120)}\n## a heading that is long ${"y".repeat(80)}`,
      }),
    ];
    const { tty } = mount(
      sessionFixture({ origin: "dream", context_mode: "standalone" }),
      backend,
      { columns: 40, rows: 22 },
    );
    try {
      await painted(tty);
      await tty.press(DOWN, DOWN, ENTER);
      // The heading sits below the first window; walk to it to prove the detail
      // itself wrapped (not just the head line).
      await tty.press(PAGE_DOWN);
      const rows = (await painted(tty)).filter((row) => row.length > 0);
      for (const row of rows) {
        expect(terminalTextWidth(row)).toBeLessThanOrEqual(40);
      }
      expect(rows.join("\n")).toContain("## a heading");
    } finally {
      tty.stop();
    }
  });
});

describe("classifyDetailTone", () => {
  test("classifies the block kinds the requirement names", () => {
    expect(classifyDetailTone("## Heading", false)).toEqual({
      tone: "header",
      inCodeBlock: false,
    });
    expect(classifyDetailTone("- a list item", false).tone).toBe("list");
    expect(classifyDetailTone("1. numbered", false).tone).toBe("list");
    expect(classifyDetailTone("> quoted", false).tone).toBe("quote");
    expect(classifyDetailTone("---", false).tone).toBe("rule");
    expect(classifyDetailTone("plain text", false).tone).toBe("plain");
  });

  test("fences open, colour their contents, and close", () => {
    const opened = classifyDetailTone("```ts", false);
    expect(opened).toEqual({ tone: "code", inCodeBlock: true });
    expect(classifyDetailTone("const x = 1;", true)).toEqual({
      tone: "code",
      inCodeBlock: true,
    });
    const closed = classifyDetailTone("```", true);
    expect(closed).toEqual({ tone: "code", inCodeBlock: false });
    expect(classifyDetailTone("plain after the fence", false).tone).toBe(
      "plain",
    );
  });
});
