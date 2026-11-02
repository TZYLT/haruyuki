// src/cli/app/pages/overview/overview-page.test.tsx

/**
 * G-8 / G-10 / G-12 for the overview page (《47-2》§1.8, §4.2 W-15): both levels
 * and their keys/pointer at 80×24 and 40 columns, a fake backend for the
 * hidden/`N+`/default/cancelled-preview cases, and the three open paths. The
 * frame and the tab store are real; the backend is the only thing faked.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clearAllSubagents } from "@/agent/subagent-state";
import { __testSetBackend, type Backend } from "@/backend";
import type { AppViewProps } from "@/cli/app/AppView";
import { ChromeHeightContext } from "@/cli/app/chrome-height";
import {
  OVERVIEW_SNAPSHOT_ERROR_NOTE,
  resetOverviewData,
} from "@/cli/app/pages/overview/overview-data";
import { OverviewPage } from "@/cli/app/pages/overview/overview-page";
import { PageHost } from "@/cli/app/pages/page-host";
import {
  createTabStripActions,
  type TabStripActionDeps,
} from "@/cli/app/tab-strip-actions";
import {
  focusTab,
  getTabsState,
  isPageTabId,
  openConversationTab,
  resetTabsForTests,
} from "@/cli/app/tabs";
import type { TabStripProjection } from "@/cli/app/types";
import { resetInputScopes } from "@/cli/helpers/focus-ledger";
import { getHoverTarget, resetHoverForTests } from "@/cli/helpers/hover-store";
import { resetBindingOwners } from "@/cli/helpers/input-router";
import { resetMouseHandlers } from "@/cli/helpers/mouse-router";
import { resetMouseTrackingForTests } from "@/cli/helpers/mouse-tracking";
import {
  type InkTty,
  mountInkTty,
  resetInkTtyState,
} from "@/test-utils/ink-tty";

const CURRENT_AGENT = "agent-1";
const CURRENT_CONVERSATION = "conv-current";
const OTHER_AGENT = "agent-2";

const ESC = "\u001B";
const LEFT = "\u001B[D";
const DOWN = "\u001B[B";
const ENTER = "\r";

/** Long enough for a fake read to land and Ink to paint the frame after it. */
const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

const EMPTY_TAB_STRIP: TabStripProjection = {
  onSelect: () => {},
  onClose: () => {},
  onOverflow: () => {},
};

interface FakeAgent {
  id: string;
  name?: string | null;
  description?: string | null;
}

interface FakeConversation {
  id: string;
  agent_id: string | null;
  summary?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  last_message_at?: string | null;
  hidden?: boolean;
}

interface FakeMessage {
  message_type?: string;
  content?: unknown;
  date?: string | null;
}

interface FakeBackendOptions {
  agents?: FakeAgent[];
  conversations?: FakeConversation[];
  /** Newest-first message rows per agent for its `default` conversation. */
  defaults?: Record<string, FakeMessage[]>;
  /** Newest-first message rows per conversation id for a lazy preview. */
  messages?: Record<string, FakeMessage[]>;
  /** Hold preview reads open, e.g. to land one after a refresh. */
  previewLoader?: (
    conversationId: string,
  ) => FakeMessage[] | Promise<FakeMessage[]>;
}

interface FakeBackendState {
  agentListCalls: number;
  failAgentList: boolean;
  defaultReads: string[];
  previewReads: string[];
}

function createFakeBackend(options: FakeBackendOptions = {}): {
  backend: Backend;
  state: FakeBackendState;
} {
  const state: FakeBackendState = {
    agentListCalls: 0,
    failAgentList: false,
    defaultReads: [],
    previewReads: [],
  };
  const backend = {
    async listAgents() {
      state.agentListCalls += 1;
      if (state.failAgentList) throw new Error("backend unavailable");
      return { items: options.agents ?? [] };
    },
    async listConversations() {
      return options.conversations ?? [];
    },
    async listConversationMessages(
      conversationId: string,
      body?: Record<string, unknown>,
    ) {
      if (conversationId === "default") {
        const agentId = typeof body?.agent_id === "string" ? body.agent_id : "";
        state.defaultReads.push(agentId);
        return options.defaults?.[agentId] ?? [];
      }
      state.previewReads.push(conversationId);
      if (options.previewLoader) {
        return await options.previewLoader(conversationId);
      }
      return options.messages?.[conversationId] ?? [];
    },
  } as unknown as Backend;
  return { backend, state };
}

