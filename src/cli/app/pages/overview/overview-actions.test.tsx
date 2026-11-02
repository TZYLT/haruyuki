// src/cli/app/pages/overview/overview-actions.test.tsx

/**
 * W-17's two New rows on the `+` overview (《47-2》§4.2 W-17; 《47-1》R-10.2 /
 * R-10.3, Q-36 / Q-54; 门 G-11).
 *
 * Two claims, both judged on the frame:
 *
 * - **New Session is the app's own `/new`.** The row calls the submit callback
 *   with the literal `/new` and nothing else: no second implementation of the
 *   session hooks, reminders or persistence, and no navigation of its own. The
 *   page leaves when the app's conversation switch focuses a tab, exactly as a
 *   typed `/new` does. G-11's "same observable actions" is therefore the same
 *   callback with the same argument.
 * - **New Agent is the existing `handleCreateNewAgent` flow** with the name
 *   typed in the page's header row (Q-54): `Enter` creates, `Esc` returns to the
 *   list, a failed create is one header note, and success is the app's `agentId`
 *   switch — which is also the page's way out when the new agent's conversation
 *   is the one already open (`default` → `default`).
 *
 * Split out of `overview-page.test.tsx` when that file reached the 1,000-line
 * limit: the shell's frame, pointer, data and navigation claims stay there, the
 * two action rows and their outcome notes live here.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { __testSetBackend, type Backend } from "@/backend";
import type { AppViewProps } from "@/cli/app/AppView";
import { ChromeHeightContext } from "@/cli/app/chrome-height";
import { resetOverviewData } from "@/cli/app/pages/overview/overview-data";
import { OverviewPage } from "@/cli/app/pages/overview/overview-page";
import {
  focusTab,
  getTabsState,
  isPageTabId,
  openConversationTab,
  resetTabsForTests,
} from "@/cli/app/tabs";
import type { TabStripProjection } from "@/cli/app/types";
import { resetInputScopes } from "@/cli/helpers/focus-ledger";
import { resetHoverForTests } from "@/cli/helpers/hover-store";
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
const AGENT_NAME = "Alpha";

const ESC = "\u001B";
const DOWN = "\u001B[B";
const ENTER = "\r";

/** Long enough for a fake read to land and Ink to paint the frame after it. */
const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

const EMPTY_TAB_STRIP: TabStripProjection = {
  onSelect: () => {},
  onClose: () => {},
  onOverflow: () => {},
};

/** A left press / release at a cell (1-based screen coordinates). */
const pressAt = (column: number, row: number) => `${ESC}[<0;${column};${row}M`;
const releaseAt = (column: number, row: number) =>
  `${ESC}[<0;${column};${row}m`;

/** A backend with one agent and no conversations: these tests open neither. */
function useFakeAgents(): void {
  const backend = {
    async listAgents() {
      return {
        items: [{ id: CURRENT_AGENT, name: AGENT_NAME, description: null }],
      };
    },
    async listConversations() {
      return [];
    },
    async listConversationMessages() {
      return [];
    },
  } as unknown as Backend;
  __testSetBackend(backend);
}

function pageProps(overrides: Partial<AppViewProps> = {}): AppViewProps {
  return {
    columns: 80,
    conversationId: CURRENT_CONVERSATION,
    agentId: CURRENT_AGENT,
    projectDirectory: process.cwd(),
    tabStrip: EMPTY_TAB_STRIP,
    handleAgentSelect: (async () => {}) as AppViewProps["handleAgentSelect"],
    isAgentBusy: () => false,
    handleCreateNewAgent:
      (async () => {}) as AppViewProps["handleCreateNewAgent"],
    onSubmit: (async () => ({ submitted: true })) as AppViewProps["onSubmit"],
    ...overrides,
  } as unknown as AppViewProps;
}

function pageElement(overrides: Partial<AppViewProps> = {}) {
  return (
    <ChromeHeightContext.Provider value={8}>
      <OverviewPage {...pageProps(overrides)} />
    </ChromeHeightContext.Provider>
  );
}

function mount(
  overrides: Partial<AppViewProps> = {},
  options: { columns?: number } = {},
): InkTty {
  return mountInkTty(pageElement(overrides), {
    columns: options.columns ?? 80,
    rows: 24,
  });
}

/** The New Agent row is the page's first item, so the cursor starts on it. */
async function openNameEditor(tty: InkTty): Promise<void> {
  await settle();
  await tty.press(ENTER);
  await settle();
}

/** The row the frame's cursor marks (the body is padded by one column). */
function cursorLabel(rows: readonly string[]): string | undefined {
  const line = rows.find((row) => row.slice(1).startsWith("> "));
  return line?.slice(3);
}

