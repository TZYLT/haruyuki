import { afterEach, describe, expect, test } from "bun:test";
import { __testSetBackend } from "@/backend";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import { HiddenSessionsOverlay } from "@/cli/components/HiddenSessionsOverlay";
import { terminalTextWidth } from "@/cli/helpers/char-width";
import { mountInkTty, resetInkTtyState } from "@/test-utils/ink-tty";

/**
 * `/maintenance sessions`, judged on the frame.
 *
 * The frame is the point (`src/cli/AGENTS.md`): three lines per conversation, a
 * window the terminal can hold, and keys asserted by what the screen then says.
 * The fixture backend pages its own rows so a page boundary is visible, and
 * records every list body it was asked for, because "search keeps `hidden_only`"
 * is a claim about the request rather than about the paint.
 */

const AGENT_ID = "agent-hidden";
const OTHER_AGENT = "agent-other";

const UP = "\u001B[A";
const DOWN = "\u001B[B";
const PAGE_DOWN = "\u001B[6~";
const END = "\u001B[F";
const ENTER = "\r";
const ESCAPE = "\u001B";

const PAGE_SIZE = 20;

/** Two hours ago, so every row's relative time reads `2h ago`. */
const ACTIVE_AT = new Date(Date.now() - 2 * 60 * 60 * 1_000).toISOString();

function page<T>(items: T[]): never {
  return items as never;
}

interface FixtureRow {
  id: string;
  agent_id: string;
  hidden?: boolean;
  summary?: string;
  origin?: string;
  context_message_count: number;
  last_message_at: string;
}

function fixtureRow(index: number, agentId = AGENT_ID): FixtureRow {
  return {
    id: `${agentId}-conv-${String(index).padStart(2, "0")}`,
    agent_id: agentId,
    // These are hidden sessions; the delete confirmation checks the field itself.
    hidden: true,
    summary: `Hidden session ${index}`,
    origin: index === 1 ? "reflection" : "background",
    context_message_count: index,
    last_message_at: ACTIVE_AT,
  };
}

class HiddenBackend extends FakeHeadlessBackend {
  /** Every `listConversations` body this backend was asked for, in order. */
  readonly calls: Array<Record<string, unknown>> = [];
  /** Ids deleted through `deleteConversation`, in order. */
  readonly deleted: string[] = [];
  /** Set to fail every delete call, for the failure state. */
  failDelete = false;
  /** Set to fail every list call, for the error state. */
  fail = false;
  /** Hold the first page until this resolves, for the loading state. */
  gate: Promise<void> | null = null;
  /** This agent's hidden conversations, newest first. */
  rows = Array.from({ length: 22 }, (_, index) => fixtureRow(index + 1));
  /** Another agent's, so the scope toggle has something to reveal. */
  otherRows = [fixtureRow(1, OTHER_AGENT), fixtureRow(2, OTHER_AGENT)];
  /** First user message per conversation id, for the title fallback. */
  firstMessages = new Map<string, string>();

  async deleteConversation(conversationId: string): Promise<void> {
    this.deleted.push(conversationId);
    if (this.failDelete) throw new Error("the file is in use");
    this.rows = this.rows.filter((row) => row.id !== conversationId);
    this.otherRows = this.otherRows.filter((row) => row.id !== conversationId);
  }

  override async listConversations(
    ...args: Parameters<FakeHeadlessBackend["listConversations"]>
  ): ReturnType<FakeHeadlessBackend["listConversations"]> {
    const body = (args[0] ?? {}) as {
      agent_id?: string;
      after?: string;
      summary_search?: string;
    };
    this.calls.push({ ...body });
    if (this.gate) await this.gate;
    if (this.fail) throw new Error("backend is offline");

    const pool = body.agent_id
      ? this.rows.filter((entry) => entry.agent_id === body.agent_id)
      : [...this.otherRows, ...this.rows];
    const query = body.summary_search?.toLowerCase();
    const matching = query
      ? pool.filter((entry) => entry.summary?.toLowerCase().includes(query))
      : pool;
    const from = body.after
      ? matching.findIndex((entry) => entry.id === body.after) + 1
      : 0;
    // A page is at most 20 rows, and the last one is short 閳?which is what the
    // page machine reads as "no more", not a promise from the backend.
    return page(
      from === 0 ? matching.slice(0, PAGE_SIZE) : matching.slice(from),
    );
  }

