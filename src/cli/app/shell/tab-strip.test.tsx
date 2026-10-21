import { afterEach, describe, expect, test } from "bun:test";
import { clearAllSubagents } from "@/agent/subagent-state";
import { TabStrip, tabStripColumns } from "@/cli/app/shell/tab-strip";
import {
  openConversationTab,
  resetTabsForTests,
  setTabUnread,
} from "@/cli/app/tabs";
import { ROW_SAFETY_COLUMNS } from "@/cli/display/statusline/formatting";
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
    onOverflow?: () => void;
  } = {},
) {
  return mountInkTty(
    <TabStrip
      onSelect={handlers.onSelect ?? (() => {})}
      onClose={handlers.onClose ?? (() => {})}
      onOverflow={handlers.onOverflow ?? (() => {})}
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
 * A page's props were pinned here until P2; the page frame's own frame tests
 * (`app/pages/page-frame.test.tsx`) now judge them, beside the component.
 */
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
      // The rule is the row's width — the terminal less the safety margin, the
      // same two columns the tab row itself spends (`ROW_SAFETY_COLUMNS`). It used
      // to run edge to edge, and that made it the one row of the frame writing the
      // terminal's final column: the terminal then wraps the next write, the frame
      // gains a line, and the alternate screen scrolls this strip away.
      expect(rows[1]).toBe("─".repeat(100 - ROW_SAFETY_COLUMNS));
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
      expect(rows[1]).toBe("─".repeat(80 - ROW_SAFETY_COLUMNS));
      // The current tab survives, and what did not fit is counted.
      expect(rows[0]).toStartWith("> M6 shell");
      expect(rows[0]).toMatch(/\+\d+/);
      expect(rows[0]?.length).toBeLessThanOrEqual(80);
    } finally {
      shell.stop();
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
      expect(rows[1]).toBe("─".repeat(100 - ROW_SAFETY_COLUMNS));
    } finally {
      shell.stop();
      queried.restore();
    }
  });

  test("the row is the narrower of the console's answer and Ink's, less the margin", () => {
    // The margin (`ROW_SAFETY_COLUMNS`) is spent on every answer: the row is
    // assembled from segments and the terminal's advance width for an ambiguous
    // glyph is not knowable from the width table, so the row never touches the
    // edge. Losing two columns of padding is the cheap side of that trade.
    expect(tabStripColumns(102, 100)).toBe(100 - ROW_SAFETY_COLUMNS);
    expect(tabStripColumns(98, 100)).toBe(98 - ROW_SAFETY_COLUMNS);
    expect(tabStripColumns(100, 100)).toBe(100 - ROW_SAFETY_COLUMNS);
    // A stream that cannot report (a pipe) leaves the queried width alone.
    expect(tabStripColumns(100, undefined)).toBe(100 - ROW_SAFETY_COLUMNS);
    expect(tabStripColumns(100, 0)).toBe(100 - ROW_SAFETY_COLUMNS);
    // Nothing to lay out stays nothing.
    expect(tabStripColumns(1, 1)).toBe(0);
  });
});
