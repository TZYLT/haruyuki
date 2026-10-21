import { afterEach, describe, expect, test } from "bun:test";
import {
  focusTab,
  openConversationTab,
  resetTabsForTests,
} from "@/cli/app/tabs";
import type { TabStripProjection } from "@/cli/app/types";
import { TabsOverlay } from "@/cli/components/TabsOverlay";
import { resetInputScopes } from "@/cli/helpers/focus-ledger";
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
