import { ShellFrame } from "@/cli/app/shell/ShellFrame";
import type { AppShellProps } from "@/cli/app/shell/types";
import { useExitSummaryAfterTeardown } from "@/cli/app/shell/use-exit-summary";
import { ViewportTranscript } from "@/cli/app/ViewportTranscript";

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

  return <ShellFrame {...props} transcript={ViewportTranscript} />;
}
