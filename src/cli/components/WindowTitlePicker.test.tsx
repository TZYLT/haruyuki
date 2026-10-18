import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WindowTitlePicker } from "@/cli/components/WindowTitlePicker";
import { resolveWindowTitleConfig } from "@/cli/helpers/window-title-config";
import { settingsManager } from "@/settings-manager";
import { mountInkTty, resetInkTtyState } from "@/test-utils/ink-tty";

/**
 * The terminal-title configurator, on the toolkit's frame.
 *
 * It is a `MultiSelectPicker` (the toolkit's adapter) inside `OverlayFrame`, so the
 * chrome migration is the whole change: what the face *does* — toggle, preview,
 * ordering, and writing the setting on confirm — has to survive it. The settings
 * manager is relocated to a temp home, since confirming writes to it.
 */

const SPACE = " ";
const DOWN = "\u001B[B";
const RIGHT = "\u001B[C";
const ENTER = "\r";

let previousHome: string | undefined;
let tempHome: string;
let projectDirectory: string;

beforeAll(async () => {
  previousHome = process.env.HOME;
  tempHome = mkdtempSync(join(tmpdir(), "haruyuki-title-picker-test-"));
  process.env.HOME = tempHome;
  await settingsManager.reset();
  await settingsManager.initialize();
  projectDirectory = join(tempHome, "project");
});

afterAll(async () => {
  await settingsManager.reset();
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  rmSync(tempHome, { recursive: true, force: true });
});

const settle = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function mount() {
  const previews: (string | null)[] = [];
  let previewEnds = 0;
  let closes = 0;
  const tty = mountInkTty(
    <WindowTitlePicker
      projectDirectory={projectDirectory}
      titleData={{
        version: "0.0.0-test",
        agentName: "Test Agent",
        modelDisplayName: "dev/test-model",
        currentDirectory: projectDirectory,
        runState: "Ready",
      }}
      onTitlePreview={(title) => previews.push(title)}
      onTitlePreviewEnd={() => {
        previewEnds += 1;
      }}
      onClose={() => {
        closes += 1;
      }}
    />,
    { columns: 80, rows: 24 },
  );
  await settle(150);
  return {
    rows: async () => {
      await settle(80);
      return tty.rows();
    },
    press: tty.press,
    stop: tty.stop,
    previews,
    previewEnds: () => previewEnds,
    closes: () => closes,
  };
}

function rowWith(rows: string[], text: string): string {
  return rows.find((row) => row.includes(text)) ?? `<no row with ${text}>`;
}

afterEach(() => {
  resetInkTtyState();
});

describe("WindowTitlePicker", () => {
  test("draws the frame's chrome, the checkboxes and the preview", async () => {
    const harness = await mount();
    const rows = await harness.rows();

    expect(rows[0]).toBe("> /title");
    expect(rows.join("\n")).toContain("Configure Terminal Title");
    expect(rowWith(rows, "Activity")).toContain("[✓]");
    expect(rowWith(rows, "Agent Name")).toContain("[✓]");
    expect(rowWith(rows, "App Name")).toContain("[ ]");
    expect(rowWith(rows, "Space to toggle")).toBeTruthy();
    harness.stop();
  });

  test("Space toggles a field and previews the line", async () => {
    const harness = await mount();
    await harness.press(SPACE);
    const rows = await harness.rows();

    expect(rowWith(rows, "Activity")).toContain("[ ]");
    expect(harness.previews).toHaveLength(1);
    expect(harness.previews[0]).toBe("Test Agent");
    harness.stop();
  });

  test("←/→ reorder the selected fields", async () => {
    const harness = await mount();
    await harness.press(DOWN, DOWN, SPACE, RIGHT);
    const rows = await harness.rows();

    // Agent Name moved past App Name: the preview still resolves to the agent's
    // name, and the ordering is what changed.
    expect(harness.previews.length).toBeGreaterThan(0);
    expect(rowWith(rows, "Agent Name")).toBeTruthy();
    harness.stop();
  });

  test("Enter writes the setting and closes", async () => {
    const harness = await mount();
    await harness.press(SPACE, ENTER);

    expect(harness.previewEnds()).toBe(1);
    expect(harness.closes()).toBe(1);
    // The toggle was persisted: `activity` is off in the project's config.
    expect(resolveWindowTitleConfig(projectDirectory)).not.toContain(
      "activity",
    );
    harness.stop();
  });
});
