import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HooksConfig } from "@/hooks/types";
import {
  isUserHooksDisabled,
  loadMatchersWithSource,
  loadSimpleMatchersWithSource,
} from "@/hooks/writer";
import { settingsManager } from "@/settings-manager";
import {
  type InkTty,
  mountInkTty,
  resetInkTtyState,
} from "@/test-utils/ink-tty";
import { HooksManager } from "./HooksManager";

/**
 * `/hooks` on the overlay toolkit — this face's first test.
 *
 * It is where the batch's two list paths meet its two text paths, so these assert
 * on the frame: which screen is on the glass, which row the marker is on, and what
 * the settings store says once a flow has finished. Every write in here targets the
 * **user** location (the save-location picker's third row): its first two rows
 * write into the repository's own `.haruyuki/`, which a test must never touch.
 */

const ESC = "\u001b";
const ENTER = "\r";
const CTRL_C = "\u0003";
const BACKSPACE = "\u007f";
const DOWN = "\u001b[B";
const UP = "\u001b[A";
const END = "\u001b[F";

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Keys 60 ms apart. The harness's own 30 ms spacing is enough for one key, but a
 * *run* of navigation keys at that spacing can land twice — the router's raw path
 * and Ink's fallback read one dispatch (recorded in `docs/37` §9J.2 item 9).
 */
async function press(tty: InkTty, ...keys: string[]): Promise<void> {
  for (const key of keys) {
    await tty.press(key);
    await settle();
  }
}

async function type(tty: InkTty, text: string): Promise<void> {
  for (const char of text) {
    await tty.press(char);
    await settle();
  }
}

let fakeHome: string;
let originalHome: string | undefined;

beforeEach(async () => {
  // Reset before HOME moves, then initialize against the fake one — the pattern
  // `hooks/loader.test.ts` established for file-backed hook config.
  await settingsManager.reset();
  fakeHome = mkdtempSync(join(tmpdir(), "hooks-face-test-"));
  originalHome = process.env.HOME;
  process.env.HOME = fakeHome;
  await settingsManager.initialize();
});

afterEach(async () => {
  await settingsManager.reset();
  process.env.HOME = originalHome;
  resetInkTtyState();
  try {
    rmSync(fakeHome, { recursive: true, force: true });
  } catch {
    // The temp directory is disposable either way.
  }
});

function seed(hooks: HooksConfig): void {
  settingsManager.updateSettings({ hooks });
}

function toolHook(command: string, matcher = "Bash") {
  return { matcher, hooks: [{ type: "command" as const, command }] };
}

function mount(): { tty: InkTty; closes: string[] } {
  const closes: string[] = [];
  const tty = mountInkTty(
    <HooksManager onClose={() => closes.push("close")} />,
    { columns: 100, rows: 40 },
  );
  return { tty, closes };
}

/** From the events screen into PreToolUse's hook list. */
async function openPreToolUse(tty: InkTty): Promise<void> {
  await press(tty, DOWN, ENTER);
  expect(await tty.text()).toContain("PreToolUse - Tool Matchers");
}

/** From the events screen into a simple event's hook list. */
async function openSimpleEvent(tty: InkTty): Promise<void> {
  // End jumps to the list's last row, which is a simple event.
  await press(tty, END, ENTER);
  expect(await tty.text()).toContain("SessionEnd - Hooks");
}

/** The whole add flow for a tool event, ending on the save-location step. */
async function toSaveLocation(tty: InkTty, command: string): Promise<void> {
  await openPreToolUse(tty);
  await press(tty, ENTER); // the add row
  expect(await tty.text()).toContain("Tool matcher:");
  await type(tty, "Bash");
  await press(tty, ENTER);
  await type(tty, command);
  await press(tty, ENTER);
  expect(await tty.text()).toContain("Where should this hook be saved?");
}

