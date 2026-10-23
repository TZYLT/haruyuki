import { getCaretCell } from "@/cli/helpers/text-layout";

/**
 * Where the terminal's real cursor belongs for a text input.
 *
 * Ink 7 can place the terminal cursor (`useCursor`), and the reason an input wants
 * it is the IME: the candidate window opens at the terminal's cursor, so a cursor
 * parked at the frame's last row puts the candidates off the bottom of the screen
 * while the user is composing in the middle of the first row.
 *
 * The two halves this joins are measured in different places and neither alone is
 * enough:
 *
 * - the **cell** comes from the draft (`getCaretCell`): which wrapped row, and which
 *   display column inside it. Columns, not characters — a CJK character or an emoji
 *   is two cells wide, and the candidate window over a wide character's left half is
 *   visible if it is one column off;
 * - the **origin** comes from the layout (`measureElement` on the box the text is
 *   laid out in): Ink's cursor coordinates are relative to the output frame, and only
 *   the layout knows where in that frame the input sits (`y`) and how far the prompt
 *   pushed the text right (`x` is already relative to the frame).
 *
 * The result is what `useTerminalCaret` hands to `setCursorPosition`.
 */
export interface CaretScreenCell {
  /** 0-based column within Ink's output frame. */
  x: number;
  /** 0-based row within Ink's output frame. */
  y: number;
}

export interface CaretScreenCellInput {
  /** The draft as displayed (placeholders and mask included). */
  text: string;
  /** Caret position in `text`, in string indexes. */
  caretOffset: number;
  /** Columns the text is wrapped at — the box it is laid out in. */
  wrapWidth: number;
  /** The text box's left edge within the frame (`measureElement().x`). */
  originX: number;
  /** The text box's top row within the frame (`measureElement().y`). */
  originY: number;
}

/**
 * The frame cell for a caret, or `null` when there is no width to lay it out at.
 *
 * A `null` answer means "do not place a cursor": with no wrap width there is no
 * reliable column to compute (the input is not laid out yet, or it is collapsed), and
 * a guessed cell would put the IME window in the wrong place instead of leaving it
 * where the terminal keeps it.
 */
export function caretScreenCell(
  input: CaretScreenCellInput,
): CaretScreenCell | null {
  if (!(input.wrapWidth > 0)) return null;
  const cell = getCaretCell(input.text, input.caretOffset, input.wrapWidth);
  return {
    x: input.originX + cell.column,
    y: input.originY + cell.lineIndex,
  };
}
