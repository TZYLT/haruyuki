import { afterEach, describe, expect, test } from "bun:test";
import { useEffect } from "react";
import { resetOlderHistoryForTests } from "@/cli/app/older-history";
import { TabStrip } from "@/cli/app/shell/tab-strip";
import { TAB_STRIP_ROWS } from "@/cli/app/shell/tab-strip-layout";
import { useMouseInput } from "@/cli/app/shell/use-mouse-input";
import { useTerminalSelection } from "@/cli/app/shell/use-terminal-selection";
import { openConversationTab, resetTabsForTests } from "@/cli/app/tabs";
import { resetViewportScroll } from "@/cli/app/viewport-scroll";
import {
  getSelection,
  resetViewportSelectionForTests,
} from "@/cli/app/viewport-selection";
import {
  registerMouseHandler,
  resetMouseHandlers,
} from "@/cli/helpers/mouse-router";
import { useInputRouter } from "@/cli/hooks/use-input-router";
import { mountInkTty, resetInkTtyState } from "@/test-utils/ink-tty";

/**
 * A click on the tab row, through the shell that actually mounts the strip.
 *
 * The strip's own hook is judged in `use-chrome-clicks.test.tsx`, with nothing
 * else registered. That is not the shell: `V2Shell` also mounts the wheel layer
 * and the drag-selection layer, and the selection layer is offered every press
 * that is not a wheel notch — including a press on the tab row, where it "ends
 * the selection". So the shell-shaped test is the only one that can say whether
 * the top bar is clickable at all.
 *
 * Two shapes are pinned, both from the machine run of 2026-10-20 that reported the
 * row ignoring every click (实机 N2):
 *
 * 1. The shape a real terminal sends under `1002` — press, motion, release — not
 *    the two-report pair a synthetic test likes to send.
 * 2. The selection layer registered **before** the strip. Effect order decided
 *    this before the router had layers, so a test that mounts them in the lucky
 *    order proves nothing.
 */

const ESC = "\u001B";

const press = (column: number, row = 1) => `${ESC}[<0;${column};${row}M`;
const release = (column: number, row = 1) => `${ESC}[<0;${column};${row}m`;
const move = (column: number, row = 1) => `${ESC}[<32;${column};${row}M`;

const seen: string[] = [];

/** A content layer that claims everything, standing in for the selection. */
function ClaimingSelectionLayer() {
  useEffect(
    () =>
      registerMouseHandler(
        () => {
          seen.push("selection");
          return true;
        },
        { name: "selection" },
      ),
    [],
  );
  return null;
}

/** The shell's own hook order, with the strip's layer registered last. */
function Shell({ earlySelection }: { earlySelection: boolean }) {
  useInputRouter();
  useMouseInput();
  useTerminalSelection({ bandTopRow: TAB_STRIP_ROWS });
  return (
    <>
      {earlySelection ? <ClaimingSelectionLayer /> : null}
      <TabStrip
        onSelect={(tabId) => {
          seen.push(`select:${tabId}`);
        }}
        onClose={(tabId) => {
          seen.push(`close:${tabId}`);
        }}
        onOverflow={() => {
          seen.push("overflow");
        }}
      />
    </>
  );
}

afterEach(() => {
  seen.length = 0;
  resetTabsForTests();
  resetOlderHistoryForTests();
  resetViewportScroll();
  resetMouseHandlers();
  resetViewportSelectionForTests();
  resetInkTtyState();
});

describe("the tab row inside the shell", () => {
  test("a click on a tab's name reaches the strip", async () => {
    openConversationTab("conv-1", "M6 shell");
    openConversationTab("conv-2", "Ledger");
    const shell = mountInkTty(<Shell earlySelection={false} />, {
      columns: 100,
      rows: 24,
    });
    try {
      const rows = await shell.rows();
      const column = (rows[0]?.indexOf("M6 shell") ?? -1) + 2;
      expect(column).toBeGreaterThan(1);
      await shell.press(press(column), release(column));
      expect(seen).toEqual(["select:conv-1"]);
    } finally {
      shell.stop();
    }
  });

  test("the click a real terminal sends — with motion in the middle — still lands", async () => {
    openConversationTab("conv-1", "M6 shell");
    openConversationTab("conv-2", "Ledger");
    const shell = mountInkTty(<Shell earlySelection={false} />, {
      columns: 100,
      rows: 24,
    });
    try {
      const rows = await shell.rows();
      const column = (rows[0]?.indexOf("M6 shell") ?? -1) + 2;
      // `1002` reports motion while the button is held, even inside one cell.
      await shell.press(press(column), move(column), move(column + 1));
      await shell.press(release(column + 1));
      expect(seen).toEqual(["select:conv-1"]);
    } finally {
      shell.stop();
    }
  });

  test("a drag from the tab row selects nothing and switches nothing", async () => {
    openConversationTab("conv-1", "M6 shell");
    openConversationTab("conv-2", "Ledger");
    const shell = mountInkTty(<Shell earlySelection={false} />, {
      columns: 100,
      rows: 24,
    });
    try {
      const rows = await shell.rows();
      const column = (rows[0]?.indexOf("M6 shell") ?? -1) + 2;
      await shell.press(
        press(column),
        move(column + 6, 8),
        release(column + 6, 8),
      );
      expect(seen).toEqual([]);
      expect(getSelection()).toBeNull();
    } finally {
      shell.stop();
    }
  });

  test("a selection layer registered first cannot swallow the click", async () => {
    openConversationTab("conv-1", "M6 shell");
    openConversationTab("conv-2", "Ledger");
    const shell = mountInkTty(<Shell earlySelection={true} />, {
      columns: 100,
      rows: 24,
    });
    try {
      const rows = await shell.rows();
      const column = (rows[0]?.indexOf("M6 shell") ?? -1) + 2;
      await shell.press(press(column), release(column));
      // Chrome is consulted first whatever the registration order, so the
      // claiming layer never sees the gesture.
      expect(seen).toEqual(["select:conv-1"]);
    } finally {
      shell.stop();
    }
  });
});
