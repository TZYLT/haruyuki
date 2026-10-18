import { afterEach, describe, expect, test } from "bun:test";
import { Text, useInput } from "ink";
import {
  type MultiSelectItem,
  MultiSelectPicker,
  type SingleSelectItem,
  SingleSelectPicker,
} from "@/cli/overlay/adapters";
import {
  type InkTty,
  mountInkTty,
  resetInkTtyState,
} from "@/test-utils/ink-tty";

/**
 * The two pickers, rewritten onto the toolkit, judged on the rendered frame.
 *
 * They are the batch that must not be visible: eight components use them, so the
 * assertions here are about what a user would see and press — the rows, the
 * cursor bar, the footer, and where a key lands — rather than about the shapes
 * the toolkit happens to expose. The mount tests that already existed for
 * `/compact` and `/topic` cover the wrapping and the string-footer crash; these
 * cover the key paths and the multi-select's own quirks.
 */

const DOWN = "\u001B[B";
const UP = "\u001B[A";
const RIGHT = "\u001B[C";
const ENTER = "\r";
const SPACE = " ";
const ESCAPE = "\u001B";
const CTRL_C = "\u0003";

/** The row the cursor bar is on, or "" when nothing is highlighted. */
async function cursorRow(tty: InkTty, marker: string): Promise<string> {
  return (await tty.rows()).find((row) => row.startsWith(marker)) ?? "";
}

const SINGLE: SingleSelectItem[] = [
  { key: "a", label: "Alpha", description: "first" },
  { key: "b", label: "Beta" },
  { key: "c", label: "Gamma", disabled: true },
];

const MULTI: MultiSelectItem[] = [
  { key: "a", label: "Alpha", description: "first" },
  { key: "b", label: "Beta", description: "second" },
  { key: "c", label: "Gamma", description: "third" },
];

afterEach(resetInkTtyState);

