import { useState } from "react";
import { LegacyShell } from "@/cli/app/shell/LegacyShell";
import type { AppShellProps } from "@/cli/app/shell/types";
import { V2Shell } from "@/cli/app/shell/V2Shell";
import { resolveUiV2Once } from "@/experiments/ui-v2";

/**
 * Shell selector.
 *
 * The single place where the legacy/full-screen split is decided. Everything
 * above this point (the core) is shell-agnostic; both shells consume the same
 * projection. Keeping the branch here — and nowhere else — is what satisfies
 * the requirement that the two shells differ only by shell, with no mode
 * branches scattered through shared components.
 *
 * The shell is resolved by `resolveUiV2Once`, the same call the process entry
 * uses for `alternateScreen`, so the shell and the buffer it draws into cannot
 * disagree. It is deliberately *not* re-read per render: the committed transcript
 * goes through an Ink `<Static>`, which re-prints on remount, so flipping the
 * shell mid-session would repaint history. `/config experiments` and `HARUYUKI_UI_V2`
 * therefore take effect on the next start; live switching belongs with the
 * panel/viewport work.
 */
export function AppShell(props: AppShellProps) {
  const [fullScreen] = useState(resolveUiV2Once);

  return fullScreen ? <V2Shell {...props} /> : <LegacyShell {...props} />;
}
