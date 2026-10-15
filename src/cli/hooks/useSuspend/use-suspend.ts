import { useStdin } from "ink";
import { useCallback, useEffect, useState } from "react";
import { SYSTEM_KEY_CHORDS } from "@/cli/helpers/keymap";
import { useKeyBindings } from "@/cli/hooks/use-input-router";

export function useSuspend() {
  const { stdin, isRawModeSupported } = useStdin();
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
            if (stdin && isRawModeSupported) {
              stdin.setRawMode(false);
            }

            process.kill(process.pid, "SIGTSTP");
          },
        },
      ],
    },
  ]);

  // Handle the SIGCONT (fg command) resume
  useEffect(() => {
    const handleResume = () => {
      if (stdin && isRawModeSupported && stdin.setRawMode) {
        stdin.setRawMode(true);
      }

      // clear the console
      process.stdout.write("\x1B[H\x1B[2J");

      forceUpdate();
    };

    process.on("SIGCONT", handleResume);

    return () => {
      process.off("SIGCONT", handleResume);
    };
  }, [stdin, isRawModeSupported, forceUpdate]);

  return resumeKey;
}
