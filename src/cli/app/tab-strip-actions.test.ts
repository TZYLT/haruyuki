import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  beginSelection,
  hasSelection,
  resetViewportSelectionForTests,
} from "@/cli/app/viewport-selection";
import { getNotice, resetNoticeForTests } from "@/cli/helpers/notice";
import {
  resetSwitchPolicyForTests,
  SWITCH_QUEUED_NOTICE,
  SWITCH_REFUSED_NOTICE,
  setSwitchPolicy,
} from "./switch-policy";
import {
  createTabStripActions,
  type TabStripActionDeps,
} from "./tab-strip-actions";
import {
  focusTab,
  getOpenConversations,
  getTabsState,
  openConversationTab,
  resetTabsForTests,
} from "./tabs";
import type { QueuedOverlayAction } from "./types";

/**
 * What the two clicks mean, judged without a backend or a frame.
 *
 * The strip's geometry and its mouse plumbing are tested beside it; this is the
 * part that decides *what happens* — whether a click switches, defers or is
 * refused, and what a close does to the tab it is on. Every one of these was a
 * ruling (《38》§3–§5), and the ruling is only real if it survives the code path.
 */

type Harness = {
  actions: ReturnType<typeof createTabStripActions>;
  /** Conversations `switchTo` was asked to load. */
  switched: string[];
  /** Queued actions the deferral wrote. */
  queued: QueuedOverlayAction[];
  /** Times the collapsed `+N` asked for the tab list. */
  overflow: number;
  /** What `switchTo` answers next. */
  outcome: "switched" | "failed";
  busy: boolean;
};

function harness(conversationId: string): Harness {
  const state: Harness = {
    actions: undefined as unknown as ReturnType<typeof createTabStripActions>,
    switched: [],
    queued: [],
    overflow: 0,
    outcome: "switched",
    busy: false,
  };
  const deps: TabStripActionDeps = {
    conversationIdRef: { current: conversationId },
    isAgentBusy: () => state.busy,
    setQueuedOverlayAction: (action) => {
      state.queued.push(typeof action === "function" ? action(null) : action);
    },
    switchTo: async (target) => {
      state.switched.push(target);
      return state.outcome === "switched"
        ? { status: "switched", message: `resumed ${target}` }
        : { status: "failed", message: `failed ${target}` };
    },
    openTabsOverlay: () => {
      state.overflow += 1;
    },
  };
  state.actions = createTabStripActions(deps);
  return state;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  resetTabsForTests();
  resetSwitchPolicyForTests();
  resetNoticeForTests();
  resetViewportSelectionForTests();
});

/**
 * Reset *before* each test as well, not only after it.
 *
 * These cases assert the tab list absolutely (`["conv-1", "conv-2"]`), and the tab
 * store is module state that outlives a file: a test elsewhere that mounts the real
 * TUI and leaves a conversation open (`conv-fake-headless-1` is the one that did)
 * makes the list open with a stranger in it. `afterEach` alone cannot help — the
 * leak is already there when the first case starts.
 */
beforeEach(() => {
  resetTabsForTests();
  resetSwitchPolicyForTests();
  resetNoticeForTests();
  resetViewportSelectionForTests();
});

