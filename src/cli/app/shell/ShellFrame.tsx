import type { ComponentType } from "react";
import { AppView, type AppViewProps } from "@/cli/app/AppView";
import type { AppShellProps } from "@/cli/app/shell/types";
import { TerminalTitleWriter } from "@/cli/components/TerminalTitleWriter";

/**
 * Shared shell chrome.
 *
 * Writes the terminal title and mounts `AppView` with the shell's transcript
 * region. The two shells differ only by `transcript`, so the decision stays at
 * the shell boundary and no mode branch leaks into `AppView`.
 */
export function ShellFrame({
  transcript,
  ...viewProps
}: AppShellProps & { transcript: ComponentType<AppViewProps> }) {
  const {
    terminalTitleConfigRefreshEpoch,
    terminalTitleTaskRunning,
    terminalTitlePreviewOverride,
    ...appViewProps
  } = viewProps;

  return (
    <>
      <TerminalTitleWriter
        projectDirectory={appViewProps.projectDirectory}
        configRefreshKey={`${appViewProps.activeOverlay ?? ""}:${terminalTitleConfigRefreshEpoch}`}
        titleData={appViewProps.terminalTitleData}
        shouldAnimate={appViewProps.shouldAnimate}
        hasActiveProgress={terminalTitleTaskRunning}
        requiresAction={appViewProps.pendingApprovals.length > 0}
        previewTitle={terminalTitlePreviewOverride}
      />
      <AppView {...appViewProps} transcript={transcript} />
    </>
  );
}
