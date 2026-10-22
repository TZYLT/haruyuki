import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearAllSubagents } from "@/agent/subagent-state";
import type { AppViewProps } from "@/cli/app/AppView";
import { ChromeHeightContext } from "@/cli/app/chrome-height";
import { PageFrame } from "@/cli/app/pages/page-frame";
import { PageHost } from "@/cli/app/pages/page-host";
import type { PageBody } from "@/cli/app/pages/page-model";
import {
  focusTab,
  getTabsState,
  isPageTabId,
  openConversationTab,
  resetTabsForTests,
} from "@/cli/app/tabs";
import {
  getViewportScrollRows,
  resetViewportScroll,
} from "@/cli/app/viewport-scroll";
import { resetInputScopes } from "@/cli/helpers/focus-ledger";
import { resetBindingOwners } from "@/cli/helpers/input-router";
import {
  registerMouseHandler,
  resetMouseHandlers,
} from "@/cli/helpers/mouse-router";
import { resetMouseTrackingForTests } from "@/cli/helpers/mouse-tracking";
import { mountInkTty, resetInkTtyState } from "@/test-utils/ink-tty";

/**
 * The page frame, as it is painted.
 *
 * Three things can only be judged on the frame, and each of them has been wrong
 * once already in this tree:
 *
 * 1. **A page still reserves the chrome's rows.** If it forgot them the composer
 *    would be pushed off the bottom rather than the page being shortened.
 * 2. **The approval the input is blocked on stays visible under it.** A page
 *    replaces the band, not the panel; without the panel a permission request
 *    arrives with the composer disabled and nothing to answer.
 * 3. **A page that scrolls does not scroll the frame**: the body window is the
 *    page's, the row count is constant.
 */
function mountPage(
  pageId: "settings" | "usage",
  chromeRows: number,
  props: Partial<AppViewProps> = {},
) {
  // The panel under a page draws whatever subagents are *live*, and that module
  // store outlives a test file: an agent left running by another suite would add
  // rows under this page and the row count below would be about it instead.
  clearAllSubagents();
  openConversationTab("M6 shell", "M6 shell");
  focusTab(pageId);
  return mountInkTty(
    <ChromeHeightContext.Provider value={chromeRows}>
      <PageHost {...({ ...DEFAULT_PAGE_PROPS, ...props } as AppViewProps)} />
    </ChromeHeightContext.Provider>,
    { columns: 80, rows: 24 },
  );
}

const DEFAULT_PAGE_PROPS = {
  columns: 80,
  conversationId: "M6 shell",
} as unknown as AppViewProps;

const APPROVAL_PAGE_PROPS = {
  columns: 80,
  conversationId: "M6 shell",
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
  handleCancelApprovals: async () => {},
  showApprovalPreview: true,
} as unknown as AppViewProps;

afterEach(() => {
  resetTabsForTests();
  resetInkTtyState();
  clearAllSubagents();
  resetMouseHandlers();
  resetMouseTrackingForTests();
  resetBindingOwners();
  resetInputScopes();
  resetViewportScroll();
});

describe("the page frame", () => {
  test("a page occupies the main area with the chrome's rows taken out", async () => {
    const page = mountPage("settings", 8);
    try {
      const rows = await page.rows({ keepTrailingBlanks: true });
      // 24 rows - 8 chrome - 2 for the strip's own rows. The page's body is short
      // enough to fit, so the band's height is visible as the frame's height.
      expect(rows.length).toBe(14);
      expect(rows[0]).toContain("Settings");
      // The root screen is the sections with their second-level entries under them
      // (P3), and the cursor is on the first row that can be acted on.
      expect(rows.join("\n")).toContain("Context");
      expect(rows.join("\n")).toContain("Topic");
    } finally {
      page.stop();
    }
  });

  test("the Usage tab shows the Usage page, not Settings", async () => {
    // The page reads the real ledger, so point the harness home at a temp dir:
    // this assertion is about which page is mounted, not about the numbers.
    const originalHome = process.env.HARUYUKI_HOME;
    const home = await mkdtemp(join(tmpdir(), "haruyuki-frame-usage-"));
    process.env.HARUYUKI_HOME = home;
    const page = mountPage("usage", 8);
    try {
      const rows = await page.rows({ keepTrailingBlanks: true });
      expect(rows[0]).toContain("Usage / Overview");
      expect(rows.join("\n")).toContain("Tab detail");
    } finally {
      page.stop();
      if (originalHome === undefined) {
        delete process.env.HARUYUKI_HOME;
      } else {
        process.env.HARUYUKI_HOME = originalHome;
      }
      await rm(home, { recursive: true, force: true });
    }
  });

  test("an empty text row is painted as one blank line", async () => {
    // Ink collapses `<Text>{""}</Text>` to zero height. Before this was handled,
    // a page could compose the blank row a design asks for and paint nothing —
    // the Usage overview's wordmark ran into its hero number while every test
    // that counted rows still passed.
    openConversationTab("M6 shell", "M6 shell");
    const body: PageBody = {
      title: "Blanks",
      rows: [
        { kind: "text", text: "above" },
        { kind: "text", text: "" },
        { kind: "text", text: "below" },
      ],
    };
    const page = mountInkTty(
      <ChromeHeightContext.Provider value={8}>
        <PageFrame view={{ ...DEFAULT_PAGE_PROPS }} body={body} />
      </ChromeHeightContext.Provider>,
      { columns: 40, rows: 24 },
    );
    try {
      const rows = await page.rows({ keepTrailingBlanks: true });
      // Column 1 is the page's accent rail (the box's own left border), so the
      // body starts at column 2 — the same column `paddingX` used to give it.
      const body = rows.map((row) => row.replace(/^┃/, ""));
      expect(body[0]).toContain("Blanks");
      expect(body[1]?.trim()).toBe("above");
      // The blank row is a *painted* row: the rail is there, the text is not.
      expect(body[2]?.trim()).toBe("");
      expect(rows[2]?.trim()).toBe("┃");
      expect(body[3]?.trim()).toBe("below");
    } finally {
      page.stop();
    }
  });

  test("a page still shows the approval that is blocking the input", async () => {
    // The approval surface lives under the transcript band, and a page replaces
    // the band. Without the panel below it, a tool asking for permission while the
    // user reads Settings would disable the input and draw nothing to answer — a
    // session stuck on an invisible question.
    const page = mountPage("settings", 8, APPROVAL_PAGE_PROPS);
    try {
      const rows = await page.rows({ keepTrailingBlanks: true });
      expect(rows[0]).toContain("Settings");
      expect(rows.join("\n")).toContain("MysteryTool");
    } finally {
      page.stop();
    }
  });

  test("Escape goes back to the conversation", async () => {
    const page = mountPage("settings", 8);
    try {
      await page.press("\u001B");
      // The page tab is no longer the active one: the tab strip would draw the
      // conversation again, which is the only visible consequence of the switch.
      expect(isPageTabId(getTabsState().activeId)).toBe(false);
      expect(getTabsState().activeId).toBe("M6 shell");
    } finally {
      page.stop();
    }
  });
});