  override async listConversationMessages(
    ...args: Parameters<FakeHeadlessBackend["listConversationMessages"]>
  ): ReturnType<FakeHeadlessBackend["listConversationMessages"]> {
    const [conversationId] = args;
    const text = this.firstMessages.get(conversationId);
    return page(
      text
        ? [{ message_type: "user_message", content: text, date: ACTIVE_AT }]
        : [],
    );
  }
}

interface Harness {
  tty: ReturnType<typeof mountInkTty>;
  backend: HiddenBackend;
  closed: () => number;
}

const settle = (ms = 200) => new Promise((resolve) => setTimeout(resolve, ms));

function mount(options: {
  backend?: HiddenBackend;
  columns?: number;
  rows?: number;
}): Harness {
  const backend = options.backend ?? new HiddenBackend();
  __testSetBackend(backend);
  let closes = 0;
  const tty = mountInkTty(
    <HiddenSessionsOverlay
      agentId={AGENT_ID}
      onClose={() => {
        closes += 1;
      }}
    />,
    { columns: options.columns ?? 80, rows: options.rows ?? 30 },
  );
  return { tty, backend, closed: () => closes };
}

/** The rows painted, after a page and its title reads have had time to land. */
async function painted(tty: ReturnType<typeof mountInkTty>): Promise<string[]> {
  await settle();
  return tty.rows();
}

function footer(rows: string[]): string {
  return rows.find((entry) => entry.includes("esc close")) ?? "";
}

function frame(rows: string[]): string {
  return rows.join("\n");
}

afterEach(() => {
  resetInkTtyState();
  __testSetBackend(null);
});

