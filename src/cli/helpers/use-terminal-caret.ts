import { type DOMElement, measureElement, useCursor, useStdout } from "ink";
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
 * - Ink's anchor arithmetic assumes the frame ends with a newline, which a
 *   **full-height** frame does not (`renderInteractiveFrame` appends it only when
 *   the frame is shorter than the terminal). The measured origin therefore carries
 *   one extra row in that case — see `fullscreenAnchorOffset`.
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

/**
 * The extra row a **full-height** frame needs, or 0.
 *
 * Ink's cursor anchor is written as "move up from the bottom of the frame"
 * (`buildCursorSuffix`: `moveUp = visibleLineCount - y`), which assumes the
 * terminal cursor sits one row **below** the last painted row — true for a frame
 * written with a trailing newline. `renderInteractiveFrame` only appends that
 * newline when the frame is shorter than the terminal (`isFullscreen ? output :
 * output + "\n"`). The full-screen shell pins its root to the terminal's rows, so
 * every frame it writes is exactly that case: the cursor is already ON the last
 * row, and Ink's move-up overshoots by one — the IME candidate window opened one
 * row above the composer (2026-10-24).
 *
 * The decision is made from the same two facts Ink uses: the root's laid-out
 * height and the stream's row count. Walking to the root is what makes it a fact
 * about the frame rather than a guess about which shell is running, so the append
 * shell (shorter frame, newline appended) keeps an offset of 0 without asking.
 */
function fullscreenAnchorOffset(
  node: DOMElement,
  terminalRows: number,
): number {
  if (!(terminalRows > 0)) return 0;
  let root: DOMElement = node;
  while (root.parentNode) root = root.parentNode;
  return measureElement(root).height >= terminalRows ? 1 : 0;
}

export function useTerminalCaret(options: TerminalCaretOptions): TerminalCaret {
  const { setCursorPosition } = useCursor();
  const { stdout } = useStdout();
  const ref = useRef<DOMElement | null>(null);
  const [origin, setOrigin] = useState<TextOrigin | null>(null);

  useLayoutEffect(() => {
    const node = ref.current;
    const measured = node ? measureElement(node) : null;
    if (!node || !measured || !(measured.width > 0) || !(measured.height > 0)) {
      // Not laid out yet (mounting) or no longer laid out (collapsed): hide rather
      // than place the cursor at a stale origin.
      setOrigin((prev) => (prev === null ? prev : null));
      return;
    }
    const y =
      stdout && stdout.isTTY
        ? measured.y + fullscreenAnchorOffset(node, stdout.rows ?? 0)
        : measured.y;
    setOrigin((prev) =>
      prev && prev.x === measured.x && prev.y === y
        ? prev
        : { x: measured.x, y },
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