/**
 * A tall body, mounted directly rather than through `PageHost`: the two real pages
 * are still placeholders, and the thing under test here is the frame's own
 * scrolling — window, markers, and who owns the wheel.
 */
function mountTallBody() {
  openConversationTab("M6 shell", "M6 shell");
  const body: PageBody = {
    title: "Scrolling",
    rows: Array.from({ length: 40 }, (_, index) => ({
      kind: "note" as const,
      text: `row ${index}`,
    })),
  };
  return mountInkTty(
    <ChromeHeightContext.Provider value={8}>
      <PageFrame
        view={{ ...DEFAULT_PAGE_PROPS, conversationId: "M6 shell" }}
        body={body}
      />
    </ChromeHeightContext.Provider>,
    { columns: 80, rows: 24 },
  );
}

/**
 * Who owns a report that lands inside a page.
 *
 * The page declines the rows it cannot act on — that is right, they are prose and
 * `↑↓` skips them too — but "declined" has to stop at the page. There is no
 * transcript underneath to offer the report to, and the selection layer is switched
 * off while a page is up, so a report that was declined all the way down was claimed
 * by **nobody**: on the Usage page, whose body is a header and two notes until P5
 * fills it, that was every report. The modes were on, other pages answered, and this
 * one looked dead.
 */
describe("a report that lands in a page", () => {
  /** A probe on the layer below, recording what reaches it. */
  function probeContent() {
    const seen: string[] = [];
    const off = registerMouseHandler(
      (report) => {
        seen.push(`${report.kind}@${report.row}`);
        return true;
      },
      { layer: "content", name: "probe" },
    );
    return { seen, off };
  }

  test("is the page's, even on a row the page cannot act on", async () => {
    const page = mountPage("usage", 8);
    const { seen, off } = probeContent();
    try {
      // Row 5 is prose: nothing there can be clicked, and the press still belongs to
      // the page rather than falling to a layer that draws nothing there.
      await page.press("\u001B[<0;10;5M\u001B[<0;10;5m");
      expect(seen).toEqual([]);
    } finally {
      off();
      page.stop();
    }
  });

  test("is nobody's below the band", async () => {
    const page = mountPage("usage", 8);
    const { seen, off } = probeContent();
    try {
      // The band is 14 rows (24 - 8 chrome - 2 strip), so row 20 is under the page:
      // the claim is the band's rectangle, not the whole screen.
      await page.press("\u001B[<0;10;20M\u001B[<0;10;20m");
      expect(seen).toEqual(["press@20", "release@20"]);
    } finally {
      off();
      page.stop();
    }
  });
});

describe("a page that overflows", () => {
  test("it windows its body and says how many rows are hidden", async () => {
    const page = mountTallBody();
    try {
      const rows = await page.rows({ keepTrailingBlanks: true });
      // 24 - 8 chrome - 2 strip - 1 header = 13 body rows; two of them are the
      // markers, so eleven body rows are drawn and the rest are counted.
      expect(rows.filter((row) => row.includes("row ")).length).toBe(11);
      expect(rows.join("\n")).toContain("↓ 29 more");
      expect(rows.join("\n")).not.toContain("↑ ");
    } finally {
      page.stop();
    }
  });

  test("the wheel scrolls the page, not the transcript behind it", async () => {
    const page = mountTallBody();
    try {
      // A notch below the tab rows, inside the band. Code 65 is "wheel down"; 64
      // is "wheel up", which would scroll a page already at its top.
      await page.press(`${"\u001B"}[<65;10;6M`);
      const rows = await page.rows({ keepTrailingBlanks: true });
      expect(rows.join("\n")).toContain("↑ 3 more");
      // The transcript's own offset never moved: the page claimed the notch on its
      // own layer, which is consulted before the wheel's.
      expect(getViewportScrollRows()).toBe(0);
    } finally {
      page.stop();
    }
  });

  test("PgDn moves a screenful, and PgUp comes back", async () => {
    const page = mountTallBody();
    try {
      await page.press("\u001B[6~");
      const scrolled = (await page.rows({ keepTrailingBlanks: true })).join(
        "\n",
      );
      expect(scrolled).toContain("↑ 12 more");

      await page.press("\u001B[5~");
      const back = (await page.rows({ keepTrailingBlanks: true })).join("\n");
      expect(back).not.toContain("↑ ");
    } finally {
      page.stop();
    }
  });
});
