import { createContext, useContext } from "react";

/**
 * The width a transcript item is laid out in, when it is not the terminal's.
 *
 * The full-screen shell (`ui_v2=on`) draws the transcript in a **band** beside the
 * context rail, so the band is narrower than the terminal — by the rail's width,
 * and by the two columns of right margin the band keeps as slack
 * (`ROW_SAFETY_COLUMNS` in `ViewportTranscript`). Everything inside the band has to
 * wrap at that width: a row laid out against the terminal's width overflows the
 * band's rectangle and is clipped by it, so the reader loses the right-hand end of
 * every long line.
 *
 * The row model measures items at exactly this width, so this is also what keeps
 * the model and the renderers from disagreeing. When they disagree, the viewport's
 * `contentOffset` is computed from the model's row count and the content is drawn
 * against the renderer's — an over-measured window lifts the transcript off the
 * band's bottom edge and leaves blank rows above the input (reported from the
 * machine as "the row measurement is wrong again", 2026-10-22). One number, read
 * by both sides, is what makes that impossible rather than unlikely.
 *
 * `null` means "no band": the append shell provides nothing, so its items lay out
 * against the terminal exactly as they always have, and its appearance stays
 * frozen.
 */
export const TranscriptColumnsScope = createContext<number | null>(null);

/**
 * The band's layout width for this subtree, or `null` outside a full-screen band.
 *
 * Read by `useTerminalWidth()`, which is the seam every item renderer already goes
 * through for its width — so a renderer needs no change to be laid out inside the
 * band, and a renderer that reads its width some other way is the thing to fix.
 */
export function useTranscriptColumns(): number | null {
  return useContext(TranscriptColumnsScope);
}
