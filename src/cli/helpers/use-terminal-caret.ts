import { type DOMElement, measureElement, useCursor } from "ink";
import {
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { caretScreenCell } from "@/cli/helpers/caret-position";

/**
 * Puts the terminal's real cursor on an input's caret.
 *
 * Without this the terminal cursor is *hidden* (`cli-cursor`) and parked at the last
 * row of the frame, so an IME opens its candidate window at the bottom of the screen
 * while the user is composing in the input — which is the thing this hook exists for.
 * Ink 7 owns the escape sequences (`useCursor`); what has to be worked out here is
 * *where* the caret is, and when nothing should be shown.
 *
 * Three facts about the timing drive the shape:
 *
 * - `useCursor`'s position is published from a `useInsertionEffect`, which React runs
 *   **before** Ink's `resetAfterCommit` (the frame write). So a position set during
 *   *render* — not from an effect — is part of the frame that render produces.
 * - `measureElement()` is only meaningful once a layout exists, i.e. never during
 *   render. The origin therefore lives in state, measured after each commit: a layout
 *   shift above the input costs one frame before the cursor follows it, and the commit
 *   that records the new origin rewrites only the cursor (the frame text is unchanged,
 *   so Ink emits a cursor-only sequence instead of a new frame). Without the state the
 *   cursor would stay on the first frame's origin for good.
 * - The **cell** must come from the same width the renderer wrapped at, so the caller
 *   passes `wrapWidth` in rather than the hook guessing it from the measured box: a
 *   box that hugs its text reports the text's width, not the space it had.
 *
 * **Only the focused input may own the cursor.** The composer stays mounted behind
 * every overlay, and an unfocused input that publishes `undefined` would hide a cursor
 * another input just placed (whichever publish runs last wins, and the order between
 * two subtrees is not something a component can rely on). So an unfocused input hides
 * the cursor only when no input anywhere holds focus — which is still every state that
 * has to be covered: disabled or collapsed input, a page owning the keyboard, a turn
 * running with the chrome hidden.
 */

export interface TerminalCaretOptions {
  /** The draft exactly as it is displayed (mask and placeholders included). */
  text: string;
  /** Caret position in `text`, in string indexes. */
  caretOffset: number;
  /** Whether this input owns the keyboard right now. */
  focused: boolean;
  /** Columns the caller wrapped the draft at; `0`/absent publishes nothing. */
  wrapWidth?: number;
}

export interface TerminalCaret {
  /** Attach to the element the input's text is laid out in. */
  ref: RefObject<DOMElement | null>;
}

/** Focused inputs in this process; see the module note above. */
let focusedCaretInputs = 0;

interface TextOrigin {
  x: number;
  y: number;
}

export function useTerminalCaret(options: TerminalCaretOptions): TerminalCaret {
  const { setCursorPosition } = useCursor();
  const ref = useRef<DOMElement | null>(null);
  const [origin, setOrigin] = useState<TextOrigin | null>(null);

  useLayoutEffect(() => {
    const node = ref.current;
    const measured = node ? measureElement(node) : null;
    if (!measured || !(measured.width > 0) || !(measured.height > 0)) {
      // Not laid out yet (mounting) or no longer laid out (collapsed): hide rather
      // than place the cursor at a stale origin.
      setOrigin((prev) => (prev === null ? prev : null));
      return;
    }
    setOrigin((prev) =>
      prev && prev.x === measured.x && prev.y === measured.y
        ? prev
        : { x: measured.x, y: measured.y },
    );
  });

  useEffect(() => {
    if (!options.focused) return undefined;
    focusedCaretInputs += 1;
    return () => {
      focusedCaretInputs -= 1;
    };
  }, [options.focused]);

  const cell =
    options.focused && origin
      ? caretScreenCell({
          text: options.text,
          caretOffset: options.caretOffset,
          wrapWidth: options.wrapWidth ?? 0,
          originX: origin.x,
          originY: origin.y,
        })
      : null;

  // Set during render: Ink's insertion effect reads this in the same commit, before
  // the frame is written (see the module note).
  if (cell) {
    setCursorPosition(cell);
  } else if (!options.focused && focusedCaretInputs === 0) {
    setCursorPosition(undefined);
  }

  return { ref };
}

/** Test seam: the focused-input counter is module state. */
export function resetTerminalCaretForTests(): void {
  focusedCaretInputs = 0;
}
