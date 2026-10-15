import { useState } from "react";
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
 *
 * The shell is resolved once per mount on purpose. The committed transcript is
 * rendered through an Ink `<Static>`, which re-prints on remount, so flipping
 * the shell mid-session would repaint history. `/experiments` and
 * `HARUYUKI_UI_V2` therefore take effect on the next start; live switching
 * belongs with the panel/viewport work.
 */
export function AppShell(props: AppShellProps) {
  const [fullScreen] = useState(() => experimentManager.isEnabled("ui_v2"));

  return fullScreen ? <V2Shell {...props} /> : <LegacyShell {...props} />;
}
