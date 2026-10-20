// src/cli/app/shell/page-shell.tsx

import { Box, Text, useStdout } from "ink";
import type { AppViewProps } from "@/cli/app/AppView";
import {
  CHROME_RESERVE_ROWS,
  useChromeHeight,
  useMeasuredChromeHeight,
} from "@/cli/app/chrome-height";
import { findTab, useTabsState } from "@/cli/app/tabs";
import { ViewportPanel } from "@/cli/app/ViewportPanel";
import { useTerminalRows } from "@/cli/hooks/use-terminal-width";
import { ContextSidebarSlot } from "./context-sidebar";
import { useHasContextSidebar } from "./sidebar-scope";
import { sidebarGeometry } from "./sidebar-sections";
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

  // The rail is the band's neighbour on a page too (`《38》§2.3`: the Settings
  // frame keeps it): a page replaces the transcript, not the shell's geometry.
  // `min(console, ink)` — the same pair the strip resolves, so the divider and
  // the `┬` land in one column.
  const { stdout } = useStdout();
  const inkColumns =
    typeof stdout?.columns === "number" && stdout.columns > 0
      ? stdout.columns
      : undefined;
  const frameColumns =
    inkColumns === undefined
      ? props.columns
      : Math.min(props.columns, inkColumns);
  const geometry = useHasContextSidebar()
    ? sidebarGeometry(frameColumns, terminalRows)
    : { railWidth: 0, bandColumns: frameColumns, junctionColumn: 0 };
  const railWidth = geometry.railWidth;
  const bandColumns = geometry.bandColumns;

  return (
    <>
      {/* The page body is the frame's elastic box while a page is shown, exactly
          as the transcript band is: it is sized from the *previous* frame's
          measurements, so when those are stale Yoga has to take the extra rows
          from somewhere, and nothing measures this box. */}
      <Box
        height={height}
        flexDirection={railWidth > 0 ? "row" : "column"}
        flexShrink={1}
        overflow="hidden"
      >
        <Box
          flexDirection="column"
          flexShrink={0}
          width={railWidth > 0 ? bandColumns : undefined}
          overflow="hidden"
          paddingX={1}
        >
          <Text bold>{title}</Text>
          <Text dimColor>{description}</Text>
        </Box>
        {railWidth > 0 && (
          <ContextSidebarSlot view={props} height={height} width={railWidth} />
        )}
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
