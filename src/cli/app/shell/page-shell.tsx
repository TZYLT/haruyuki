// src/cli/app/shell/page-shell.tsx

import { Box, Text } from "ink";
import type { AppViewProps } from "@/cli/app/AppView";
import { CHROME_RESERVE_ROWS, useChromeHeight } from "@/cli/app/chrome-height";
import { findTab, useTabsState } from "@/cli/app/tabs";
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
 * is `terminalRows - chrome - top`, where the chrome is what the composer
 * measured on the previous frame and the top rows are the strip's. A page that
 * instead let flex decide would be laid out by a column whose height nothing
 * fixes, and the composer would jump to just under the strip.
 */
export function PageShell(_props: AppViewProps) {
  const state = useTabsState();
  const tab = findTab(state.activeId, state);
  const terminalRows = useTerminalRows();
  const chromeRows = useChromeHeight();
  const height = Math.max(
    1,
    terminalRows - (chromeRows ?? CHROME_RESERVE_ROWS) - TAB_STRIP_ROWS,
  );

  const title = tab?.title ?? "Settings";
  const description = PAGE_DESCRIPTIONS[tab?.id ?? "settings"];

  return (
    <Box
      height={height}
      flexShrink={0}
      flexDirection="column"
      paddingX={1}
      overflow="hidden"
    >
      <Text bold>{title}</Text>
      <Text dimColor>{description}</Text>
    </Box>
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
