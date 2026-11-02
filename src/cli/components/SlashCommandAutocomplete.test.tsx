import { afterEach, describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
import { getHoverTarget, resetHoverForTests } from "@/cli/helpers/hover-store";
import { resetBindingOwners } from "@/cli/helpers/input-router";
import { resetMouseHandlers } from "@/cli/helpers/mouse-router";
import { resetMouseTrackingForTests } from "@/cli/helpers/mouse-tracking";
import { useKeyBindings } from "@/cli/hooks/use-input-router";
import {
  type InkTty,
  mountInkTty,
  resetInkTtyState,
} from "@/test-utils/ink-tty";
import {
  mergeCommandList,
  SlashCommandAutocomplete,
} from "./SlashCommandAutocomplete";
import type {
  CommandMatch,
  ModCommandAutocompleteItem,
} from "./types/autocomplete";

/**
 * The slash-command popup, judged on the frame.
 *
 * What a frame sees here is geometry -- the two-column gutter, the name column
 * padded to `CMD_COL_WIDTH`, one space, the dim argument placeholder and the
 * description -- plus the rules that only exist on screen: the window follows
 * the cursor, the popup keeps its height while it does, a space switches to the
 * next level, and a level with no candidates draws nothing at all.
 *
 * What a frame *cannot* see is which row is selected: the item's only marker is
 * colour and bold (`Autocomplete.tsx`), and the test process has no colour
 * (docs/37 §8 item 14). The window moving is the observable half of the cursor.
 *
 * The interaction half (T-02, R-02.3/R-02.4) is judged on the callbacks the
 * composer wires to: `onSelect` is the execution path, `onAutocomplete` is the
 * fill path, and the popup is a controlled component, so a fill is asserted by
 * feeding the returned text back in as the next input. Esc's priority is judged
 * with a second `app`-scope table standing in for the composer's interrupt.
 *
 * The list is the registry plus custom commands plus user-invocable skills. The
 * first page is always builtins, so that page is pinned here as the registry
 * draws it; everything else is driven by fixtures this file owns, because the
 * skill set (and therefore every count) belongs to the checkout and its HOME
 * rather than to the component.
 */

const DOWN = "\u001b[B";
const ESCAPE = "\u001B";
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

const DEFAULT_MODS: Record<string, ModCommandAutocompleteItem> = {
  zmod: modCommand("zmod", "a mod command"),
};

interface PopupOptions {
  onSelect?: (value: string) => void;
  onAutocomplete?: (value: string) => void;
  onActiveChange?: (isActive: boolean) => void;
  modCommands?: Record<string, ModCommandAutocompleteItem>;
}

function popupElement(input: string, options: PopupOptions = {}) {
  return (
    <SlashCommandAutocomplete
      currentInput={input}
      cursorPosition={input.length}
      onSelect={options.onSelect}
      onAutocomplete={options.onAutocomplete}
      onActiveChange={options.onActiveChange}
      modCommands={options.modCommands ?? DEFAULT_MODS}
    />
  );
}

function mountPopup(input: string, options: PopupOptions = {}): InkTty {
  return mountInkTty(popupElement(input, options), {
    columns: 100,
    rows: 40,
  });
}

async function frame(
  input: string,
  modCommands: Record<string, ModCommandAutocompleteItem> = DEFAULT_MODS,
): Promise<string[]> {
  const tty = mountPopup(input, { modCommands });
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
   * The mouse half of the popup (《38》§19.1, the P2 row): a click is that row's
   * *accept*, and under R-02.4 accept is the fill half of Tab — it never
   * executes. Judged on the frame for the geometry and on the callback for the
   * action: the popup sits in the bottom chrome, so its rows are screen rows and
   * the test's coordinates are the ones the terminal would report. What the frame
   * cannot see is the hover *colour* (the test process has no colour), so the
   * store is read — which is the half a move writes.
   */
  const pressAt = (column: number, row: number) =>
    `${ESCAPE}[<0;${column};${row}M`;
  const releaseAt = (column: number, row: number) =>
    `${ESCAPE}[<0;${column};${row}m`;
  const moveTo = (column: number, row: number) =>
    `${ESCAPE}[<35;${column};${row}M`;

  function mountPointer(
    input: string,
    modCommands: Record<string, ModCommandAutocompleteItem>,
  ): { filled: string[]; tty: InkTty } {
    const filled: string[] = [];
    const tty = mountPopup(input, {
      modCommands,
      onAutocomplete: (value) => {
        filled.push(value);
      },
    });
    return { filled, tty };
  }

  test("a click on a row fills that row's word instead of running it", async () => {
    const { filled, tty } = mountPointer("/zmod", MANY);
    try {
      await settle();
      // Screen row 2 is the second row of the popup, whose first row is row 1.
      await tty.press(pressAt(4, 2), releaseAt(4, 2));
      // Accept is Tab's fill: the word plus the separating space that opens the
      // next level (`fillCompletion`).
      expect(filled).toEqual(["/zmod-02 "]);
    } finally {
      tty.stop();
    }
  });

  test("a click lands on the row the window is showing, not on its screen number", async () => {
    const { filled, tty } = mountPointer("/zmod", MANY);
    try {
      await settle();
      // Eight steps put the cursor on the fifth fixture and slide the window to
      // `zmod-05`…, which is what the frame already pins. The first screen row is
      // therefore list row 4, and clicking it must fill *that* command.
      for (let step = 0; step < 8; step += 1) {
        await tty.press(DOWN);
        await settle(40);
      }
      const rows = await tty.rows();
      expect(rows[0]).toStartWith("  /zmod-05");

      await tty.press(pressAt(4, 1), releaseAt(4, 1));
      expect(filled).toEqual(["/zmod-05 "]);
    } finally {
      tty.stop();
    }
  });

  test("the footer and the space around the rows are not rows", async () => {
    const { filled, tty } = mountPointer("/zmod", MANY);
    try {
      await settle();
      // Row 9 is `↓ 4 more below`, which is not a command.
      await tty.press(pressAt(4, 9), releaseAt(4, 9));
      expect(filled).toEqual([]);
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

  test("no candidates hides the popup instead of collapsing to a message", async () => {
    // R-02.3: a level with nothing to offer draws nothing. `/zzz` is not a
    // command, and the composer's Enter still sends it as ordinary input — the
    // popup must not stand in the way with a "no matches" row.
    expect(await frame("/zzz")).toEqual([]);
    expect(await frame("/dream zzz")).toEqual([]);
  });

  test("a finished command or ordinary text draws no popup", async () => {
    // A free-form command has no structured next level; text that never began
    // with `/` has nothing to complete.
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
    const tty = mountPopup("/zmod", { modCommands: MANY });
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

  test("a narrow terminal truncates the hint and the description instead of wrapping", async () => {
    // One screen line per candidate is the popup's contract; on a narrow
    // terminal the argument placeholder and the description have to share what
    // is left, not push the row onto a second line (which would move the footer
    // under the cursor).
    const tty = mountInkTty(popupElement("/dream "), { columns: 40, rows: 24 });
    try {
      await settle();
      const rows = await tty.rows();
      expect(rows).toHaveLength(7);
      for (const row of rows) {
        expect(row.length).toBeLessThanOrEqual(40);
      }
      expect(rows[0]).toStartWith("  status");
    } finally {
      tty.stop();
    }
  });
});

describe("levels and filtering (R-02.3)", () => {
  test("a space switches to the next level and shows the argument placeholder", async () => {
    // `/dream ` has seven rows. `run` carries its syntax hint (`[--budget
    // <tokens>]`) dim between the name and the description; the hint is part of
    // the row, never a candidate of its own.
    expect(await frame("/dream ")).toEqual([
      "  status         Show dream settings, recent runs and ledger spend",
      "  run            [--budget <tokens>] Start one dream run now (respects the configured budget)",
      "  config         Open the Dream section of the Settings page",
      "  on             Enable dream and finish first-run setup",
      "  off            Disable dream",
      "  note           <text> Queue a note the next dream run reads first",
      "  notes          [clear] List the queued dream notes",
    ]);
  });

  test("a third level lists the children of the settled word", async () => {
    // `/dream note ` is the reserved `note remove` path, so the only candidate is
    // its child; `remove`'s own `<id>` placeholder rides on the row.
    expect(await frame("/dream note ")).toEqual([
      "  remove         <id> Remove a queued dream note",
    ]);
  });

  test("a hub's second level comes from the shared table, not a copy", async () => {
    // `/agent ` has twelve subcommands: eight rows and the scroll footer. The
    // table is `HUBS`, which the dispatch rewrites also read.
    const rows = await frame("/agent ");
    expect(rows.slice(0, 8)).toEqual([
      "  list           Browse agents",
      "  pin            [name] Pin this agent",
      "  unpin          Unpin this agent",
      "  pinned         Browse pinned agents",
      "  rename         <name> Rename this agent",
      "  describe       <text> Set this agent's description",
      "  system         Switch system prompt",
      "  personality    Switch personality",
    ]);
    expect(rows).toHaveLength(9);
    expect(rows[8]).toMatch(MORE_BELOW);
  });

  test("an enumerated argument shows its value and the subcommand's explanation", async () => {
    // `/agent profile ` is a closed enum. The options carry no description in
    // the spec table (they are bare strings), so each row borrows the parent
    // subcommand's one line — the value is the row's name, the explanation is
    // what the enum controls.
    expect(await frame("/agent profile ")).toEqual([
      "  save           Save, load or delete a local agent profile",
      "  load           Save, load or delete a local agent profile",
      "  delete         Save, load or delete a local agent profile",
      "  usage          Save, load or delete a local agent profile",
    ]);
    expect(await frame("/schedule autostart ")).toEqual([
      "  on             OS autostart (wakes a short-lived host every minute)",
      "  off            OS autostart (wakes a short-lived host every minute)",
      "  status         OS autostart (wakes a short-lived host every minute)",
    ]);
  });

  test("levels 2 and 3 filter by prefix, level 1 keeps includes", async () => {
    // Level 1 keeps the historical `includes` match: `drea` finds `/dream`.
    const level1 = await frame("/drea");
    expect(level1).toHaveLength(1);
    expect(level1[0]).toStartWith("  /dream");

    // Level 2 is prefix: `pi` finds `pin` and `pinned` but not `unpin`, which
    // merely *contains* it.
    expect(await frame("/agent pi")).toEqual([
      "  pin            [name] Pin this agent",
      "  pinned         Browse pinned agents",
    ]);
    expect(await frame("/dream st")).toEqual([
      "  status         Show dream settings, recent runs and ledger spend",
    ]);
  });
});

describe("Enter, Tab and Esc (R-02.3/R-02.4, Q-46)", () => {
  test("a complete command executes on one Enter", async () => {
    const selected: string[] = [];
    const filled: string[] = [];
    const tty = mountPopup("/model", {
      onSelect: (value) => selected.push(value),
      onAutocomplete: (value) => filled.push(value),
    });
    try {
      await settle();
      await tty.press("\r");
      // The highlighted candidate is already typed, so filling would change
      // nothing and Enter falls through to execution with the whole draft.
      expect(selected).toEqual(["/model"]);
      expect(filled).toEqual([]);
    } finally {
      tty.stop();
    }
  });

  test("half a command costs two Enters: fill, then execute", async () => {
    const selected: string[] = [];
    const filled: string[] = [];
    const tty = mountPopup("/dream no", {
      onSelect: (value) => selected.push(value),
      onAutocomplete: (value) => filled.push(value),
    });
    try {
      await settle();
      await tty.press("\r");
      // First Enter only fills the word, without the separating space, so the
      // same candidate stays highlighted and the second Enter sees it typed.
      expect(filled).toEqual(["/dream note"]);
      expect(selected).toEqual([]);

      await tty.rerender(
        popupElement("/dream note", {
          onSelect: (value) => selected.push(value),
          onAutocomplete: (value) => filled.push(value),
        }),
      );
      await settle(60);
      await tty.press("\r");
      expect(selected).toEqual(["/dream note"]);
      expect(filled).toEqual(["/dream note"]);
    } finally {
      tty.stop();
    }
  });

  test("Tab fills the word and the space that opens the next level", async () => {
    const filled: string[] = [];
    const tty = mountPopup("/dream no", {
      onAutocomplete: (value) => filled.push(value),
    });
    try {
      await settle();
      await tty.press("\t");
      expect(filled).toEqual(["/dream note "]);

      await tty.rerender(
        popupElement("/dream note ", {
          onAutocomplete: (value) => filled.push(value),
        }),
      );
      await settle(60);
      // The popup is still up, now at the third level.
      expect(await tty.rows()).toEqual([
        "  remove         <id> Remove a queued dream note",
      ]);
    } finally {
      tty.stop();
    }
  });

  test("Tab at the last level fills and the popup closes", async () => {
    const filled: string[] = [];
    const tty = mountPopup("/schedule list", {
      onAutocomplete: (value) => filled.push(value),
    });
    try {
      await settle();
      await tty.press("\t");
      // `list` takes free text, so the next level has no candidates and the
      // popup collapses by itself after the fill.
      expect(filled).toEqual(["/schedule list "]);
      await tty.rerender(
        popupElement("/schedule list ", {
          onAutocomplete: (value) => filled.push(value),
        }),
      );
      await settle(60);
      expect(await tty.rows()).toEqual([]);
    } finally {
      tty.stop();
    }
  });

  test("Enter with no popup does nothing and leaves the composer its key", async () => {
    const selected: string[] = [];
    const filled: string[] = [];
    const tty = mountPopup("/model ", {
      onSelect: (value) => selected.push(value),
      onAutocomplete: (value) => filled.push(value),
    });
    try {
      await settle();
      await tty.press("\r");
      expect(selected).toEqual([]);
      expect(filled).toEqual([]);
    } finally {
      tty.stop();
    }
  });
});

/**
 * The composer's interrupt, as a probe: a second `app`-scope table standing in
 * for the one `InputRich` registers. The popup's claim must keep it away from
 * Esc while rows are up, and give it back when they are gone.
 */
function InterruptProbe({
  onInterrupt,
  children,
}: {
  onInterrupt: () => void;
  children: ReactElement;
}) {
  useKeyBindings("interrupt-probe", [
    {
      scope: "app",
      bindings: [
        {
          id: "probe.interrupt",
          chords: [{ key: "escape" }],
          run: () => {
            onInterrupt();
            return "consumed";
          },
        },
      ],
    },
  ]);
  return children;
}

describe("Esc (R-02.3, 47-2 §1.2)", () => {
  test("Esc closes the popup before the composer's interrupt runs", async () => {
    const active: boolean[] = [];
    const interrupts: string[] = [];
    const tty = mountInkTty(
      <InterruptProbe onInterrupt={() => interrupts.push("interrupt")}>
        {popupElement("/dream ", {
          onActiveChange: (isActive) => active.push(isActive),
        })}
      </InterruptProbe>,
      { columns: 100, rows: 40 },
    );
    try {
      await settle();
      expect(active).toEqual([true]);

      await tty.press(ESCAPE);
      await settle(60);
      // Closed, not executed: the frame is empty and the interrupt never ran.
      expect(await tty.rows()).toEqual([]);
      expect(interrupts).toEqual([]);
      expect(active).toEqual([true, false]);

      // The next keystroke that changes the draft reopens the popup.
      await tty.rerender(
        <InterruptProbe onInterrupt={() => interrupts.push("interrupt")}>
          {popupElement("/dream s", {
            onActiveChange: (isActive) => active.push(isActive),
          })}
        </InterruptProbe>,
      );
      await settle(60);
      expect(await tty.rows()).toEqual([
        "  status         Show dream settings, recent runs and ledger spend",
      ]);
    } finally {
      tty.stop();
    }
  });

  test("with no popup Esc keeps its ordinary app meaning", async () => {
    const interrupts: string[] = [];
    const tty = mountInkTty(
      <InterruptProbe onInterrupt={() => interrupts.push("interrupt")}>
        {popupElement("/model ", {})}
      </InterruptProbe>,
      { columns: 100, rows: 40 },
    );
    try {
      await settle();
      await tty.press(ESCAPE);
      expect(interrupts).toEqual(["interrupt"]);
    } finally {
      tty.stop();
    }
  });
});

describe("mergeCommandList (custom / skill / mod precedence)", () => {
  function command(name: string, order = 100): CommandMatch {
    return { cmd: `/${name}`, desc: `${name} desc`, order };
  }

  test("a custom command hides the builtin of the same name", () => {
    const merged = mergeCommandList(
      {
        builtin: [command("review"), command("model")],
        custom: [{ ...command("review"), desc: "custom review" }],
        skill: [],
        mod: [],
      },
      { fullScreen: true },
    );
    expect(merged.map((entry) => entry.cmd)).toEqual(["/model", "/review"]);
    expect(merged[1]?.desc).toBe("custom review");
  });

  test("a mod command hides the builtin and a custom command beats a mod", () => {
    const merged = mergeCommandList(
      {
        builtin: [command("deploy")],
        custom: [command("deploy")],
        skill: [],
        mod: [command("deploy")],
      },
      { fullScreen: true },
    );
    expect(merged).toEqual([command("deploy")]);
  });

  test("a skill yields to any command of the same name", () => {
    const merged = mergeCommandList(
      {
        builtin: [],
        custom: [command("review")],
        skill: [command("review"), command("dream")],
        mod: [],
      },
      { fullScreen: true },
    );
    expect(merged.map((entry) => entry.cmd)).toEqual(["/review", "/dream"]);
    expect(merged[0]?.order).toBe(100);
    expect(merged[1]?.order).toBe(100);
  });

  test("legacy hides the full-screen-only commands and keeps the rest ordered", () => {
    const merged = mergeCommandList(
      {
        builtin: [
          command("tabs", 10),
          command("model", 20),
          command("usage", 30),
        ],
        custom: [],
        skill: [],
        mod: [],
      },
      { fullScreen: false },
    );
    expect(merged.map((entry) => entry.cmd)).toEqual(["/model"]);
  });
});
