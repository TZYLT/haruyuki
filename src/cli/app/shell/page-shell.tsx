// src/cli/app/shell/page-shell.tsx

import { Box, Text } from "ink";
import type { AppViewProps } from "@/cli/app/AppView";
import {
  CHROME_RESERVE_ROWS,
  useChromeHeight,
  useMeasuredChromeHeight,
} from "@/cli/app/chrome-height";
import { findTab, useTabsState } from "@/cli/app/tabs";
import { ViewportPanel } from "@/cli/app/ViewportPanel";
import { useTerminalRows } from "@/cli/hooks/use-terminal-width";
import { TAB_STRIP_ROWS } from "./tab-strip-layout";

/**
 * A page occupying the main area, in place of the transcript.
 *
 * **A stand-in for now.** P0's job is the shell's zones and the tab row; the
 * pages themselves (Settings, Usage) arrive in P2–P5, and until then switching to
 * one must still do something visible, honest, and reversible — otherwise the
 * tab row would look broken the first time someone clicks `Settings`.
 *
 * It sizes itself the way the transcript does, and for the same reason: the band
 * is `terminalRows - chrome - panel - top`, where the chrome and the panel are
 * what the previous frame measured and the top rows are the strip's. A page that
 * instead let flex decide would be laid out by a column whose height nothing
 * fixes, and the composer would jump to just under the strip.
 *
 * **It draws the same panel the transcript does**, and that is not decoration: the
 * approval surface and the running-subagent group live below the band, and a page
 * replaces the band only. Without this panel, a tool that asks for permission
 * while the user is reading Settings would find the input disabled and the
 * approval nowhere on screen — the session would be stuck with nothing to answer.
 * `approvalIsDrawn` is `false` because a page never draws a transcript row, so the
 * focused approval is always the panel's.
 */
export function PageShell(props: AppViewProps) {
  const state = useTabsState();
  const tab = findTab(state.activeId, state);
  const terminalRows = useTerminalRows();
  const chromeRows = useChromeHeight();
  const { ref: panelRef, rows: panelRows } = useMeasuredChromeHeight();
  const height = Math.max(
    1,
    terminalRows -
      (chromeRows ?? CHROME_RESERVE_ROWS) -
      (panelRows ?? 0) -
      TAB_STRIP_ROWS,
  );

  const title = tab?.title ?? "Settings";
  const description = PAGE_DESCRIPTIONS[tab?.id ?? "settings"];

  return (
    <>
      {/* The page body is the frame's elastic box while a page is shown, exactly
          as the transcript band is: it is sized from the *previous* frame's
          measurements, so when those are stale Yoga has to take the extra rows
          from somewhere, and nothing measures this box. */}
      <Box
        height={height}
        flexDirection="column"
        flexShrink={1}
        overflow="hidden"
        paddingX={1}
      >
        <Text bold>{title}</Text>
        <Text dimColor>{description}</Text>
      </Box>
      <ViewportPanel
        panelRef={panelRef}
        approvalIsDrawn={false}
        approval={props}
      />
    </>
  );
}

/**
 * What each page will hold, in the order the design lists it.
 *
 * Copy, not structure: the pages replace these lines with their own layout, and
 * what is promised here is the shape the user is about to get (《38》§12, §14).
 */
const PAGE_DESCRIPTIONS: Record<string, string> = {
  usage: "概览：用量与成本 · 明细：上下文拆分",
  settings: "通用 · 模型 · 权限 · 连接",
};
