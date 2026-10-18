import { afterEach, describe, expect, test } from "bun:test";
import { commands } from "@/cli/commands/registry";
import {
  type InkTty,
  mountInkTty,
  resetInkTtyState,
} from "@/test-utils/ink-tty";
import { HelpDialog } from "./HelpDialog";

/**
 * `/help`, judged on the frame.
 *
 * Rows, never the stdout chunk stream: joining raw Ink writes re-asserts Ink's
 * own diffing instead of what is on screen, and `src/cli/AGENTS.md` records the
 * class of bug where a key path is wired perfectly, the state is what the test
 * asserts, and the frame is empty. The three tests that used the chunk stream
 * (the footer, a command row's spacing, and the page line after ten ↓) are the
 * cases below now, at the layer they are about.
 */
const ESC = "\u001b";
const CTRL_C = "\u0003";
const DOWN = "\u001b[B";
const TAB_KEY = "\t";
const SHIFT_TAB = "\u001b[Z";
const RIGHT = "\u001b[C";
const PAGE_SIZE = 10;

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

async function pressKeys(tty: InkTty, ...keys: string[]): Promise<void> {
  for (const key of keys) {
    await tty.press(key);
    await settle();
  }
}

let closes: string[];

function mountFrame(): InkTty {
  closes = [];
  return mountInkTty(<HelpDialog onClose={() => closes.push("close")} />, {
    columns: 100,
    rows: 40,
  });
}

async function commandTotal(): Promise<number> {
  const { getCustomCommands } = await import("@/cli/commands/custom.js");
  const custom = await getCustomCommands();
  const builtins = Object.entries(commands).filter(([_, cmd]) => !cmd.hidden);
  return builtins.length + custom.length;
}

function markedRow(rows: string[]): string | null {
  return rows.find((row) => row.startsWith("›")) ?? null;
}

function pageLine(rows: string[]): string | undefined {
  return rows.find((row) => row.trimStart().startsWith("Page "));
}

afterEach(resetInkTtyState);

describe("HelpDialog on the overlay toolkit", () => {
  test("paints the header, the tabs, the page line and exactly one page", async () => {
    const total = await commandTotal();
    const tty = mountFrame();
    try {
      await settle(120);
      const rows = await tty.rows();

      expect(rows[0]).toBe("> /help");
      expect(rows[1]).toBe("─".repeat(100));
      expect(rows[3]).toMatch(/^Haruyuki v/);
      expect(rows[5]).toContain(`Commands (${total})`);
      expect(pageLine(rows)).toBe(`  Page 1/${Math.ceil(total / PAGE_SIZE)}`);
      expect(rows.at(-1)).toBe("↑↓ scroll · ←→ page · Tab switch · Esc cancel");

      // Name and description on one row, one space apart: the list paints both
      // itself rather than leaning on Ink to lay out two columns. This was the
      // chunk stream's `toContain("/model Switch model")`.
      expect(rows).toContain("  /model Switch model");

      // One page of rows, and nothing but the frame's blank line and the footer
      // after the tenth one.
      const firstRow = rows.findIndex((row) => row.startsWith("›"));
      expect(firstRow).toBeGreaterThan(0);
      expect(rows[firstRow + PAGE_SIZE]).toBe("");
      expect(rows[firstRow + PAGE_SIZE + 1]).toBe(
        "↑↓ scroll · ←→ page · Tab switch · Esc cancel",
      );
    } finally {
      tty.stop();
    }
  });

  test("↓ crosses a page boundary by moving the page, not by sliding", async () => {
    const total = await commandTotal();
    expect(total).toBeGreaterThan(PAGE_SIZE);
    const tty = mountFrame();
    try {
      await settle(120);
      const firstRow = (await tty.rows()).findIndex((row) =>
        row.startsWith("›"),
      );
      await pressKeys(tty, ...Array.from({ length: PAGE_SIZE }, () => DOWN));
      const rows = await tty.rows();

      expect(pageLine(rows)).toBe(`  Page 2/${Math.ceil(total / PAGE_SIZE)}`);
      // The 11th item is at the top of the window, and the marker is on it.
      expect(rows[firstRow]?.startsWith("›")).toBe(true);
    } finally {
      tty.stop();
    }
  });

  test("k and → are whole-page steps that land on the page's first row", async () => {
    const total = await commandTotal();
    expect(total).toBeGreaterThan(PAGE_SIZE);
    const tty = mountFrame();
    try {
      await settle(120);
      const firstRow = (await tty.rows()).findIndex((row) =>
        row.startsWith("›"),
      );

      // `j` is the *previous* page on this face, so at the first page it does
      // nothing; `k` is the next one.
      await pressKeys(tty, "j");
      expect(pageLine(await tty.rows())).toBe(
        `  Page 1/${Math.ceil(total / PAGE_SIZE)}`,
      );

      await pressKeys(tty, "k");
      const second = await tty.rows();
      expect(pageLine(second)).toBe(`  Page 2/${Math.ceil(total / PAGE_SIZE)}`);
      expect(second[firstRow]?.startsWith("›")).toBe(true);

      if (total > PAGE_SIZE * 2) {
        await pressKeys(tty, RIGHT);
        expect(pageLine(await tty.rows())).toBe(
          `  Page 3/${Math.ceil(total / PAGE_SIZE)}`,
        );
      }
    } finally {
      tty.stop();
    }
  });

  test("Tab moves to the shortcuts page, which is one page", async () => {
    const tty = mountFrame();
    try {
      await settle(120);
      await pressKeys(tty, TAB_KEY);
      const rows = await tty.rows();

      expect(rows[5]).toContain("Shortcuts (10)");
      expect(pageLine(rows)).toBe("  Page 1/1");
      expect(
        rows.some((row) => row.includes("Open command autocomplete")),
      ).toBe(true);
      expect(markedRow(rows)?.startsWith("›")).toBe(true);
    } finally {
      tty.stop();
    }
  });

  test("Shift+Tab is the same key, as it was before the toolkit", async () => {
    // `ESC[Z` reaches the router as `tab` *with* `shift` set, and this face read
    // `if (key.tab)` without looking at the modifier before it moved onto the
    // toolkit. Applying the strict chord reading to it silently dropped the key —
    // and no batch's frame-equivalence script pressed Shift+Tab, which is why the
    // migration shipped it. `namedKeyChords` is where that meaning is stated now.
    const tty = mountFrame();
    try {
      await settle(120);
      await pressKeys(tty, SHIFT_TAB);
      const rows = await tty.rows();

      expect(rows[5]).toContain("Shortcuts (10)");
      expect(pageLine(rows)).toBe("  Page 1/1");
    } finally {
      tty.stop();
    }
  });

  test("Escape and Ctrl+C both close it", async () => {
    const tty = mountFrame();
    try {
      await settle(120);
      await pressKeys(tty, ESC);
      expect(closes).toEqual(["close"]);
    } finally {
      tty.stop();
    }

    const second = mountFrame();
    try {
      await settle(120);
      await pressKeys(second, CTRL_C);
      expect(closes).toEqual(["close"]);
    } finally {
      second.stop();
    }
  });
});