describe("clicking a tab's name", () => {
  test("a page takes over the main area without touching the runtime", () => {
    openConversationTab("conv-1", "first");
    openConversationTab("conv-2", "second");
    const app = harness("conv-2");

    app.actions.onSelect("settings");

    expect(getTabsState().activeId).toBe("settings");
    expect(app.switched).toEqual([]);
    // The conversations are still open behind the page.
    expect(getOpenConversations().map((tab) => tab.id)).toEqual([
      "conv-1",
      "conv-2",
    ]);
  });

  test("the conversation already on screen is focused back, not switched", async () => {
    openConversationTab("conv-1", "first");
    focusTab("settings");
    const app = harness("conv-1");

    app.actions.onSelect("conv-1");

    expect(getTabsState().activeId).toBe("conv-1");
    expect(app.switched).toEqual([]);
  });

  test("another conversation is loaded and its tab focused", async () => {
    openConversationTab("conv-1", "first");
    openConversationTab("conv-2", "second");
    const app = harness("conv-2");

    app.actions.onSelect("conv-1");
    await settle();

    expect(app.switched).toEqual(["conv-1"]);
    expect(getNotice()).toBeNull();
  });

  test("a failed switch says so on the hint row and leaves the tab alone", async () => {
    openConversationTab("conv-1", "first");
    openConversationTab("conv-2", "second");
    const app = harness("conv-2");
    app.outcome = "failed";

    app.actions.onSelect("conv-1");
    await settle();

    expect(getNotice()).toBe("failed conv-1");
  });

  test("a click while a turn runs is deferred by the compatibility policy", async () => {
    openConversationTab("conv-1", "first");
    openConversationTab("conv-2", "second");
    const app = harness("conv-2");
    app.busy = true;

    app.actions.onSelect("conv-1");

    expect(app.switched).toEqual([]);
    expect(app.queued).toEqual([
      { type: "switch_conversation", conversationId: "conv-1" },
    ]);
    expect(getNotice()).toBe(SWITCH_QUEUED_NOTICE);
  });

  test("a click while a turn runs is refused by the full-screen policy", async () => {
    openConversationTab("conv-1", "first");
    openConversationTab("conv-2", "second");
    const app = harness("conv-2");
    app.busy = true;
    setSwitchPolicy("refuse");

    app.actions.onSelect("conv-1");

    expect(app.switched).toEqual([]);
    expect(app.queued).toEqual([]);
    expect(getNotice()).toBe(SWITCH_REFUSED_NOTICE);
  });

  test("either click drops a selection taken from the transcript", () => {
    openConversationTab("conv-1", "first");
    openConversationTab("conv-2", "second");
    const app = harness("conv-2");

    beginSelection({ row: 3, column: 1 });
    app.actions.onSelect("settings");
    expect(hasSelection()).toBe(false);

    beginSelection({ row: 3, column: 1 });
    app.actions.onClose("conv-1");
    // Closing a *background* tab leaves the transcript in place, so the text the
    // drag covered is still the text on screen.
    expect(hasSelection()).toBe(true);
  });
});

describe("clicking a tab's close", () => {
  test("the last conversation tab cannot be closed", () => {
    openConversationTab("conv-1", "first");
    const app = harness("conv-1");

    app.actions.onClose("conv-1");

    expect(getNotice()).toBe("At least one conversation tab must stay open");
    expect(getOpenConversations().map((tab) => tab.id)).toEqual(["conv-1"]);
    expect(app.switched).toEqual([]);
  });

  test("a background tab is dropped without loading anything", () => {
    openConversationTab("conv-1", "first");
    openConversationTab("conv-2", "second");
    const app = harness("conv-2");

    app.actions.onClose("conv-1");

    expect(getOpenConversations().map((tab) => tab.id)).toEqual(["conv-2"]);
    expect(getTabsState().activeId).toBe("conv-2");
    expect(app.switched).toEqual([]);
  });

  test("the current tab hands over to the most recently opened one left", async () => {
    openConversationTab("conv-1", "first");
    openConversationTab("conv-2", "second");
    openConversationTab("conv-3", "third");
    const app = harness("conv-3");

    app.actions.onClose("conv-3");
    await settle();

    expect(app.switched).toEqual(["conv-2"]);
    expect(getOpenConversations().map((tab) => tab.id)).toEqual([
      "conv-1",
      "conv-2",
    ]);
    expect(getTabsState().activeId).toBe("conv-2");
  });

  test("a handover that fails keeps the tab that was asked to close", async () => {
    openConversationTab("conv-1", "first");
    openConversationTab("conv-2", "second");
    const app = harness("conv-2");
    app.outcome = "failed";

    app.actions.onClose("conv-2");
    await settle();

    expect(getOpenConversations().map((tab) => tab.id)).toEqual([
      "conv-1",
      "conv-2",
    ]);
    expect(getNotice()).toBe("failed conv-1");
    expect(hasSelection()).toBe(false);
  });

  test("the current tab cannot be closed while a turn runs", () => {
    openConversationTab("conv-1", "first");
    openConversationTab("conv-2", "second");
    const app = harness("conv-2");
    app.busy = true;

    app.actions.onClose("conv-2");

    expect(getNotice()).toBe("Running · press Esc to interrupt before closing");
    expect(app.switched).toEqual([]);
    expect(getOpenConversations()).toHaveLength(2);
  });
});
