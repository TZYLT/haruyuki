import type { AppViewProps } from "@/cli/app/AppView";

/**
 * What the shell's tab strip does when it is clicked.
 *
 * The shell draws the row and hit-tests it; the *meaning* of a click is the
 * conversation core's, because showing a conversation is a switch and closing one
 * is a view plus a runtime decision. So the shell is handed these two callbacks
 * and nothing else — it never learns what a conversation switch is, which is what
 * keeps the two shells differing by shell alone.
 *
 * Both are keyed by tab id: a conversation id, or one of the two page ids.
 */
export type TabStripProjection = {
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
};

/**
 * Projection handed from the conversation core (`AppCoordinator`) to a shell.
 *
 * A shell owns presentation only: it renders the terminal-title writer and the
 * transcript/overlay tree. It must not add orchestration or derive a second
 * copy of runtime state — every shell shares the one runtime owned by the core
 * (see the TUI redesign requirement that the two shells differ only by shell,
 * never by core).
 */
export type AppShellProps = AppViewProps & {
  /** Bumped when `/title` persists settings so the writer re-reads config. */
  terminalTitleConfigRefreshEpoch: number;
  /** Whether the terminal title should animate an activity spinner. */
  terminalTitleTaskRunning: boolean;
  /** Transient `/title` preview override; `undefined` means "no preview". */
  terminalTitlePreviewOverride: string | null | undefined;
  /**
   * The tab strip's behaviour.
   *
   * Drawn by the full-screen shell only: the append shell receives it and has no
   * row to attach it to, which is how the compatibility mode stays without a
   * strip. Nothing in core branches on which shell is reading this.
   */
  tabStrip: TabStripProjection;
};
