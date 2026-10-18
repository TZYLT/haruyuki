import { afterEach, describe, expect, test } from "bun:test";
import { __testSetBackend } from "@/backend";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import { ConversationSelector } from "@/cli/components/ConversationSelector";
import { mountInkTty, resetInkTtyState } from "@/test-utils/ink-tty";

/**
 * `/resume` on the toolkit, judged on the frame.
 *
 * The list is the interesting part: its window, its cursor, the page it fetches
 * when the cursor reaches the end, and the two keys that are *not* the list's
 * (`j`/`k`, which belong to the always-live search field — before the toolkit
 * they were bound by the list *and* typed into the field, one press doing both).
 *
 * The fixture backend is the fake headless backend with its three reads
 * overridden: the real one pages its own in-memory store, and this test needs a
 * page boundary it can see.
 */

const AGENT_ID = "agent-resume";
const NOW = "2026-03-01T12:00:00.000Z";
const PAGE_SIZE = 20;

const DOWN = "\u001B[B";
const PAGE_DOWN = "\u001B[6~";
const PAGE_UP = "\u001B[5~";
const ENTER = "\r";
const ESCAPE = "\u001B";
const BACKSPACE = "\u007F";

/**
 * `paginatedItems` reads a bare array as well as a page object, which is what
 * the fake backend's own `listConversations` returns (`as never` there too).
 */
function page<T>(items: T[]): never {
  return items as never;
}

const conversation = (index: number) => ({
  id: `conv-${String(index).padStart(2, "0")}`,
  agent_id: AGENT_ID,
  summary: `Conversation ${index}`,
  created_at: NOW,
  updated_at: NOW,
});

const userMessage = (text: string) => ({
  message_type: "user_message",
  content: text,
  date: NOW,
});

const assistantMessage = (text: string) => ({
  message_type: "assistant_message",
  content: [{ type: "text", text }],
  date: NOW,
});

class ConversationBackend extends FakeHeadlessBackend {
  /** Set to make the first page fail, for the error state. */
  fail = false;

  override async listConversations(
    ...args: Parameters<FakeHeadlessBackend["listConversations"]>
  ): ReturnType<FakeHeadlessBackend["listConversations"]> {
    if (this.fail) throw new Error("backend is offline");
    const body = (args[0] ?? {}) as { after?: string; summary_search?: string };
    const all = Array.from({ length: 23 }, (_, index) => conversation(index));
    const matching = body.summary_search
      ? all.filter((row) => row.summary.includes(body.summary_search as string))
      : all;
    if (body.after) {
      const from = matching.findIndex((row) => row.id === body.after) + 1;
      return page(matching.slice(from, from + 3));
    }
    return page(matching.slice(0, PAGE_SIZE));
  }

  override async listConversationMessages(
    ..._args: Parameters<FakeHeadlessBackend["listConversationMessages"]>
  ): ReturnType<FakeHeadlessBackend["listConversationMessages"]> {
    return page([
      assistantMessage("Here is what I found."),
      userMessage("Search the ledger for the missing entry."),
    ]);
  }

  override async listAgentMessages(
    ...args: Parameters<FakeHeadlessBackend["listAgentMessages"]>
  ): ReturnType<FakeHeadlessBackend["listAgentMessages"]> {
    const body = (args[1] ?? {}) as { limit?: number };
    if (body.limit === 1) return page([userMessage("first")]);
    return page([userMessage("hello there"), assistantMessage("hi")]);
  }
}

interface Harness {
  rows: () => Promise<string[]>;
  text: () => Promise<string>;
  press: (...keys: string[]) => Promise<void>;
  stop: () => void;
  selected: string[];
  cancelled: () => number;
}

const settle = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function mount(
  options: { backend?: ConversationBackend } = {},
): Promise<Harness> {
  const backend = options.backend ?? new ConversationBackend();
  __testSetBackend(backend);
  const selected: string[] = [];
  let cancels = 0;
  const tty = mountInkTty(
    <ConversationSelector
      agentId={AGENT_ID}
      agentName="Resume Agent"
      currentConversationId="conv-02"
      onSelect={(id) => selected.push(id)}
      onCancel={() => {
        cancels += 1;
      }}
    />,
    { columns: 80, rows: 24 },
  );
  // The first page is fetched in an effect, and the keys are inert until it
  // lands (`navigationEnabled: !isLoading`), so a test that presses straight
  // away would measure the loading frame.
  await settle(400);
  return {
    rows: async () => {
      await settle(120);
      return tty.rows();
    },
    text: tty.text,
    press: tty.press,
    stop: tty.stop,
    selected,
    cancelled: () => cancels,
  };
}

