import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearAllSubagents } from "@/agent/subagent-state";
import type { AppViewProps } from "@/cli/app/AppView";
import { ChromeHeightContext } from "@/cli/app/chrome-height";
import { SettingsPage } from "@/cli/app/pages/settings/settings-page";
import {
  focusTab,
  getTabsState,
  openConversationTab,
  resetTabsForTests,
} from "@/cli/app/tabs";
import {
  getSystemRemindersVisible,
  setSystemRemindersVisible,
} from "@/cli/components/transcript-display-state";
import { resetInputScopes } from "@/cli/helpers/focus-ledger";
import { resetBindingOwners } from "@/cli/helpers/input-router";
import { resetMouseHandlers } from "@/cli/helpers/mouse-router";
import { resetMouseTrackingForTests } from "@/cli/helpers/mouse-tracking";
import { loadPermissions } from "@/permissions/loader";
import {
  type InkTty,
  mountInkTty,
  resetInkTtyState,
} from "@/test-utils/ink-tty";

/**
 * The settings page, as it is painted and as it writes.
 *
 * Three claims, each of which state alone cannot prove:
 *
 * 1. **The root screen is the categories and their entries** (《38》§12.3bis 1), and
 *    the cursor never lands on a category title.
 * 2. **A sub-screen is a screen**: `Enter` opens it with a breadcrumb, `Esc` comes
 *    back to the root, and only the root's `Esc` leaves for the conversation.
 * 3. **A write goes somewhere real.** The toggle case reads a store back; the
 *    permission case reads the settings file back from the project directory it
 *    wrote to — a page whose `A` "worked" on screen and wrote nothing is the exact
 *    failure a rows-and-values assertion cannot see.
 */
const DOWN = "\u001B[B";
const ENTER = "\r";
const ESC = "\u001B";
const SPACE = " ";
const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));

const tempDirs: string[] = [];

async function projectDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "haruyuki-settings-"));
  tempDirs.push(dir);
  return dir;
}

function props(projectDirectory: string): AppViewProps {
  return {
    columns: 80,
    conversationId: "M6 shell",
    agentId: "agent-1",
    projectDirectory,
    currentModelDisplay: "qwen3-coder-30b",
    currentReasoningEffort: "high",
    uiPermissionMode: "unrestricted",
    handlePermissionModeChange: () => {},
    runtimeFlags: { tokenStreaming: false, reasoningTabCycle: false },
    setRuntimeFlag: () => {},
  } as unknown as AppViewProps;
}

function mount(projectDirectory: string): InkTty {
  clearAllSubagents();
  openConversationTab("M6 shell", "M6 shell");
  focusTab("settings");
  return mountInkTty(
    <ChromeHeightContext.Provider value={8}>
      <SettingsPage {...props(projectDirectory)} />
    </ChromeHeightContext.Provider>,
    { columns: 80, rows: 24 },
  );
}

/**
 * The row the cursor is on.
 *
 * The frame pads the page's column by one (`paddingX={1}`), so the cursor mark is
 * the second cell of the line, not the first: `" > 被动召回 …"`.
 */
function cursorLine(rows: readonly string[]): string | undefined {
  return rows.find((row) => row.slice(1).startsWith("> "));
}

function cursorLabel(rows: readonly string[]): string | undefined {
  const line = cursorLine(rows);
  return line?.slice(3);
}

/** Press `↑↓` until the cursor row is the one whose label starts with `label`. */
async function moveCursorTo(tty: InkTty, label: string): Promise<void> {
  for (let step = 0; step < 40; step += 1) {
    const rows = await tty.rows();
    if (cursorLabel(rows)?.startsWith(label)) return;
    await tty.press(DOWN);
    await settle(40);
  }
  throw new Error(`the cursor never reached ${label}`);
}

