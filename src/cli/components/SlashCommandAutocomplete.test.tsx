import { afterEach, describe, expect, test } from "bun:test";
import { getHoverTarget, resetHoverForTests } from "@/cli/helpers/hover-store";
import { resetBindingOwners } from "@/cli/helpers/input-router";
import { resetMouseHandlers } from "@/cli/helpers/mouse-router";
import { resetMouseTrackingForTests } from "@/cli/helpers/mouse-tracking";
import {
  type InkTty,
  mountInkTty,
  resetInkTtyState,
} from "@/test-utils/ink-tty";
import { SlashCommandAutocomplete } from "./SlashCommandAutocomplete";
import type { ModCommandAutocompleteItem } from "./types/autocomplete";

/**
 * The slash-command popup, judged on the frame.
 *
 * What a frame sees here is geometry -- the two-column gutter, the command
 * column padded to `CMD_COL_WIDTH`, one space, the description -- plus the two
 * rules that only exist on screen: the window follows the cursor, and the popup
 * keeps its height while it does. A navigation test can assert the cursor moved
 * and still miss a footer that reflows underneath it, which is what the
 * component's own comment sets out to prevent ("keep each item one visual line
 * tall so navigating doesn't reflow the footer").
 *
 * What a frame *cannot* see is which row is selected: the item's only marker is
 * colour and bold (`Autocomplete.tsx`), and the test process has no colour
 * (docs/37 §8 item 14). The window moving is the observable half of the cursor.
 *
 * The list is the registry plus custom commands plus user-invocable skills. The
 * first page is always builtins, so that page is pinned here as the registry
 * draws it; everything else is driven by fixtures this file owns, because the
 * skill set (and therefore every count) belongs to the checkout and its HOME
 * rather than to the component.
 */

const DOWN = "\u001b[B";
const CMD_COL_WIDTH = 14;
const GUTTER = 2;
/** The scroll footer. The number depends on the loaded command set. */
const MORE_BELOW = /^\s+↓ \d+ more below$/;

const settle = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));

function modCommand(
  id: string,
  description: string,
): ModCommandAutocompleteItem {
  return { id, description, order: 150 };
}

/** Twelve fixtures: more than one page, so the footer and its reserve appear. */
const MANY: Record<string, ModCommandAutocompleteItem> = Object.fromEntries(
  Array.from({ length: 12 }, (_, index) => {
    const id = `zmod-${String(index + 1).padStart(2, "0")}`;
    return [id, modCommand(id, `fixture ${index + 1}`)];
  }),
);

/** What the last page shows: the final eight fixtures, footer gone. */
const LAST_PAGE = Array.from({ length: 8 }, (_, index) => {
  const number = index + 5;
  return `  /zmod-${String(number).padStart(2, "0")}       fixture ${number} (mod)`;
});

function mountPopup(
  input: string,
  modCommands: Record<string, ModCommandAutocompleteItem>,
): InkTty {
  return mountInkTty(
    <SlashCommandAutocomplete
      currentInput={input}
      cursorPosition={input.length}
      onSelect={() => {}}
      onAutocomplete={() => {}}
      modCommands={modCommands}
    />,
    { columns: 100, rows: 40 },
  );
}

async function frame(
  input: string,
  modCommands: Record<string, ModCommandAutocompleteItem> = {
    zmod: modCommand("zmod", "a mod command"),
  },
): Promise<string[]> {
  const tty = mountPopup(input, modCommands);
  try {
    await settle();
    return await tty.rows();
  } finally {
    tty.stop();
  }
}

afterEach(() => {
  resetInkTtyState();
  resetMouseHandlers();
  resetHoverForTests();
  resetMouseTrackingForTests();
  resetBindingOwners();
});