describe("SingleSelectPicker", () => {
  test("paints the rows, the cursor and the default hint", async () => {
    const picker = mountInkTty(
      <SingleSelectPicker
        items={SINGLE}
        onSelect={() => {}}
        onCancel={() => {}}
      />,
    );
    try {
      const rows = await picker.rows();
      expect(rows[0]).toBe("> Alpha · first");
      expect(rows[1]).toBe("  Beta");
      expect(rows[2]).toBe("  Gamma");
      expect(rows.join("\n")).toContain(
        "Enter select · ↑↓/jk navigate · Esc cancel",
      );
    } finally {
      picker.stop();
    }
  });

  test("j/k and the arrows move the cursor", async () => {
    const picker = mountInkTty(
      <SingleSelectPicker
        items={SINGLE}
        onSelect={() => {}}
        onCancel={() => {}}
      />,
    );
    try {
      await picker.press("j");
      expect(await cursorRow(picker, "> ")).toContain("Beta");
      await picker.press("j");
      expect(await cursorRow(picker, "> ")).toContain("Gamma");
      await picker.press("k");
      expect(await cursorRow(picker, "> ")).toContain("Beta");
      await picker.press(DOWN);
      expect(await cursorRow(picker, "> ")).toContain("Gamma");
      await picker.press(UP);
      expect(await cursorRow(picker, "> ")).toContain("Beta");
    } finally {
      picker.stop();
    }
  });

  test("Enter selects under the cursor, Escape and Ctrl+C cancel", async () => {
    const selected: string[] = [];
    let cancelled = 0;
    const picker = mountInkTty(
      <SingleSelectPicker
        items={SINGLE}
        onSelect={(key) => selected.push(key)}
        onCancel={() => {
          cancelled += 1;
        }}
      />,
    );
    try {
      await picker.press("j", ENTER);
      expect(selected).toEqual(["b"]);

      await picker.press(ESCAPE);
      await picker.press(CTRL_C);
      expect(cancelled).toBe(2);
    } finally {
      picker.stop();
    }
  });

  test("Shift+Enter confirms, the way the picker read `key.return`", async () => {
    // A kitty-protocol terminal sends Shift+Enter as CSI-u, so the event arrives
    // as `return` with `shift` — a different chord under the strict reading, and
    // the picker this replaced tested `if (key.return)` without looking at it.
    const selected: string[] = [];
    const picker = mountInkTty(
      <SingleSelectPicker
        items={SINGLE}
        onSelect={(key) => selected.push(key)}
        onCancel={() => {}}
      />,
    );
    try {
      await picker.press("\u001b[13;2u");
      expect(selected).toEqual(["a"]);
    } finally {
      picker.stop();
    }
  });

  test("a disabled row confirms nothing", async () => {
    const selected: string[] = [];
    const picker = mountInkTty(
      <SingleSelectPicker
        items={SINGLE}
        onSelect={(key) => selected.push(key)}
        onCancel={() => {}}
      />,
    );
    try {
      await picker.press(DOWN, DOWN, ENTER);
      expect(await cursorRow(picker, "> ")).toContain("Gamma");
      expect(selected).toEqual([]);
    } finally {
      picker.stop();
    }
  });

  test("initialCursorIndex decides where the cursor starts", async () => {
    const picker = mountInkTty(
      <SingleSelectPicker
        items={SINGLE}
        initialCursorIndex={1}
        onSelect={() => {}}
        onCancel={() => {}}
      />,
    );
    try {
      expect(await cursorRow(picker, "> ")).toContain("Beta");
    } finally {
      picker.stop();
    }
  });

  test("renderItem takes the row over, with the index in the whole list", async () => {
    const seen: number[] = [];
    const picker = mountInkTty(
      <SingleSelectPicker
        items={SINGLE}
        onSelect={() => {}}
        onCancel={() => {}}
        renderItem={(item, index, isSelected) => {
          seen.push(index);
          return (
            <Text>
              {isSelected ? "*" : "-"}
              {item.label}
            </Text>
          );
        }}
      />,
    );
    try {
      const rows = await picker.rows();
      expect(seen).toEqual([0, 1, 2]);
      expect(rows).toContain("*Alpha");
      expect(rows).toContain("-Beta");
    } finally {
      picker.stop();
    }
  });

  test("a caller's footer replaces the default hint", async () => {
    const picker = mountInkTty(
      <SingleSelectPicker
        items={SINGLE}
        onSelect={() => {}}
        onCancel={() => {}}
        footer=" Enter trim · Esc cancel"
      />,
    );
    try {
      const painted = (await picker.rows()).join("\n");
      expect(painted).toContain("Enter trim");
      expect(painted).not.toContain("↑↓/jk navigate");
    } finally {
      picker.stop();
    }
  });

  test("a key it does not use still travels past it", async () => {
    // The property is the router's, not the picker's: a key no binding consumes
    // is dispatched to the legacy `useInput` handlers. It used to be asserted
    // through the picker's `onUnhandledKey` callback — a second channel onto the
    // same keys, which no caller used — so this probe is the path a caller
    // actually takes.
    const forwarded: string[] = [];
    function LegacyProbe() {
      useInput((_input, key) => {
        if (key.tab) forwarded.push("tab");
      });
      return null;
    }

    const picker = mountInkTty(
      <>
        <SingleSelectPicker
          items={SINGLE}
          onSelect={() => {}}
          onCancel={() => {}}
        />
        <LegacyProbe />
      </>,
    );
    try {
      await picker.press("\t");
      expect(forwarded).toEqual(["tab"]);
      // The picker did not take it: the cursor is where it was.
      expect(await cursorRow(picker, "> ")).toContain("Alpha");
    } finally {
      picker.stop();
    }
  });
});

