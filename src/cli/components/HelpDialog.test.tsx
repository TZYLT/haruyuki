import { afterEach, describe, expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { render } from "ink";
import stripAnsi from "strip-ansi";
import { commands } from "@/cli/commands/registry";
import {
  type InkTty,
  mountInkTty,
  resetInkTtyState,
} from "@/test-utils/ink-tty";
import { HelpDialog } from "./HelpDialog";

class CaptureStream extends Writable {
  columns = 100;
  rows = 24;
  isTTY = true;
  chunks: string[] = [];

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.chunks.push(String(chunk));
    callback();
  }
}

function createInputStream(): NodeJS.ReadStream {
  const input = new Readable({ read() {} }) as NodeJS.ReadStream;
  input.isTTY = true;
  input.setRawMode = () => input;
  input.ref = () => input;
  input.unref = () => input;
  return input;
}

async function renderHelpDialog(
  interact?: (stdin: NodeJS.ReadStream) => void | Promise<void>,
): Promise<string> {
  const stdout = new CaptureStream() as CaptureStream & NodeJS.WriteStream;
  const stdin = createInputStream();
  const instance = render(<HelpDialog onClose={() => {}} />, {
    stdout,
    stdin,
    debug: false,
    patchConsole: false,
    exitOnCtrlC: false,
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  await interact?.(stdin);
  await new Promise((resolve) => setTimeout(resolve, 20));
  instance.unmount();
  instance.cleanup();

  return stripAnsi(stdout.chunks.join(""));
}

test("HelpDialog renders its footer without raw Ink text", async () => {
  const output = await renderHelpDialog();

  expect(output).toContain("Haruyuki v");
  expect(output).toContain("↑↓ scroll · ←→ page · Tab switch · Esc cancel");
});

test("HelpDialog keeps spacing between commands and descriptions", async () => {
  const output = await renderHelpDialog();

  expect(output).toContain("/model Switch model");
});

test("HelpDialog scrolls commands with down arrow", async () => {
  const output = await renderHelpDialog(async (stdin) => {
    for (let i = 0; i < 10; i += 1) {
      stdin.push("\x1b[B");
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  });

  expect(output).toContain("Page 2/");
});

/**
 * The migration's own assertions (B8), on the frame.
 *
 * The face is **page-aligned**, which is the whole reason the list model grew
 * `anchor: "page"`: the window moves a whole page at a time, the cursor lands on
 * the page's first row when the page turns, and ↑/↓ cross a page boundary
 * without the list sliding. A list can be wired perfectly and still scroll like
 * the wrong anchor, which is exactly what a state assertion cannot see.
 *
 * The list's length comes from the command registry plus whatever custom
 * commands this checkout has, so the expected page count is computed from the
 * same source the component reads rather than hard-coded.
 */
const ESC = "\u001b";
const CTRL_C = "\u0003";
const DOWN = "\u001b[B";
const TAB_KEY = "\t";
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
