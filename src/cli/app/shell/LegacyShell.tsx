import { AppendTranscript } from "@/cli/app/AppendTranscript";
import { ShellFrame } from "@/cli/app/shell/ShellFrame";
import type { AppShellProps } from "@/cli/app/shell/types";
import { useSwitchPolicy } from "@/cli/app/shell/use-switch-policy";

/**
 * Append-style shell (`ui_v2=off`) — the behaviour-compatible "compatibility
 * mode". Its transcript region is the Ink `<Static>` + live tree.
 *
 * It declares the compatibility switch policy: a switch asked for while a turn
 * runs is *deferred*, exactly as it was before M6 existed. Declaring it (rather
 * than leaving the default in place) keeps the two shells' answers visible side by
 * side, which is what makes them a policy rather than an accident.
 */
export function LegacyShell(props: AppShellProps) {
  useSwitchPolicy("queue");
  return <ShellFrame {...props} transcript={AppendTranscript} />;
}