describe("the events screen", () => {
  test("paints the standard header, the toggle and every event", async () => {
    const { tty } = mount();
    try {
      const painted = await tty.text();
      expect(painted).toContain("> /hooks");
      expect(painted).toContain("Hooks · 0 hooks");
      expect(painted).toContain("1. Disable all hooks");
      expect(painted).toContain("2. PreToolUse - Before tool execution");
      expect(painted).toContain("12. SessionEnd - When a session ends");
      expect(painted).toContain("Enter to select · esc to cancel");
      // The box this face drew itself is what the frame replaced.
      expect(painted).not.toContain("╭");
    } finally {
      tty.stop();
    }
  });

  test("Escape at the root closes it", async () => {
    const { tty, closes } = mount();
    try {
      await press(tty, ESC);
      expect(closes).toEqual(["close"]);
    } finally {
      tty.stop();
    }
  });

  test("an event row counts the hooks configured for it", async () => {
    seed({ PreToolUse: [toolHook("echo one"), toolHook("echo two", "Edit")] });
    const { tty } = mount();
    try {
      expect(await tty.text()).toContain("PreToolUse - Before tool execution");
      expect(await tty.text()).toContain("(2)");
    } finally {
      tty.stop();
    }
  });

  test("Enter on the toggle disables every hook and says so in the title", async () => {
    const { tty } = mount();
    try {
      await press(tty, ENTER);
      let painted = await tty.text();
      expect(painted).toContain("Hooks · 0 hooks (disabled)");
      expect(painted).toContain("1. Enable all hooks");
      expect(isUserHooksDisabled()).toBe(true);

      await press(tty, ENTER);
      painted = await tty.text();
      expect(painted).toContain("Hooks · 0 hooks");
      expect(painted).toContain("1. Disable all hooks");
      expect(isUserHooksDisabled()).toBe(false);
    } finally {
      tty.stop();
    }
  });
});

describe("an event's hook list", () => {
  test("lists a tool matcher with its source, matcher column and command", async () => {
    seed({ PreToolUse: [toolHook("echo hi")] });
    const { tty } = mount();
    try {
      await openPreToolUse(tty);
      const painted = await tty.text();
      expect(painted).toContain("+ Add new matcher...");
      expect(painted).toContain("[User]");
      expect(painted).toMatch(/\[User\] Bash\s+echo hi/);
      expect(painted).toContain("Exit code 2 - show stderr to model and block");
      expect(painted).toContain("Enter to select · esc to go back");
    } finally {
      tty.stop();
    }
  });

  test("a simple event's list has no matcher column", async () => {
    seed({
      SessionEnd: [{ hooks: [{ type: "command", command: "say done" }] }],
    });
    const { tty } = mount();
    try {
      await openSimpleEvent(tty);
      const painted = await tty.text();
      expect(painted).toContain("SessionEnd - Hooks");
      expect(painted).toContain("[User] say done");
      expect(painted).toContain("+ Add new hook...");
      expect(painted).toContain("Exit code 0 - success, continue");
    } finally {
      tty.stop();
    }
  });

  test("Escape goes back to the events list and does not close", async () => {
    seed({ PreToolUse: [toolHook("echo hi")] });
    const { tty, closes } = mount();
    try {
      await openPreToolUse(tty);
      await press(tty, ESC);
      expect(await tty.text()).toContain("Hooks · 1 hooks");
      expect(closes).toEqual([]);
    } finally {
      tty.stop();
    }
  });

  test("windows the list at ten rows and counts what is behind", async () => {
    seed({
      PreToolUse: Array.from({ length: 12 }, (_value, index) =>
        toolHook(`hook-${String(index + 1).padStart(2, "0")}`),
      ),
    });
    const { tty } = mount();
    try {
      await openPreToolUse(tty);
      let painted = await tty.text();
      expect(painted).toMatch(/↓ 3 more/);
      expect(painted).not.toContain("hook-12");

      // End is the list's: the window follows the cursor to the far end.
      await press(tty, END);
      painted = await tty.text();
      expect(painted).toMatch(/↑ 3 more/);
      expect(painted).toContain("hook-12");
      expect(painted).not.toContain("hook-01");
    } finally {
      tty.stop();
    }
  });
});

