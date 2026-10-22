import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runShellCommand } from "@/cli/app/shell-commands";
import {
  focusTab,
  getTabsState,
  openConversationTab,
  resetTabsForTests,
} from "@/cli/app/tabs";
import type { TabStripProjection } from "@/cli/app/types";
import { resetUiV2Resolution } from "@/experiments/ui-v2";

/**
 * The five chrome commands, and the shell that owns them.
 *
 * The defect this file exists for was reported from a legacy run: `/close` acted on
 * the tab store even though the append shell draws no tabs, and the switch that
 * followed landed on the `"loading"` placeholder tab — which was then persisted as
 * the session, so the next start failed to resume it ("Conversation loading not
 * found"). The rule is that these are *the full-screen shell's*: in legacy they are
 * not commands, and the registry prints one line instead.
 */
type Harness = {
  closed: string[];
  opened: number;
  overlays: string[];
};

function harness() {
  const seen: Harness = { closed: [], opened: 0, overlays: [] };
  const tabStrip: TabStripProjection = {
    onSelect: () => {},
    onClose: (tabId) => {
      seen.closed.push(tabId);
    },
    onOverflow: () => {},
  };
  return {
    seen,
    deps: {
      openTabs: () => {
        seen.opened += 1;
      },
      openOverlay: (overlay: string) => {
        seen.overlays.push(overlay);
        return undefined;
      },
      tabStrip,
    },
  };
}

beforeEach(() => {
  resetTabsForTests();
  resetUiV2Resolution();
  delete process.env.HARUYUKI_UI_V2;
});

afterEach(() => {
  delete process.env.HARUYUKI_UI_V2;
  resetUiV2Resolution();
  resetTabsForTests();
});

function useFullScreenShell(): void {
  process.env.HARUYUKI_UI_V2 = "1";
  resetUiV2Resolution();
}

describe("chrome commands in the append shell", () => {
  test("none of the five is acted on", () => {
    openConversationTab("conv-1", "M6 shell");
    focusTab("conv-1");
    const { seen, deps } = harness();

    for (const command of [
      "/tabs",
      "/close",
      "/settings",
      "/usage",
      "/message-history",
    ]) {
      expect(runShellCommand(command, deps)).toBe(false);
    }
    // Nothing moved: no face, no close, and the active tab is still the one the
    // shell is showing.
    expect(seen).toEqual({ closed: [], opened: 0, overlays: [] });
    expect(getTabsState().activeId).toBe("conv-1");
  });

  test("an ordinary command is still not a shell command", () => {
    useFullScreenShell();
    const { deps } = harness();
    expect(runShellCommand("/help", deps)).toBe(false);
    // Even a command whose body is a page does not match the four.
    expect(runShellCommand("/statusline", deps)).toBe(false);
  });
});

describe("chrome commands in the full-screen shell", () => {
  test("/tabs raises the face and /close closes the active tab", () => {
    useFullScreenShell();
    openConversationTab("conv-1", "M6 shell");
    focusTab("conv-1");
    const { seen, deps } = harness();

    expect(runShellCommand("/tabs", deps)).toBe(true);
    expect(seen.opened).toBe(1);

    expect(runShellCommand("/close", deps)).toBe(true);
    expect(seen.closed).toEqual(["conv-1"]);
  });

  test("/usage and /settings focus the two fixed pages", () => {
    useFullScreenShell();
    openConversationTab("conv-1", "M6 shell");
    focusTab("conv-1");
    const { deps } = harness();

    expect(runShellCommand("/settings", deps)).toBe(true);
    expect(getTabsState().activeId).toBe("settings");

    expect(runShellCommand("/usage", deps)).toBe(true);
    expect(getTabsState().activeId).toBe("usage");
  });

  test("/message-history raises the face through the command row", () => {
    useFullScreenShell();
    openConversationTab("conv-1", "M6 shell");
    focusTab("conv-1");
    const { seen, deps } = harness();

    expect(runShellCommand("/message-history", deps)).toBe(true);
    expect(seen.overlays).toEqual(["message-history"]);
    // A command, not a page: the tab strip does not move.
    expect(getTabsState().activeId).toBe("conv-1");
  });
});
