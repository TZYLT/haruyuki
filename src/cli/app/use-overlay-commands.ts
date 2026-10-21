import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
  useEffect,
} from "react";
import type { CommandHandle } from "@/cli/commands/runner";
import type { ModelSelectorOptions } from "./submit-handler-context";
import type { ActiveOverlay, AppCommandRunner } from "./types";

/**
 * Who owns the overlay's command row.
 *
 * An overlay opened by a slash command shows that command in the transcript, and
 * the row has to be *finished* whichever way the face closes. The bookkeeping is
 * one ref (`pendingOverlayCommandRef`) and four moves: start (or refresh) the
 * command, consume it when the face completes, cancel it with its dismissal
 * message, and keep its phase in step with the face actually being on screen.
 *
 * It lives here rather than in `AppCoordinator` for the reason the size ratchet
 * exists: this is a module with one responsibility and its own state invariant
 * ("the ref and `activeOverlay` describe the same face, or the ref is null"), and
 * it reads far better as such than as a hundred lines in the middle of a 4.5k-line
 * component. The hook takes the setters it must touch and owns nothing else.
 */
export type PendingOverlayCommand = {
  overlay: ActiveOverlay;
  command: CommandHandle;
  openingOutput: string;
  dismissOutput: string;
};

export type OverlayCommands = {
  /** Start the command row for a face, or refresh the one already pending. */
  startOverlayCommand: (
    overlay: ActiveOverlay,
    input: string,
    openingOutput: string,
    dismissOutput: string,
  ) => CommandHandle;
  /** Take the pending row for this face, leaving the ref empty. */
  consumeOverlayCommand: (overlay: ActiveOverlay) => CommandHandle | null;
  /** Start the row *and* show the face — they are always done together. */
  openOverlay: (
    overlay: NonNullable<ActiveOverlay>,
    input: string,
    openingOutput: string,
    dismissOutput: string,
  ) => CommandHandle;
  /** Close the face *and* finish its row with the caller's result. */
  completeOverlay: (
    overlay: NonNullable<ActiveOverlay>,
  ) => CommandHandle | null;
  /** Raise `/tabs`, from the command and from the strip's `+N` alike. */
  openTabsOverlay: () => void;
};

export function useOverlayCommands(input: {
  commandRunner: AppCommandRunner;
  pendingOverlayCommandRef: MutableRefObject<PendingOverlayCommand | null>;
  activeOverlay: ActiveOverlay;
  setActiveOverlay: Dispatch<SetStateAction<ActiveOverlay>>;
  /** The three UI resets every overlay close shares with the composer. */
  setFeedbackPrefill: Dispatch<SetStateAction<string>>;
  setSearchQuery: Dispatch<SetStateAction<string>>;
  setModelSelectorOptions: Dispatch<SetStateAction<ModelSelectorOptions>>;
  setModelReasoningPrompt: (value: null) => void;
}): OverlayCommands {
  const {
    commandRunner,
    pendingOverlayCommandRef,
    activeOverlay,
    setActiveOverlay,
    setFeedbackPrefill,
    setSearchQuery,
    setModelSelectorOptions,
    setModelReasoningPrompt,
  } = input;

  const startOverlayCommand = useCallback(
    (
      overlay: ActiveOverlay,
      commandInput: string,
      openingOutput: string,
      dismissOutput: string,
    ) => {
      const pending = pendingOverlayCommandRef.current;
      if (pending && pending.overlay === overlay) {
        // Re-opening a face that is already up keeps its row: a second
        // `/model` while the selector is open must not print a second line.
        pending.openingOutput = openingOutput;
        pending.dismissOutput = dismissOutput;
        return pending.command;
      }
      const command = commandRunner.start(commandInput, openingOutput);
      pendingOverlayCommandRef.current = {
        overlay,
        command,
        openingOutput,
        dismissOutput,
      };
      return command;
    },
    [commandRunner, pendingOverlayCommandRef],
  );

  const consumeOverlayCommand = useCallback(
    (overlay: ActiveOverlay) => {
      const pending = pendingOverlayCommandRef.current;
      if (!pending || pending.overlay !== overlay) {
        return null;
      }
      pendingOverlayCommandRef.current = null;
      return pending.command;
    },
    [pendingOverlayCommandRef],
  );

  const openOverlay = useCallback(
    (
      overlay: NonNullable<ActiveOverlay>,
      commandInput: string,
      openingOutput: string,
      dismissOutput: string,
    ) => {
      const cmd = startOverlayCommand(
        overlay,
        commandInput,
        openingOutput,
        dismissOutput,
      );
      setActiveOverlay(overlay);
      return cmd;
    },
    [setActiveOverlay, startOverlayCommand],
  );

  const completeOverlay = useCallback(
    (overlay: NonNullable<ActiveOverlay>) => {
      const cmd = consumeOverlayCommand(overlay);
      setActiveOverlay(null);
      setFeedbackPrefill("");
      setSearchQuery("");
      setModelSelectorOptions({});
      setModelReasoningPrompt(null);
      return cmd;
    },
    [
      consumeOverlayCommand,
      setActiveOverlay,
      setFeedbackPrefill,
      setSearchQuery,
      setModelReasoningPrompt,
      setModelSelectorOptions,
    ],
  );

  /**
   * Raise `/tabs`.
   *
   * Called from three places that must agree: the command, and the collapsed `+N`
   * marker's click (which goes through the strip's projection). The already-open
   * guard keeps a second click from stacking a second command row behind a face
   * that is already up.
   */
  const openTabsOverlay = useCallback(() => {
    if (activeOverlay === "tabs") return;
    openOverlay("tabs", "/tabs", "标签列表", "标签列表已关闭");
  }, [activeOverlay, openOverlay]);

  // The row's phase follows the face: a command started before its overlay was
  // committed says "waiting" only while the overlay is actually on screen.
  useEffect(() => {
    const pending = pendingOverlayCommandRef.current;
    if (!pending || pending.overlay !== activeOverlay) {
      return;
    }
    pending.command.update({
      output: pending.openingOutput,
      phase: "waiting",
      dimOutput: true,
    });
  }, [activeOverlay, pendingOverlayCommandRef]);

  return {
    startOverlayCommand,
    consumeOverlayCommand,
    openOverlay,
    completeOverlay,
    openTabsOverlay,
  };
}
