// src/cli/app/tabs.ts

import { useSyncExternalStore } from "react";

/**
 * The tab strip's model: which conversations this session has opened, in the
 * order it opened them, and which tab the main area is showing.
 *
 * A module store rather than React state, for the reason `viewport-scroll` and
 * `older-history` are: the writers are mouse reports and command paths that
 * arrive outside the component tree, and the reader is one strip of chrome. A
 * tab change is rare — open, focus, close, a title arriving — so the store
 * notifies instead of re-rendering the composer or the transcript per keystroke
 * (the flicker red line in `src/cli/AGENTS.md`).
 *
 * **The set** is the M6 ruling (《38》§3.1): every conversation this session has
 * opened, in open order, then the two fixed pages with `Usage` immediately left
 * of `Settings` at the right end. Every conversation the app switches to is
 * recorded here; nothing else opens a tab.
 *
 * **A tab is a handle, not a runtime.** The app keeps exactly one live
 * conversation (甲), so a background tab stores identity and display only:
 * conversation id, title, unread mark. It holds no transcript (《38》§5), which
 * is why `unread` means "the backend has a new message for it" and not "a
 * background turn finished". Nothing in this module produces that mark yet —
 * there is no such source under 甲; the flag is here so the strip can draw it
 * and the event that does arrive can set it.
 *
 * **The open order is the order tabs were focused, not the order the backend
 * lists them.** That is what makes `/resume`-then-`/resume` produce a stable
 * left-to-right history of where the user has been.
 */

/** The fixed page tabs, in strip order: `Usage` then `Settings` (rightmost). */
export type PageTabId = "usage" | "settings";

export const PAGE_TABS = [
  { kind: "page", id: "usage", title: "Usage" },
  { kind: "page", id: "settings", title: "Settings" },
] as const satisfies readonly PageTab[];

export type ConversationTab = {
  kind: "conversation";
  /** Backend conversation id (`"default"` for an agent's default conversation). */
  id: string;
  /** Display title: the conversation summary, else the id. Never empty. */
  title: string;
  /** The backend has a message for this conversation the user has not seen. */
  unread: boolean;
};

export type PageTab = {
  kind: "page";
  id: PageTabId;
  title: string;
};

export type Tab = ConversationTab | PageTab;

export type TabsState = {
  /** Opened conversations, in open order. */
  conversations: readonly ConversationTab[];
  /**
   * The tab the main area shows: a conversation id, or a page id.
   *
   * One id space, because the strip is one row and only one tab is active. The
   * two page ids are reserved words ("usage" / "settings"), never conversation
   * ids: a conversation id that collided with one would be a backend id shaped
   * like a page name.
   */
  activeId: string;
};

const EMPTY: TabsState = { conversations: [], activeId: "" };

let state: TabsState = EMPTY;
let version = 0;
const listeners = new Set<() => void>();

function publish(next: TabsState): void {
  state = next;
  version += 1;
  for (const listener of listeners) listener();
}

