import { LegacyShell } from "@/cli/app/shell/LegacyShell";
import type { AppShellProps } from "@/cli/app/shell/types";
import { V2Shell } from "@/cli/app/shell/V2Shell";
import { experimentManager } from "@/experiments/manager";

/**
 * Shell selector.
 *
 * The single place where the legacy/full-screen split is decided. Everything
 * above this point (the core) is shell-agnostic; both shells consume the same
 * projection. Keeping the branch here — and nowhere else — is what satisfies
 * the requirement that the two shells differ only by shell, with no mode
 * branches scattered through shared components.
 */
export function AppShell(props: AppShellProps) {
  return experimentManager.isEnabled("ui_v2") ? (
    <V2Shell {...props} />
  ) : (
    <LegacyShell {...props} />
  );
}
