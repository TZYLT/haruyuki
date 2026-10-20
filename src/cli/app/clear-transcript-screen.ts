import { CLEAR_SCREEN_AND_HOME } from "./constants";

/**
 * Start the transcript over on the screen, not just in the model.
 *
 * Changing the conversation (a tab switch, `/resume`, `/new`) replaces every item
 * the transcript shows, so the frame that follows has nothing in common with the
 * one before it. Ink repaints the cells it knows about, but the screen is a
 * terminal someone is reading: rows that the new frame does not overwrite keep
 * whatever the previous conversation left there — the machine reported it as "after
 * `/new` the previous conversation's text is still on screen" (2026-10-20).
 *
 * The clear is shell-agnostic on purpose. The full-screen shell's frame is pinned
 * to the terminal's height, so a stale row is a row nothing will repaint; the
 * append shell re-emits its `<Static>` transcript on the epoch bump that goes with
 * this call anyway. Both directions are the terminal's own "start from the top",
 * which is what a conversation change is.
 *
 * Screens are cleared, scrollback is not: `2J` + home leaves the user's history in
 * the terminal's own buffer where they can still scroll to it.
 */
export function clearTranscriptScreen(
  stream: { write(chunk: string): unknown } = process.stdout,
): void {
  try {
    stream.write(CLEAR_SCREEN_AND_HOME);
  } catch {
    // A closed stream (the process is going away) must not fail the switch: the
    // conversation state is already the new one, and the screen is about to stop
    // existing anyway.
  }
}
