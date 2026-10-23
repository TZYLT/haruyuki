import chalk from "chalk";
import { Box, type Key, Text, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import {
  getCaretCell,
  renderCaretRows,
  wrapDisplayRows,
} from "@/cli/helpers/text-layout";
import { useTerminalCaret } from "@/cli/helpers/use-terminal-caret";

// Owned text input for the composer.
//
// It replaces `ink-text-input`, which the fork used to vendor a patched copy of.
// That fork carried behavior the upstream package does not have and the TUI
// depends on: filtering control/meta key sequences so they are not inserted as
// text, treating modified Enter as a newline (the parent inserts it) rather than
// a submit, meta-aware arrow/backspace handling, Ctrl+A/E/K/U/Y line editing,
// and a parent-drivable cursor offset.
//
// Both the value and the caret are tracked in refs and read at event time, so
// several input events arriving in one tick (an IME commit split across stdin
// reads) accumulate in order instead of each overwriting the previous one from
// a stale render closure.

/** Ctrl+letter keys this component handles itself; every other Ctrl+letter is a
 *  parent shortcut and must not be inserted as text. */
const HANDLED_CTRL_KEYS = new Set(["a", "e", "k", "u", "y"]);

/**
 * Whether `input` is a control sequence that must not be inserted as text.
 * Plain Escape is intentionally allowed through so apps can bind it.
 */
function isControlSequence(input: string, key: Key): boolean {
  if (key.tab || (key.ctrl && input === "c")) return true;
  if (key.shift && key.tab) return true;

  // Modified Enter is handled by the parent for newline insertion.
  if (key.return && (key.shift || key.meta || key.ctrl)) return true;

  // Ctrl+W (delete word) is handled by the parent.
  if (key.ctrl && (input === "w" || input === "W")) return true;

  if (
    key.ctrl &&
    input &&
    /^[a-z]$/i.test(input) &&
    !HANDLED_CTRL_KEYS.has(input.toLowerCase())
  ) {
    return true;
  }

  // Meta/Option shortcuts (Ghostty CSI-u, WezTerm ESC+p, ...) belong to the
  // parent component, not to the focused text input.
  if (key.meta && input) return true;

  // CSI sequences and other multi-char escape sequences would render garbage.
  if (
    typeof input === "string" &&
    input.startsWith("\x1b") &&
    input.length > 1
  ) {
    return true;
  }

  // Forward delete is the input router's binding; this component must not also
  // act on it, or one press would delete on both sides of the caret.
  if (key.delete) return true;

  return false;
}

export interface TextInputProps {
  value: string;
  /**
   * Report an edit. Returning `false` refuses it: the parent kept its own value
   * (for example the composer intercepting `!` on an empty draft to enter bash
   * mode), and this input must go back to displaying the parent's value rather
   * than keeping the rejected one — otherwise the next keystroke builds on text
   * the parent never accepted.
   */
  onChange: (value: string) => boolean | void;
  onSubmit?: (value: string) => void;
  placeholder?: string;
  focus?: boolean;
  mask?: string;
  /** Parent-driven caret position (applied once, then reported back). */
  externalCursorOffset?: number;
  onCursorOffsetChange?: (offset: number) => void;
  /**
   * Columns the parent has given this input, when it knows them.
   *
   * With a width, the input lays the draft out itself (one `<Text>` row per wrapped
   * line) and puts the terminal cursor on the caret's cell — the IME opens its
   * candidate window there. Without one (an overlay's field, which measures itself)
   * it keeps the old shape: Ink wraps, and no cursor is published. Publishing a cell
   * from a guessed width would be worse than no cursor: it would drag the IME window
   * to a column nothing is drawn at.
   */
  wrapWidth?: number;
}

export function TextInput({
  value: originalValue,
  onChange,
  onSubmit,
  placeholder = "",
  focus = true,
  mask,
  externalCursorOffset,
  onCursorOffsetChange,
  wrapWidth,
}: TextInputProps) {
  const [cursorOffset, setCursorOffset] = useState(
    (originalValue || "").length,
  );
  const cursorOffsetRef = useRef(cursorOffset);

  // Latest value this input knows about. Adopt the prop only when it actually
  // changed (a parent-driven edit), so an optimistic value from an event that
  // React has not flushed yet is not clobbered.
  const lastPropRef = useRef(originalValue || "");
  const latestValueRef = useRef(originalValue || "");
  if ((originalValue || "") !== lastPropRef.current) {
    lastPropRef.current = originalValue || "";
    latestValueRef.current = originalValue || "";
  }
  const killBufferRef = useRef("");

  // Clamp the caret when the value shrinks from the parent.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-clamp when the incoming value changes
  useEffect(() => {
    if (!focus) {
      return;
    }
    const next = latestValueRef.current;
    if (cursorOffsetRef.current > next.length) {
      cursorOffsetRef.current = next.length;
      setCursorOffset(next.length);
    }
  }, [originalValue, focus]);

  // Apply a parent-driven caret nudge.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run when the nudge or value changes
  useEffect(() => {
    if (typeof externalCursorOffset !== "number") {
      return;
    }
    const clamped = Math.max(
      0,
      Math.min(externalCursorOffset, (originalValue || "").length),
    );
    cursorOffsetRef.current = clamped;
    setCursorOffset(clamped);
    onCursorOffsetChange?.(clamped);
  }, [externalCursorOffset, originalValue]);

  useInput(
    (input, key) => {
      if (isControlSequence(input, key)) {
        return;
      }

      const base = latestValueRef.current;
      const caret = cursorOffsetRef.current;

      if (key.return) {
        onSubmit?.(base);
        return;
      }

      let nextValue = base;
      let nextCursor = caret;

      if (key.leftArrow || key.rightArrow) {
        if (key.meta) return; // Option+Arrow = word navigation (parent)
        nextCursor += key.leftArrow ? -1 : 1;
      } else if (key.upArrow || key.downArrow) {
        return; // parent decides (wrapped-line navigation)
      } else if (key.backspace) {
        if (key.meta) return; // Option+Delete = delete word (parent)
        if (caret > 0) {
          nextValue = base.slice(0, caret - 1) + base.slice(caret);
          nextCursor--;
        }
      } else if (key.ctrl && input === "a") {
        nextCursor = 0;
      } else if (key.ctrl && input === "e") {
        nextCursor = base.length;
      } else if (key.ctrl && input === "k") {
        if (caret < base.length) {
          killBufferRef.current = base.slice(caret);
          nextValue = base.slice(0, caret);
        }
      } else if (key.ctrl && input === "u") {
        if (caret > 0) {
          killBufferRef.current = base.slice(0, caret);
          nextValue = base.slice(caret);
          nextCursor = 0;
        }
      } else if (key.ctrl && input === "y") {
        const kill = killBufferRef.current;
        if (kill) {
          nextValue = base.slice(0, caret) + kill + base.slice(caret);
          nextCursor = caret + kill.length;
        }
      } else {
        nextValue = base.slice(0, caret) + input + base.slice(caret);
        nextCursor += input.length;
      }

      nextCursor = Math.max(0, Math.min(nextCursor, nextValue.length));
      cursorOffsetRef.current = nextCursor;
      setCursorOffset(nextCursor);
      onCursorOffsetChange?.(nextCursor);
      if (nextValue !== base) {
        if (onChange(nextValue) === false) {
          // The parent refused the edit and still holds `lastPropRef`: keep showing
          // that, or this input's optimistic value becomes the base for the next
          // keystroke (the composer's `!`-to-bash-mode entry used to leak a `!`
          // into the first command that way).
          latestValueRef.current = lastPropRef.current;
          const restored = Math.min(
            cursorOffsetRef.current,
            lastPropRef.current.length,
          );
          cursorOffsetRef.current = restored;
          setCursorOffset(restored);
          onCursorOffsetChange?.(restored);
          return;
        }
        latestValueRef.current = nextValue;
      }
    },
    { isActive: focus },
  );

  const value = latestValueRef.current;
  const maskedValue = mask ? mask.repeat(value.length) : value;

  // Lay the draft out at the width the parent gave us, then place both carets with
  // the same cell (`text-layout.ts`): the inverse-video one the user sees, and — via
  // `useTerminalCaret` — the terminal's real one that the IME opens its candidate
  // window at. Wrapping here instead of leaving it to Ink is what makes "the cell" a
  // fact rather than a guess: Ink only ever re-wraps a row it measures wider than the
  // box, and every row here stays within `wrapWidth` *display columns*.
  const laidOutWidth = Math.max(0, wrapWidth ?? 0);
  const rows =
    laidOutWidth > 0
      ? wrapDisplayRows(maskedValue, laidOutWidth)
      : [maskedValue];
  const layout = useTerminalCaret({
    text: maskedValue,
    caretOffset: cursorOffset,
    focused: focus,
    wrapWidth: laidOutWidth,
  });

  let renderedValue = rows.join("\n");
  let renderedPlaceholder = placeholder ? chalk.grey(placeholder) : undefined;

  // The visible caret is the character under it (or a trailing space) in inverse
  // video; the terminal's own cursor is placed on that same cell by the hook above.
  if (focus) {
    renderedPlaceholder =
      placeholder.length > 0
        ? chalk.inverse(placeholder[0]) + chalk.grey(placeholder.slice(1))
        : chalk.inverse(" ");
    renderedValue = renderCaretRows(
      rows,
      getCaretCell(maskedValue, cursorOffset, laidOutWidth),
      chalk.inverse,
    );
  }

  // The box wraps the text only to have something measurable: it *is* the text's
  // origin. The prompt (or an overlay's marker) sits outside it, so the cursor's
  // column is this box's `x` plus the caret's column and its row is the box's `y`
  // plus the wrapped line — nothing here has to know how wide the prompt was.
  return (
    <Box ref={layout.ref}>
      <Text>
        {placeholder
          ? maskedValue.length > 0
            ? renderedValue
            : renderedPlaceholder
          : renderedValue}
      </Text>
    </Box>
  );
}
