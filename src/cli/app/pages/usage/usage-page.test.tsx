import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearAllSubagents } from "@/agent/subagent-state";
import type { AppViewProps } from "@/cli/app/AppView";
import { ChromeHeightContext } from "@/cli/app/chrome-height";
import {
  UsagePage,
  usageHeaderSegments,
} from "@/cli/app/pages/usage/usage-page";
import {
  focusTab,
  getTabsState,
  openConversationTab,
  resetTabsForTests,
} from "@/cli/app/tabs";
import { resetInputScopes } from "@/cli/helpers/focus-ledger";
import { clearHoverIn, resetHoverForTests } from "@/cli/helpers/hover-store";
import { resetBindingOwners } from "@/cli/helpers/input-router";
import { resetMouseHandlers } from "@/cli/helpers/mouse-router";
import { resetMouseTrackingForTests } from "@/cli/helpers/mouse-tracking";
import {
  type InkTty,
  mountInkTty,
  resetInkTtyState,
} from "@/test-utils/ink-tty";
import { appendUsageRecord, buildUsageRecord } from "@/usage/ledger";

/**
 * The Usage page as it is painted.
 *
 * Three claims only the frame can answer: the overview draws the hero the tier
 * rule picked, `Tab` switches screens *inside* the page (the app scope uses
 * `Tab` for the reasoning level, so a page that forgets the binding would
 * silently change that instead), and `Esc` at the root hands focus back to the
 * conversation tab.
 */
const TAB = "\t";
const ESC = "\u001B";
const settle = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));

const tempDirs: string[] = [];
const originalHome = process.env.HARUYUKI_HOME;

/**
 * 09:00 local **today**, for a record the overview will call "today".
 *
 * The fixture used to pin `new Date(2026, 9, 22, 9)`. The page was right and the
 * test was wrong the moment the wall clock left that day: "today 960k tok"
 * became "today 0 tok" with nothing changed in `src/`. A ledger record's day is
 * relative by nature, so the fixture derives it from the clock too.
 */
function todayAtNine(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9);
}

async function homeWithLedger(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "haruyuki-usage-page-"));
  tempDirs.push(dir);
  process.env.HARUYUKI_HOME = dir;
  await appendUsageRecord(
    buildUsageRecord({
      at: todayAtNine(),
      agentId: "agent-1",
      model: "openai/gpt-5.5",
      prompt: 700_000,
      cachedInput: 200_000,
      cacheWrite: 10_000,
      completion: 50_000,
      steps: 2,
      wallMs: 4_000,
      apiMs: 3_000,
      contextTokens: 84_000,
      cost: {
        input: 0.1,
        cacheRead: 0.2,
        cacheWrite: 0.3,
        output: 0.4,
        total: 1,
      },
    }),
  );
  return dir;
}

function props(columns: number): AppViewProps {
  return {
    columns,
    conversationId: "M6 shell",
    agentId: "agent-1",
    projectDirectory: process.cwd(),
    currentModelDisplay: "qwen3-coder-30b",
    currentReasoningEffort: "high",
    uiPermissionMode: "unrestricted",
    handlePermissionModeChange: () => {},
    runtimeFlags: { tokenStreaming: false, reasoningTabCycle: false },
    setRuntimeFlag: () => {},
  } as unknown as AppViewProps;
}

/**
 * The page at `columns`, in a terminal tall enough for the block tier: the band
 * is `rows - chrome - strip`, so 37 rows leaves a 27-row band and a 26-row body —
 * the overview's block is 22 rows and needs the room (it is 22 because M6.5 put a
 * blank row above the art, a blank row above the grid, and the today/streak line
 * under it).
 */
function mount(columns: number): InkTty {
  clearAllSubagents();
  openConversationTab("M6 shell", "M6 shell");
  focusTab("usage");
  return mountInkTty(
    <ChromeHeightContext.Provider value={8}>
      <UsagePage {...props(columns)} />
    </ChromeHeightContext.Provider>,
    { columns, rows: 37 },
  );
}

