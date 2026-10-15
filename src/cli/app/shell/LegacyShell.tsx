import { AppendTranscript } from "@/cli/app/AppendTranscript";
import { ShellFrame } from "@/cli/app/shell/ShellFrame";
import type { AppShellProps } from "@/cli/app/shell/types";

/**
 * Append-style shell (`ui_v2=off`) — the behaviour-compatible "compatibility
 * mode". Its transcript region is the Ink `<Static>` + live tree.
 */
export function LegacyShell(props: AppShellProps) {
  return <ShellFrame {...props} transcript={AppendTranscript} />;
}
