import { afterEach, describe, expect, test } from "bun:test";
import { Box, Text } from "ink";
import { useEffect } from "react";
import {
  beginSelection,
  hasSelection,
  resetViewportSelectionForTests,
} from "@/cli/app/viewport-selection";
import { resetInputScopes } from "@/cli/helpers/focus-ledger";
import { resetBindingOwners } from "@/cli/helpers/input-router";
import {
  registerMouseHandler,
  resetMouseHandlers,
} from "@/cli/helpers/mouse-router";
import {
  useInputRouter,
  useInputScopeClaim,
} from "@/cli/hooks/use-input-router";
import { mountInkTty, resetInkTtyState } from "@/test-utils/ink-tty";
import type { TabStripRegion } from "./tab-strip-layout";
import { useChromeClicks } from "./use-chrome-clicks";

/**
 * The strip's mouse path, driven through the **real** router and the **real**
 * report parser.
 *
 * Three claims can only be judged here: a press and release on the tab row is a
 * click and resolves to the rectangle the strip drew; a drag is not a click; and
 * the two blocking rules hold — an overlay that owns the keyboard also owns the
 * pointer, and a page's main area is not selectable text. The pure click window
 * is unit-tested in `mouse-click.test.ts`; what is left is the wiring, which is
 * exactly the layer `src/cli/AGENTS.md` warns can be perfect and do nothing.
 */

const ESC = "\u001B";

const press = (column: number, row = 1) => `${ESC}[<0;${column};${row}M`;
const release = (column: number, row = 1) => `${ESC}[<0;${column};${row}m`;
const dragTo = (column: number, row = 1) => `${ESC}[<32;${column};${row}M`;

/** The row the layout hands back for a two-tab strip, plus a fake `×`. */
const REGIONS: TabStripRegion[] = [
  { id: "conv-a", part: "name", from: 1, to: 10 },
  { id: "conv-b", part: "name", from: 12, to: 21 },
  { id: "conv-b", part: "close", from: 22, to: 23 },
];

type Harness = {
  selected: string[];
  closed: string[];
  /** Times the collapsed `+N` asked for the tab list. */
  overflow: number;
  /** Reports a later layer (the selection) would have seen. */
  late: string[];
};

function probe(harness: Harness, options: { overlay?: boolean } = {}) {
  return <Probe harness={harness} options={options} />;
}

function Probe({
  harness,
  options,
}: {
  harness: Harness;
  options: { overlay?: boolean };
}) {
  useInputRouter();
  useInputScopeClaim("overlay", options.overlay === true);
  useChromeClicks({
    regions: REGIONS,
    onSelect: (tabId) => {
      harness.selected.push(tabId);
    },
    onClose: (tabId) => {
      harness.closed.push(tabId);
    },
    onOverflow: () => {
      harness.overflow += 1;
    },
  });
  // A handler registered *after* the chrome layer, standing in for the selection:
  // it must not see the tail of a gesture the chrome layer already claimed.
  useEffect(
    () =>
      registerMouseHandler((report) => {
        harness.late.push(`${report.kind}:${report.row}:${report.column}`);
        return false;
      }),
    [harness.late],
  );
  return (
    <Box>
      <Text>probe</Text>
    </Box>
  );
}

function mount(options: { overlay?: boolean } = {}) {
  const harness: Harness = { selected: [], closed: [], late: [], overflow: 0 };
  const shell = mountInkTty(probe(harness, options), { columns: 80, rows: 24 });
  return { harness, shell };
}

afterEach(() => {
  resetInkTtyState();
  resetInputScopes();
  resetBindingOwners();
  resetMouseHandlers();
  resetViewportSelectionForTests();
});

describe("a click on the tab row", () => {
  test("a name click switches to that tab", async () => {
    const { harness, shell } = mount();
    try {
      await shell.press(press(4), release(4));
      expect(harness.selected).toEqual(["conv-a"]);
      expect(harness.closed).toEqual([]);
    } finally {
      shell.stop();
    }
  });

  test("a click on the × closes that tab, and the name is not sent", async () => {
    const { harness, shell } = mount();
    try {
      await shell.press(press(22), release(22));
      expect(harness.closed).toEqual(["conv-b"]);
      expect(harness.selected).toEqual([]);
    } finally {
      shell.stop();
    }
  });

  test("a drag that begins on a tab is neither a click nor a selection", async () => {
    const { harness, shell } = mount();
    try {
      await shell.press(press(4), dragTo(9), release(9));
      expect(harness.selected).toEqual([]);
      expect(harness.closed).toEqual([]);
      expect(hasSelection()).toBe(false);
    } finally {
      shell.stop();
    }
  });

  test("an overlay that owns the keyboard owns the pointer too", async () => {
    const { harness, shell } = mount({ overlay: true });
    try {
      await shell.press(press(4), release(4));
      expect(harness.selected).toEqual([]);
      // And the leftover selection is untouched: the click was declined, not
      // quietly turned into something else.
      beginSelection({ row: 3, column: 1 });
      expect(hasSelection()).toBe(true);
    } finally {
      shell.stop();
    }
  });

  test("a press below the tab row is left to the layer below", async () => {
    // P2 moved a page's rows onto the `page` layer, right after this one, so the
    // chrome must *decline* a press under its row instead of claiming the whole
    // band (which is what P0 did when there was nothing else to claim it).
    const { harness, shell } = mount();
    try {
      await shell.press(press(4, 5), release(4, 5));
      expect(harness.selected).toEqual([]);
      expect(harness.late.filter((seen) => seen.startsWith("press"))).toEqual([
        "press:5:4",
      ]);
    } finally {
      shell.stop();
    }
  });

  test("the release of a chrome press is not offered to the selection", async () => {
    const { harness, shell } = mount();
    try {
      // A press on the tab row released a row lower is not a click — and it is
      // still this layer's gesture, not the selection's. Handing the release on
      // would look to the selection like the end of a drag it never began.
      await shell.press(press(4, 1), release(4, 12));
      expect(harness.selected).toEqual([]);
      expect(harness.closed).toEqual([]);
      expect(harness.late.filter((seen) => seen.startsWith("release"))).toEqual(
        [],
      );
    } finally {
      shell.stop();
    }
  });
});
