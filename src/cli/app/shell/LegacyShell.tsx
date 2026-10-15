import { AppView } from "@/cli/app/AppView";
import type { AppShellProps } from "@/cli/app/shell/types";
import { TerminalTitleWriter } from "@/cli/components/TerminalTitleWriter";

/**
 * Append-style shell: the committed transcript plus the live tree rendered by
 * `AppView`, with the terminal-title writer attached.
 *
 * This is the behaviour-compatible shell kept behind `ui_v2=off` (the
 * "compatibility mode"). It must stay behaviour-equivalent to the pre-redesign
 * coordinator render.
 */
export function LegacyShell({
  terminalTitleConfigRefreshEpoch,
  terminalTitleTaskRunning,
  terminalTitlePreviewOverride,
  ...viewProps
}: AppShellProps) {
  return (
    <>
      <TerminalTitleWriter
        projectDirectory={viewProps.projectDirectory}
        configRefreshKey={`${viewProps.activeOverlay ?? ""}:${terminalTitleConfigRefreshEpoch}`}
        titleData={viewProps.terminalTitleData}
        shouldAnimate={viewProps.shouldAnimate}
        hasActiveProgress={terminalTitleTaskRunning}
        requiresAction={viewProps.pendingApprovals.length > 0}
        previewTitle={terminalTitlePreviewOverride}
      />
      <AppView {...viewProps} />
    </>
  );
}
