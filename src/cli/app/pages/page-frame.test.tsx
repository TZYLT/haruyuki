import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearAllSubagents } from "@/agent/subagent-state";
import type { AppViewProps } from "@/cli/app/AppView";
import { ChromeHeightContext } from "@/cli/app/chrome-height";
import { offsetForCursor, PageFrame } from "@/cli/app/pages/page-frame";
import { PageHost } from "@/cli/app/pages/page-host";
import {
  type PageBody,
  type PageRow,
  pageWindow,
  rowHeight,
} from "@/cli/app/pages/page-model";
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
      expect(rows.join("\n")).toContain("Tab switch");
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
      // No accent rail: `《38》§11.9` ② put one on the page's left edge and the
      // M6.5 pass rejected it on the machine ("整条去掉"), so the body starts one
      // padding column in and no row begins with `┃`.
      expect(rows.some((row) => row.includes("┃"))).toBe(false);
      expect(rows[0]).toContain("Blanks");
      expect(rows[1]?.trim()).toBe("above");
      // The blank row is a *painted* row: everything is empty, but it exists.
      expect(rows[2]?.trim()).toBe("");
      expect(rows[3]?.trim()).toBe("below");
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

const UP = "\u001B[A";
const DOWN = "\u001B[B";
const HOME = "\u001B[1~";
const END = "\u001B[4~";

/** The row the cursor marks. The frame pads the body by one column. */
function cursorRowIndex(rows: readonly string[]): number {
  return rows.findIndex((row) => row.slice(1).startsWith("> "));
}

function cursorLine(rows: readonly string[]): string | undefined {
  const index = cursorRowIndex(rows);
  return index < 0 ? undefined : rows[index];
}

/**
 * The T-10 row-model demo page (G-8): a header and items of one to three
 * continuation lines, two of them indented like the overview's descriptions.
 *
 * It lives in this file on purpose. W-05 must not add a production page — W-08
 * and W-15 own the real overview — but the gate asks for a page the multi-line
 * row model can be judged on: blocks painted whole, `↑↓` moving by item, and a
 * window that counts terminal lines rather than rows. The body is 14 lines for
 * a 13-line body area, so it overflows by exactly one row under the old
 * arithmetic: `↓ 1 more` on the first frame, and the same item count after a
 * scroll.
 */
