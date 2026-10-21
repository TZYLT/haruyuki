import { useEffect, useRef } from "react";
import {
  getTabsState,
  subscribeToTabs,
  useActiveTabIsPage,
} from "@/cli/app/tabs";
import { scrollTranscriptWheel } from "@/cli/app/viewport-scroll";
import { LEADER_KEY_CHORDS } from "@/cli/helpers/keymap";
import { registerMouseHandler } from "@/cli/helpers/mouse-router";
import {
  acquireMouseTracking,
  type MouseTrackingStream,
  syncMouseTracking,
  toggleMouseTracking,
} from "@/cli/helpers/mouse-tracking";
import { showNotice } from "@/cli/helpers/notice";
import { useKeyBindings } from "@/cli/hooks/use-input-router";

/**
 * Mouse input for the full-screen shell (the M3-4 milestone).
 *
 * Mounted by `V2Shell` and not by the append shell, which is the honest boundary:
 * mouse reporting is what a *viewport* needs (a wheel notch has to scroll a band),
 * and it is also what costs the user their terminal's own selection — a mode with
 * a price attached should not be turned on for a shell that gains nothing from it.
 * The append shell keeps the terminal's selection and context menu untouched.
 *
 * Three duties, all of them thin:
 *
 * 1. Ask for mouse reporting while mounted, and give it back on unmount.
 * 2. Route the reports the input router reads (`mouse-router.ts`).
 * 3. Offer the escape hatch on the leader prefix, since `1002` steals the
 *    terminal's selection and a user must be able to get it back from inside the
 *    app without knowing a terminal incantation.
 *
 * The mode state itself lives in `mouse-tracking.ts` so `use-suspend` can hand it
 * over and take it back around a `Ctrl+Z` (a subshell with mouse reporting still
 * on receives the reports as typed text).
 */
export function useMouseInput(
  stream: MouseTrackingStream = process.stdout,
): void {
  // Owned, not toggled: see `acquireMouseTracking`. The app root is keyed by the
  // conversation, so a switch mounts a second shell before the first releases —
  // a plain pair lets the last write be the disable.
  useEffect(() => acquireMouseTracking(stream), [stream]);

  // The terminal is a peer: a redraw, an alt-screen entry or a terminal-side reset
  // can clear reporting without telling us, and the tab row is where that shows
  // first (the pointer stops answering *after a tab operation*). Re-assert on each
  // focus change; three short sequences, no state change.
  useEffect(() => {
    let lastActiveId = getTabsState().activeId;
    return subscribeToTabs(() => {
      const activeId = getTabsState().activeId;
      if (activeId === lastActiveId) return;
      lastActiveId = activeId;
      syncMouseTracking(stream);
    });
  }, [stream]);

  // The other transition that can leave the terminal without reporting: a page
  // coming up or going away. The page's own hover release writes `1003l` on its way
  // out, and the frame it replaces is a very different one — reported from a real
  // run as "the mouse dies when I open Usage or leave Settings". A parent's effect
  // runs after the unmounted child's cleanup in the same commit, which is exactly
  // the order needed: the re-assert is the last write. The first render is skipped:
  // the acquire above already asked, and re-asserting there would write the modes
  // twice on startup.
  const pageIsActive = useActiveTabIsPage();
  const previousPageActive = useRef(pageIsActive);
  useEffect(() => {
    if (previousPageActive.current === pageIsActive) return;
    previousPageActive.current = pageIsActive;
    syncMouseTracking(stream);
  }, [pageIsActive, stream]);

  useEffect(() => {
    return registerMouseHandler(
      (report) => {
        if (report.wheel === "up") {
          scrollTranscriptWheel("up");
          return true;
        }
        if (report.wheel === "down") {
          scrollTranscriptWheel("down");
          return true;
        }
        // Clicks and drags belong to the selection layer (M3-5); until it is
        // mounted, a click is spent here rather than typed into the draft.
        return false;
      },
      { name: "wheel" },
    );
  }, []);

  useKeyBindings("mouse", [
    {
      scope: "app",
      bindings: [
        {
          id: "leader.toggleMouse",
          leader: true,
          chords: LEADER_KEY_CHORDS.toggleMouse,
          label: "鼠标上报 开/关",
          run: () => {
            const enabled = toggleMouseTracking(stream);
            showNotice(
              enabled
                ? "鼠标上报已开启（拖拽选择 → ctrl+x y 复制；终端原生选择用 shift 拖拽）"
                : "鼠标上报已关闭（终端原生选择与右键菜单恢复；ctrl+x m 可再开）",
            );
            return "consumed";
          },
        },
      ],
    },
  ]);
}
