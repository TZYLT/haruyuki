import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { Readable, Writable } from "node:stream";
import { render, Text } from "ink";
import type { ReactElement } from "react";
import { resetInputScopes } from "@/cli/helpers/focus-ledger";
import { resetBindingOwners } from "@/cli/helpers/input-router";
import {
  getTerminalFrame,
  installTerminalFrameCapture,
  resetTerminalFrameForTests,
} from "@/cli/helpers/terminal-frame";
import {
  type MultiSelectItem,
  MultiSelectPicker,
  type SingleSelectItem,
  SingleSelectPicker,
} from "@/cli/overlay/adapters";

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

class CaptureStream extends Writable {
  columns = 80;
  rows = 24;
  isTTY = true;

  override _write(
    _chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    callback();
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

const DOWN = "\u001B[B";
const UP = "\u001B[A";
const RIGHT = "\u001B[C";
const ENTER = "\r";
const SPACE = " ";
const ESCAPE = "\u001B";
const CTRL_C = "\u0003";

/**
 * Pin the terminal size: the multi-select sizes its label box as
 * `columns - 6`, so a test that did not know the width would be asserting
 * against whatever the runner happened to report.
 */
function forceTerminalSize(columns: number, rows: number): () => void {
  const saved = {
    rows: Object.getOwnPropertyDescriptor(process.stdout, "rows"),
    columns: Object.getOwnPropertyDescriptor(process.stdout, "columns"),
  };
  Object.defineProperty(process.stdout, "columns", {
    configurable: true,
    value: columns,
  });
  Object.defineProperty(process.stdout, "rows", {
    configurable: true,
    value: rows,
  });
  return () => {
    for (const key of ["rows", "columns"] as const) {
      const descriptor = saved[key];
      if (descriptor) {
        Object.defineProperty(process.stdout, key, descriptor);
      } else {
        delete (process.stdout as { rows?: number; columns?: number })[key];
      }
    }
  };
}

function mount(element: ReactElement) {
  const stdout = new CaptureStream() as unknown as NodeJS.WriteStream;
  const release = installTerminalFrameCapture(stdout);
  const stdin = new Readable({ read() {} }) as NodeJS.ReadStream;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;

  const instance = render(element, {
    stdin,
    stdout,
    debug: false,
    patchConsole: false,
    exitOnCtrlC: false,
  });

  return {
    /** The rows painted, with the frame's unused trailing rows dropped. */
    async rows(): Promise<string[]> {
      await tick();
      const rows = [...(getTerminalFrame()?.text ?? [])];
      while (rows.length > 0 && rows.at(-1) === "") rows.pop();
      return rows;
    },
    async press(...keys: string[]) {
      for (const key of keys) {
        stdin.push(key);
        await tick();
      }
    },
    stop() {
      instance.unmount();
      instance.cleanup();
      release();
    },
  };
}

/** The row the cursor bar is on, or "" when nothing is highlighted. */
async function cursorRow(
  picker: ReturnType<typeof mount>,
  marker: string,
): Promise<string> {
  const rows = await picker.rows();
  return rows.find((row) => row.startsWith(marker)) ?? "";
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

let restoreTerminalSize: () => void;

beforeAll(() => {
  restoreTerminalSize = forceTerminalSize(80, 24);
});

afterAll(() => {
  restoreTerminalSize();
});

afterEach(() => {
  resetInputScopes();
  resetBindingOwners();
  resetTerminalFrameForTests();
});

describe("SingleSelectPicker", () => {
  test("paints the rows, the cursor and the default hint", async () => {
    const picker = mount(
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
    const picker = mount(
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
    const picker = mount(
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

  test("a disabled row confirms nothing", async () => {
    const selected: string[] = [];
    const picker = mount(
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
    const picker = mount(
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
    const picker = mount(
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
    const picker = mount(
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

  test("hands a key it does not use to onUnhandledKey, and still lets it travel", async () => {
    const forwarded: string[] = [];
    const picker = mount(
      <SingleSelectPicker
        items={SINGLE}
        onSelect={() => {}}
        onCancel={() => {}}
        onUnhandledKey={(_input, key) => forwarded.push(key.tab ? "tab" : "?")}
      />,
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
    const picker = mount(
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
    const picker = mount(
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
    const picker = mount(
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
    const picker = mount(
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
    const picker = mount(
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
    const ordered = mount(
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

    const plain = mount(
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
