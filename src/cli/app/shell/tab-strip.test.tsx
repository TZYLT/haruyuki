import { afterEach, describe, expect, test } from "bun:test";
import type { AppViewProps } from "@/cli/app/AppView";
import { ChromeHeightContext } from "@/cli/app/chrome-height";
import { PageShell } from "@/cli/app/shell/page-shell";
import { TabStrip } from "@/cli/app/shell/tab-strip";
import {
  focusTab,
  openConversationTab,
  resetTabsForTests,
  setTabUnread,
} from "@/cli/app/tabs";
import { mountInkTty, resetInkTtyState } from "@/test-utils/ink-tty";

/**
 * The strip as it is actually painted.
 *
 * The layout is unit-tested beside this file; what is judged here is that the
 * *frame* carries it — the row on the screen, the rule under it, the row count
 * the rest of the shell budgets for. `src/cli/AGENTS.md` records why: a tab row
 * can be wired perfectly and paint nothing, and no state assertion can see that.
 */

function mountStrip(columns: number) {
  return mountInkTty(<TabStrip />, { columns, rows: 24 });
}

afterEach(() => {
  resetTabsForTests();
  resetInkTtyState();
});

describe("the tab strip frame", () => {
  test("one row of tabs, a rule, and the pages pinned right", async () => {
    openConversationTab("conv-1", "M6 shell");
    openConversationTab("conv-2", "Ledger");

    const shell = mountStrip(100);
    try {
      const rows = await shell.rows();
      // Exactly the two rows the band's budget reserves.
      expect(rows.length).toBe(2);
      // The current tab is marked, the one behind it is not.
      expect(rows[0]).toContain("> Ledger");
      expect(rows[0]).toContain("  M6 shell");
      expect(rows[0]).toEndWith("Settings");
      expect(rows[0]?.indexOf("Usage")).toBeLessThan(
        rows[0]?.indexOf("Settings") ?? -1,
      );
      // The rule is the row's full width, and it is a rule.
      expect(rows[1]).toBe("─".repeat(100));
    } finally {
      shell.stop();
    }
  });

  test("the last conversation tab carries no x, and the unread mark is painted", async () => {
    // A single conversation: nothing to hand focus to, so no close hot zone.
    openConversationTab("conv-1", "M6 shell");
    const single = mountStrip(100);
    try {
      const rows = await single.rows();
      expect(rows[0]).toContain("M6 shell");
      expect(rows[0]?.includes("×")).toBe(false);
    } finally {
      single.stop();
    }

    // Two: both can be closed. The background one is unread (a backend message
    // while its tab was not focused), which is the mark the strip exists to show.
    openConversationTab("conv-2", "Ledger");
    setTabUnread("conv-2", true);
    openConversationTab("conv-1", "M6 shell");
    const pair = mountStrip(100);
    try {
      const rows = await pair.rows();
      // One close hot zone per closeable conversation tab.
      expect(rows[0]?.split("×").length).toBe(3);
      expect(rows[0]).toContain("• Ledger");
    } finally {
      pair.stop();
    }
  });

  test("a narrow terminal still paints two rows", async () => {
    for (const title of [
      "M6 shell",
      "Ledger work",
      "Diff face",
      "Settings page",
      "Usage screens",
    ]) {
      openConversationTab(title, title);
    }
    openConversationTab("M6 shell", "M6 shell");

    const shell = mountStrip(80);
    try {
      const rows = await shell.rows();
      // No wrapping: the strip is a fixed two rows whatever it had to drop.
      expect(rows.length).toBe(2);
      expect(rows[1]).toBe("─".repeat(80));
      // The current tab survives, and what did not fit is counted.
      expect(rows[0]).toStartWith("> M6 shell");
      expect(rows[0]).toMatch(/\+\d+/);
      expect(rows[0]?.length).toBeLessThanOrEqual(80);
    } finally {
      shell.stop();
    }
  });

  test("a page occupies the main area with the chrome's rows taken out", async () => {
    openConversationTab("M6 shell", "M6 shell");
    focusTab("settings");
    const page = mountInkTty(
      <ChromeHeightContext.Provider value={8}>
        <PageShell {...({} as AppViewProps)} />
      </ChromeHeightContext.Provider>,
      { columns: 80, rows: 24 },
    );
    try {
      const rows = await page.rows({ keepTrailingBlanks: true });
      // 24 rows - 8 chrome - 2 for the strip's own rows.
      expect(rows.length).toBe(14);
      expect(rows[0]).toContain("Settings");
      expect(rows.join("\n")).toContain("通用");
    } finally {
      page.stop();
    }
  });
});