describe("the hidden sessions list", () => {
  test("asks for hidden conversations only, for this agent, in pages of 20", async () => {
    const { tty, backend } = mount({});
    try {
      await painted(tty);
      expect(backend.calls[0]).toMatchObject({
        agent_id: AGENT_ID,
        hidden_only: true,
        limit: PAGE_SIZE,
      });
      // No summary search until one is typed: the first page is the whole list.
      expect(backend.calls[0]?.summary_search).toBeUndefined();
    } finally {
      tty.stop();
    }
  });

  test("paints three lines per conversation: title, origin|agent|ctx, when", async () => {
    const { tty } = mount({});
    try {
      const rows = await painted(tty);
      const first = rows.indexOf("> Hidden session 1");
      expect(first).toBeGreaterThan(-1);
      // The cursor row is the title; its two metadata lines follow, then the
      // blank line that separates the row from the next conversation.
      expect(rows[first + 1]).toBe("  reflection · agent-hidden · ctx 1");
      expect(rows[first + 2]).toBe("  2h ago");
      expect(rows[first + 3]).toBe("");
      // Row 2 sits directly under it, without the cursor bar.
      expect(rows[first + 4]).toBe("  Hidden session 2");
      expect(rows[first + 5]).toBe("  background · agent-hidden · ctx 2");
      expect(rows[first + 6]).toBe("  2h ago");
    } finally {
      tty.stop();
    }
  });

  test("a conversation with no summary shows its first user message", async () => {
    const backend = new HiddenBackend();
    const untitled = { ...fixtureRow(1), summary: undefined };
    backend.rows = [untitled, fixtureRow(2)];
    backend.firstMessages.set(untitled.id, "Summarize the ledger bug");
    const { tty } = mount({ backend });
    try {
      const rows = await painted(tty);
      expect(rows.join("\n")).toContain("> Summarize the ledger bug");
    } finally {
      tty.stop();
    }
  });

  test("a conversation with neither summary nor messages says (untitled)", async () => {
    const backend = new HiddenBackend();
    backend.rows = [{ ...fixtureRow(1), summary: undefined }];
    const { tty } = mount({ backend });
    try {
      const rows = await painted(tty);
      expect(rows.join("\n")).toContain("> (untitled)");
    } finally {
      tty.stop();
    }
  });

  test("says it is loading before the first page lands", async () => {
    const backend = new HiddenBackend();
    let release = () => {};
    backend.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { tty } = mount({ backend });
    try {
      expect(await tty.text()).toContain("Loading hidden sessions...");
      release();
      await settle(300);
      expect(await tty.text()).not.toContain("Loading hidden sessions...");
    } finally {
      tty.stop();
    }
  });

  test("a failed read is shown, not swallowed", async () => {
    const backend = new HiddenBackend();
    backend.fail = true;
    const { tty } = mount({ backend });
    try {
      const rows = await painted(tty);
      expect(rows.join("\n")).toContain(
        "Error reading hidden sessions: backend is offline",
      );
      expect(rows.join("\n")).not.toContain(
        "No hidden sessions for this agent.",
      );
    } finally {
      tty.stop();
    }
  });

  test("the empty state names the agent scope and points at a", async () => {
    const backend = new HiddenBackend();
    backend.rows = [];
    const { tty } = mount({ backend });
    try {
      const rows = await painted(tty);
      expect(rows.join("\n")).toContain("No hidden sessions for this agent.");
      expect(rows.join("\n")).toContain("Press a to look across all agents.");
    } finally {
      tty.stop();
    }
  });

  test("the all-agents empty state says where background sessions come from", async () => {
    const backend = new HiddenBackend();
    backend.rows = [];
    backend.otherRows = [];
    const { tty } = mount({ backend });
    try {
      await tty.press("a");
      const rows = await painted(tty);
      const joined = rows.join("\n");
      expect(joined).toContain("No hidden sessions yet.");
      expect(joined).toContain("Background sessions appear after a reflection");
      expect(joined).toContain("subagent runs.");
      expect(footer(rows)).toContain("a this agent only");
    } finally {
      tty.stop();
    }
  });
});

