import type { ComponentType } from "react";
import { AppView, type AppViewProps } from "@/cli/app/AppView";
import type { AppShellProps } from "@/cli/app/shell/types";
import { TerminalTitleWriter } from "@/cli/components/TerminalTitleWriter";
import {
  useInputRouter,
  useInputScopeClaim,
} from "@/cli/hooks/use-input-router";

/**
 * Shared shell chrome.
 *
 * Writes the terminal title and mounts `AppView` with the shell's transcript
 * region. The two shells differ only by `transcript`, so the decision stays at
 * the shell boundary and no mode branch leaks into `AppView`.
 *
 * The shell also mounts the app's single input router: it is the layer both
 * shells share, and where a key goes — the router's declarative table and the
 * components that still use Ink's `useInput` — must not depend on which shell is
 * drawing. Input ownership is claimed here for the same reason: an open overlay
 * or dialog route and a pending approval are facts this projection already
 * carries, and they are the priority chain the router routes by.
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

  useInputRouter();
  // One keyboard, one owner. §4.5 ruling c: an open overlay owns it, and a
  // pending approval waits behind the overlay — visible as a compact stub, not
  // as the current approval. Claiming both layers would hand the overlay's keys
  // to the approval instead, because `modal` outranks `overlay` in
  // `INPUT_SCOPE_PRIORITY` and a migrated selector binds through the router.
  const overlayOwnsInput = appViewProps.activeOverlay !== null;
  const currentApproval = overlayOwnsInput
    ? undefined
    : appViewProps.currentApproval;

  useInputScopeClaim("overlay", overlayOwnsInput);
  useInputScopeClaim(
    "modal",
    !overlayOwnsInput && appViewProps.pendingApprovals.length > 0,
  );

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
      <AppView
        {...appViewProps}
        currentApproval={currentApproval}
        transcript={transcript}
      />
    </>
  );
}