/** ↓ to the agent row, Enter: the conversation level, whose first row is New Session. */
async function openConversationLevel(tty: InkTty): Promise<void> {
  await settle();
  // Step until the cursor actually moves: a single press can be lost while the
  // mount settles, and asserting on the frame means waiting for the frame.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const before = cursorLabel(await tty.rows());
    await tty.press(DOWN);
    await settle(60);
    if (cursorLabel(await tty.rows()) !== before) break;
  }
  await tty.press(ENTER);
  await settle();
}

async function typeText(tty: InkTty, text: string): Promise<void> {
  await tty.press(...text);
  await settle(60);
}

function submitName(created: string[]): AppViewProps["handleCreateNewAgent"] {
  return (async (name: string) => {
    created.push(name);
  }) as AppViewProps["handleCreateNewAgent"];
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
  resetMouseHandlers();
  resetHoverForTests();
  resetMouseTrackingForTests();
  resetBindingOwners();
  resetInputScopes();
});

describe("New Agent (Q-54)", () => {
  test("a click on the row opens the one-row editor; Esc returns to the list", async () => {
    useFakeAgents();
    const created: string[] = [];
    const tty = mount({ handleCreateNewAgent: submitName(created) });
    try {
      await settle();
      // The New Agent row is the band's third line (header, blank, row).
      await tty.press(pressAt(2, 3), releaseAt(2, 3));
      await settle(120);
      const editor = await tty.rows();
      // The editor *is* the header row; the list behind it does not move.
      expect(editor[0]).toContain("New agent name:");
      expect(editor.join("\n")).toContain(AGENT_NAME);
      // Typing reaches the editor rather than the page's keys.
      await typeText(tty, "Beta");
      expect((await tty.rows())[0]).toContain("Beta");

      // Esc cancels: no create, and the list has the keys again.
      await tty.press(ESC);
      await settle();
      const back = await tty.rows();
      expect(back[0]).toContain("Agents");
      expect(back[0]).not.toContain("New agent name:");
      expect(created).toEqual([]);
      expect(getTabsState().activeId).toBe("overview");
      // The frame's own Esc is back too: it leaves the page.
      await tty.press(ESC);
      await settle();
      expect(getTabsState().activeId).toBe(CURRENT_CONVERSATION);
    } finally {
      tty.stop();
    }
  });

  test("an invalid name keeps the editor open with its reason", async () => {
    useFakeAgents();
    const created: string[] = [];
    const tty = mount({ handleCreateNewAgent: submitName(created) });
    try {
      await openNameEditor(tty);
      await tty.press("/");
      await tty.press(ENTER);
      await settle(80);
      const rows = await tty.rows();
      expect(rows[0]).toContain("New agent name:");
      expect(rows[0]).toContain("invalid");
      // Nothing was handed to the app: the same editor is still up.
      expect(created).toEqual([]);
    } finally {
      tty.stop();
    }
  });

  test("Enter creates the named agent, and the app's switch is what leaves the page", async () => {
    useFakeAgents();
    const created: string[] = [];
    const tty = mountInkTty(
      pageElement({ handleCreateNewAgent: submitName(created) }),
      {
        columns: 80,
        rows: 24,
      },
    );
    try {
      await openNameEditor(tty);
      await typeText(tty, "Beta");
      await tty.press(ENTER);
      await settle();
      expect(created).toEqual(["Beta"]);

      // The app switched to the new agent. Its default conversation is the id
      // this session already has open (`default` → `default`), so no tab is
      // focused by the app — the page's own focus of the target is the way out
      // (R-10.4: the same navigation, this entry point).
      expect(getTabsState().activeId).toBe("overview");
      await tty.rerender(
        pageElement({
          agentId: "agent-new",
          handleCreateNewAgent: submitName(created),
        }),
      );
      await settle(120);
      expect(isPageTabId(getTabsState().activeId)).toBe(false);
      expect(getTabsState().activeId).toBe(CURRENT_CONVERSATION);
    } finally {
      tty.stop();
    }
  });

  test("a create that never switches the app is reported in one note", async () => {
    useFakeAgents();
    const created: string[] = [];
    const tty = mount({ handleCreateNewAgent: submitName(created) });
    try {
      await openNameEditor(tty);
      await typeText(tty, "Beta");
      await tty.press(ENTER);
      // The handler resolves for both outcomes; the page's settle window is what
      // separates "the app switched" from "it did not".
      await settle(700);
      const rows = await tty.rows();
      expect(rows[0]).toContain('Couldn\'t create agent "Beta".');
      // A note, not a state: the agent list is still the page.
      expect(rows.join("\n")).toContain(AGENT_NAME);
      expect(getTabsState().activeId).toBe("overview");
    } finally {
      tty.stop();
    }
  });

  test("a create that rejects is reported in one note", async () => {
    useFakeAgents();
    const tty = mount({
      handleCreateNewAgent: (async () => {
        throw new Error("backend unavailable");
      }) as AppViewProps["handleCreateNewAgent"],
    });
    try {
      await openNameEditor(tty);
      await typeText(tty, "Beta");
      await tty.press(ENTER);
      await settle(200);
      expect((await tty.rows())[0]).toContain('Couldn\'t create agent "Beta".');
    } finally {
      tty.stop();
    }
  });
});

