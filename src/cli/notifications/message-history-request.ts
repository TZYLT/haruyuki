// src/cli/notifications/message-history-request.ts

/**
 * One door to the message history face, for callers that are not the shell.
 *
 * The face is `V2Shell`'s state (`activeOverlay`), and the hint row that names
 * the unread count is a leaf inside the composer — it must not import the shell,
 * and the append shell has no face at all. Passing `setActiveOverlay` down would
 * therefore either couple the hint row to V2 or teach the hint row about a mode
 * it cannot have. So the shell that *owns* the face registers how to raise it,
 * and whoever can see the badge asks for it; the answer is a boolean because a
 * caller has to know whether there was a door to click.
 *
 * Opening the face already clears the count. This module adds an entry, never a
 * second clearing rule: it calls the same opener the chord
 * (`use-message-history.ts`) and the `/message-history` command reach, so
 * clicking the badge and pressing `Ctrl+X h` cannot diverge.
 */
export type MessageHistoryOpener = () => void;

/**
 * One opener, last registration wins.
 *
 * Last-wins rather than a set: the opener raises *screen state*, and dispatching
 * to two mounted shells would raise the face in a tree that is on its way out.
 * A switch mounts the replacement shell before the outgoing one's cleanup runs,
 * so last-wins is also the order the user would expect.
 */
let opener: MessageHistoryOpener | null = null;

/** Register the shell's opener; call the result on unmount. */
export function registerMessageHistoryOpener(
  open: MessageHistoryOpener,
): () => void {
  opener = open;
  return () => {
    // Identity-checked: the cleanup of a shell that has already been replaced
    // must not clear the registration the replacement just made.
    if (opener === open) opener = null;
  };
}

/** Whether a shell has a face to raise (the append shell has none). */
export function hasMessageHistoryOpener(): boolean {
  return opener !== null;
}

/**
 * Raise the face. Returns `false` when nothing registered one, so a caller can
 * treat "no door" as "this click was not mine" instead of swallowing it.
 */
export function openMessageHistory(): boolean {
  if (!opener) return false;
  opener();
  return true;
}

/** Test seam. */
export function resetMessageHistoryOpenerForTests(): void {
  opener = null;
}
