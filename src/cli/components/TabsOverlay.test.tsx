import { afterEach, describe, expect, test } from "bun:test";
import {
  focusTab,
  openConversationTab,
  pageTabs,
  resetTabsForTests,
} from "@/cli/app/tabs";
import type { TabStripProjection } from "@/cli/app/types";
import { TabsOverlay } from "@/cli/components/TabsOverlay";
import { resetInputScopes } from "@/cli/helpers/focus-ledger";
import { getHoverTarget, resetHoverForTests } from "@/cli/helpers/hover-store";
import { resetBindingOwners } from "@/cli/helpers/input-router";
import { resetMouseHandlers } from "@/cli/helpers/mouse-router";
import { resetMouseTrackingForTests } from "@/cli/helpers/mouse-tracking";
import { mountInkTty, resetInkTtyState } from "@/test-utils/ink-tty";

/**
 * `/tabs`: the keyboard's door to the strip.
 *
 * Three claims: it lists what the strip draws (conversations in open order, then
 * the two pages), `Enter` does what clicking a tab does and dismisses, and `D`
 * closes the tab under the cursor *and stays open* — closing several tabs is one
 * command. All three are judged on the frame, because a list that renders nothing
 * and a list whose keys go nowhere look identical from state.
 */
type Harness = {
  selected: string[];
  closed: string[];
  dismissed: number;
};

function actions(harness: Harness): TabStripProjection {
  return {
    onSelect: (tabId) => {
      harness.selected.push(tabId);
    },
    onClose: (tabId) => {
      harness.closed.push(tabId);
    },
    onOverflow: () => {},
  };
}

function mount(): { harness: Harness; tty: ReturnType<typeof mountInkTty> } {
  const harness: Harness = { selected: [], closed: [], dismissed: 0 };
  const tty = mountInkTty(
    <TabsOverlay
      actions={actions(harness)}
      onDismiss={() => {
        harness.dismissed += 1;
      }}
    />,
    { columns: 60, rows: 24 },
  );
  return { harness, tty };
}

afterEach(() => {
  resetTabsForTests();
  resetInkTtyState();
  resetBindingOwners();
  resetMouseHandlers();
  resetMouseTrackingForTests();
  resetHoverForTests();
  resetInputScopes();
});

describe("the /tabs face", () => {
  test("lists the conversations in open order, then the pages", async () => {
    openConversationTab("conv-1", "M6 shell");
    openConversationTab("conv-2", "Ledger work");
    const { tty } = mount();
    try {
      const rows = await tty.rows();
      const text = rows.join("\n");
      expect(text).toContain("/tabs");
      expect(text).toContain("M6 shell");
      expect(text).toContain("Ledger work");
      expect(text).toContain("Usage");
      expect(text).toContain("Settings");
      // The active tab is marked, and the cursor starts on it.
      expect(text).toContain("Ledger work (current)");
      expect(rows.find((row) => row.includes("Ledger work"))).toStartWith("> ");
    } finally {
      tty.stop();
    }
  });

  test("the overview page is spelled Agents, while the strip's own label stays + (C-14)", async () => {
    openConversationTab("conv-1", "M6 shell");
    const { harness, tty } = mount();
    try {
      const rows = await tty.rows();
      const text = rows.join("\n");
      // C-14: a lone `+` in a list of words reads as "add", so the face names
      // the destination. The strip keeps drawing `+` — that symbol is the door.
      expect(text).toContain("Agents");
      expect(rows.some((row) => row.includes("+"))).toBe(false);
      expect(pageTabs()[0]?.title).toBe("+");

      // The row still targets the overview tab: ↓ from `conv-1`, then Enter.
      await tty.press("\u001B[B");
      await tty.press("\r");
      expect(harness.selected).toEqual(["overview"]);
      expect(harness.dismissed).toBe(1);
    } finally {
      tty.stop();
    }
  });

  test("Enter switches to the row under the cursor and dismisses", async () => {
    openConversationTab("conv-1", "M6 shell");
    openConversationTab("conv-2", "Ledger work");
    const { harness, tty } = mount();
    try {
      // The cursor starts on the active tab (the last opened); one row up is the
      // first conversation.
      await tty.press("\u001B[A");
      await tty.press("\r");
      expect(harness.selected).toEqual(["conv-1"]);
      expect(harness.dismissed).toBe(1);
      expect(harness.closed).toEqual([]);
    } finally {
      tty.stop();
    }
  });

  test("D closes the tab under the cursor and leaves the list up", async () => {
    openConversationTab("conv-1", "M6 shell");
    openConversationTab("conv-2", "Ledger work");
    const { harness, tty } = mount();
    try {
      await tty.press("d");
      expect(harness.closed).toEqual(["conv-2"]);
      // Still up: closing several is one command.
      expect(harness.dismissed).toBe(0);
    } finally {
      tty.stop();
    }
  });

  test("a page row has no close", async () => {
    openConversationTab("conv-1", "M6 shell");
    focusTab("settings");
    const { harness, tty } = mount();
    try {
      // The cursor starts on `Settings`, a fixed page tab.
      await tty.press("d");
      expect(harness.closed).toEqual([]);
      expect(harness.dismissed).toBe(0);
    } finally {
      tty.stop();
    }
  });

  test("Escape dismisses without touching a tab", async () => {
    openConversationTab("conv-1", "M6 shell");
    const { harness, tty } = mount();
    try {
      await tty.press("\u001B");
      expect(harness.dismissed).toBe(1);
      expect(harness.selected).toEqual([]);
      expect(harness.closed).toEqual([]);
    } finally {
      tty.stop();
    }
  });
});