describe("the list's keys", () => {
  test("a switches to every agent and asks without an agent filter", async () => {
    const { tty, backend } = mount({});
    try {
      await painted(tty);
      await tty.press("a");
      const rows = await painted(tty);
      expect(backend.calls.at(-1)?.agent_id).toBeUndefined();
      expect(backend.calls.at(-1)?.hidden_only).toBe(true);
      expect(footer(rows)).toContain("a this agent only");
      // Another agent's row is in the list now, so the scope is visible per row.
      expect(rows.join("\n")).toContain("agent-other");

      await tty.press("a");
      await painted(tty);
      expect(backend.calls.at(-1)?.agent_id).toBe(AGENT_ID);
    } finally {
      tty.stop();
    }
  });

  test("/ focuses the search field, and a typed query refetches hidden-only", async () => {
    const { tty, backend } = mount({});
    try {
      await painted(tty);
      await tty.press("/");
      await tty.press("1", "1");
      const rows = await painted(tty);
      expect(rows.join("\n")).toContain("Search: 11");
      expect(backend.calls.at(-1)?.summary_search).toBe("11");
      expect(backend.calls.at(-1)?.hidden_only).toBe(true);
      expect(rows.join("\n")).toContain("> Hidden session 11");
    } finally {
      tty.stop();
    }
  });

  test("j and k are search text while the field is focused", async () => {
    const { tty, backend } = mount({});
    try {
      await painted(tty);
      await tty.press("/");
      await tty.press("j");
      const rows = await painted(tty);
      expect(rows.join("\n")).toContain("Search: j");
      // Nothing matches "j", so nothing was navigated into: the letter was the
      // field's, not the list's.
      expect(backend.calls.at(-1)?.summary_search).toBe("j");
      expect(rows.join("\n")).toContain('No hidden sessions match "j".');
    } finally {
      tty.stop();
    }
  });

  test("Escape leaves the search and reloads the first page, then closes", async () => {
    const { tty, backend, closed } = mount({});
    try {
      await painted(tty);
      await tty.press("/");
      await tty.press("1", "1");
      await painted(tty);

      await tty.press(ESCAPE);
      const cleared = await painted(tty);
      expect(backend.calls.at(-1)?.summary_search).toBeUndefined();
      expect(cleared.join("\n")).toContain("Search: press / to search");
      expect(closed()).toBe(0);

      await tty.press(ESCAPE);
      expect(closed()).toBe(1);
    } finally {
      tty.stop();
    }
  });

  test("Enter leaves the search field without closing the face", async () => {
    const { tty, closed } = mount({});
    try {
      await painted(tty);
      await tty.press("/");
      await tty.press(ENTER);
      const rows = await painted(tty);
      expect(rows.join("\n")).toContain("Search: press / to search");
      // Back on the list: `a` acts again rather than typing.
      await tty.press("a");
      await painted(tty);
      expect(footer(await tty.rows())).toContain("a this agent only");
      expect(closed()).toBe(0);
    } finally {
      tty.stop();
    }
  });

  test("Enter on a row opens the read-only detail, and Escape returns to the list", async () => {
    const { tty, closed } = mount({});
    try {
      await painted(tty);
      await tty.press(ENTER);
      const detailRows = await painted(tty);
      // The detail's own footer, not the list's: the face switched.
      expect(detailRows.join("\n")).toContain("Enter expands");
      expect(detailRows.join("\n")).toContain("Esc back");
      expect(closed()).toBe(0);

      await tty.press(ESCAPE);
      const backRows = await painted(tty);
      expect(footer(backRows)).toContain("esc close");
      expect(closed()).toBe(0);

      // A second Escape (now with the list focused) closes the face.
      await tty.press(ESCAPE);
      expect(closed()).toBe(1);
    } finally {
      tty.stop();
    }
  });

  test("walking to the end fetches the next page with the last row as its cursor", async () => {
    const { tty, backend } = mount({});
    try {
      await painted(tty);
      await tty.press(END);
      await settle(300);
      await tty.press(END);
      await settle(300);
      const rows = await painted(tty);

      expect(backend.calls.length).toBeGreaterThanOrEqual(2);
      expect(backend.calls.at(-1)?.after).toBe(backend.rows[PAGE_SIZE - 1]?.id);
      expect(rows.join("\n")).toContain("Hidden session 22");
      expect(footer(rows)).toContain("/ search");
    } finally {
      tty.stop();
    }
  });

  test("a search result paginates too, still hidden-only", async () => {
    const { tty, backend } = mount({});
    try {
      await painted(tty);
      // "hidden" matches every fixture summary, so the query pages like the list.
      await tty.press("/");
      await tty.press("h", "i", "d", "d", "e", "n");
      await painted(tty);
      expect(backend.calls.at(-1)?.summary_search).toBe("hidden");

      // Home/End belong to the search field's caret while it has focus, so the
      // walk to the last row is by page step 鈥?which is what a reader does.
      for (let page = 0; page < 6; page += 1) {
        await tty.press(PAGE_DOWN);
        await settle(120);
      }
      await settle(300);
      await tty.press(PAGE_DOWN);
      await settle(300);
      const rows = await painted(tty);

      expect(backend.calls.at(-1)).toMatchObject({
        after: backend.rows[PAGE_SIZE - 1]?.id,
        hidden_only: true,
        summary_search: "hidden",
      });
      expect(rows.join("\n")).toContain("Hidden session 22");
    } finally {
      tty.stop();
    }
  });
});

