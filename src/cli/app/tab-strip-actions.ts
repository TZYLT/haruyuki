// src/cli/app/tab-strip-actions.ts

import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { showNotice } from "@/cli/helpers/notice";
import type { ConversationSwitchOutcome } from "./submit-navigation-commands";
import { queueOrRefuseSwitch } from "./switch-policy";
import {
  focusTab,
  getOpenConversations,
  isPageTabId,
  removeConversationTab,
} from "./tabs";
import type { QueuedOverlayAction, TabStripProjection } from "./types";
import { clearSelection } from "./viewport-selection";

/**
 * What a click on the tab strip means, as one plain function of the app's state.
 *
 * Kept out of `use-conversation-switching.ts` (which owns the *switch* itself)
 * because the size ratchet caps that file, and out of the shell because showing a
 * conversation is a switch — the shell is handed these two callbacks and never
 * learns what one is.
 *
 * The switch arrives as a function rather than as the pile of state it needs
 * (`switchTo`): these two clicks are the only part of a conversation switch that is
 * a *policy* decision, and taking the switch as a parameter is what lets that
 * decision be judged without a backend behind it.
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
 * Both clicks cancel a standing selection, because both replace the text it was
 * taken from. A selection is *text read off the frame at drag time*, so a stale one
 * would let `Ctrl+X y` copy lines out of a conversation the user has left.
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
  /** Load a conversation into the main area. */
  switchTo: (conversationId: string) => Promise<ConversationSwitchOutcome>;
  /**
   * Raise the `/tabs` face.
   *
   * The collapsed `+N` marker opens it (《38》§3.8) — the marker is the only thing
   * on the row that stands for the tabs which are not drawn. It is a callback
   * rather than something this module does itself: opening a face is the view's
   * (it owns `activeOverlay`), and this module deliberately knows nothing about
   * overlays.
   */
  openTabsOverlay: () => void;
};

export function createTabStripActions(
  deps: TabStripActionDeps,
): TabStripProjection {
  const switchTo = deps.switchTo;

  function onSelect(tabId: string): void {
    clearSelection();
    if (isPageTabId(tabId) || tabId === deps.conversationIdRef.current) {
      focusTab(tabId);
      return;
    }
    if (deps.isAgentBusy()) {
      // No command row: a click is not a typed command. The policy decides
      // whether the switch waits for the turn or is refused with a notice.
      queueOrRefuseSwitch({
        output:
          "Conversation switch queued – will switch after current task completes",
        defer: () =>
          deps.setQueuedOverlayAction({
            type: "switch_conversation",
            conversationId: tabId,
          }),
      });
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
        clearSelection();
        removeConversationTab(tabId);
        return;
      }
      showNotice(outcome.message);
    });
  }

  return { onSelect, onClose, onOverflow: deps.openTabsOverlay };
}