/** An ISO instant `minutes` in the past, so relative times are stable. */
function atAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function conversation(input: {
  id: string;
  agentId: string | null;
  minutesAgo: number;
  summary?: string | null;
  hidden?: boolean;
}): FakeConversation {
  const at = atAgo(input.minutesAgo);
  return {
    id: input.id,
    agent_id: input.agentId,
    summary: input.summary,
    created_at: at,
    updated_at: at,
    last_message_at: at,
    hidden: input.hidden,
  };
}

function message(
  messageType: "user_message" | "assistant_message",
  text: string,
): FakeMessage {
  return { message_type: messageType, content: text, date: atAgo(1) };
}

function agent(id: string, name: string, description?: string): FakeAgent {
  return { id, name, description: description ?? null };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function pageProps(overrides: Partial<AppViewProps> = {}): AppViewProps {
  return {
    columns: 80,
    conversationId: CURRENT_CONVERSATION,
    agentId: CURRENT_AGENT,
    projectDirectory: process.cwd(),
    tabStrip: EMPTY_TAB_STRIP,
    handleAgentSelect: (async () => {}) as AppViewProps["handleAgentSelect"],
    ...overrides,
  } as unknown as AppViewProps;
}

function mount(
  overrides: Partial<AppViewProps> = {},
  options: { columns?: number; rows?: number } = {},
): InkTty {
  clearAllSubagents();
  return mountInkTty(
    <ChromeHeightContext.Provider value={8}>
      <OverviewPage {...pageProps(overrides)} />
    </ChromeHeightContext.Provider>,
    { columns: options.columns ?? 80, rows: options.rows ?? 24 },
  );
}

/** The row the frame's cursor marks (the body is padded by one column). */
function cursorLine(rows: readonly string[]): string | undefined {
  return rows.find((row) => row.slice(1).startsWith("> "));
}

function cursorLabel(rows: readonly string[]): string | undefined {
  return cursorLine(rows)?.slice(3);
}

/** Press `↓` until the cursor is on the row whose label starts with `label`. */
async function moveCursorTo(tty: InkTty, label: string): Promise<void> {
  for (let step = 0; step < 40; step += 1) {
    if (cursorLabel(await tty.rows())?.startsWith(label)) return;
    await tty.press(DOWN);
    await settle(40);
  }
  throw new Error(`the cursor never reached ${label}`);
}

/** The 1-based screen row of the first painted line containing `text`. */
function screenRowOf(rows: readonly string[], text: string): number {
  const index = rows.findIndex((row) => row.includes(text));
  if (index < 0) throw new Error(`no painted row contains ${text}`);
  return index + 1;
}

/** A left press / release at a cell of the 80×24 frame. */
const pressAt = (column: number, row: number) => `${ESC}[<0;${column};${row}M`;
const releaseAt = (column: number, row: number) =>
  `${ESC}[<0;${column};${row}m`;
/** Any-motion (1003): no button down, which is what a hover sees. */
const moveTo = (column: number, row: number) => `${ESC}[<35;${column};${row}M`;

async function clickRow(
  tty: InkTty,
  rows: readonly string[],
  text: string,
): Promise<void> {
  const row = screenRowOf(rows, text);
  await tty.press(pressAt(2, row), releaseAt(2, row));
  await settle(120);
}

/** A click on a column of the page's header row (row 1 of the frame). */
async function clickHeader(tty: InkTty, column: number): Promise<void> {
  await tty.press(pressAt(column, 1), releaseAt(column, 1));
  await settle(120);
}

beforeEach(() => {
  resetOverviewData();
  resetTabsForTests();
  openConversationTab(CURRENT_CONVERSATION, "Current work");
  focusTab("overview");
});

afterEach(() => {
  __testSetBackend(null);
  resetOverviewData();
  resetTabsForTests();
  resetInkTtyState();
  clearAllSubagents();
  resetMouseHandlers();
  resetHoverForTests();
  resetMouseTrackingForTests();
  resetBindingOwners();
  resetInputScopes();
});

describe("the agent level (G-8)", () => {
  function mountAgents(): InkTty {
    const { backend } = createFakeBackend({
      agents: [
        agent("agent-1", "Alpha", "writes the release notes"),
        agent(OTHER_AGENT, "Beta"),
      ],
      conversations: [
        conversation({
          id: "conv-a1",
          agentId: "agent-1",
          minutesAgo: 5,
          summary: "Team standup",
        }),
        conversation({
          id: "conv-a2",
          agentId: "agent-1",
          minutesAgo: 30,
          summary: "Release notes",
        }),
      ],
      messages: {
        "conv-a1": [
          message("user_message", "the last user words"),
          message("assistant_message", "the last agent words"),
        ],
      },
    });
    __testSetBackend(backend);
    return mount();
  }

  test("the header, the blank line, the fixed New Agent row, then every agent", async () => {
    const tty = mountAgents();
    try {
      await settle();
      const rows = await tty.rows();
      // R-10.7: breadcrumb + keys in the one header row.
      expect(rows[0]).toContain("Agents");
      expect(rows[0]).toContain("↑↓ move");
      // "内容与页头之间空一行".
      expect(rows[1]?.trim()).toBe("");
      // R-10.2: `New Agent` is the fixed first row; the cursor starts on it.
      expect(rows[2]).toContain("New Agent");
      expect(cursorLabel(rows)).toContain("New Agent");

      const text = rows.join("\n");
      expect(text).toContain("Alpha");
      expect(text).toContain("writes the release notes");
      expect(text).toContain("2 conv");
      expect(text).toContain("5m ago");
      // An agent with nothing shows 0 conversations and `—` for no activity.
      expect(text).toContain("Beta");
      expect(text).toContain("0 conv");
      expect(text).toContain("—");
    } finally {
      tty.stop();
    }
  });

  test("↑↓ moves by item across multi-line blocks, and Enter opens that agent", async () => {
    const tty = mountAgents();
    try {
      await settle();
      await moveCursorTo(tty, "Alpha");
      // The item is three terminal lines, but one ↓ step past it is Beta.
      await tty.press(DOWN);
      await settle(60);
      expect(cursorLabel(await tty.rows())).toContain("Beta");
      await tty.press(DOWN);
      await settle(60);
      // The cursor stops at the end instead of wrapping, and ↑ steps back by item.
      expect(cursorLabel(await tty.rows())).toContain("Beta");
      await tty.press("\u001B[A"); // ↑
      await settle(60);
      expect(cursorLabel(await tty.rows())).toContain("Alpha");

      await moveCursorTo(tty, "Alpha");
      await tty.press(ENTER);
      await settle();
      const second = await tty.rows();
      // R-10.7: the breadcrumb names the level you are on.
      expect(second[0]).toContain("Agents / Alpha");
      // R-10.3: New Session is the fixed first row of the second level.
      expect(second.join("\n")).toContain("New Session");
      expect(second.join("\n")).toContain("Team standup");
      // R-10.3: three lines — title, latest user message, latest agent message.
      const titleIndex = second.findIndex((row) =>
        row.includes("Team standup"),
      );
      expect(second[titleIndex]?.trim().endsWith("created 5m ago")).toBe(true);
      expect(second[titleIndex + 1]).toContain("the last user words");
      expect(second[titleIndex + 2]).toContain("the last agent words");
      expect(second[titleIndex + 3]?.trim()).toBe("");
      expect(cursorLabel(second)).toContain("New Session");
    } finally {
      tty.stop();
    }
  });

  test("Esc and ← go back one level, then Esc leaves the page (R-10.6)", async () => {
    const tty = mountAgents();
    try {
      await settle();
      await moveCursorTo(tty, "Alpha");
      await tty.press(ENTER);
      await settle();
      expect((await tty.rows())[0]).toContain("Agents / Alpha");

      // Esc balances one level; the page is still the active tab.
      await tty.press(ESC);
      await settle();
      const back = await tty.rows();
      expect(back.join("\n")).toContain("New Agent");
      expect(back[0]).not.toContain("/");
      expect(getTabsState().activeId).toBe("overview");

      // ← is the same way up from the second level.
      await moveCursorTo(tty, "Alpha");
      await tty.press(ENTER);
      await settle();
      expect((await tty.rows())[0]).toContain("Agents / Alpha");
      await tty.press(LEFT);
      await settle();
      expect((await tty.rows()).join("\n")).toContain("New Agent");
      expect(getTabsState().activeId).toBe("overview");

      // At the root only Esc leaves: there is no level above it for the arrow.
      await tty.press(LEFT);
      await settle();
      expect(getTabsState().activeId).toBe("overview");
      await tty.press(ESC);
      await settle();
      expect(getTabsState().activeId).toBe(CURRENT_CONVERSATION);
    } finally {
      tty.stop();
    }
  });

  test("a hover is the whole block and a click on any line opens it (R-10.5)", async () => {
    const tty = mountAgents();
    try {
      await settle();
      const rows = await tty.rows();
      // Alpha is visible index 3: blank, New Agent, item gap, Alpha.
      await tty.press(moveTo(2, screenRowOf(rows, "writes the release notes")));
      await settle(60);
      expect(getHoverTarget()).toEqual({ area: "page", index: 3 });

      // A continuation line is part of the same block: a click there opens Alpha.
      await clickRow(tty, await tty.rows(), "writes the release notes");
      expect((await tty.rows())[0]).toContain("Agents / Alpha");
    } finally {
      tty.stop();
    }
  });

  test("the wheel scrolls the page and its height never moves", async () => {
    const { backend } = createFakeBackend({
      agents: [
        agent("agent-1", "Alpha", "first"),
        agent(OTHER_AGENT, "Beta", "second"),
        agent("agent-3", "Gamma", "third"),
        agent("agent-4", "Delta", "fourth"),
        agent("agent-5", "Epsilon", "fifth"),
        agent("agent-6", "Zeta", "sixth"),
      ],
    });
    __testSetBackend(backend);
    const tty = mount();
    try {
      await settle();
      const before = await tty.rows({ keepTrailingBlanks: true });
      expect(before.join("\n")).toContain("↓ 4 more");
      expect(before.join("\n")).not.toContain("↑ ");

      // A notch inside the band (code 65 is wheel down).
      await tty.press(`${ESC}[<65;10;6M`);
      await settle(120);
      const after = await tty.rows({ keepTrailingBlanks: true });
      expect(after.join("\n")).toContain("↑ 3 more");
      expect(after.length).toBe(before.length);
    } finally {
      tty.stop();
    }
  });

  test("New Agent is selectable and says it is not wired here yet (W-17)", async () => {
    const tty = mountAgents();
    try {
      await settle();
      await clickRow(tty, await tty.rows(), "New Agent");
      const rows = await tty.rows();
      expect(rows[0]).toContain("New Agent is not available yet.");
      // A no-op, not a crash: still on the agent level.
      expect(getTabsState().activeId).toBe("overview");
      expect(rows.join("\n")).not.toContain("Agents / ");
    } finally {
      tty.stop();
    }
  });
});

describe("the conversation level (G-8)", () => {
  function mountConversations(): InkTty {
    const { backend } = createFakeBackend({
      agents: [agent("agent-1", "Alpha", "writes the release notes")],
      conversations: [
        conversation({
          id: "conv-a1",
          agentId: "agent-1",
          minutesAgo: 5,
          summary: "Team standup",
        }),
        conversation({
          id: "conv-a2",
          agentId: "agent-1",
          minutesAgo: 30,
          summary: "Release notes",
        }),
      ],
      messages: {
        "conv-a1": [
          message("user_message", "the last user words"),
          message("assistant_message", "the last agent words"),
        ],
      },
    });
    __testSetBackend(backend);
    return mount();
  }

  test("New Session is the first row and a click on it is a visible no-op", async () => {
    const tty = mountConversations();
    try {
      await settle();
      await moveCursorTo(tty, "Alpha");
      await tty.press(ENTER);
      await settle();
      expect((await tty.rows())[0]).toContain("Agents / Alpha");

      await clickRow(tty, await tty.rows(), "New Session");
      expect((await tty.rows())[0]).toContain(
        "New Session is not available yet.",
      );
      expect(getTabsState().activeId).toBe("overview");
    } finally {
      tty.stop();
    }
  });

  test("an agent with no conversations shows the one-line empty note", async () => {
    const { backend } = createFakeBackend({
      agents: [agent("agent-1", "Alpha")],
    });
    __testSetBackend(backend);
    const tty = mount();
    try {
      await settle();
      await moveCursorTo(tty, "Alpha");
      await tty.press(ENTER);
      await settle();
      const text = (await tty.rows()).join("\n");
      expect(text).toContain("New Session");
      expect(text).toContain("No conversations to show yet.");
    } finally {
      tty.stop();
    }
  });

  test("an empty agent list is the New Agent row plus one line", async () => {
    const { backend } = createFakeBackend({ agents: [] });
    __testSetBackend(backend);
    const tty = mount();
    try {
      await settle();
      const rows = await tty.rows();
      expect(rows[0]).toContain("Agents");
      expect(rows[1]?.trim()).toBe("");
      expect(rows[2]).toContain("New Agent");
      expect(rows.join("\n")).toContain("No agents to show yet.");
    } finally {
      tty.stop();
    }
  });

  test("a click on a breadcrumb segment returns to the agent level (R-10.5)", async () => {
    const tty = mountConversations();
    try {
      await settle();
      await moveCursorTo(tty, "Alpha");
      await tty.press(ENTER);
      await settle();
      expect((await tty.rows())[0]).toContain("Agents / Alpha");

      // The header's first segment is `Agents`, starting at column 2.
      await clickHeader(tty, 2);
      const rows = await tty.rows();
      expect(rows[0]).toContain("Agents");
      expect(rows[0]).not.toContain("/");
      expect(rows.join("\n")).toContain("New Agent");
      expect(getTabsState().activeId).toBe("overview");

      // At the root the same segment leaves the page for the conversation.
      await clickHeader(tty, 2);
      expect(getTabsState().activeId).toBe(CURRENT_CONVERSATION);
    } finally {
      tty.stop();
    }
  });
});

describe("the data behind the page (G-10)", () => {
  test("hidden conversations are excluded and a full aggregation renders N+", async () => {
    const many = Array.from({ length: 1000 }, (_, index) =>
      conversation({
        id: `conv-${index}`,
        agentId: "agent-1",
        minutesAgo: index,
        summary: `Conversation ${index}`,
      }),
    );
    many.push(
      conversation({
        id: "hidden-conv",
        agentId: "agent-1",
        minutesAgo: 1,
        summary: "Hidden conversation",
        hidden: true,
      }),
    );
    const { backend } = createFakeBackend({
      agents: [agent("agent-1", "Alpha")],
      conversations: many,
    });
    __testSetBackend(backend);
    const tty = mount();
    try {
      await settle(250);
      const rows = await tty.rows();
      const text = rows.join("\n");
      // Q-37 / R-10.8: the aggregation pass hit its cap, so the count is `N+`.
      expect(text).toContain("1000+ conv");
      // Q-35: a hidden conversation is not shown, and is not counted either.
      expect(text).not.toContain("Hidden conversation");
    } finally {
      tty.stop();
    }
  });

  test("each agent's default conversation is 补读 and listed (Q-53)", async () => {
    const { backend, state } = createFakeBackend({
      agents: [agent("agent-1", "Alpha")],
      conversations: [],
      defaults: { "agent-1": [message("assistant_message", "from default")] },
    });
    __testSetBackend(backend);
    const tty = mount();
    try {
      await settle();
      // The supplement read happened for the agent even with no listed rows.
      expect(state.defaultReads).toContain("agent-1");
      await moveCursorTo(tty, "Alpha");
      await tty.press(ENTER);
      await settle();
      const text = (await tty.rows()).join("\n");
      expect(text).toContain("Default");
    } finally {
      tty.stop();
    }
  });

  test("the failure state is one note and the r key, and r re-reads (Q-39)", async () => {
    const { backend, state } = createFakeBackend({
      agents: [agent("agent-1", "Alpha")],
    });
    state.failAgentList = true;
    __testSetBackend(backend);
    const tty = mount();
    try {
      await settle();
      const failed = await tty.rows();
      expect(failed.join("\n")).toContain(OVERVIEW_SNAPSHOT_ERROR_NOTE);
      // Q-39: the retry key is visible next to the note.
      expect(failed[0]).toContain("r retry");
      expect(state.agentListCalls).toBe(1);

      state.failAgentList = false;
      await tty.press("r");
      await settle(250);
      const recovered = await tty.rows();
      expect(recovered.join("\n")).toContain("Alpha");
      expect(state.agentListCalls).toBe(2);
      // The header reports the refresh, then goes back to its key hint.
      expect(recovered[0]).toContain("Updated");
    } finally {
      tty.stop();
    }
  });

  test("snippets are read once per conversation, and a stale read is dropped (R-10.8)", async () => {
    const pending: Array<{
      conversationId: string;
      deferred: ReturnType<typeof createDeferred<FakeMessage[]>>;
    }> = [];
    const { backend, state } = createFakeBackend({
      agents: [agent("agent-1", "Alpha")],
      conversations: [
        conversation({
          id: "conv-a1",
          agentId: "agent-1",
          minutesAgo: 5,
          summary: "Team standup",
        }),
        conversation({
          id: "conv-a2",
          agentId: "agent-1",
          minutesAgo: 30,
          summary: "Release notes",
        }),
      ],
      previewLoader: (conversationId) => {
        const deferred = createDeferred<FakeMessage[]>();
        pending.push({ conversationId, deferred });
        return deferred.promise;
      },
    });
    __testSetBackend(backend);
    const tty = mount();
    try {
      await settle();
      await moveCursorTo(tty, "Alpha");
      await tty.press(ENTER);
      await settle();
      // One read per conversation when the level opens.
      expect(state.previewReads).toEqual(["conv-a1", "conv-a2"]);
      expect(pending).toHaveLength(2);

      // Moving the cursor inside the level asks for nothing new.
      await tty.press(DOWN);
      await settle(60);
      await tty.press(DOWN);
      await settle(60);
      expect(state.previewReads).toHaveLength(2);

      // `r` opens a new generation: the old reads are still open, and the new
      // asks start, so the old answer belongs to a snapshot nobody is showing.
      await tty.press("r");
      await settle(250);
      expect(pending).toHaveLength(4);
      expect(state.previewReads).toHaveLength(4);

      const oldFirst = pending.find(
        (entry) => entry.conversationId === "conv-a1",
      );
      oldFirst?.deferred.resolve([
        message("user_message", "stale user words"),
        message("assistant_message", "stale agent words"),
      ]);
      await settle(200);
      expect((await tty.rows()).join("\n")).not.toContain("stale user words");

      const fresh = pending.filter(
        (entry) => entry.conversationId === "conv-a1",
      );
      const latest = fresh.at(-1);
      latest?.deferred.resolve([
        message("user_message", "fresh user words"),
        message("assistant_message", "fresh agent words"),
      ]);
      await settle(200);
      const text = (await tty.rows()).join("\n");
      expect(text).toContain("fresh user words");
      expect(text).toContain("fresh agent words");
      expect(text).not.toContain("stale user words");
    } finally {
      tty.stop();
    }
  });

  test("a preview that fails leaves the rows and reports it in the header", async () => {
    const { backend } = createFakeBackend({
      agents: [agent("agent-1", "Alpha")],
      conversations: [
        conversation({
          id: "conv-a1",
          agentId: "agent-1",
          minutesAgo: 5,
          summary: "Team standup",
        }),
      ],
      previewLoader: () => {
        throw new Error("preview unavailable");
      },
    });
    __testSetBackend(backend);
    const tty = mount();
    try {
      await settle();
      await moveCursorTo(tty, "Alpha");
      await tty.press(ENTER);
      await settle(250);
      const rows = await tty.rows();
      expect(rows.join("\n")).toContain("Team standup");
      expect(rows[0]).toContain("Couldn't load the conversation.");
      expect(rows[0]).toContain("r retry");
    } finally {
      tty.stop();
    }
  });
});

describe("opening a conversation exits the page and focuses the target (G-12)", () => {
  /**
   * The real tab-strip policy with the app's conversation switch stubbed in the
   * one place this mount cannot own: `switchTo` opens/focuses the tab, so "the
   * page left" is the real `activeId` changing.
   */
  function mountWithNavigation(options: {
    agents: FakeAgent[];
    conversations: FakeConversation[];
    onAgentSelect?: (
      agentId: string,
      opts: { conversationId?: string } | undefined,
    ) => void;
  }): { tty: InkTty; switched: string[] } {
    const switched: string[] = [];
    const conversationIdRef = { current: CURRENT_CONVERSATION };
    const tabStrip = createTabStripActions({
      conversationIdRef,
      isAgentBusy: () => false,
      setQueuedOverlayAction:
        (() => {}) as unknown as TabStripActionDeps["setQueuedOverlayAction"],
      switchTo: async (conversationId: string) => {
        switched.push(conversationId);
        conversationIdRef.current = conversationId;
        openConversationTab(conversationId, conversationId);
        return { status: "switched" as const, message: "switched" };
      },
      openTabsOverlay: () => {},
    });
    const { backend } = createFakeBackend({
      agents: options.agents,
      conversations: options.conversations,
    });
    __testSetBackend(backend);
    const tty = mount({
      tabStrip,
      handleAgentSelect: (async (
        agentId: string,
        opts?: { conversationId?: string },
      ) => {
        options.onAgentSelect?.(agentId, opts);
        if (opts?.conversationId) {
          openConversationTab(opts.conversationId, opts.conversationId);
        }
      }) as AppViewProps["handleAgentSelect"],
    });
    return { tty, switched };
  }

  test("same agent: the tab strip's select switches, and the page is gone", async () => {
    const { tty, switched } = mountWithNavigation({
      agents: [agent("agent-1", "Alpha")],
      conversations: [
        conversation({
          id: "conv-other",
          agentId: "agent-1",
          minutesAgo: 5,
          summary: "Other topic",
        }),
      ],
    });
    try {
      await settle();
      await moveCursorTo(tty, "Alpha");
      await tty.press(ENTER);
      await settle();
      await moveCursorTo(tty, "Other topic");
      await tty.press(ENTER);
      await settle(200);
      expect(switched).toEqual(["conv-other"]);
      expect(isPageTabId(getTabsState().activeId)).toBe(false);
      expect(getTabsState().activeId).toBe("conv-other");
    } finally {
      tty.stop();
    }
  });

  test("the current conversation: focusing its own tab leaves the page", async () => {
    const { tty, switched } = mountWithNavigation({
      agents: [agent("agent-1", "Alpha")],
      conversations: [
        conversation({
          id: CURRENT_CONVERSATION,
          agentId: "agent-1",
          minutesAgo: 5,
          summary: "Current work",
        }),
      ],
    });
    try {
      await settle();
      await moveCursorTo(tty, "Alpha");
      await tty.press(ENTER);
      await settle();
      await moveCursorTo(tty, "Current work");
      await tty.press(ENTER);
      await settle(120);
      // The tab strip focuses the tab that is already current — no switch.
      expect(switched).toEqual([]);
      expect(getTabsState().activeId).toBe(CURRENT_CONVERSATION);
    } finally {
      tty.stop();
    }
  });

  test("another agent: handleAgentSelect carries the conversation, and the page is gone", async () => {
    const calls: Array<[string, string | undefined]> = [];
    const { tty } = mountWithNavigation({
      agents: [agent("agent-1", "Alpha"), agent(OTHER_AGENT, "Beta")],
      conversations: [
        conversation({
          id: "conv-b",
          agentId: OTHER_AGENT,
          minutesAgo: 3,
          summary: "Beta talk",
        }),
      ],
      onAgentSelect: (agentId, opts) => {
        calls.push([agentId, opts?.conversationId]);
      },
    });
    try {
      await settle();
      await moveCursorTo(tty, "Beta");
      await tty.press(ENTER);
      await settle();
      expect((await tty.rows())[0]).toContain("Agents / Beta");
      await moveCursorTo(tty, "Beta talk");
      await tty.press(ENTER);
      await settle(200);
      expect(calls).toEqual([[OTHER_AGENT, "conv-b"]]);
      expect(isPageTabId(getTabsState().activeId)).toBe(false);
      expect(getTabsState().activeId).toBe("conv-b");
    } finally {
      tty.stop();
    }
  });
});

describe("the + tab (W-15 wiring)", () => {
  test("the page host shows the real overview page, not a placeholder", async () => {
    const { backend } = createFakeBackend({
      agents: [agent("agent-1", "Alpha", "writes the release notes")],
    });
    __testSetBackend(backend);
    const tty = mountInkTty(
      <ChromeHeightContext.Provider value={8}>
        <PageHost {...pageProps()} />
      </ChromeHeightContext.Provider>,
      { columns: 80, rows: 24 },
    );
    try {
      await settle();
      const before = await tty.rows();
      expect(before[0]).toContain("Agents");
      expect(before.join("\n")).toContain("Alpha");
      // The real page's keyboard path works through the host: ↓ then Enter.
      await moveCursorTo(tty, "Alpha");
      await tty.press(ENTER);
      await settle();
      expect((await tty.rows())[0]).toContain("Agents / Alpha");
    } finally {
      tty.stop();
    }
  });
});

describe("the narrow frame", () => {
  test("at 40 columns the header and the rows stay one line each", async () => {
    const { backend } = createFakeBackend({
      agents: [
        agent(
          "agent-1",
          "Alpha",
          "writes the release notes and keeps the changelog in order",
        ),
      ],
      conversations: [],
    });
    __testSetBackend(backend);
    const tty = mount({}, { columns: 40 });
    try {
      await settle();
      const rows = await tty.rows({ keepTrailingBlanks: true });
      // 24 rows - 8 chrome - 2 strip = the band; the page keeps its height, so
      // nothing wrapped into an extra line and the hint was clipped in place.
      expect(rows.length).toBe(14);
      expect(rows[0]).toContain("Agents");
      expect(rows[0]).toContain("...");
      expect(rows[0]).not.toContain("r refresh");
      expect(rows[2]).toContain("New Agent");

      const text = rows.join("\n");
      expect(text).toContain("Alpha");
      // The continuation line is clipped by the row builder to the band's width.
      expect(text).toContain("writes the release notes and keep...");
      expect(text).not.toContain("changelog in order");
    } finally {
      tty.stop();
    }
  });
});