// --- The pointer, through the shared seam ----------------------------------
//
// This face used to wire `useMouseRows` and its own hover subscription; the row
// hit test and the click=Enter rule now come from `OverlayListView`, so these
// tests are the regression that the dedupe kept the behaviour. The list starts on
// screen row 6 (the frame draws `/tabs`, the rule, the title and their blanks
// above it): `conv-1`, `conv-2`, `Agents` (the overview page's row), `Usage`,
// `Settings` are rows 6-10.

const ESC = "\u001B";
/** A left press / release at a cell (1-based screen coordinates). */
const pressAt = (column: number, row: number) => `${ESC}[<0;${column};${row}M`;
const releaseAt = (column: number, row: number) =>
  `${ESC}[<0;${column};${row}m`;
/** Any-motion (`1003`): the pointer moved, no button down. */
const moveTo = (column: number, row: number) => `${ESC}[<35;${column};${row}M`;
/** A wheel notch: 64 = up, 65 = down. */
const wheelAt = (direction: "up" | "down", column: number, row: number) =>
  `${ESC}[<${direction === "up" ? 64 : 65};${column};${row}M`;

describe("the /tabs face answers the pointer", () => {
  test("a click is that row's Enter: switch and dismiss", async () => {
    openConversationTab("conv-1", "M6 shell");
    openConversationTab("conv-2", "Ledger work");
    const { harness, tty } = mount();
    try {
      // Screen row 6 is `conv-1`; the cursor starts on the active `conv-2`.
      await tty.press(pressAt(3, 6), releaseAt(3, 6));
      expect(harness.selected).toEqual(["conv-1"]);
      expect(harness.dismissed).toBe(1);
      expect(harness.closed).toEqual([]);
    } finally {
      tty.stop();
    }
  });

  test("a click on the current tab only dismisses", async () => {
    openConversationTab("conv-1", "M6 shell");
    openConversationTab("conv-2", "Ledger work");
    const { harness, tty } = mount();
    try {
      await tty.press(pressAt(3, 7), releaseAt(3, 7));
      expect(harness.selected).toEqual([]);
      expect(harness.dismissed).toBe(1);
    } finally {
      tty.stop();
    }
  });

  test("hover lights the row under the pointer, including a page tab", async () => {
    openConversationTab("conv-1", "M6 shell");
    const { tty } = mount();
    try {
      await tty.press(moveTo(3, 6));
      expect(getHoverTarget()?.index).toBe(0);
      // `Settings` (screen row 9) is a page tab: same rule, no exception.
      await tty.press(moveTo(3, 9));
      expect(getHoverTarget()?.index).toBe(3);
      await tty.press(moveTo(3, 12));
      expect(getHoverTarget()).toBeNull();
    } finally {
      tty.stop();
    }
  });

  test("a wheel notch moves the cursor one row", async () => {
    openConversationTab("conv-1", "M6 shell");
    openConversationTab("conv-2", "Ledger work");
    const { tty } = mount();
    try {
      // The cursor starts on `conv-2` (row 7); one notch up is `conv-1`.
      await tty.press(wheelAt("up", 3, 7));
      const rows = await tty.rows();
      const cursorRow = rows.find(
        (row) => row.startsWith("> ") && !row.startsWith("> /"),
      );
      expect(cursorRow).toContain("M6 shell");
    } finally {
      tty.stop();
    }
  });

  test("a click on a page tab selects it, still without closing anything", async () => {
    openConversationTab("conv-1", "M6 shell");
    const { harness, tty } = mount();
    try {
      await tty.press(pressAt(3, 9), releaseAt(3, 9));
      expect(harness.selected).toEqual(["settings"]);
      expect(harness.dismissed).toBe(1);
      expect(harness.closed).toEqual([]);
    } finally {
      tty.stop();
    }
  });
});
