import { Box, useStdout } from "ink";
import { type ReactNode, useCallback } from "react";
import type { AppViewProps } from "@/cli/app/AppView";
import { DiffFaceHost } from "@/cli/app/faces/diff-face";
import { diffFaceTotals } from "@/cli/app/faces/diff-face-model";
import { setDiffFaceSource } from "@/cli/app/faces/diff-face-store";
import { PageHost } from "@/cli/app/pages/page-host";
import { DiffFaceScope } from "@/cli/app/shell/diff-face-scope";
import { ShellFrame } from "@/cli/app/shell/ShellFrame";
import { ContextSidebarScope } from "@/cli/app/shell/sidebar-scope";
import { sidebarGeometry } from "@/cli/app/shell/sidebar-sections";
import { TabStrip } from "@/cli/app/shell/tab-strip";
import { TAB_STRIP_ROWS } from "@/cli/app/shell/tab-strip-layout";
import type { AppShellProps } from "@/cli/app/shell/types";
import { useAmbiguousWidthProbe } from "@/cli/app/shell/use-ambiguous-width";
import { useDiffFace } from "@/cli/app/shell/use-diff-face";
import { useExitSummaryAfterTeardown } from "@/cli/app/shell/use-exit-summary";
import { useMessageHistory } from "@/cli/app/shell/use-message-history";
import { useMouseInput } from "@/cli/app/shell/use-mouse-input";
import { useSwitchPolicy } from "@/cli/app/shell/use-switch-policy";
import { useTerminalSelection } from "@/cli/app/shell/use-terminal-selection";
import { useActiveTabIsPage } from "@/cli/app/tabs";
import { ViewportTranscript } from "@/cli/app/ViewportTranscript";
import { Toasts } from "@/cli/components/Toasts";
import type { DiffPatchFile } from "@/cli/helpers/diff-patch";
import { useTerminalRows } from "@/cli/hooks/use-terminal-width";

/**
 * The full-screen frame: exactly the terminal's rows, and clipped to them.
 *
 * A fixed height rather than let the content decide, because the band sizes itself
 * from the chrome and panel measured on the *previous* frame — Ink paints during
 * the commit and React's layout effects run after it, so the measurement is always
 * one frame behind. When the chrome or the panel grows (a pinned approval, the
 * exit stats, the input getting taller), that frame is taller than the terminal:
 * measured on the machine at 50 rows into a 46-row screen during a wheel test. The
 * terminal scrolls, the whole layout shifts up for that frame — which is what the
 * user saw as the input bar jumping while scrolling — and Ink's erase bookkeeping
 * is left describing a screen that no longer matches.
 *
 * Pinning the height keeps that scroll inside our own box: the rows that do not fit
 * are dropped, nothing ever draws past the screen, and the next frame (measurement
 * caught up) is right again. It also makes the frame's row count exactly the
 * terminal's, which is the shape Ink treats as fullscreen.
 */
export function FullScreenFrame({ children }: { children: ReactNode }) {
  const rows = useTerminalRows();
  return (
    <Box height={rows} overflow="hidden" flexDirection="column" flexShrink={0}>
      {children}
    </Box>
  );
}

/**
 * The transcript region with the shell's top rows reserved.
 *
 * `ViewportTranscript` sizes its band as `terminalRows - chrome - panel`, and both
 * of those are measured inside `AppView`; the rows the *shell* draws above the
 * band are not, and only the shell knows them. Reserving them here keeps that
 * knowledge in the file that draws the strip rather than teaching the band about
 * a tab row it cannot see.
 *
 * A module-level component, not an inline arrow: `ShellFrame` renders `transcript`
 * as a component type, and a fresh function identity per render would remount the
 * band — and remounting it drops the viewport's scroll position.
 */
function V2Transcript(props: AppViewProps) {
  return <ViewportTranscript {...props} reserveTopRows={TAB_STRIP_ROWS} />;
}

/**
 * Full-screen shell (`ui_v2=on`).
 *
 * Draws the transcript in a bounded, bottom-pinned viewport instead of an
 * append-only `<Static>` tree, so render cost does not grow with history. The
 * alt-screen buffer itself is enabled by `render({ alternateScreen })` at the
 * process entry, which is also why this shell — and not the append one — hands
 * the exit summary to the process entry to print after teardown.
 *
 * It also owns the M6 shell's two top rows: the tab strip and the rule under it.
 * They are drawn here, outside `AppView`, because they are chrome the shell adds
 * to the frame — the append shell does not draw them at all, which is what keeps
 * the compatibility mode frozen without a mode branch anywhere in core.
 */