describe("adding a hook", () => {
  test("a tool event asks for the matcher, the command and the location, then writes", async () => {
    const { tty } = mount();
    try {
      await toSaveLocation(tty, "echo hi");
      let painted = await tty.text();
      expect(painted).toContain("Event: PreToolUse");
      expect(painted).toContain("Matcher: Bash");
      expect(painted).toContain("Command: echo hi");
      expect(painted).toContain("User settings");
      expect(painted).toContain("Where should this hook be saved?");

      // Third row: the user settings file, and the only location a test may write.
      await press(tty, DOWN, DOWN, ENTER);
      painted = await tty.text();
      expect(painted).toContain("PreToolUse - Tool Matchers");
      expect(painted).toMatch(/\[User\] Bash\s+echo hi/);

      const matchers = loadMatchersWithSource("PreToolUse");
      expect(matchers).toHaveLength(1);
      expect(matchers[0]?.matcher).toBe("Bash");
      expect(matchers[0]?.hooks).toEqual([
        { type: "command", command: "echo hi" },
      ]);
      expect(matchers[0]?.source).toBe("user");
    } finally {
      tty.stop();
    }
  });

  test("the field is a real editor: backspace deletes, and it is cleared for the next hook", async () => {
    const { tty } = mount();
    try {
      await openPreToolUse(tty);
      await press(tty, ENTER);
      await type(tty, "Bashh");
      expect(await tty.text()).toContain("Bashh");
      await press(tty, BACKSPACE);
      expect(await tty.text()).toContain("Bash");
      await press(tty, ENTER);
      expect(await tty.text()).toContain("Matcher: Bash");

      // Escape back to the matcher step keeps the pattern — it is the step's own
      // state — and entering the step again does not.
      await press(tty, ESC);
      expect(await tty.text()).toContain("Bash");
      await press(tty, ESC, ENTER);
      const repainted = await tty.text();
      expect(repainted).toContain("* (matches all tools)");
      expect(repainted).not.toMatch(/Tool matcher:.*Bash/);
    } finally {
      tty.stop();
    }
  });

  test("a simple event skips the matcher step and writes without one", async () => {
    const { tty } = mount();
    try {
      await openSimpleEvent(tty);
      await press(tty, ENTER);
      let painted = await tty.text();
      expect(painted).toContain("Add new hook for SessionEnd");
      expect(painted).not.toContain("Matcher:");

      await type(tty, "say done");
      await press(tty, ENTER);
      painted = await tty.text();
      expect(painted).toContain("Command: say done");
      expect(painted).not.toContain("Matcher:");

      await press(tty, DOWN, DOWN, ENTER);
      painted = await tty.text();
      expect(painted).toContain("SessionEnd - Hooks");
      expect(painted).toContain("say done");

      const matchers = loadSimpleMatchersWithSource("SessionEnd");
      expect(matchers).toHaveLength(1);
      expect(matchers[0]?.hooks).toEqual([
        { type: "command", command: "say done" },
      ]);
      expect("matcher" in (matchers[0] ?? {})).toBe(false);
    } finally {
      tty.stop();
    }
  });

  test("Escape from the command step goes back one step, and Ctrl+C closes from it", async () => {
    const { tty, closes } = mount();
    try {
      await toSaveLocation(tty, "echo hi");
      await press(tty, ESC);
      expect(await tty.text()).toContain("Command:");

      await press(tty, ESC);
      expect(await tty.text()).toContain("Tool matcher:");

      await press(tty, ESC);
      expect(await tty.text()).toContain("PreToolUse - Tool Matchers");
      expect(closes).toEqual([]);

      await press(tty, ENTER, ENTER, CTRL_C);
      expect(closes).toEqual(["close"]);
    } finally {
      tty.stop();
    }
  });

  test("an empty command writes nothing", async () => {
    const { tty } = mount();
    try {
      await toSaveLocation(tty, "");
      await press(tty, DOWN, DOWN, ENTER);
      // Still on the picker: the old handler returned before saving.
      expect(await tty.text()).toContain("Where should this hook be saved?");
      expect(loadMatchersWithSource("PreToolUse")).toHaveLength(0);
    } finally {
      tty.stop();
    }
  });
});

describe("deleting a hook", () => {
  test("the confirmation names the matcher, the command and the source, and defaults to No", async () => {
    seed({ PreToolUse: [toolHook("echo hi")] });
    const { tty } = mount();
    try {
      await openPreToolUse(tty);
      await press(tty, DOWN, ENTER);
      const painted = await tty.text();
      expect(painted).toContain("Delete hook?");
      expect(painted).toContain("Matcher: Bash");
      expect(painted).toContain("Command: echo hi");
      expect(painted).toContain("Source: User");
      expect(painted).toContain("Yes, delete");
      expect(painted).toContain("No, cancel");

      // Escape is a step back here, not a cancel of the overlay.
      await press(tty, ESC);
      expect(await tty.text()).toContain("PreToolUse - Tool Matchers");
      expect(loadMatchersWithSource("PreToolUse")).toHaveLength(1);
    } finally {
      tty.stop();
    }
  });

  test("Yes, delete removes it and returns to the hook list", async () => {
    seed({ PreToolUse: [toolHook("echo hi")] });
    const { tty } = mount();
    try {
      await openPreToolUse(tty);
      await press(tty, DOWN, ENTER);
      // The cursor starts on "No, cancel"; up is "Yes, delete".
      await press(tty, UP, ENTER);
      await settle(150);
      const painted = await tty.text();
      expect(painted).toContain("PreToolUse - Tool Matchers");
      expect(painted).not.toContain("echo hi");
      expect(loadMatchersWithSource("PreToolUse")).toHaveLength(0);
    } finally {
      tty.stop();
    }
  });
});
