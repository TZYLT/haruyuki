import { afterEach, describe, expect, test } from "bun:test";
import { clearAllSubagents } from "@/agent/subagent-state";
import type { AppViewProps } from "@/cli/app/AppView";
import { ChromeHeightContext } from "@/cli/app/chrome-height";
import { PageShell } from "@/cli/app/shell/page-shell";
import { TabStrip, tabStripColumns } from "@/cli/app/shell/tab-strip";
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

function mountStrip(
  columns: number,
  handlers: {
    onSelect?: (tabId: string) => void;
    onClose?: (tabId: string) => void;
  } = {},
) {
  return mountInkTty(
    <TabStrip
      onSelect={handlers.onSelect ?? (() => {})}
      onClose={handlers.onClose ?? (() => {})}
    />,
    { columns, rows: 24 },
  );
}

/**
 * Make the console answer with a width of its own.
 *
 * `useTerminalWidth` queries `process.stdout.getWindowSize()` while Ink lays out
 * against the stream's `columns`, so on a real machine the two can disagree —
 * which is what the first run showed. Pinning only one of them is how this test
 * says so.
 */
function withQueriedColumns(
  columns: number,
  rows = 24,
): { restore: () => void } {
  const saved = Object.getOwnPropertyDescriptor(
    process.stdout,
    "getWindowSize",
  );
  Object.defineProperty(process.stdout, "getWindowSize", {
    configurable: true,
    value: () => [columns, rows],
  });
  return {
    restore: () => {
      if (saved) {
        Object.defineProperty(process.stdout, "getWindowSize", saved);
        return;
      }
      delete (process.stdout as { getWindowSize?: unknown }).getWindowSize;
    },
  };
}

/**
 * A page's props, narrowed to what the panel below it reads.
 *
 * The page's own layout ignores the rest of `AppViewProps`; this is the same
 * narrowing `ViewportPanel`'s test makes, with the same fixture: an approval whose
 * tool call is not in any transcript.
 */
const APPROVAL_PAGE_PROPS = {
  currentApproval: {
    toolCallId: "ap-1",
    toolName: "MysteryTool",
    toolArgs: JSON.stringify({ key: "value" }),
  },
  currentApprovalContext: undefined,
  precomputedDiffsRef: { current: new Map() },
  handleApproveCurrent: async () => {},
  handleApproveAlways: async () => {},
  handleDenyCurrent: async () => {},
  handleCancelApprovals: () => {},
  showApprovalPreview: true,
} as unknown as AppViewProps;

afterEach(() => {
  resetTabsForTests();
  resetInkTtyState();
  clearAllSubagents();
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

  test("a console that reports a wider screen cannot push the row off the frame", async () => {
    // The first machine run: the console answered with the screen *buffer* width,
    // the strip laid the row out at that width, and the row wrapped by the
    // difference — one extra line, which scrolled the alternate screen and took
    // the whole tab row with it (row 1 was the tail `gs` of `Settings`).
    openConversationTab("conv-1", "M6 shell");
    openConversationTab("conv-2", "Ledger work");
    const queried = withQueriedColumns(102);
    const shell = mountStrip(100);
    try {
      const rows = await shell.rows();
      expect(rows.length).toBe(2);
      expect(rows[0]?.length).toBeLessThanOrEqual(100);
      expect(rows[0]).toEndWith("Settings");
      expect(rows[1]).toBe("─".repeat(100));
    } finally {
      shell.stop();
      queried.restore();
    }
  });

  test("the row is the narrower of the console's answer and Ink's", () => {
    expect(tabStripColumns(102, 100)).toBe(100);
    expect(tabStripColumns(98, 100)).toBe(98);
    expect(tabStripColumns(100, 100)).toBe(100);
    // A stream that cannot report (a pipe) leaves the queried width alone.
    expect(tabStripColumns(100, undefined)).toBe(100);
    expect(tabStripColumns(100, 0)).toBe(100);
  });

  test("a page still shows the approval that is blocking the input", async () => {
    // The approval surface lives under the transcript band, and a page replaces
    // the band. Without the panel below it, a tool asking for permission while the
    // user reads Settings would disable the input and draw nothing to answer — a
    // session stuck on an invisible question.
    openConversationTab("M6 shell", "M6 shell");
    focusTab("settings");
    const page = mountInkTty(
      <ChromeHeightContext.Provider value={8}>
        <PageShell {...APPROVAL_PAGE_PROPS} />
      </ChromeHeightContext.Provider>,
      { columns: 80, rows: 24 },
    );
    try {
      const rows = await page.rows({ keepTrailingBlanks: true });
      expect(rows[0]).toContain("Settings");
      expect(rows.join("\n")).toContain("MysteryTool");
    } finally {
      page.stop();
    }
  });
});
