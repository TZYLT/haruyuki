import { afterEach, describe, expect, test } from "bun:test";
import { SkillsDialog } from "@/cli/components/SkillsDialog";
import { mountInkTty, resetInkTtyState } from "@/test-utils/ink-tty";

/**
 * `/skills` on the toolkit, judged on the frame.
 *
 * The keys are the part worth pinning: the arrows are *scroll*, not navigation —
 * this face has no cursor — and they used to be an Ink `useInput` handler.
 * (`overlay/key-owner.test.ts` pins that they are a router table now; this file
 * pins that they still do what they did.)
 *
 * The strip's counts come from the checkout (`Project`/`Bundled` are non-empty
 * here), so the assertions are on the labels' shape rather than their numbers.
 */

const TAB = "\t";
const DOWN = "\u001B[B";
const UP = "\u001B[A";
const LEFT = "\u001B[D";
const ESCAPE = "\u001B";
const CTRL_C = "\u0003";

const settle = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function mount() {
  let closes = 0;
  const tty = mountInkTty(
    <SkillsDialog
      onClose={() => {
        closes += 1;
      }}
      agentId="agent-skills"
    />,
    { columns: 80, rows: 24 },
  );
  // Discovery runs in an effect and reads the filesystem.
  await settle(600);
  return {
    rows: async () => {
      await settle(80);
      return tty.rows();
    },
    press: tty.press,
    stop: tty.stop,
    closed: () => closes,
  };
}

/** The one row carrying `text`, or the empty string, so a miss cannot pass as a row. */
function rowWith(rows: string[], text: string): string {
  return rows.find((row) => row.includes(text)) ?? "";
}

/** The line under the strip: which source the active tab shows. */
function descriptionRow(rows: string[]): string {
  const index = rows.findIndex((row) => /Project \[\d+\]/.test(row));
  return index === -1 ? "<no strip>" : (rows[index + 1] ?? "<no description>");
}

afterEach(() => {
  resetInkTtyState();
});

describe("SkillsDialog", () => {
  test("draws the frame, the strip with counts, and the footer", async () => {
    const harness = await mount();
    const rows = await harness.rows();
    const text = rows.join("\n");

    expect(rows[0]).toBe("> /skills");
    expect(text).toMatch(/Skills \(\d+ currently available\)/);
    expect(text).toMatch(/Project \[\d+\]/);
    expect(text).toMatch(/Agent \[\d+\]/);
    expect(text).toMatch(/Global \[\d+\]/);
    expect(text).toMatch(/Bundled \[\d+\]/);
    expect(text).toContain("↑↓ scroll · ←→/Tab switch · Esc to close");
    harness.stop();
  });

  test("the strip walks forward and back", async () => {
    const harness = await mount();
    expect(descriptionRow(await harness.rows())).toBe("  .skills/");

    await harness.press(TAB);
    expect(descriptionRow(await harness.rows())).toContain(
      "/agents/agent-skills/memory/skills/",
    );

    await harness.press(LEFT);
    expect(descriptionRow(await harness.rows())).toBe("  .skills/");
    harness.stop();
  });

  test("the arrows scroll the longest tab and count what is left", async () => {
    const harness = await mount();
    // project -> agent -> global -> bundled
    await harness.press(TAB, TAB, TAB);
    const atTop = await harness.rows();

    expect(descriptionRow(atTop)).toBe(
      "  Built-in skills shipped with Haruyuki",
    );
    expect(rowWith(atTop, "more below")).toBeTruthy();

    await harness.press(DOWN);
    const scrolled = await harness.rows();

    // The window moved rather than the list growing: same five rows, different
    // first one, and one fewer line left below.
    const topList = atTop.filter((row) => row.includes("tokens"));
    const scrolledList = scrolled.filter((row) => row.includes("tokens"));
    expect(scrolledList).toHaveLength(topList.length);
    expect(scrolledList[0]).not.toBe(topList[0]);
    expect(rowWith(scrolled, "more below")).toContain("14 more");

    await harness.press(UP);
    expect(await harness.rows()).toEqual(atTop);
    harness.stop();
  });

  test("Escape and Ctrl+C both close", async () => {
    const harness = await mount();
    await harness.press(ESCAPE);
    expect(harness.closed()).toBe(1);

    await harness.press(CTRL_C);
    expect(harness.closed()).toBe(2);
    harness.stop();
  });
});
