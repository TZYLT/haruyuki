import { ShellFrame } from "@/cli/app/shell/ShellFrame";
import type { AppShellProps } from "@/cli/app/shell/types";
import { ViewportTranscript } from "@/cli/app/ViewportTranscript";

/**
 * Full-screen shell (`ui_v2=on`).
 *
 * Draws the transcript in a bounded, bottom-pinned viewport instead of an
 * append-only `<Static>` tree, so render cost does not grow with history. The
 * alt-screen buffer itself is enabled by `render({ alternateScreen })` at the
 * process entry.
 */
export function V2Shell(props: AppShellProps) {
  return <ShellFrame {...props} transcript={ViewportTranscript} />;
}
