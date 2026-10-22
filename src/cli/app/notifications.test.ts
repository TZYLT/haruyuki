import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { notify } from "@/cli/app/notifications";
import {
  focusTab,
  openConversationTab,
  resetTabsForTests,
} from "@/cli/app/tabs";
import {
  getMessageHistorySnapshot,
  resetMessageHistoryForTests,
} from "@/cli/notifications/history-store";
import {
  getToastSnapshot,
  resetToastsForTests,
} from "@/cli/notifications/toast-store";

/**
 * One event, one surface (`docs/38` §15.3).
 *
 * A finished turn writes its own summary row into the transcript, so the toast is
 * only for the case the row cannot cover: the turn finished while a page held the
 * band. Errors are the mirror image — the transcript is where they must stay, so
 * they are history and nothing else. Both halves are asserted here because the
 * second one is a one-line change away from being the bug: a toast over a
 * conversation that already shows the same numbers says the same thing twice.
 */

let tempRoot: string | null = null;
const originalHome = process.env.HARUYUKI_HOME;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "haruyuki-notify-"));
  process.env.HARUYUKI_HOME = tempRoot;
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HARUYUKI_HOME;
  else process.env.HARUYUKI_HOME = originalHome;
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  tempRoot = null;
  resetTabsForTests();
  resetToastsForTests();
  resetMessageHistoryForTests();
});

describe("a finished turn", () => {
  test("says nothing on the frame while its own row is on screen", () => {
    openConversationTab("conversation-a", "Conversation A");

    notify("turn", "Turn finished");

    expect(getToastSnapshot().toasts).toEqual([]);
    expect(getMessageHistorySnapshot().entries).toEqual([]);
  });

  test("toasts and is remembered when a page holds the band", () => {
    openConversationTab("conversation-a", "Conversation A");
    focusTab("settings");

    notify("turn", "Turn finished");

    expect(getToastSnapshot().toasts.map((toast) => toast.text)).toEqual([
      "Turn finished",
    ]);
    expect(getMessageHistorySnapshot().entries).toEqual([
      expect.objectContaining({ kind: "turn", text: "Turn finished" }),
    ]);
  });
});

describe("an error", () => {
  test("is remembered and never toasted, even while a page holds the band", () => {
    openConversationTab("conversation-a", "Conversation A");
    focusTab("usage");

    notify("error", "Stream error");

    expect(getToastSnapshot().toasts).toEqual([]);
    expect(getMessageHistorySnapshot().entries).toEqual([
      expect.objectContaining({ kind: "error", text: "Stream error" }),
    ]);
  });
});