describe("the frame in a narrow terminal", () => {
  test("keeps every row inside the width and three lines per conversation", async () => {
    const long = "A very long inherited reflection summary ".repeat(6).trim();
    const backend = new HiddenBackend();
    backend.rows = [{ ...fixtureRow(1), summary: long }, fixtureRow(2)];
    const { tty } = mount({ backend, columns: 40, rows: 24 });
    try {
      const rows = await painted(tty);
      for (const entry of rows) {
        expect(terminalTextWidth(entry)).toBeLessThanOrEqual(40);
      }
      const joined = rows.join("\n");
      // The title is clipped, not wrapped: the row still costs exactly three
      // lines, which is what the window's height budget is built on.
      expect(joined).toContain("A very long inherited reflection");
      expect(joined).toContain("reflection · agent-hidden · ctx 1");
      expect(joined).toContain("2h ago");
      expect(rows.some((entry) => entry.endsWith("..."))).toBe(true);
    } finally {
      tty.stop();
    }
  });
});

describe("the list's window", () => {
  test("moves with the cursor", async () => {
    const { tty } = mount({});
    try {
      const first = await painted(tty);
      expect(first).toContain("> Hidden session 1");

      await tty.press(DOWN, DOWN, DOWN, DOWN, DOWN);
      const moved = await painted(tty);
      expect(moved.join("\n")).not.toContain("> Hidden session 1");
      expect(moved.join("\n")).toContain("> Hidden session 6");

      await tty.press(UP);
      const back = await painted(tty);
      expect(back.join("\n")).toContain("> Hidden session 5");
    } finally {
      tty.stop();
    }
  });
});

describe("deleting from the list", () => {
  test("d asks first, names the row, and defaults to Cancel", async () => {
    const { tty, backend } = mount({});
    try {
      await painted(tty);
      await tty.press("d");
      const confirm = frame(await painted(tty));
      expect(confirm).toContain("Delete this hidden session?");
      expect(confirm).toContain("Hidden session 1");
      expect(confirm).toContain(`${AGENT_ID}-conv-01`);
      // Row 1's fixture carries origin reflection and one in-context message;
      // the inherited count is unknown because the fixture never recorded one.
      expect(confirm).toContain(
        "reflection · inherited count unknown · 1 in context",
      );
      expect(confirm).toContain("cannot be undone");
      expect(confirm).toContain("background task may fail");

      // The default row is Cancel: Enter must not destroy anything.
      await tty.press(ENTER);
      await painted(tty);
      expect(backend.deleted).toEqual([]);
      expect(frame(await tty.rows())).toContain("Hidden session 1");
    } finally {
      tty.stop();
    }
  });

  test("confirming deletes the row and reloads the page", async () => {
    const { tty, backend } = mount({});
    try {
      await painted(tty);
      await tty.press("d");
      await painted(tty);
      // Up moves from Cancel to Delete; Enter now fires it.
      await tty.press(UP);
      await tty.press(ENTER);
      await settle(300);

      expect(backend.deleted).toEqual([`${AGENT_ID}-conv-01`]);
      const rows = frame(await painted(tty));
      expect(rows).not.toContain("Hidden session 1");
      expect(rows).toContain("Hidden session 2");
      expect(rows).toContain("esc close");
    } finally {
      tty.stop();
    }
  });

  test("a failed delete keeps the row and reports the error", async () => {
    const backend = new HiddenBackend();
    backend.failDelete = true;
    const { tty } = mount({ backend });
    try {
      await painted(tty);
      await tty.press("d");
      await painted(tty);
      await tty.press(UP);
      await tty.press(ENTER);
      await settle(300);

      const confirm = frame(await painted(tty));
      expect(confirm).toContain("Delete failed: the file is in use");
      // Still the confirmation: the row must not look deleted while the disk
      // still has it.
      expect(confirm).toContain("Delete this hidden session?");

      await tty.press(ESCAPE);
      expect(frame(await painted(tty))).toContain("Hidden session 1");
    } finally {
      tty.stop();
    }
  });
});