describe("MultiSelectPicker", () => {
  test("Space toggles, and Enter confirms in list order", async () => {
    const confirmed: string[][] = [];
    const picker = mountInkTty(
      <MultiSelectPicker
        items={MULTI}
        selected={new Set(["c"])}
        onConfirm={(keys) => confirmed.push(keys)}
        onCancel={() => {}}
      />,
    );
    try {
      await picker.press(SPACE);
      // The toggle happened where the user can see it.
      expect((await picker.rows()).join("")).toContain("[✓]");

      await picker.press(ENTER);
      // List order, not the order they were toggled in.
      expect(confirmed).toEqual([["a", "c"]]);
    } finally {
      picker.stop();
    }
  });

  test("a disabled row toggles nothing, and Ctrl+C cancels", async () => {
    const confirmed: string[][] = [];
    let cancelled = 0;
    const picker = mountInkTty(
      <MultiSelectPicker
        items={[
          { key: "env", label: "From env", description: "d", disabled: true },
        ]}
        selected={new Set()}
        onConfirm={(keys) => confirmed.push(keys)}
        onCancel={() => {
          cancelled += 1;
        }}
      />,
    );
    try {
      await picker.press(SPACE, ENTER);
      // Enter still confirms — with nothing selected, because the only row is
      // blocked. The picker's answer is the checkbox set, not the row, and a list
      // of blocked rows has to stay closable from the keyboard.
      expect(confirmed).toEqual([[]]);

      await picker.press(CTRL_C);
      expect(cancelled).toBe(1);
    } finally {
      picker.stop();
    }
  });

  test("←/→ reorder the item under the cursor when ordering is on", async () => {
    const confirmed: string[][] = [];
    const picker = mountInkTty(
      <MultiSelectPicker
        items={MULTI}
        selected={new Set(["a", "b", "c"])}
        onConfirm={(keys) => confirmed.push(keys)}
        onCancel={() => {}}
        enableOrdering
      />,
    );
    try {
      await picker.press(RIGHT);
      // The cursor travelled with the row it swapped.
      expect(await cursorRow(picker, "›")).toContain("Alpha");

      await picker.press(ENTER);
      expect(confirmed).toEqual([["b", "a", "c"]]);
    } finally {
      picker.stop();
    }
  });

  test("without ordering the arrows leave the order alone", async () => {
    const confirmed: string[][] = [];
    const picker = mountInkTty(
      <MultiSelectPicker
        items={MULTI}
        selected={new Set(["a", "b", "c"])}
        onConfirm={(keys) => confirmed.push(keys)}
        onCancel={() => {}}
      />,
    );
    try {
      await picker.press(RIGHT, ENTER);
      expect(confirmed).toEqual([["a", "b", "c"]]);
    } finally {
      picker.stop();
    }
  });

  test("reports the order to the caller as it changes", async () => {
    const changes: string[][] = [];
    const picker = mountInkTty(
      <MultiSelectPicker
        items={MULTI}
        selected={new Set(["a", "b", "c"])}
        onConfirm={() => {}}
        onCancel={() => {}}
        onSelectionChange={(keys) => changes.push(keys)}
      />,
    );
    try {
      await picker.press(SPACE);
      expect(changes[0]).toEqual(["a", "b", "c"]);
      expect(changes.at(-1)).toEqual(["b", "c"]);
    } finally {
      picker.stop();
    }
  });

  test("paints the preview and mentions reordering only when it is on", async () => {
    const ordered = mountInkTty(
      <MultiSelectPicker
        items={MULTI}
        selected={new Set()}
        onConfirm={() => {}}
        onCancel={() => {}}
        preview="> haruyuki · agent"
        enableOrdering
      />,
    );
    try {
      const painted = (await ordered.rows()).join("\n");
      expect(painted).toContain("> haruyuki · agent");
      // Ink wraps the hint at 80 columns, so the tail is asserted loosely.
      expect(painted).toContain("←→ to");
      expect(painted).toContain("reorder");
    } finally {
      ordered.stop();
    }

    const plain = mountInkTty(
      <MultiSelectPicker
        items={MULTI}
        selected={new Set()}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    try {
      const painted = (await plain.rows()).join("\n");
      expect(painted).toContain("Space to toggle");
      expect(painted).not.toContain("←→");
    } finally {
      plain.stop();
    }
  });
});
