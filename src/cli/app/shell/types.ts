import type { AppViewProps } from "@/cli/app/AppView";

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
};