afterEach(async () => {
  resetTabsForTests();
  resetInkTtyState();
  clearAllSubagents();
  resetMouseHandlers();
  resetMouseTrackingForTests();
  resetBindingOwners();
  resetInputScopes();
  setSystemRemindersVisible(false);
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("the settings page", () => {
  test("the root screen is categories with their entries, and the cursor skips titles", async () => {
    const tty = mount(await projectDir());
    try {
      const rows = await tty.rows();
      expect(rows[0]).toBe(" Settings");
      expect(rows.join("\n")).toContain("上下文管理");
      expect(rows.join("\n")).toContain("话题与压力");
      // The first selectable row is the first entry, not the first title.
      const cursor = cursorLabel(rows);
      expect(cursor).toBeDefined();
      expect(cursor).not.toContain("上下文管理");
      expect(cursor).toContain("话题与压力");
    } finally {
      tty.stop();
    }
  });

  test("Enter opens a group screen with a breadcrumb, Escape comes back", async () => {
    const tty = mount(await projectDir());
    try {
      await moveCursorTo(tty, "被动召回");
      await tty.press(ENTER);
      await settle();
      const group = await tty.rows();
      expect(group[0]).toContain("Settings / 记忆与反思 / 被动召回");
      expect(group.join("\n")).toContain("分数下限");

      await tty.press(ESC);
      await settle();
      const root = await tty.rows();
      expect(root[0]).toBe(" Settings");
      expect(root.join("\n")).toContain("上下文管理");
      // Still on the page: only the root's Escape leaves.
      expect(getTabsState().activeId).toBe("settings");

      await tty.press(ESC);
      await settle();
      expect(getTabsState().activeId).toBe("M6 shell");
    } finally {
      tty.stop();
    }
  });

  test("Space toggles the row under the cursor and the frame shows the new value", async () => {
    const tty = mount(await projectDir());
    try {
      await moveCursorTo(tty, "系统提醒可见");
      expect(getSystemRemindersVisible()).toBe(false);
      expect((await tty.rows()).join("\n")).toContain("系统提醒可见  Off");

      await tty.press(SPACE);
      await settle(120);
      expect(getSystemRemindersVisible()).toBe(true);
      expect((await tty.rows()).join("\n")).toContain("系统提醒可见  On");
      expect((await tty.rows()).join("\n")).toContain("已更新");
    } finally {
      tty.stop();
    }
  });

  test("a click on a row is that row's Enter", async () => {
    const tty = mount(await projectDir());
    try {
      await moveCursorTo(tty, "被动召回");
      const rows = await tty.rows();
      const index = rows.findIndex((row) =>
        row.slice(1).startsWith("> 被动召回"),
      );
      // Screen row = index + 1; the header is row 1.
      const press = `${ESC}[<0;4;${index + 1}M`;
      const release = `${ESC}[<0;4;${index + 1}m`;
      await tty.press(press, release);
      await settle();
      expect((await tty.rows())[0]).toContain("被动召回");
    } finally {
      tty.stop();
    }
  });

  test("the permissions screen counts the buckets, and a rule added there is on disk", async () => {
    const dir = await projectDir();
    const tty = mount(dir);
    try {
      await moveCursorTo(tty, "权限");
      await tty.press(ENTER);
      await settle(400);
      const screen = await tty.rows();
      expect(screen[0]).toContain("工具与权限 / 权限");
      expect(screen.join("\n")).toContain("模式");
      expect(screen.join("\n")).toMatch(/写入\s+project/);

      await moveCursorTo(tty, "允许");
      await tty.press(ENTER);
      await settle(400);
      // The list is merged with the machine's own user rules, so this case asserts
      // only about the rule it writes — an "empty bucket" assertion would be a
      // statement about the developer's `~/.haruyuki/settings.json`.
      expect((await tty.rows()).join("\n")).not.toContain("Bash(ls:*)");

      // A new rule: the page's own editor takes the keyboard and writes on Enter.
      await tty.press("a");
      await settle(50);
      for (const char of "Bash(ls:*)") {
        await tty.press(char);
      }
      await tty.press(ENTER);
      await settle(400);

      const bucket = await tty.rows();
      expect(bucket.join("\n")).toContain("Bash(ls:*)");
      const onDisk = await loadPermissions(dir);
      expect(onDisk.allow ?? []).toContain("Bash(ls:*)");

      // D twice: the first press arms, the second deletes.
      await tty.press("d");
      await settle(80);
      expect((await tty.rows()).join("\n")).toContain("再按 D 删除");
      await tty.press("d");
      await settle(400);
      expect((await tty.rows()).join("\n")).not.toContain("Bash(ls:*)");
      expect((await loadPermissions(dir)).allow ?? []).not.toContain(
        "Bash(ls:*)",
      );
    } finally {
      tty.stop();
    }
  });
});