describe("New Session is /new (G-11)", () => {
  test("the row hands the submit path the literal /new, and nothing else", async () => {
    useFakeAgents();
    const submissions: Array<string | undefined> = [];
    const agentSelects: string[] = [];
    const tabSelects: string[] = [];
    const created: string[] = [];
    const tty = mount({
      onSubmit: (async (message?: string) => {
        submissions.push(message);
        return { submitted: true };
      }) as AppViewProps["onSubmit"],
      handleAgentSelect: (async (agentId: string) => {
        agentSelects.push(agentId);
      }) as AppViewProps["handleAgentSelect"],
      handleCreateNewAgent: submitName(created),
      tabStrip: {
        ...EMPTY_TAB_STRIP,
        onSelect: (tabId: string) => {
          tabSelects.push(tabId);
        },
      },
    });
    try {
      await openConversationLevel(tty);
      expect((await tty.rows())[0]).toContain(`Agents / ${AGENT_NAME}`);
      // The cursor starts on the fixed first row.
      await tty.press(ENTER);
      await settle(120);
      expect(submissions).toEqual(["/new"]);
      // The page re-implements none of /new: no switch, no other action.
      expect(agentSelects).toEqual([]);
      expect(tabSelects).toEqual([]);
      expect(created).toEqual([]);
      // And no navigation of its own: it leaves when the app's switch focuses.
      expect(getTabsState().activeId).toBe("overview");
    } finally {
      tty.stop();
    }
  });

  test("the app's conversation switch is what leaves the page", async () => {
    useFakeAgents();
    const tty = mount({
      onSubmit: (async () => {
        // What the submit path's `/new` ends with: a new conversation in the
        // main area, which `use-conversation-tab` opens and focuses.
        openConversationTab("conv-new", "New session");
        return { submitted: true };
      }) as AppViewProps["onSubmit"],
    });
    try {
      await openConversationLevel(tty);
      await tty.press(ENTER);
      await settle(120);
      expect(isPageTabId(getTabsState().activeId)).toBe(false);
      expect(getTabsState().activeId).toBe("conv-new");
    } finally {
      tty.stop();
    }
  });

  test("a refused submit is one note, and the page stays", async () => {
    useFakeAgents();
    const tty = mount({
      onSubmit: (async () => ({
        submitted: false,
      })) as AppViewProps["onSubmit"],
    });
    try {
      await openConversationLevel(tty);
      await tty.press(ENTER);
      await settle(120);
      expect((await tty.rows())[0]).toContain("Couldn't start a new session.");
      expect(getTabsState().activeId).toBe("overview");
    } finally {
      tty.stop();
    }
  });

  test("a busy agent's /new refusal is repeated in the header", async () => {
    useFakeAgents();
    const tty = mount({
      isAgentBusy: () => true,
      onSubmit: (async () => ({ submitted: true })) as AppViewProps["onSubmit"],
    });
    try {
      await openConversationLevel(tty);
      await tty.press(ENTER);
      await settle(120);
      expect((await tty.rows())[0]).toContain(
        "/new is disabled while the agent is running.",
      );
      expect(getTabsState().activeId).toBe("overview");
    } finally {
      tty.stop();
    }
  });
});

describe("the name editor on a narrow terminal", () => {
  test("the editor and its clipped reason stay one header row at 40 columns", async () => {
    useFakeAgents();
    const created: string[] = [];
    const tty = mount(
      { handleCreateNewAgent: submitName(created) },
      { columns: 40 },
    );
    try {
      await openNameEditor(tty);
      await tty.press("/");
      await tty.press(ENTER);
      await settle(80);
      const rows = await tty.rows({ keepTrailingBlanks: true });
      // Still the band's full height: the editor row and its clipped error did
      // not wrap into a line the frame never budgeted.
      expect(rows.length).toBe(14);
      expect(rows[0]).toContain("New agent name:");
      expect(rows[0]).toContain("Name contains");
    } finally {
      tty.stop();
    }
  });
});
