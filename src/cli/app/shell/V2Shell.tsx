import { Box } from "ink";
import type { ReactNode } from "react";
import { ShellFrame } from "@/cli/app/shell/ShellFrame";
import type { AppShellProps } from "@/cli/app/shell/types";
import { useExitSummaryAfterTeardown } from "@/cli/app/shell/use-exit-summary";
import { useMouseInput } from "@/cli/app/shell/use-mouse-input";
import { useTerminalSelection } from "@/cli/app/shell/use-terminal-selection";
import { ViewportTranscript } from "@/cli/app/ViewportTranscript";
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
 * Full-screen shell (`ui_v2=on`).
 *
 * Draws the transcript in a bounded, bottom-pinned viewport instead of an
 * append-only `<Static>` tree, so render cost does not grow with history. The
 * alt-screen buffer itself is enabled by `render({ alternateScreen })` at the
 * process entry, which is also why this shell — and not the append one — hands
 * the exit summary to the process entry to print after teardown.
 */
export function V2Shell(props: AppShellProps) {
  useExitSummaryAfterTeardown(props);
  // Mouse reporting, wheel scrolling and the mouse escape hatch: the viewport is
  // the reason this shell wants the mouse at all.
  useMouseInput();
  // Drag selection over the rendered rows, its highlight, and Ctrl+X y.
  useTerminalSelection({
    items: () => [...props.staticItems, ...props.liveItems],
  });

  return (
    <FullScreenFrame>
      <ShellFrame {...props} transcript={ViewportTranscript} />
    </FullScreenFrame>
  );
}
