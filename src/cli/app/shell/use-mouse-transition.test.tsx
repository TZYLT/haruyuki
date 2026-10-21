import { afterEach, describe, expect, test } from "bun:test";
import { Text } from "ink";
import { useEffect } from "react";
import { useMouseInput } from "@/cli/app/shell/use-mouse-input";
import {
  focusTab,
  isPageTabId,
  openConversationTab,
  resetTabsForTests,
  useTabsState,
} from "@/cli/app/tabs";
import { resetViewportScroll } from "@/cli/app/viewport-scroll";
import { resetBindingOwners } from "@/cli/helpers/input-router";
import { resetMouseHandlers } from "@/cli/helpers/mouse-router";
import {
  acquireMouseHover,
  disableMouseTracking,
  isMouseTrackingEnabled,
  MOUSE_HOVER_ENABLE,
  MOUSE_TRACKING_ENABLE,
  type MouseTrackingStream,
  resetMouseTrackingForTests,
} from "@/cli/helpers/mouse-tracking";
import { resetNoticeForTests } from "@/cli/helpers/notice";
import { mountInkTty, resetInkTtyState } from "@/test-utils/ink-tty";

/**
 * The two transitions that used to leave the mouse dead.
 *
 * Reported from a real run: "the mouse dies when I open Usage or leave Settings".
 * Both are the same transition ??a page coming up or going away ??and both write a
 * `1003l` on their way out (the page's hover claim). The shell therefore re-asserts
 * its modes on that transition, and a parent's effect runs after the unmounted
 * child's cleanup, so the re-assert is the *last* write. The assertion is the write
 * log, not the flag: the flag was true in the broken case too.
 */
describe("a page coming up or going away", () => {
  function makeStream(): MouseTrackingStream & { writes: string[] } {
    const writes: string[] = [];
    return {
      writes,
      isTTY: true,
      write(chunk: string) {
        writes.push(chunk);
        return true;
      },
    };
  }

  /** Stands in for a page with rows the pointer can light (`Settings`). */
  function HoveringPage() {
    useEffect(() => acquireMouseHover(), []);
    return <Text>page</Text>;
  }

  /**
   * Stands in for a page made only of prose (`Usage` until P5), which claims no
   * any-motion at all ??the asymmetry that made the reported defect.
   */
  function ProsePage() {
    return <Text>page</Text>;
  }

  function Shell({ stream }: { stream: MouseTrackingStream }) {
    useMouseInput(stream);
    // The active id, not "is a page": Settings ? Usage keeps that boolean `true`, so
    // a selector on it would not re-render and the page would never be swapped ?
    // which is the same trap `page-host.tsx` avoids by reading the whole tab state.
    const state = useTabsState();
    if (!isPageTabId(state.activeId)) return <Text>conversation</Text>;
    return state.activeId === "settings" ? <HoveringPage /> : <ProsePage />;
  }

  const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

  afterEach(() => {
    resetTabsForTests();
    resetInkTtyState();
    resetMouseHandlers();
    resetMouseTrackingForTests();
    resetBindingOwners();
    resetNoticeForTests();
    resetViewportScroll();
  });

  test("leaving a page re-asserts the modes after the page's hover release", async () => {
    openConversationTab("conv-1", "M6 shell");
    focusTab("conv-1");
    const stream = makeStream();
    const tty = mountInkTty(<Shell stream={stream} />, {
      columns: 60,
      rows: 16,
    });
    try {
      await settle();
      expect(stream.writes).toEqual([MOUSE_TRACKING_ENABLE]);

      // Into a page with rows: hover is claimed, so `1003` is asked for.
      focusTab("settings");
      await settle();
      expect(stream.writes.at(-1)).toBe(MOUSE_HOVER_ENABLE);

      // Out of it: the page releases `1003`, and the shell's own effect must be the
      // last write ??otherwise the terminal is left with reporting off while
      // everything in the app believes it is on.
      focusTab("conv-1");
      await settle();
      expect(stream.writes.at(-1)).toBe(MOUSE_TRACKING_ENABLE);
      expect(isMouseTrackingEnabled()).toBe(true);
    } finally {
      tty.stop();
    }
  });

  test("an unexpected disable is repaired by the next transition", async () => {
    openConversationTab("conv-1", "M6 shell");
    focusTab("conv-1");
    const stream = makeStream();
    const tty = mountInkTty(<Shell stream={stream} />, {
      columns: 60,
      rows: 16,
    });
    try {
      await settle();
      // Something outside the hook turned reporting off without releasing its
      // claim ??the shape the real defect had.
      disableMouseTracking();
      expect(isMouseTrackingEnabled()).toBe(false);

      focusTab("settings");
      await settle();
      expect(isMouseTrackingEnabled()).toBe(true);
      expect(stream.writes.at(-1)).toBe(MOUSE_HOVER_ENABLE);
    } finally {
      tty.stop();
    }
  });

  test("a prose page does not leave reporting off when it replaces a hoverable one", async () => {
    // The reported defect, exactly: Settings ??Usage. `pageIsActive` does not change
    // (both are pages), so nothing re-asserted; the page being left released its
    // any-motion on the way out, and `1003l` was the terminal's last word. Windows
    // Terminal keeps one mouse state behind the four VT modes, so that left it
    // reporting *nothing* ??clicks, hover and the terminal's own selection all went
    // back to the terminal while this process believed reporting was on. The release
    // now re-states the base modes itself, so no transition can lose them.
    openConversationTab("conv-1", "M6 shell");
    focusTab("conv-1");
    const stream = makeStream();
    const tty = mountInkTty(<Shell stream={stream} />, {
      columns: 60,
      rows: 16,
    });
    try {
      await settle();
      focusTab("settings");
      await settle();
      expect(stream.writes.at(-1)).toBe(MOUSE_HOVER_ENABLE);

      focusTab("usage");
      await settle();
      expect(stream.writes.at(-1)).toContain("?1000h");
      expect(isMouseTrackingEnabled()).toBe(true);
    } finally {
      tty.stop();
    }
  });
});
