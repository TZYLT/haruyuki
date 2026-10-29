// src/cli/app/switch-policy.ts

import type { CommandHandle } from "@/cli/commands/runner";
import { showNotice } from "@/cli/helpers/notice";
import type { AppCommandRunner } from "./types";

/**
 * What a switch request does while a turn is running.
 *
 * **The ruling (《38》§5, 2026-10-19).** One conversation is live at a time, so a
 * request to show a different one while the agent is working has to wait or be
 * refused — and the two shells answer differently: the full-screen shell **refuses
 * and says so**, while the compatibility shell keeps deferring the request to the
 * end of the turn, which is what it has always done. The user's reasoning was
 * mechanical: the mode is not "difficult", it is that a queued switch hides the
 * fact that the click did not happen yet.
 *
 * **The policy is a module value the shell declares, not a prop.** The switch is
 * performed by core hooks and handlers that the shell does not render
 * (`use-conversation-switching`, `tab-strip-actions`, `AppView`'s pickers), so a
 * prop would have to be threaded through `AppViewProps` — and the only other way
 * for core to learn it is to ask which shell is mounted, which is the `if
 * (legacy)` the design forbids (《32》I11). A shell that declares nothing gets the
 * compatibility answer, which is also the honest default: no declaration, no new
 * behaviour.
 *
 * The switch is called off through the **transient notice**, never a toast: a
 * refusal has to be seen (《32》§5.5), and the notice sits in the bottom hint row
 * where the user is looking after a click.
 */

export type SwitchPolicy = "queue" | "refuse";

/** The refusal, verbatim from 《38》§7.5. */
export const SWITCH_REFUSED_NOTICE =
  "Running · press Esc to interrupt before switching";

/** What the compatibility shell says when it defers instead. */
export const SWITCH_QUEUED_NOTICE = "Switch queued · runs after this turn";

let policy: SwitchPolicy = "queue";
const listeners = new Set<() => void>();

export function getSwitchPolicy(): SwitchPolicy {
  return policy;
}

/** Declare the mounted shell's policy. Called by the shell, once, on mount. */
export function setSwitchPolicy(next: SwitchPolicy): void {
  if (policy === next) return;
  policy = next;
  for (const listener of listeners) listener();
}

export function subscribeToSwitchPolicy(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether a switch asked for now is refused rather than deferred. */
export function refusesWhileBusy(): boolean {
  return policy === "refuse";
}

/**
 * Spend a switch request that arrived while a turn is running.
 *
 * One call for the three typed paths (`/resume`, `/search`, `/agent list`) because the
 * shapes were identical: a command row that says "queued", an update to a running
 * phase, and a `setQueuedOverlayAction` for the turn's end. Under the refusing
 * policy the same row is failed instead, so the picker the user came from closes
 * with an explanation rather than a promise that will not be kept — and the
 * notice says what to do about it.
 *
 * A `defer` that receives no command id is the mouse-click case: there is no row
 * to re-open at the end of the turn, so the queued action carries none.
 */
export function queueOrRefuseSwitch(input: {
  /** Starts the command row when the request deserves one (omitted for a click). */
  commandRunner?: Pick<AppCommandRunner, "start">;
  /** The row's input, e.g. `/resume`. */
  commandInput?: string;
  /** What the row says while it waits. */
  output?: string;
  /** An already-open picker's command, if the request came from one. */
  command?: CommandHandle | null;
  /** Runs the deferral for this request. */
  defer: (commandId?: string) => void;
}): true {
  const output = input.output ?? "Switch requested";
  const command =
    input.command ??
    (input.commandRunner && input.commandInput
      ? input.commandRunner.start(input.commandInput, output)
      : null);

  if (refusesWhileBusy()) {
    command?.fail(SWITCH_REFUSED_NOTICE);
    showNotice(SWITCH_REFUSED_NOTICE);
    return true;
  }

  command?.update({ output, phase: "running" });
  input.defer(command?.id);
  showNotice(SWITCH_QUEUED_NOTICE);
  return true;
}

/** Test seam. */
export function resetSwitchPolicyForTests(): void {
  policy = "queue";
  listeners.clear();
}
