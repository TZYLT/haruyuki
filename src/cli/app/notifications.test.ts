import { afterEach, describe, expect, test } from "bun:test";
import { notifyTurnComplete } from "@/cli/app/notifications";
import {
  focusTab,
  openConversationTab,
  resetTabsForTests,
} from "@/cli/app/tabs";
import {
  getToastSnapshot,
  resetToastsForTests,
} from "@/cli/notifications/toast-store";

/**
 * One event, one surface (`docs/38` §15.3).
 *
 * A finished turn writes its own summary row into the transcript, so the toast is
 * only for the case the row cannot cover: the turn finished while a page held the
 * band. Both halves are asserted here because the second one is a one-line change
 * away from being the bug — a toast over a conversation that already shows the
 * same numbers says the same thing twice.
 */

afterEach(() => {
  resetTabsForTests();
  resetToastsForTests();
});

describe("a finished turn", () => {
  test("says nothing on the frame while its own row is on screen", () => {
    openConversationTab("conversation-a", "Conversation A");

    notifyTurnComplete();

    expect(getToastSnapshot().toasts).toEqual([]);
  });

  test("toasts when a page holds the band", () => {
    openConversationTab("conversation-a", "Conversation A");
    focusTab("settings");

    notifyTurnComplete();

    expect(getToastSnapshot().toasts.map((toast) => toast.text)).toEqual([
      "Turn finished",
    ]);
  });
});
