import { LegacyShell } from "@/cli/app/shell/LegacyShell";
import type { AppShellProps } from "@/cli/app/shell/types";

/**
 * Full-screen shell (`ui_v2=on`).
 *
 * At M1 this only proves the shell seam and the runtime switch: the new shell
 * must mount and behave identically to the append-style shell. The alt-screen
 * viewport, key/mouse handling and panels land in M2+, at which point this
 * component stops delegating to the legacy shell.
 */
export function V2Shell(props: AppShellProps) {
  return <LegacyShell {...props} />;
}
