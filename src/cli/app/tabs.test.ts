import { afterEach, describe, expect, test } from "bun:test";
import {
  allTabs,
  conversationTitle,
  findTab,
  focusTab,
  getOpenConversations,
  getTabsState,
  getTabUnread,
  isPageTabId,
  openConversationTab,
  pageTabs,
  removeConversationTab,
  resetTabsForTests,
  setTabTitle,
  setTabUnread,
  subscribeToTabs,
} from "./tabs";

/**
 * The tab model: open order, the active tab, the unread mark, and what happens
 * to focus when a tab goes away.
 *
 * The store is small and its rules are the ones the strip draws and the click
 * handler acts on, so they are pinned here rather than through a frame: the
 * interesting cases are *ordering* (open order is the order the user visited,
 * not the backend's) and *handoff* (which tab is active after a close).
 */

afterEach(() => {
  resetTabsForTests();
});

describe("the tab model", () => {
  test("conversations are recorded in open order and the last one focused", () => {
    openConversationTab("conv-1", "first");
    openConversationTab("conv-2", "second");
    openConversationTab("conv-3", "third");

    expect(getOpenConversations().map((tab) => tab.id)).toEqual([
      "conv-1",
      "conv-2",
      "conv-3",
    ]);
    expect(getTabsState().activeId).toBe("conv-3");
  });

  test("opening a conversation again focuses its tab instead of growing one", () => {
    openConversationTab("conv-1", "first");
    openConversationTab("conv-2", "second");
    openConversationTab("conv-1", "first");

    expect(getOpenConversations().map((tab) => tab.id)).toEqual([
      "conv-1",
      "conv-2",
    ]);
    expect(getTabsState().activeId).toBe("conv-1");
  });

  test("the two pages are always on the strip, after the conversations", () => {
    openConversationTab("conv-1", "first");
    expect(allTabs().map((tab) => tab.id)).toEqual([
      "conv-1",
      "usage",
      "settings",
    ]);
    expect(pageTabs().map((tab) => tab.id)).toEqual(["usage", "settings"]);
    expect(isPageTabId("settings")).toBe(true);
    expect(isPageTabId("conv-1")).toBe(false);
    expect(findTab("usage")?.title).toBe("Usage");
  });

  test("focusing a page moves the main area without touching the conversations", () => {
    openConversationTab("conv-1", "first");
    focusTab("settings");

    expect(getTabsState().activeId).toBe("settings");
    expect(getOpenConversations().map((tab) => tab.id)).toEqual(["conv-1"]);
  });

  test("focusing an unknown tab changes nothing", () => {
    openConversationTab("conv-1", "first");
    focusTab("no-such-tab");
    expect(getTabsState().activeId).toBe("conv-1");
  });

  test("a title is updated in place, and an unknown id is ignored", () => {
    openConversationTab("conv-1", "conv-1");
    setTabTitle("conv-1", "the real title");
    setTabTitle("conv-2", "never seen");

    expect(getOpenConversations()).toEqual([
      {
        kind: "conversation",
        id: "conv-1",
        title: "the real title",
        unread: false,
      },
    ]);
  });

  test("the unread mark is set from outside and cleared by focusing", () => {
    openConversationTab("conv-1", "first");
    openConversationTab("conv-2", "second");
    // conv-2 was focused by opening it, so it starts read.
    expect(getTabUnread("conv-2")).toBe(false);

    setTabUnread("conv-1", true);
    expect(getTabUnread("conv-1")).toBe(true);

    focusTab("conv-1");
    expect(getTabUnread("conv-1")).toBe(false);
  });

  test("closing the active tab hands over to the most recently opened one left", () => {
    openConversationTab("conv-1", "first");
    openConversationTab("conv-2", "second");
    openConversationTab("conv-3", "third");

    removeConversationTab("conv-3");
    expect(getTabsState().activeId).toBe("conv-2");
    expect(getOpenConversations().map((tab) => tab.id)).toEqual([
      "conv-1",
      "conv-2",
    ]);
  });

  test("closing a background tab leaves the active one alone", () => {
    openConversationTab("conv-1", "first");
    openConversationTab("conv-2", "second");

    removeConversationTab("conv-1");
    expect(getTabsState().activeId).toBe("conv-2");
    expect(getOpenConversations().map((tab) => tab.id)).toEqual(["conv-2"]);
  });

  test("closing a tab the strip does not hold is a no-op", () => {
    openConversationTab("conv-1", "first");
    removeConversationTab("conv-9");
    expect(getTabsState().activeId).toBe("conv-1");
  });

  test("a title falls back to the conversation id", () => {
    expect(conversationTitle("Ledger work", "conv-1")).toBe("Ledger work");
    expect(conversationTitle("  \n Second line \n third", "conv-1")).toBe(
      "Second line",
    );
    expect(conversationTitle(null, "conv-1")).toBe("conv-1");
    expect(conversationTitle("   ", "conv-1")).toBe("conv-1");
  });

  test("the snapshot is stable until something changes", () => {
    const before = getTabsState();
    expect(getTabsState()).toBe(before);

    let notified = 0;
    const unsubscribe = subscribeToTabs(() => {
      notified += 1;
    });
    openConversationTab("conv-1", "first");
    expect(notified).toBe(1);
    expect(getTabsState()).not.toBe(before);

    // A no-op does not notify, which is what keeps the strip from repainting.
    setTabUnread("conv-9", true);
    setTabTitle("conv-9", "nope");
    focusTab("conv-1");
    expect(notified).toBe(1);
    unsubscribe();
  });
});
