// src/cli/app/tab-strip-actions.ts

import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { showNotice } from "@/cli/helpers/notice";
import type { TabStripProjection } from "./shell/types";
import {
  type ConversationSwitchDeps,
  switchConversationDirect,
} from "./submit-navigation-commands";
import {
  focusTab,
  getOpenConversations,
  isPageTabId,
  removeConversationTab,
} from "./tabs";
import type { QueuedOverlayAction } from "./types";

/**
 * What a click on the tab strip means, as one plain function of the app's state.
 *
 * Kept out of `use-conversation-switching.ts` (which owns the *switch* itself)
 * because the size ratchet caps that file, and out of the shell because showing a
 * conversation is a switch — the shell is handed these two callbacks and never
 * learns what one is.
 *
 * The two clicks differ in how much they can damage:
 *
 * - **Select** either focuses a page (a view over a conversation that stays
 *   loaded) or switches conversations. While a turn is running the switch is
 *   *deferred* through the queued-action machinery `/agents` already uses, so the
 *   click survives the turn. P0 ships that deferral; the shell's policy replaces
 *   it where the shell refuses instead.
 * - **Close** drops a view. A background conversation tab is just a handle, so
 *   closing it touches nothing else. The tab being *shown* has to hand the main
 *   area to another conversation first, and is refused when there is no other —
 *   the main area always shows a conversation (2026-10-19 ruling).
 *
 * The conversation the app is on is read from a ref at click time, never captured:
 * a click can arrive several turns after the render that installed these
 * callbacks.
 */
export type TabStripActionDeps = {
  /** The conversation in the main area right now (fresh at click time). */
  conversationIdRef: MutableRefObject<string>;
  isAgentBusy: () => boolean;
  setQueuedOverlayAction: Dispatch<SetStateAction<QueuedOverlayAction>>;
  /** Everything a direct conversation switch needs. */
  switchDeps: ConversationSwitchDeps;
};

export function createTabStripActions(
  deps: TabStripActionDeps,
): TabStripProjection {
  const switchTo = (conversationId: string) =>
    switchConversationDirect(deps.switchDeps, conversationId, {
      origin: "tab",
    });

  function onSelect(tabId: string): void {
    if (isPageTabId(tabId) || tabId === deps.conversationIdRef.current) {
      focusTab(tabId);
      return;
    }
    if (deps.isAgentBusy()) {
      deps.setQueuedOverlayAction({
        type: "switch_conversation",
        conversationId: tabId,
      });
      showNotice("会话切换已排队 · 当前回合结束后切换");
      return;
    }
    void switchTo(tabId).then((outcome) => {
      if (outcome.status === "failed") showNotice(outcome.message);
    });
  }

  function onClose(tabId: string): void {
    if (isPageTabId(tabId)) {
      focusTab(deps.conversationIdRef.current);
      return;
    }
    const open = getOpenConversations();
    if (!open.some((tab) => tab.id === tabId)) return;
    const remaining = open.filter((tab) => tab.id !== tabId);
    if (remaining.length === 0) {
      showNotice("至少保留一个会话标签");
      return;
    }
    if (tabId !== deps.conversationIdRef.current) {
      removeConversationTab(tabId);
      return;
    }
    if (deps.isAgentBusy()) {
      showNotice("正在运行 · 先 Esc 中断再关闭会话");
      return;
    }
    const next = remaining.at(-1);
    if (!next) return;
    void switchTo(next.id).then((outcome) => {
      if (outcome.status === "switched") {
        removeConversationTab(tabId);
        return;
      }
      showNotice(outcome.message);
    });
  }

  return { onSelect, onClose };
}