export function subscribeToTabs(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The current state, by identity.
 *
 * `useSyncExternalStore` compares snapshots by reference, so this must return
 * the same object until something actually changes — hence the store keeping one
 * frozen snapshot and replacing it in `publish` rather than building a fresh
 * object per read.
 */
export function getTabsState(): TabsState {
  return state;
}

export function getTabsVersion(): number {
  return version;
}

export function useTabsState(): TabsState {
  return useSyncExternalStore(subscribeToTabs, getTabsState);
}

/** Whether the main area is showing one of the fixed pages rather than the transcript. */
export function activeTabIsPage(): boolean {
  return isPageTabId(state.activeId);
}

/**
 * A boolean snapshot of [activeTabIsPage].
 *
 * The full-screen shell picks the main area's component from this, and
 * `useSyncExternalStore` compares snapshots with `Object.is`: subscribing to the
 * boolean means a title arriving on some background tab does not re-render the
 * shell, while opening or closing a page does.
 */
export function useActiveTabIsPage(): boolean {
  return useSyncExternalStore(subscribeToTabs, activeTabIsPage);
}

/** Whether an id names one of the fixed pages rather than a conversation. */
export function isPageTabId(id: string): id is PageTabId {
  return id === "usage" || id === "settings";
}

/** The fixed page tabs, as a plain array (the readonly tuple is not iterable-friendly in JSX). */
export function pageTabs(): readonly PageTab[] {
  return PAGE_TABS;
}

/** Every tab in strip order: conversations in open order, then the pages. */
export function allTabs(current: TabsState = state): readonly Tab[] {
  return [...current.conversations, ...PAGE_TABS];
}

/** The tab an id names, or `undefined` when the strip does not hold it. */
export function findTab(
  id: string,
  current: TabsState = state,
): Tab | undefined {
  return allTabs(current).find((tab) => tab.id === id);
}

/**
 * The title to show for a conversation: its summary, else its id.
 *
 * Summaries are model-written and can carry newlines or surrounding space; a tab
 * is one row, so only the first non-empty line is taken. Same fallback order as
 * the terminal title (`helpers/window-title-config.ts`).
 */
export function conversationTitle(
  summary: string | null | undefined,
  conversationId: string,
): string {
  const firstLine = summary
    ?.split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return firstLine && firstLine.length > 0 ? firstLine : conversationId;
}

/**
 * The title a tab should show, from what the app knows right now.
 *
 * A summary is a real title; the conversation id is only the fallback for having
 * none. **And an existing tab's own title outranks the fallback**, which is the
 * rule that keeps a summary arriving as `null` (a switch clears it — it belongs to
 * the conversation being left) from demoting a tab the user is looking at to its
 * id. `conversationTitle` alone cannot express that: it only sees one conversation.
 */
export function tabTitleFor(
  conversationId: string,
  summary: string | null,
): string {
  if (summary !== null && summary.trim().length > 0) {
    return conversationTitle(summary, conversationId);
  }
  return findTab(conversationId)?.title ?? conversationId;
}

/**
 * Record that a conversation is open and make it the active tab.
 *
 * Every switch path ends here, so opening the same conversation twice focuses the
 * tab it already has instead of growing a second one — which is also what keeps
 * the strip's order stable when the user moves back and forth. Opening the tab
 * that is already open, with the title it already has, changes nothing at all.
 */
export function openConversationTab(
  conversationId: string,
  title: string,
): void {
  const existing = state.conversations.find((tab) => tab.id === conversationId);
  if (
    existing &&
    existing.title === title &&
    !existing.unread &&
    state.activeId === conversationId
  ) {
    // Nothing to publish: the tab is already exactly this. Replacing the snapshot
    // would repaint the row for no change, and the store's identity is what tells
    // `useSyncExternalStore` whether anything happened.
    return;
  }
  const conversations = existing
    ? state.conversations.map((tab) =>
        tab.id === conversationId ? { ...tab, title, unread: false } : tab,
      )
    : [
        ...state.conversations,
        {
          kind: "conversation" as const,
          id: conversationId,
          title,
          unread: false,
        },
      ];
  publish({ conversations, activeId: conversationId });
}

/** Update a conversation tab's title in place. No-op when the id is not open. */
export function setTabTitle(conversationId: string, title: string): void {
  if (!state.conversations.some((tab) => tab.id === conversationId)) return;
  if (
    state.conversations.every(
      (tab) => tab.id !== conversationId || tab.title === title,
    )
  ) {
    return;
  }
  publish({
    ...state,
    conversations: state.conversations.map((tab) =>
      tab.id === conversationId ? { ...tab, title } : tab,
    ),
  });
}

/**
 * Mark a conversation as having unseen backend messages.
 *
 * Focusing the tab clears it (`focusTab`), which is the whole contract: the mark
 * exists to tell the user to look at a tab, not to survive their looking.
 */
export function setTabUnread(conversationId: string, unread: boolean): void {
  const target = state.conversations.find((tab) => tab.id === conversationId);
  if (!target || target.unread === unread) return;
  publish({
    ...state,
    conversations: state.conversations.map((tab) =>
      tab.id === conversationId ? { ...tab, unread } : tab,
    ),
  });
}

export function getTabUnread(conversationId: string): boolean {
  return (
    state.conversations.find((tab) => tab.id === conversationId)?.unread ??
    false
  );
}

/** Make a tab the one the main area shows. Unknown ids and no-ops change nothing. */
export function focusTab(id: string): void {
  if (state.activeId === id) return;
  if (!findTab(id)) return;
  const conversations = isPageTabId(id)
    ? state.conversations
    : state.conversations.map((tab) =>
        tab.id === id ? { ...tab, unread: false } : tab,
      );
  publish({ conversations, activeId: id });
}

/**
 * Drop a conversation from the strip, handing focus to the most recently opened
 * conversation that is left.
 *
 * **The caller owns the "can this be closed" question**, not this function:
 * `use-tab-strip.ts` refuses to close the last conversation tab and refuses
 * while the runtime is busy, and only then calls here. The fallback to
 * `"settings"` is therefore unreachable from the UI and exists so that the store
 * cannot be left pointing at a tab it no longer holds.
 */
export function removeConversationTab(conversationId: string): void {
  const index = state.conversations.findIndex(
    (tab) => tab.id === conversationId,
  );
  if (index < 0) return;
  const conversations = state.conversations.filter(
    (tab) => tab.id !== conversationId,
  );
  const remaining = conversations.at(-1);
  const activeId =
    state.activeId === conversationId
      ? (remaining?.id ?? "settings")
      : state.activeId;
  publish({ conversations, activeId });
}

/** The conversations this session has opened, in open order. */
export function getOpenConversations(): readonly ConversationTab[] {
  return state.conversations;
}

/** Test seam: no tabs, nothing focused. */
export function resetTabsForTests(): void {
  state = EMPTY;
  version = 0;
  listeners.clear();
}
