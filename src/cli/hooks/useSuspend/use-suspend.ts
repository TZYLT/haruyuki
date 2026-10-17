import { useApp } from "ink";
import { useCallback, useEffect, useState } from "react";
import { SYSTEM_KEY_CHORDS } from "@/cli/helpers/keymap";
import {
  disableMouseTracking,
  enableMouseTracking,
} from "@/cli/helpers/mouse-tracking";
import { useKeyBindings } from "@/cli/hooks/use-input-router";
import { debugWarn } from "@/utils/debug";

/** Resolves the next time the process is resumed with `SIGCONT`. */
export function waitForResumeSignal(): Promise<void> {
  return new Promise<void>((resolve) => {
    process.once("SIGCONT", () => {
      resolve();
    });
  });
}

/**
 * How long a hand-over waits for `SIGCONT` before the watchdog restores the terminal.
 *
 * A `SIGTSTP`'d process runs no JavaScript, so this timer can only fire while the
 * process is *running*: reaching the deadline therefore means the stop either never
 * happened (no job control — containers with no controlling terminal) or the resume
 * signal is never coming. Either way the terminal would stay handed over with no way
 * back, because Ink restores it only when the callback it was given settles.
 */
export const SUSPEND_WATCHDOG_MS = 2000;

/**
 * Settle `promise`, or give up after `ms`.
 *
 * The timer is cleared as soon as either side wins, and `unref`'d so a pending
 * watchdog never holds the event loop open (a real resume usually arrives first).
 */
function withWatchdog(promise: Promise<void>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      resolve();
    }, ms);
    timer.unref?.();
    void promise.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Stop the process and resolve once it is resumed.
 *
 * The resume listener is armed **before** the stop request on purpose: a
 * self-delivered `SIGTSTP` can stop the process before the call returns, so
 * registering afterwards would wait for a signal that already fired and leave
 * the terminal handed over forever (raw mode off, no way back).
 *
 * It also resolves on the watchdog, for the case where `SIGCONT` never arrives (see
 * `SUSPEND_WATCHDOG_MS`): resolving is what makes Ink restore the terminal, so a
 * missing signal has to degrade to a late restore rather than to a dead session.
 */
export function stopUntilResumed(
  stop: () => void,
  waitForResume: () => Promise<void> = waitForResumeSignal,
  watchdogMs: number = SUSPEND_WATCHDOG_MS,
): Promise<void> {
  const resumed = waitForResume();
  stop();
  return withWatchdog(resumed, watchdogMs);
}

export function useSuspend() {
  const { suspendTerminal } = useApp();
  // Use a state variable to force a re-render when needed
  const [resumeKey, setResumeKey] = useState(0);

  const forceUpdate = useCallback(() => {
    setResumeKey((prev) => prev + 1);
  }, []);

  // Suspend is a `system` binding: it stays reachable whatever owns input, which
  // is what the unconditional `useInput` handler it replaces did.
  useKeyBindings("use-suspend", [
    {
      scope: "system",
      bindings: [
        {
          id: "system.suspend",
          chords: SYSTEM_KEY_CHORDS.suspend,
          run: () => {
            // Suspending is a POSIX job-control concept: there is no SIGTSTP on
            // Windows, and `process.kill(pid, "SIGTSTP")` throws
            // ERR_UNKNOWN_SIGNAL there — from a key binding, which means an
            // uncaught exception and a process exit. The key is inert on
            // Windows.
            if (process.platform === "win32") {
              return;
            }

            // Mouse reporting is not part of Ink's hand-over, and it must not
            // survive into the subshell: the terminal would keep sending reports
            // to whatever is reading the tty, and a shell prompt prints them as
            // text. It is handed back after Ink has restored the terminal.
            const mouseWasOn = disableMouseTracking();

            // Ink 7 owns the terminal hand-over: `suspendTerminal` turns raw
            // mode, bracketed paste, the kitty protocol and the alternate
            // screen off before the callback, then restores all of them and
            // forces a full redraw. Doing it by hand (raw mode only) left the
            // subshell reading kitty-encoded keys with its prompt drawn in the
            // alternate screen.
            // The hand-over is bounded: `stopUntilResumed` resolves on the watchdog
            // even if `SIGCONT` never arrives, so a session with no job control
            // (a container without a controlling terminal) gets its terminal back
            // instead of staying handed over for good.
            void suspendTerminal(() =>
              stopUntilResumed(() => process.kill(process.pid, "SIGTSTP")),
            )
              .catch((error: unknown) => {
                // Never let a failed hand-over reach the uncaught-exception
                // handler: that would exit the session and drop the draft.
                debugWarn("suspend", "suspendTerminal failed", error);
              })
              .finally(() => {
                if (mouseWasOn) enableMouseTracking();
              });
          },
        },
      ],
    },
  ]);

  // Handle the SIGCONT (fg command) resume. Ink restores the terminal itself;
  // this only forces the tree to repaint so a legacy `<Static>` transcript is
  // re-emitted onto a screen the subshell has since overwritten.
  useEffect(() => {
    const handleResume = () => {
      forceUpdate();
    };

    process.on("SIGCONT", handleResume);

    return () => {
      process.off("SIGCONT", handleResume);
    };
  }, [forceUpdate]);

  return resumeKey;
}
