import chalk from "chalk";
import { type Key, Text, useInput } from "ink";
import { useEffect, useRef, useState } from "react";

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
  showCursor?: boolean;
  /** Parent-driven caret position (applied once, then reported back). */
  externalCursorOffset?: number;
  onCursorOffsetChange?: (offset: number) => void;
}

export function TextInput({
  value: originalValue,
  onChange,
  onSubmit,
  placeholder = "",
  focus = true,
  mask,
  showCursor = true,
  externalCursorOffset,
  onCursorOffsetChange,
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
    if (!focus || !showCursor) {
      return;
    }
    const next = latestValueRef.current;
    if (cursorOffsetRef.current > next.length) {
      cursorOffsetRef.current = next.length;
      setCursorOffset(next.length);
    }
  }, [originalValue, focus, showCursor]);

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
        if (showCursor) {
          nextCursor += key.leftArrow ? -1 : 1;
        }
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
  let renderedValue = maskedValue;
  let renderedPlaceholder = placeholder ? chalk.grey(placeholder) : undefined;

  // Fake caret: render the character under it (or a trailing space) in inverse
  // video. Ink does not expose a real terminal cursor here.
  if (showCursor && focus) {
    renderedPlaceholder =
      placeholder.length > 0
        ? chalk.inverse(placeholder[0]) + chalk.grey(placeholder.slice(1))
        : chalk.inverse(" ");
    renderedValue = maskedValue.length > 0 ? "" : chalk.inverse(" ");
    let index = 0;
    for (const char of maskedValue) {
      renderedValue += index === cursorOffset ? chalk.inverse(char) : char;
      index++;
    }
    if (maskedValue.length > 0 && cursorOffset === maskedValue.length) {
      renderedValue += chalk.inverse(" ");
    }
  }

  return (
    <Text>
      {placeholder
        ? maskedValue.length > 0
          ? renderedValue
          : renderedPlaceholder
        : renderedValue}
    </Text>
  );
}