describe("the popup's pointer", () => {
  /**
   * The mouse half of the popup (《38》§19.1, the P2 row): a click *is* that row's
   * `Enter`, and hover is the row under the pointer.
   *
   * Judged on the frame for the geometry and on the callback for the action: the
   * popup sits in the bottom chrome, so its rows are screen rows and the test's
   * coordinates are the ones the terminal would report. What the frame cannot see
   * is the hover *colour* (the test process has no colour), so the store is read —
   * which is the half a move writes.
   */
  const ESC = "\u001B";
  const pressAt = (column: number, row: number) =>
    `${ESC}[<0;${column};${row}M`;
  const releaseAt = (column: number, row: number) =>
    `${ESC}[<0;${column};${row}m`;
  const moveTo = (column: number, row: number) =>
    `${ESC}[<35;${column};${row}M`;

  function mountPointer(
    input: string,
    modCommands: Record<string, ModCommandAutocompleteItem>,
  ): { selected: string[]; tty: InkTty } {
    const selected: string[] = [];
    const tty = mountInkTty(
      <SlashCommandAutocomplete
        currentInput={input}
        cursorPosition={input.length}
        onSelect={(command) => {
          selected.push(command);
        }}
        onAutocomplete={() => {}}
        modCommands={modCommands}
      />,
      { columns: 100, rows: 40 },
    );
    return { selected, tty };
  }

  test("a click on a row runs that row's Enter", async () => {
    const { selected, tty } = mountPointer("/zmod", MANY);
    try {
      await settle();
      // Screen row 2 is the second row of the popup, whose first row is row 1.
      await tty.press(pressAt(4, 2), releaseAt(4, 2));
      expect(selected).toEqual(["/zmod-02"]);
    } finally {
      tty.stop();
    }
  });

  test("a click lands on the row the window is showing, not on its screen number", async () => {
    const { selected, tty } = mountPointer("/zmod", MANY);
    try {
      await settle();
      // Eight steps put the cursor on the fifth fixture and slide the window to
      // `zmod-05`…, which is what the frame already pins. The first screen row is
      // therefore list row 4, and clicking it must run *that* command.
      for (let step = 0; step < 8; step += 1) {
        await tty.press(DOWN);
        await settle(40);
      }
      const rows = await tty.rows();
      expect(rows[0]).toStartWith("  /zmod-05");

      await tty.press(pressAt(4, 1), releaseAt(4, 1));
      expect(selected).toEqual(["/zmod-05"]);
    } finally {
      tty.stop();
    }
  });

  test("the footer and the space around the rows are not rows", async () => {
    const { selected, tty } = mountPointer("/zmod", MANY);
    try {
      await settle();
      // Row 9 is `↓ 4 more below`, which is not a command.
      await tty.press(pressAt(4, 9), releaseAt(4, 9));
      expect(selected).toEqual([]);
    } finally {
      tty.stop();
    }
  });

  test("hover follows the pointer and clears when it leaves the rows", async () => {
    const { tty } = mountPointer("/zmod", MANY);
    try {
      await settle();
      await tty.press(moveTo(4, 2));
      expect(getHoverTarget()).toEqual({ area: "autocomplete", index: 1 });

      await tty.press(moveTo(4, 3));
      expect(getHoverTarget()).toEqual({ area: "autocomplete", index: 2 });

      // Off the rows, onto the footer: nothing is lit.
      await tty.press(moveTo(4, 9));
      expect(getHoverTarget()).toBeNull();
    } finally {
      tty.stop();
    }
  });
});

describe("SlashCommandAutocomplete on the frame", () => {
  test("a row is the gutter, the padded command and one space before the description", async () => {
    const rows = await frame("/zmod");

    expect(rows).toEqual(["  /zmod          a mod command (mod)"]);
    // The description starts where the geometry says: gutter + padded column +
    // the single separating space. Padding alone would put it at 16.
    expect(rows[0]?.indexOf("a mod command (mod)")).toBe(
      GUTTER + CMD_COL_WIDTH + 1,
    );
  });

  test("a command name longer than the column is truncated, not wrapped", async () => {
    // The popup is one line per item, so a name past the column must be cut
    // rather than pushed onto a second row, which would move the footer under the
    // cursor. A fixture owns the name because the real long ones are skills, and
    // a skill's id belongs to the checkout rather than to this component.
    const name = "zmod-beyond-the-column";
    const rows = await frame(`/${name}`, {
      [name]: modCommand(name, "a long name"),
    });

    expect(rows).toHaveLength(1);
    const column = rows[0]?.slice(GUTTER, GUTTER + CMD_COL_WIDTH) ?? "";
    expect(column).toHaveLength(CMD_COL_WIDTH);
    expect(column).toEndWith("...");
    // Truncated to the column, so the description still starts where every other
    // row's does.
    expect(rows[0]?.indexOf("a long name")).toBe(GUTTER + CMD_COL_WIDTH + 1);
  });

  test("no match says so instead of collapsing to nothing", async () => {
    expect(await frame("/zzz")).toEqual(["  No matching commands"]);
  });

  test("a finished command or ordinary text draws no popup", async () => {
    // A space ends the command token, and text that never began with `/` has
    // nothing to complete.
    expect(await frame("/model ")).toEqual([]);
    expect(await frame("hello")).toEqual([]);
  });

  test("the first page is the builtins, in registry order", async () => {
    const rows = await frame("/");

    expect(rows.slice(0, 8)).toEqual([
      "  /agent         Agent: browse, pin, rename, describe, system, personality, tools",
      "  /model         Switch model",
      "  /doctor        Investigate an agent issue in this conversation",
      "  /memory        Memory: view, init, filesystem backend, remote, palace, recall",
      "  /search        Search messages across all agents (/search [query])",
      "  /recall        Configure passive recall of earlier conversations and memory",
      "  /clear         Clear in-context messages",
      "  /cd            Change working directory for this TUI session (/cd <path>)",
    ]);
    expect(rows).toHaveLength(9);
    expect(rows[8]).toMatch(MORE_BELOW);
  });

  test("the window follows the cursor and the popup keeps its height", async () => {
    const tty = mountPopup("/zmod", MANY);
    try {
      await settle();
      const top = await tty.rows({ keepTrailingBlanks: true });
      expect(top).toHaveLength(9);
      expect(top.at(-1)).toBe("  ↓ 4 more below");

      for (let step = 0; step < 8; step += 1) {
        await tty.press(DOWN);
        await settle(60);
      }
      const last = await tty.rows({ keepTrailingBlanks: true });

      // Nine rows again: the last page has nothing below it, so the footer is
      // *replaced* by the blank row that reserves its place rather than removed.
      // `rows()` would have trimmed that row and reported a popup one row shorter
      // than the one on screen.
      expect(last).toHaveLength(9);
      expect(last.at(-1)).toBe("");
      // Eight steps put the cursor on the fifth fixture; the window slides to the
      // last eight and no further, so the cursor stays inside it.
      expect(last.slice(0, 8)).toEqual(LAST_PAGE);
    } finally {
      tty.stop();
    }
  });
});
