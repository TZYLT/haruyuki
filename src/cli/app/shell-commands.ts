// src/cli/app/shell-commands.ts

import { resolveUiV2Once } from "@/experiments/ui-v2";
import { focusTab, getTabsState } from "./tabs";
import type { TabStripProjection } from "./types";

/**
 * The four commands that belong to the full-screen shell's chrome.
 *
 * `/tabs`, `/close`, `/usage` and `/settings` name the tab strip and the two
 * fixed pages. The append shell draws neither — so in legacy they are not
 * commands at all, and the answer is the registry's own one-line receipt rather
 * than an action. That is not cosmetic: `/close` in the append shell operated a
 * tab store whose rows the user cannot see, and the switch that followed a close
 * could land on the `"loading"` placeholder tab, which then got persisted as the
 * session ("Conversation loading not found" on the next start).
 *
 * The split lives here, not in the submit handler, for the reason the size ratchet
 * exists: four branches and their comment are a module's worth of policy about
 * *which shell owns a command*, and the submit handler is the file that must not
 * keep growing.
 */
export type ShellCommandDeps = {
  /** Raise the `/tabs` face (the view owns `activeOverlay`). */
  openTabs: () => void;
  /** The strip's own actions, shared with a click on the row. */
  tabStrip: TabStripProjection;
};

/**
 * Run a shell command when this is one and the full-screen shell is active.
 *
 * Returns `false` for anything else — including all four in legacy — so the
 * caller falls through to the command registry, which prints one line and does
 * nothing (the P2-12 contract: no crash, no frame change).
 */
export function runShellCommand(
  trimmed: string,
  deps: ShellCommandDeps,
): boolean {
  if (!resolveUiV2Once()) return false;
  switch (trimmed) {
    case "/tabs":
      deps.openTabs();
      return true;
    case "/close":
      // The same function a click on the tab's `×` calls: closing is a view
      // decision with a ruling behind it (busy / last tab), not a second version
      // of it written here.
      deps.tabStrip.onClose(getTabsState().activeId);
      return true;
    case "/usage":
      focusTab("usage");
      return true;
    case "/settings":
      focusTab("settings");
      return true;
    default:
      return false;
  }
}