/** The frame's line that carries the position footer, or "" when it is absent. */
function footerRow(rows: string[]): string {
  return rows.find((row) => row.includes("Showing ")) ?? "";
}

function queryRow(rows: string[]): string {
  return rows.find((row) => row.includes("Search:")) ?? "";
}

/** The row the list's cursor is on, not the `> /resume` header. */
function cursorRow(rows: string[]): string {
  return rows.find((row) => row.startsWith("> ") && row !== "> /resume") ?? "";
}

/**
 * The rows the list actually painted.
 *
 * Asserted alongside the footer on purpose: the footer is computed from the
 * controller's window, so a view that stopped windowing would still print
 * "Showing 1-3" while painting twenty-one rows.
 */
function itemRows(rows: string[]): string[] {
  return rows.filter((row) =>
    /(^|\s)(Conversation \d+|default) .*\(conv-|\(agent's default/.test(row),
  );
}

afterEach(() => {
  resetInkTtyState();
  __testSetBackend(null);
});

describe("ConversationSelector", () => {
  test("shows the page's window and says the position in its own footer", async () => {
    const harness = await mount();
    const rows = await harness.rows();

    // Three items on a 24-row terminal (`(24 - 11) / 4`), with the synthetic
    // `default` row first and no toolkit indicator rows: this face counts the
    // window itself.
    expect(queryRow(rows)).toContain("Search:");
    expect(rows.join("\n")).toContain("default (agent's default conversation)");
    expect(footerRow(rows)).toBe("  Showing 1-3 of 21+");
    expect(itemRows(rows)).toHaveLength(3);
    expect(rows.some((row) => row.includes("more"))).toBe(false);
    harness.stop();
  });

  test("the window holds the cursor in the middle and moves with it", async () => {
    const harness = await mount();
    await harness.press(DOWN, DOWN, DOWN);
    const rows = await harness.rows();

    expect(footerRow(rows)).toBe("  Showing 3-5 of 21+");
    expect(itemRows(rows)).toHaveLength(3);
    // The synthetic `default` row is index 0, so three steps from the top is
    // `conv-02`.
    expect(cursorRow(rows)).toContain("(conv-02)");
    harness.stop();
  });

  test("PageDown and PageUp page the window", async () => {
    const harness = await mount();
    await harness.press(PAGE_DOWN);
    expect(footerRow(await harness.rows())).toBe("  Showing 3-5 of 21+");

    await harness.press(PAGE_UP);
    expect(footerRow(await harness.rows())).toBe("  Showing 1-3 of 21+");
    harness.stop();
  });

  test("Enter selects the row under the cursor, by identity", async () => {
    const harness = await mount();
    await harness.press(DOWN, DOWN, ENTER);

    expect(harness.selected).toEqual(["conv-01"]);
    harness.stop();
  });

  test("j and k are search text, not navigation", async () => {
    // The search field is always live, so the list does not bind them: before
    // the toolkit one press both moved the cursor and typed the letter.
    const harness = await mount();
    await harness.press("j");
    const rows = await harness.rows();

    expect(queryRow(rows)).toContain("Search: j");
    // Nothing matches "j", so the list is not there to navigate — which is the
    // point: the letter went to the query, and the query is what filtered.
    expect(rows.join("\n")).toContain("No matching conversations");
    harness.stop();
  });

  test("typing searches, backspace edits, and Escape clears before it cancels", async () => {
    const harness = await mount();
    await harness.press("l", "e", "d");
    expect(queryRow(await harness.rows())).toContain("Search: led");

    await harness.press(BACKSPACE);
    expect(queryRow(await harness.rows())).toContain("Search: le");

    await harness.press(ESCAPE);
    const cleared = await harness.rows();
    expect(queryRow(cleared)).toContain("search conversation titles");
    expect(harness.cancelled()).toBe(0);

    await harness.press(ESCAPE);
    expect(harness.cancelled()).toBe(1);
    harness.stop();
  });

  test("fetches the next page when the cursor reaches the end of the list", async () => {
    const harness = await mount();
    // 21 rows, three on screen: walk to the bottom, which is where the old
    // handler asked for the page.
    await harness.press(...Array.from({ length: 20 }, () => DOWN));
    const rows = await harness.rows();

    expect(rows.join("\n")).toContain("of 24");
    // The third page was short, so the list ended and the footer drops its `+`.
    expect(footerRow(rows)).not.toContain("+");
    harness.stop();
  });

  test("a failed first page is shown instead of the list", async () => {
    const backend = new ConversationBackend();
    backend.fail = true;
    const harness = await mount({ backend });
    const rows = await harness.rows();

    expect(rows.join("\n")).toContain("Error: backend is offline");
    expect(rows.join("\n")).not.toContain("Showing ");
    harness.stop();
  });
});