export function V2Shell(props: AppShellProps) {
  // A switch asked for while a turn runs is refused and said out loud, not
  // deferred: the ruled answer for the full-screen shell (《38》§5).
  useSwitchPolicy("refuse");
  useExitSummaryAfterTeardown(props);
  // Which columns Unicode's ambiguous characters take on this terminal's font
  // (`char-width.ts`): the probe is the reason a row can be laid out exactly, and it
  // is re-armed on resize, which is what a font change produces.
  useAmbiguousWidthProbe();
  // Mouse reporting, wheel scrolling and the mouse escape hatch: the viewport is
  // the reason this shell wants the mouse at all.
  useMouseInput();
  // Drag selection over the rendered rows, its highlight, and Ctrl+X y.
  //
  // The drag stops at the transcript's last column: the rail is chrome beside the
  // band, and a selection that ran into it would copy `│ ctx 62%` into the middle
  // of a sentence. The width is the same `min(console, ink)` the strip and the
  // bands resolve, so the boundary the painter uses is the boundary they drew.
  const { stdout } = useStdout();
  const inkColumns =
    typeof stdout?.columns === "number" && stdout.columns > 0
      ? stdout.columns
      : undefined;
  const frameColumns =
    inkColumns === undefined
      ? props.columns
      : Math.min(props.columns, inkColumns);
  const terminalRows = useTerminalRows();
  const geometry = sidebarGeometry(frameColumns, terminalRows);
  // The tab row replaces the main area with a page when one is focused.
  const pageIsActive = useActiveTabIsPage();
  // The diff face takes the band for as long as its overlay route is open. It is
  // not a tab: it is raised over the conversation, owns the keyboard, and leaves
  // nothing behind (`docs/38` §13.2), so it is chosen here — where the band's
  // content is chosen — and closed by the same `closeOverlay` every face uses.
  const diffFaceIsActive = props.activeOverlay === "diff";
  // The message history face's chord. Registered here, in the shell that has the
  // band reporting into it — the append shell registers nothing and stays frozen.
  const { setActiveOverlay } = props;
  const openMessageHistory = useCallback(() => {
    setActiveOverlay("message-history");
  }, [setActiveOverlay]);
  useMessageHistory(openMessageHistory);
  // The diff face's chord (`Ctrl+X d`): the newest diff the transcript can draw.
  const openDiffFace = useCallback(
    (files: DiffPatchFile[]) => {
      const totals = diffFaceTotals(files);
      const first = files[0];
      setDiffFaceSource({
        label:
          files.length === 1 && first
            ? first.path
            : `${files.length} files · +${totals.additions} −${totals.deletions}`,
        files,
      });
      setActiveOverlay("diff");
    },
    [setActiveOverlay],
  );
  useDiffFace({
    precomputedDiffsRef: props.precomputedDiffsRef,
    open: openDiffFace,
  });
  // The selection stands down while a page holds the band: there is no transcript
  // text under the pointer, and it is the page's rows that answer a press now.
  useTerminalSelection({
    items: () => [...props.staticItems, ...props.liveItems],
    bandTopRow: TAB_STRIP_ROWS,
    bandColumns: geometry.bandColumns,
    pageActive: pageIsActive,
  });

  return (
    <FullScreenFrame>
      {/* The rail is this shell's, and the bands read that from the scope: the
          append shell never provides it, so its band has no rail and needs no
          branch of its own. */}
      <ContextSidebarScope.Provider value>
        <TabStrip {...props.tabStrip} frameColumns={frameColumns} />
        {/* The diff face exists only in this shell; the append shell provides no
            scope, so an approval's `O` is not a key there (`diff-face-scope.ts`). */}
        <DiffFaceScope.Provider value>
          <ShellFrame
            {...props}
            transcript={
              diffFaceIsActive
                ? DiffFaceHost
                : pageIsActive
                  ? PageHost
                  : V2Transcript
            }
            // The toast band lives in this shell's row budget (`docs/38` §2.1),
            // between the transcript and the input — the append shell has neither
            // the budget nor the band, and passes nothing.
            aboveInput={Toasts}
          />
        </DiffFaceScope.Provider>
      </ContextSidebarScope.Provider>
    </FullScreenFrame>
  );
}
