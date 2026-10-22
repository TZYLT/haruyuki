import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearAllSubagents } from "@/agent/subagent-state";
import type { AppViewProps } from "@/cli/app/AppView";
import { ChromeHeightContext } from "@/cli/app/chrome-height";
import { UsagePage } from "@/cli/app/pages/usage/usage-page";
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

async function homeWithLedger(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "haruyuki-usage-page-"));
  tempDirs.push(dir);
  process.env.HARUYUKI_HOME = dir;
  await appendUsageRecord(
    buildUsageRecord({
      at: new Date(2026, 9, 22, 9),
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
 * is `rows - chrome - strip`, so 32 rows leaves a 22-row band and an 18-row body
 * — exactly the overview's block height.
 */
function mount(columns: number): InkTty {
  clearAllSubagents();
  openConversationTab("M6 shell", "M6 shell");
  focusTab("usage");
  return mountInkTty(
    <ChromeHeightContext.Provider value={8}>
      <UsagePage {...props(columns)} />
    </ChromeHeightContext.Provider>,
    { columns, rows: 32 },
  );
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
    expect(frame).toContain("cost (est.)");
  });

  test("the blank row between the two block texts is really painted", async () => {
    // Ink collapses an empty <Text> to zero height, so a page could compose the
    // blank row the design asks for and paint nothing (2026-10-22).
    await homeWithLedger();
    const tty = mount(100);
    await settle();
    const rows = await tty.rows();
    const header = rows.findIndex((row) => row.includes("Usage / Overview"));
    expect(header).toBeGreaterThanOrEqual(0);
    expect(rows[header + 1]).toContain("█"); // wordmark
    // The gap row paints the page's accent rail and nothing else.
    expect(rows[header + 6]?.trim()).toBe("┃"); // the gap
    expect(rows[header + 7]).toContain("█"); // hero number
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

  test("Esc hands focus back to the conversation tab", async () => {
    await homeWithLedger();
    const tty = mount(100);
    await settle();
    await tty.press(ESC);
    await settle();
    expect(getTabsState().activeId).toBe("M6 shell");
  });
});