/** A left click on a screen cell (1-based row and column). */
async function clickAt(
  tty: InkTty,
  row: number,
  column: number,
): Promise<void> {
  await tty.press(`${ESC}[<0;${column};${row}M`, `${ESC}[<0;${column};${row}m`);
  await settle(120);
}

/**
 * The 1-based column of a word painted on the header row.
 *
 * Read out of the frame rather than hard-coded: the header's own layout is what a
 * click has to agree with, and a test that computed the column itself would pass
 * while the drawn line disagreed. The header is screen row 1, and the band's
 * padding puts the first glyph in column 2 — the same coordinates the settings
 * page's breadcrumb test uses.
 */
async function headerColumn(tty: InkTty, word: string): Promise<number> {
  const header = (await tty.rows())[0] ?? "";
  const index = header.indexOf(word);
  if (index < 0) throw new Error(`the header does not draw ${word}: ${header}`);
  return index + 1;
}

afterEach(async () => {
  if (originalHome === undefined) {
    delete process.env.HARUYUKI_HOME;
  } else {
    process.env.HARUYUKI_HOME = originalHome;
  }
  resetTabsForTests();
  resetInkTtyState();
  clearAllSubagents();
  resetMouseHandlers();
  clearHoverIn("page");
  resetHoverForTests();
  resetMouseTrackingForTests();
  resetBindingOwners();
  resetInputScopes();
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("the usage page", () => {
  test("the overview draws the hero at a wide terminal", async () => {
    await homeWithLedger();
    const tty = mount(100);
    await settle();
    const rows = await tty.rows();
    const frame = rows.join("\n");
    expect(frame).toContain("Usage / Overview");
    // The block tier is up: the hero is art, and the label under it says tokens.
    expect(frame).toContain("███");
    expect(frame).toContain("tokens");
    expect(frame).toContain("Last 4 weeks");
    expect(frame).toContain("total cost");
    // M6.5: today's trio closes the block on one line under the grid.
    expect(frame).toContain("today 960k tok");
    expect(frame).toContain("streak 1 day");
  });

  test("the blank rows above the art and above the grid are really painted", async () => {
    // Ink collapses an empty <Text> to zero height, so a page could compose a
    // blank row and paint nothing (2026-10-22). M6.5 then asked for two more of
    // them: one under the header, one between the unit and the grid.
    await homeWithLedger();
    const tty = mount(100);
    await settle();
    const rows = await tty.rows();
    const header = rows.findIndex((row) => row.includes("Usage / Overview"));
    expect(header).toBeGreaterThanOrEqual(0);
    expect(rows[header + 1]?.trim()).toBe(""); // the blank under the header
    expect(rows[header + 2]).toContain("█"); // wordmark
    // The gap row between the two block texts paints nothing (there is no rail).
    expect(rows[header + 7]?.trim()).toBe("");
    expect(rows[header + 8]).toContain("█"); // hero number
  });

  test("a narrow terminal falls back to one line", async () => {
    await homeWithLedger();
    const tty = mount(40);
    await settle();
    const frame = (await tty.rows()).join("\n");
    expect(frame).toContain("960k tokens");
    expect(frame).not.toContain("███");
  });

  test("Tab switches to the detail screen and back", async () => {
    await homeWithLedger();
    const tty = mount(100);
    await settle();
    expect((await tty.rows()).join("\n")).toContain("Usage / Overview");

    await tty.press(TAB);
    await settle();
    const detail = (await tty.rows()).join("\n");
    expect(detail).toContain("Usage / Detail");
    expect(detail).toContain("Cost (est. $ 1.00000)");
    expect(detail).toContain("History (last 14 days)");

    await tty.press(TAB);
    await settle();
    expect((await tty.rows()).join("\n")).toContain("Usage / Overview");
  });

  test("the screen word carries the other screen as its target", () => {
    // The header draws one screen word (`Usage / Overview`), and that word is the
    // switch: its target is the screen a click would open (2026-10-24).
    const overview = usageHeaderSegments("overview", "2026-09-28 – 2026-10-22");
    expect(
      overview.flatMap((segment) => (segment.target ? [segment.target] : [])),
    ).toEqual(["detail"]);
    expect(overview[0]?.target).toBeUndefined();
    expect(overview[2]?.target).toBeUndefined();

    const detail = usageHeaderSegments("detail", "2026-09-28 – 2026-10-22");
    expect(
      detail.flatMap((segment) => (segment.target ? [segment.target] : [])),
    ).toEqual(["overview"]);
  });

  test("clicking the screen word switches, the same move Tab makes", async () => {
    // A page owns the main area, so a mouse user had no way to change screens
    // without going back to the keyboard (2026-10-23). The one word names the
    // current screen and toggles to the other; the word is replaced, never added
    // beside (2026-10-24).
    await homeWithLedger();
    const tty = mount(100);
    try {
      await settle();
      expect((await tty.rows())[0]).toContain("Usage / Overview");
      expect((await tty.rows())[0]).not.toContain("Detail");

      await clickAt(tty, 1, await headerColumn(tty, "Overview"));
      const detail = (await tty.rows()).join("\n");
      expect(detail).toContain("Usage / Detail");
      expect(detail).not.toContain("Overview");
      expect(detail).toContain("Cost (est. $ 1.00000)");

      // The word that now names the other screen is still the target: clicking it
      // goes back, and the header is one word again.
      await clickAt(tty, 1, await headerColumn(tty, "Detail"));
      expect((await tty.rows()).join("\n")).toContain("Usage / Overview");
    } finally {
      tty.stop();
    }
  });

  test("the page name, the date and the key hint are not click targets", async () => {
    await homeWithLedger();
    const tty = mount(100);
    try {
      await settle();
      // Aim at each non-segment on purpose: none may change the screen, because
      // a click there is spent on nothing rather than on the screen switcher.
      for (const word of ["Usage", "2026-", "Tab switch"]) {
        await clickAt(tty, 1, await headerColumn(tty, word));
        expect((await tty.rows())[0]).toContain("Usage / Overview");
      }
    } finally {
      tty.stop();
    }
  });

  test("the detail screen paints a blank row above every section", async () => {
    // The row list says "blank"; only the frame knows whether it *painted* one
    // (Ink collapses an empty <Text>). This is the same class of bug as the
    // overview's wordmark running into the hero number (2026-10-22).
    await homeWithLedger();
    const tty = mount(100);
    await settle();
    await tty.press(TAB);
    await settle();
    const rows = await tty.rows();
    for (const title of [
      "Cost (est.",
      "Context composition",
      "By model",
      "Automated tasks",
      "History (last",
    ]) {
      const index = rows.findIndex((row) => row.includes(title));
      expect(index).toBeGreaterThan(0);
      expect(rows[index - 1]?.trim()).toBe("");
    }
  });

  test("a reflection record is drawn in the Automated tasks section", async () => {
    // F-03 §5.16.5's user-visible outcome: automated spend is on the detail
    // screen, next to the interactive bill, without changing the overview's
    // total. Only the frame can answer whether the section paints.
    await homeWithLedger();
    await appendUsageRecord(
      buildUsageRecord({
        at: todayAtNine(),
        agentId: "agent-1",
        model: "openai/gpt-5.5",
        prompt: 10_000,
        cachedInput: 0,
        cacheWrite: 0,
        completion: 500,
        steps: 1,
        wallMs: 2_000,
        apiMs: 1_000,
        source: "reflection",
        outcome: "completed",
        runId: "reflection-agent-1-abc",
        sessionId: "local-conv-2",
        parentSessionId: "local-conv-1",
      }),
    );
    const tty = mount(100);
    await settle();
    await tty.press(TAB);
    await settle();
    const frame = (await tty.rows()).join("\n");
    expect(frame).toContain("Automated tasks");
    expect(frame).toContain("reflection");
    expect(frame).toContain("total");
  });

  test("Esc hands focus back to the conversation tab", async () => {
    await homeWithLedger();
    const tty = mount(100);
    await settle();
    await tty.press(ESC);
    await settle();
    expect(getTabsState().activeId).toBe("M6 shell");
  });
});