function mountMultiLineDemo() {
  openConversationTab("M6 shell", "M6 shell");
  const rows: PageRow[] = [
    { kind: "header", text: "Agents" },
    {
      kind: "item",
      id: "alpha",
      label: "Alpha",
      value: "3 convs",
      lines: ["  Alpha description", "  writes the release notes"],
    },
    {
      kind: "item",
      id: "beta",
      label: "Beta",
      value: "1 conv",
      lines: ["  Beta description"],
    },
    {
      kind: "item",
      id: "gamma",
      label: "Gamma",
      value: "0 convs",
      lines: ["  Gamma description", "  recently active", "  no summary"],
    },
    { kind: "item", id: "delta", label: "Delta", value: "7 convs" },
    {
      kind: "item",
      id: "epsilon",
      label: "Epsilon",
      value: "2 convs",
      lines: ["  Epsilon description", "  two conversations"],
    },
  ];
  const body: PageBody = { title: "Overview", rows };
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

describe("a page of multi-line items", () => {
  test("paints an item as one contiguous block, continuation lines included", async () => {
    const page = mountMultiLineDemo();
    try {
      const painted = await page.rows();
      expect(painted[0]?.trim()).toBe("Overview");
      // The body's group header is a row of its own, above the first item.
      expect(painted[1]?.trim()).toBe("Agents");
      expect(cursorRowIndex(painted)).toBe(2);
      expect(painted[2]).toContain("Alpha");

      // The page's own lines are drawn verbatim: its two-space indent is the
      // indent on screen, and the frame neither re-indents nor clips them.
      expect(painted[3]).toContain("  Alpha description");
      expect(painted[4]).toContain("  writes the release notes");

      // The next item starts after the whole block, not after its first line.
      expect(painted[5]).toContain("Beta");
      expect(painted[6]).toContain("  Beta description");
      expect(painted[7]).toContain("Gamma");
      expect(painted[10]).toContain("  no summary");
      expect(painted[11]).toContain("Delta");

      // The selection mark is the item's first line; the block below it is part
      // of the same item and carries no second mark.
      expect(painted[3]?.slice(1).startsWith("> ")).toBe(false);
      expect(painted.join("\n")).toContain("↓ 1 more");
    } finally {
      page.stop();
    }
  });

  test("↑↓ move by item, not by terminal line", async () => {
    const page = mountMultiLineDemo();
    try {
      await page.press(DOWN);
      const second = await page.rows();
      expect(cursorRowIndex(second)).toBe(5);
      expect(second[5]).toContain("Beta");
      // The block that was selected before is still drawn in full: stepping to
      // the next item did not scroll or reflow the page.
      expect(second[3]).toContain("Alpha description");
      expect(second[4]).toContain("writes the release notes");

      await page.press(DOWN);
      const third = await page.rows();
      expect(cursorRowIndex(third)).toBe(7);
      expect(third[7]).toContain("Gamma");

      await page.press(UP);
      const back = await page.rows();
      expect(cursorRowIndex(back)).toBe(5);
      expect(back[5]).toContain("Beta");
    } finally {
      page.stop();
    }
  });

  test("the cursor leaving the bottom scrolls by whole blocks", async () => {
    const page = mountMultiLineDemo();
    try {
      // Alpha → Beta → Gamma → Delta → Epsilon. The last step drags the window
      // down; it must land on a row boundary, so both continuation lines of
      // Epsilon (and the whole of every other visible item) are drawn.
      await page.press(DOWN, DOWN, DOWN, DOWN);
      const painted = await page.rows();
      const text = painted.join("\n");
      expect(cursorLine(painted)).toContain("Epsilon");
      expect(text).toContain("↑ 2 more");
      expect(text).not.toContain("↓");
      expect(text).toContain("Beta description");
      expect(text).toContain("Gamma description");
      expect(text).toContain("Epsilon description");
      expect(text).toContain("two conversations");
      expect(text).not.toContain("Alpha description");
    } finally {
      page.stop();
    }
  });

  test("End and Home move the window over the line heights, not the row count", async () => {
    const page = mountMultiLineDemo();
    try {
      // The last window starts at row 2 (Beta); with the old row-count clamp
      // `End` could not move at all on this body.
      await page.press(END);
      const ended = await page.rows();
      const endedText = ended.join("\n");
      expect(endedText).toContain("↑ 2 more");
      expect(endedText).not.toContain("↓");
      expect(endedText).toContain("Epsilon description");
      expect(endedText).toContain("two conversations");

      await page.press(HOME);
      const top = await page.rows();
      expect(top[0]?.trim()).toBe("Overview");
      expect(top.join("\n")).toContain("↓ 1 more");
      expect(top.join("\n")).not.toContain("↑");
    } finally {
      page.stop();
    }
  });

  test("an empty continuation line is painted, not collapsed", async () => {
    openConversationTab("M6 shell", "M6 shell");
    const body: PageBody = {
      title: "Blanks",
      rows: [
        {
          kind: "item",
          id: "one",
          label: "One",
          lines: ["", "  after the blank"],
        },
        { kind: "item", id: "two", label: "Two" },
      ],
    };
    const page = mountInkTty(
      <ChromeHeightContext.Provider value={8}>
        <PageFrame
          view={{ ...DEFAULT_PAGE_PROPS, conversationId: "M6 shell" }}
          body={body}
        />
      </ChromeHeightContext.Provider>,
      { columns: 80, rows: 24 },
    );
    try {
      const painted = await page.rows();
      expect(cursorRowIndex(painted)).toBe(1);
      // Ink collapses <Text>{""}</Text>, so the page's blank line would vanish
      // and every row under it would move up while the window still counted it.
      expect(painted[2]?.trim()).toBe("");
      expect(painted[3]).toContain("  after the blank");
      expect(painted[4]).toContain("Two");
    } finally {
      page.stop();
    }
  });
});

describe("offsetForCursor over multi-line items", () => {
  const rows: PageRow[] = [
    { kind: "item", id: "a", label: "A", lines: ["1", "2", "3"] },
    { kind: "item", id: "b", label: "B", lines: ["1", "2"] },
    { kind: "item", id: "c", label: "C", lines: ["1"] },
    { kind: "item", id: "d", label: "D" },
  ];
  const heights = rows.map(rowHeight);

  test("leaves a cursor that is already visible where it is", () => {
    expect(
      offsetForCursor({ rows, heights, height: 6, offset: 0, cursor: 0 }),
    ).toBe(0);
  });

  test("scrolls the fewest rows that show the cursor's whole block", () => {
    // The six-line window reserves two marker rows, so only the four-line first
    // item fits: a cursor on row 2 pulls the window down to that row's block.
    expect(
      offsetForCursor({ rows, heights, height: 6, offset: 0, cursor: 2 }),
    ).toBe(2);
    // …and a cursor above the window pulls it back to the cursor's own row.
    expect(
      offsetForCursor({ rows, heights, height: 6, offset: 2, cursor: 1 }),
    ).toBe(1);
  });

  test("with one-line rows it matches the old arithmetic at every offset", () => {
    const flat: PageRow[] = Array.from({ length: 12 }, (_, index) => ({
      kind: "item" as const,
      id: `row-${index}`,
      label: `row ${index}`,
    }));
    const heights = flat.map(rowHeight);
    for (let height = 0; height <= 10; height += 1) {
      for (let offset = -1; offset <= 12; offset += 1) {
        const window = pageWindow({ count: flat.length, height, offset });
        for (let cursor = 0; cursor < flat.length; cursor += 1) {
          // The function this replaced, verbatim: a row-index formula that
          // only knew how many *rows* were visible.
          const legacy =
            cursor < window.start
              ? cursor
              : cursor < window.end
                ? window.start
                : Math.max(0, cursor - (window.end - window.start) + 1);
          expect(offsetForCursor({ rows: flat, height, offset, cursor })).toBe(
            legacy,
          );
          expect(
            offsetForCursor({ rows: flat, heights, height, offset, cursor }),
          ).toBe(legacy);
        }
      }
    }
  });
});
