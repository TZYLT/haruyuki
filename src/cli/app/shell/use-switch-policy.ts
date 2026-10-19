// src/cli/app/shell/use-switch-policy.ts

import { useEffect } from "react";
import { type SwitchPolicy, setSwitchPolicy } from "@/cli/app/switch-policy";

/**
 * The shell declares how a switch request behaves while a turn is running.
 *
 * Mounted by each shell with its own answer, so the difference lives where the
 * shells already differ (`V2Shell` / `LegacyShell`) instead of inside every
 * handler that can request a switch. Unmounting restores the compatibility
 * answer: a core rendered with no shell — a component test, a future surface —
 * defers, which is the behaviour that existed before this policy did.
 */
export function useSwitchPolicy(policy: SwitchPolicy): void {
  useEffect(() => {
    setSwitchPolicy(policy);
    return () => {
      setSwitchPolicy("queue");
    };
  }, [policy]);
}
