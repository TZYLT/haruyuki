// Paste-aware text input wrapper that:
// 1. Detects large pastes (>5 lines or >500 chars) and replaces with placeholders
// 2. Supports image pasting (iTerm2 inline, data URLs, file paths, macOS clipboard)
// 3. Maintains separate display value (with placeholders) vs actual value (full content)
// 4. Resolves placeholders on submit

// Import useInput from vendored Ink for bracketed paste support
import { useInput, usePaste, useStdin } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  translatePasteForImages,
  tryImportClipboardImageMac,
} from "@/cli/helpers/clipboard";
import {
  allocatePaste,
  resolvePlaceholders,
} from "@/cli/helpers/paste-registry";
import { TextInput } from "./TextInput";

// Fallback paste aggregation windows (ms). A markerless paste arrives as many
// small input events; chunks that land within the "normal" window are treated
// as one run, and once a run is clearly paste-sized (>= ESCALATE_AT chars) the
// window widens so the remaining chunks still join. Kept short so ordinary
// typing and key auto-repeat stay in separate runs.
const PASTE_FALLBACK_NORMAL_MS = 16;
const PASTE_FALLBACK_PASTE_MS = 150;
const PASTE_FALLBACK_ESCALATE_AT = 128;

// How many paste-aware composers are focused right now. `usePaste` is
// registered for the whole app lifetime (Ink ties bracketed-paste mode to
// having a listener), so every mounted composer — including the always-mounted
// one while an overlay owns focus — hears the same paste event. Only the
// focused one may insert it.
let focusedPasteAwareInputCount = 0;

// Global timestamp for forward delete coordination
// Use globalThis to ensure singleton across bundle
declare global {
  // eslint-disable-next-line no-var
  var __haruyukiForwardDeleteTimestamp: number | undefined;
}

interface PasteAwareTextInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  placeholder?: string;
  focus?: boolean;
  cursorPosition?: number;
  onCursorMove?: (position: number) => void;

  /**
   * Called when the user presses `!` while the input is empty.
   * Return true to consume the keystroke (it will NOT appear in the input).
   */
  onBangAtEmpty?: () => boolean;

  /**
   * Called when the user presses Backspace while the input is empty.
   * Return true to consume the keystroke.
   */
  onBackspaceAtEmpty?: () => boolean;

  /**
   * Called when an image paste fails (e.g., image too large).
   */
  onPasteError?: (message: string) => void;
}

function countLines(text: string): number {
  return (text.match(/\r\n|\r|\n/g) || []).length + 1;
}

/** Replace newlines with visual indicator for display */
function sanitizeForDisplay(text: string): string {
  return text.replace(/\r\n|\r|\n/g, "↵");
}

/** Find the boundary of the previous word for option+left navigation */
function findPreviousWordBoundary(text: string, cursorPos: number): number {
  if (cursorPos === 0) return 0;

  // Move back one position if we're at the end of a word
  let pos = cursorPos - 1;

  // Skip whitespace backwards
  while (pos > 0 && /\s/.test(text.charAt(pos))) {
    pos--;
  }

  // Skip word characters backwards
  while (pos > 0 && /\S/.test(text.charAt(pos))) {
    pos--;
  }

  // If we stopped at whitespace, move forward one
  if (pos > 0 && /\s/.test(text.charAt(pos))) {
    pos++;
  }

  return Math.max(0, pos);
}

/** Find the boundary of the next word for option+right navigation */
function findNextWordBoundary(text: string, cursorPos: number): number {
  if (cursorPos >= text.length) return text.length;

  let pos = cursorPos;

  // Skip current word forward
  while (pos < text.length && /\S/.test(text.charAt(pos))) {
    pos++;
  }

  // Skip whitespace forward
  while (pos < text.length && /\s/.test(text.charAt(pos))) {
    pos++;
  }

  return pos;
}

type WordDirection = "left" | "right";

// biome-ignore lint/suspicious/noControlCharactersInRegex: Terminal escape sequences require ESC control character
const OPTION_LEFT_PATTERN = /^\u001b\[(?:1;)?(?:3|4|7|8|9)D$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: Terminal escape sequences require ESC control character
const OPTION_RIGHT_PATTERN = /^\u001b\[(?:1;)?(?:3|4|7|8|9)C$/;

function detectOptionWordDirection(sequence: string): WordDirection | null {
  if (!sequence.startsWith("\u001b")) return null;
  if (sequence === "\u001bb" || sequence === "\u001bB") return "left";
  if (sequence === "\u001bf" || sequence === "\u001bF") return "right";
  if (OPTION_LEFT_PATTERN.test(sequence)) return "left";
  if (OPTION_RIGHT_PATTERN.test(sequence)) return "right";
  return null;
}

export function PasteAwareTextInput({
  value,
  onChange,
  onSubmit,
  placeholder,
  focus = true,
  cursorPosition,
  onCursorMove,
  onBangAtEmpty,
  onBackspaceAtEmpty,
  onPasteError,
}: PasteAwareTextInputProps) {
  // Ink 7 narrows `useStdin()`'s public type to `PublicProps`; the runtime
  // context still carries `internal_eventEmitter`. Access it through a local
  // type instead of a second raw stdin listener (see src/cli/AGENTS.md).
  const { internal_eventEmitter } = useStdin() as unknown as {
    internal_eventEmitter?: import("node:events").EventEmitter;
  };
  const [displayValue, setDisplayValue] = useState(value);
  // The sync effect below skips renders that already display `value`, so
  // resolve placeholders for the initial value here instead of on mount.
  const [actualValue, setActualValue] = useState(() =>
    resolvePlaceholders(value),
  );
  const caretOffsetRef = useRef<number>((value || "").length);
  const [nudgeCursorOffset, setNudgeCursorOffset] = useState<
    number | undefined
  >(undefined);
  const displayValueRef = useRef(displayValue);
  const actualValueRef = useRef(actualValue);
  const focusRef = useRef(focus);

  // Keep display + actual in refs as well as state: a sequence of edits can
  // arrive before React re-renders (back-to-back pastes, an IME commit split
  // across reads), and each one must read the previous result rather than a
  // stale `displayValue` from the last render.
  const setDraft = useCallback((nextDisplay: string, nextActual: string) => {
    displayValueRef.current = nextDisplay;
    actualValueRef.current = nextActual;
    setDisplayValue(nextDisplay);
    setActualValue(nextActual);
  }, []);

  useEffect(() => {
    focusRef.current = focus;
  }, [focus]);

  // Register this composer as a focused paste owner while it has focus, so an
  // unfocused composer knows another paste-aware input will handle the paste.
  useEffect(() => {
    if (!focus) {
      return undefined;
    }
    focusedPasteAwareInputCount += 1;
    return () => {
      focusedPasteAwareInputCount -= 1;
    };
  }, [focus]);

  // Apply cursor position from parent
  useEffect(() => {
    if (typeof cursorPosition === "number") {
      setNudgeCursorOffset(cursorPosition);
      caretOffsetRef.current = cursorPosition;
    }
  }, [cursorPosition]);

  // Sync external value changes (treat incoming value as DISPLAY value)
  useEffect(() => {
    // Only a parent-driven change needs syncing. When this render already
    // displays the incoming value, it is the echo of our own onChange and the
    // handlers have set display/actual/caret. Syncing anyway is harmful: stdin
    // can deliver several input events in one tick (an IME commit split across
    // reads), so this passive effect may run after a later event has advanced
    // the display and caret — applying this render's older value would clamp
    // the caret short and drop the newer chunks (#4493).
    if (value === displayValue) {
      return;
    }
    // Recompute ACTUAL by substituting placeholders via shared registry
    const resolved = resolvePlaceholders(value);
    setDraft(value, resolved);

    // Keep caret in bounds when parent updates value (e.g. clearing input).
    // This also ensures mode-switch hotkeys that depend on caret position behave correctly.
    const nextCaret = Math.max(
      0,
      Math.min(caretOffsetRef.current, value.length),
    );
    if (nextCaret !== caretOffsetRef.current) {
      setNudgeCursorOffset(nextCaret);
      caretOffsetRef.current = nextCaret;
    }
  }, [value, displayValue, setDraft]);

  // Intercept paste events and macOS fallback for image clipboard imports
  useInput(
    (input, key) => {
      // Handle Shift/Option/Ctrl + Enter to insert newline
      if (key.return && (key.shift || key.meta || key.ctrl)) {
        const at = Math.max(
          0,
          Math.min(caretOffsetRef.current, displayValueRef.current.length),
        );

        // Insert actual \n for visual newline (cursor moves to new line)
        const newValue =
          displayValueRef.current.slice(0, at) +
          "\n" +
          displayValueRef.current.slice(at);

        setDraft(newValue, newValue); // Display and actual are same (both have \n)
        onChangeRef.current(newValue);

        const nextCaret = at + 1;
        setNudgeCursorOffset(nextCaret);
        caretOffsetRef.current = nextCaret;
        return;
      }

      // macOS: Ctrl+V probes the clipboard for an image (native terminals do not
      // send image data through bracketed paste). Elsewhere the terminal owns
      // Ctrl+V as a paste binding, so leave the key alone.
      if (process.platform === "darwin" && key.ctrl && input === "v") {
        // Fire async handler (can't await in useInput callback)
        (async () => {
          const result = await tryImportClipboardImageMac();
          if (result) {
            if ("error" in result) {
              // Report the error via callback
              onPasteErrorRef.current?.(result.error);
              return;
            }
            // Success - insert the placeholder
            const clip = result.placeholder;
            const at = Math.max(
              0,
              Math.min(caretOffsetRef.current, displayValueRef.current.length),
            );
            const newDisplay =
              displayValueRef.current.slice(0, at) +
              clip +
              displayValueRef.current.slice(at);
            setDraft(newDisplay, newDisplay);
            onChangeRef.current(newDisplay);
            const nextCaret = at + clip.length;
            setNudgeCursorOffset(nextCaret);
            caretOffsetRef.current = nextCaret;
          }
        })();
        return;
      }

      // Bracketed paste is handled on Ink's separate 'paste' channel (usePaste
      // below). It never reaches this handler while usePaste is active.

      if (
        (key.meta && (input === "v" || input === "V")) ||
        (key.ctrl && key.shift && (input === "v" || input === "V"))
      ) {
        // Fire async handler
        (async () => {
          const result = await tryImportClipboardImageMac();
          if (result) {
            if ("error" in result) {
              onPasteErrorRef.current?.(result.error);
              return;
            }
            const placeholder = result.placeholder;
            const base = displayValueRef.current;
            const at = Math.max(
              0,
              Math.min(caretOffsetRef.current, base.length),
            );
            const newDisplay = base.slice(0, at) + placeholder + base.slice(at);
            const newActual =
              actualValueRef.current.slice(0, at) +
              placeholder +
              actualValueRef.current.slice(at);
            setDraft(newDisplay, newActual);
            onChange(newDisplay);
            const nextCaret = at + placeholder.length;
            setNudgeCursorOffset(nextCaret);
            caretOffsetRef.current = nextCaret;
          }
        })();
      }

      // Backspace on empty input - handle here since handleChange won't fire
      // (value doesn't change when backspacing on empty)
      // Use ref to avoid stale closure issues
      // Note: On macOS, backspace sends \x7f which Ink parses as "delete", not "backspace"
      if ((key.backspace || key.delete) && displayValueRef.current === "") {
        onBackspaceAtEmptyRef.current?.();
        return;
      }
    },
    { isActive: focus },
  );

  // Bracketed paste is delivered on Ink 7's separate 'paste' channel. Ink ties
  // bracketed paste mode (`\x1b[?2004h`) to having a `usePaste` listener, so
  // this stays active for the whole app lifetime: gating it on the composer's
  // focus left pastes unbracketed while unfocused (overlay open / turn running),
  // and they then arrived as many raw input events (literal newlines, no
  // placeholder). The old Ink patch kept the mode on unconditionally.
  usePaste((text) => {
    if (typeof text !== "string") {
      return;
    }
    if (!focusRef.current) {
      // Composer unfocused. If a paste-aware composer owns focus it will insert
      // this paste from its own usePaste listener, so forwarding here too would
      // insert it twice. Only a focused input without usePaste (a raw
      // TextInput, e.g. the masked API-key field) needs the forwarded event.
      if (focusedPasteAwareInputCount > 0) {
        return;
      }
      internal_eventEmitter?.emit("input", text);
      return;
    }
    const payload = text;
    // Translate any image payloads in the paste (OSC 1337, data URLs, paths).
    const translated = translatePasteForImages(payload);
    const insertPastedText = (value: string) => {
      const base = displayValueRef.current;
      const at = Math.max(0, Math.min(caretOffsetRef.current, base.length));
      const isLarge = countLines(value) > 5 || value.length > 500;
      if (isLarge) {
        const pasteId = allocatePaste(value);
        const placeholder = `[Pasted text #${pasteId} +${countLines(value)} lines]`;
        const newDisplay = base.slice(0, at) + placeholder + base.slice(at);
        const newActual =
          actualValueRef.current.slice(0, at) +
          value +
          actualValueRef.current.slice(at);
        setDraft(newDisplay, newActual);
        onChange(newDisplay);
        const nextCaret = at + placeholder.length;
        setNudgeCursorOffset(nextCaret);
        caretOffsetRef.current = nextCaret;
      } else {
        const displayText = sanitizeForDisplay(value);
        const newDisplay = base.slice(0, at) + displayText + base.slice(at);
        const newActual =
          actualValueRef.current.slice(0, at) +
          value +
          actualValueRef.current.slice(at);
        setDraft(newDisplay, newActual);
        onChange(newDisplay);
        const nextCaret = at + displayText.length;
        setNudgeCursorOffset(nextCaret);
        caretOffsetRef.current = nextCaret;
      }
    };

    // A paste that carried no text: either an image-only clipboard (macOS can
    // read it directly) or a clipboard the terminal could not turn into text
    // (for example a file copied in Explorer and pasted on Windows). Report it
    // rather than silently doing nothing.
    if ((!translated || translated.length === 0) && payload.length === 0) {
      if (process.platform === "darwin") {
        void (async () => {
          const clipResult = await tryImportClipboardImageMac();
          if (clipResult) {
            if ("error" in clipResult) {
              onPasteErrorRef.current?.(clipResult.error);
              return;
            }
            insertPastedText(clipResult.placeholder);
          }
        })();
      } else {
        onPasteErrorRef.current?.(
          "Nothing to paste: no text in the clipboard. Copy the image file itself and paste its path.",
        );
      }
      return;
    }

    if (translated && translated.length > 0) {
      insertPastedText(translated);
    }
  });

  // Store callbacks in refs to avoid stale closures in event handlers
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const onBackspaceAtEmptyRef = useRef(onBackspaceAtEmpty);
  useEffect(() => {
    onBackspaceAtEmptyRef.current = onBackspaceAtEmpty;
  }, [onBackspaceAtEmpty]);

  const onPasteErrorRef = useRef(onPasteError);
  useEffect(() => {
    onPasteErrorRef.current = onPasteError;
  }, [onPasteError]);

  // Fallback paste aggregation. Ink 7 drops the fork's time-window paste
  // aggregator, so a paste without bracketed-paste markers arrives as many
  // small input events (one per stdin read) that individually look like
  // ordinary typing. Accumulate rapid successive insertions; once the run is
  // paste-sized, replace it with a placeholder (or sanitize it inline).
  const pasteBurstRef = useRef<{
    active: boolean;
    start: number;
    text: string;
    timer: ReturnType<typeof setTimeout> | null;
  }>({ active: false, start: 0, text: "", timer: null });

  const resetPasteBurst = useCallback(() => {
    const burst = pasteBurstRef.current;
    if (burst.timer) {
      clearTimeout(burst.timer);
      burst.timer = null;
    }
    burst.active = false;
    burst.text = "";
  }, []);

  const flushPasteBurst = useCallback(() => {
    const burst = pasteBurstRef.current;
    if (burst.timer) {
      clearTimeout(burst.timer);
      burst.timer = null;
    }
    if (!burst.active) {
      return;
    }
    const { start, text } = burst;
    burst.active = false;
    burst.text = "";

    const display = displayValueRef.current;
    // Bail if the run no longer sits where it did (an interleaved edit landed).
    if (display.slice(start, start + text.length) !== text) {
      return;
    }

    const translated = translatePasteForImages(text);
    const actual = actualValueRef.current;
    // Map the display offset to the actual offset (placeholders expand).
    const actualStart = resolvePlaceholders(display.slice(0, start)).length;

    if (countLines(translated) > 5 || translated.length > 500) {
      const pasteId = allocatePaste(translated);
      const placeholder = `[Pasted text #${pasteId} +${countLines(translated)} lines]`;
      const newDisplay =
        display.slice(0, start) +
        placeholder +
        display.slice(start + text.length);
      const newActual =
        actual.slice(0, actualStart) +
        translated +
        actual.slice(actualStart + text.length);
      setDraft(newDisplay, newActual);
      onChangeRef.current(newDisplay);
      const nextCaret = start + placeholder.length;
      setNudgeCursorOffset(nextCaret);
      caretOffsetRef.current = nextCaret;
      return;
    }

    // Small run: keep it inline, but sanitize newlines for display like the
    // bracketed-paste path does.
    const displayText = sanitizeForDisplay(translated);
    if (displayText === text && translated === text) {
      return;
    }
    const newDisplay =
      display.slice(0, start) +
      displayText +
      display.slice(start + text.length);
    const newActual =
      actual.slice(0, actualStart) +
      translated +
      actual.slice(actualStart + text.length);
    setDraft(newDisplay, newActual);
    onChangeRef.current(newDisplay);
    const nextCaret = start + displayText.length;
    setNudgeCursorOffset(nextCaret);
    caretOffsetRef.current = nextCaret;
  }, [setDraft]);

  useEffect(() => resetPasteBurst, [resetPasteBurst]);

  // Consolidated raw stdin handler for Option+Arrow navigation and Option+Delete
  // Uses internal_eventEmitter (Ink's private API) for escape sequences that useInput doesn't parse correctly.
  // Falls back gracefully if internal_eventEmitter is unavailable (useInput handler above still works for some cases).
  useEffect(() => {
    if (!internal_eventEmitter) return undefined;

    const moveCursorToPreviousWord = () => {
      const newPos = findPreviousWordBoundary(
        displayValueRef.current,
        caretOffsetRef.current,
      );
      setNudgeCursorOffset(newPos);
      caretOffsetRef.current = newPos;
    };

    const moveCursorToNextWord = () => {
      const newPos = findNextWordBoundary(
        displayValueRef.current,
        caretOffsetRef.current,
      );
      setNudgeCursorOffset(newPos);
      caretOffsetRef.current = newPos;
    };

    const deletePreviousWord = () => {
      const curPos = caretOffsetRef.current;
      const wordStart = findPreviousWordBoundary(
        displayValueRef.current,
        curPos,
      );
      if (wordStart === curPos) return;

      const newDisplay =
        displayValueRef.current.slice(0, wordStart) +
        displayValueRef.current.slice(curPos);
      const resolvedActual = resolvePlaceholders(newDisplay);

      setDraft(newDisplay, resolvedActual);
      onChangeRef.current(newDisplay);
      setNudgeCursorOffset(wordStart);
      caretOffsetRef.current = wordStart;
    };

    // Forward delete: delete character AFTER cursor
    const forwardDeleteAtCursor = (cursorPos: number) => {
      if (cursorPos >= displayValueRef.current.length) return;

      const newDisplay =
        displayValueRef.current.slice(0, cursorPos) +
        displayValueRef.current.slice(cursorPos + 1);
      const resolvedActual = resolvePlaceholders(newDisplay);

      // Update refs synchronously for consecutive operations
      caretOffsetRef.current = cursorPos;

      setDraft(newDisplay, resolvedActual);
      onChangeRef.current(newDisplay);
      // Cursor stays in place, sync it
      setNudgeCursorOffset(cursorPos);
    };

    const insertNewlineAtCursor = () => {
      const at = Math.max(
        0,
        Math.min(caretOffsetRef.current, displayValueRef.current.length),
      );

      const newValue =
        displayValueRef.current.slice(0, at) +
        "\n" +
        displayValueRef.current.slice(at);

      setDraft(newValue, newValue);
      onChangeRef.current(newValue);

      const nextCaret = at + 1;
      setNudgeCursorOffset(nextCaret);
      caretOffsetRef.current = nextCaret;
    };

    // Move cursor to beginning of input (Home key)
    const moveCursorToStart = () => {
      setNudgeCursorOffset(0);
      caretOffsetRef.current = 0;
    };

    // Move cursor to end of input (End key)
    const moveCursorToEnd = () => {
      const endPos = displayValueRef.current.length;
      setNudgeCursorOffset(endPos);
      caretOffsetRef.current = endPos;
    };

    const handleRawInput = (payload: unknown) => {
      if (!focusRef.current) return;

      // Extract sequence from payload (may be string or object with sequence property)
      let sequence: string | null = null;
      if (typeof payload === "string") {
        sequence = payload;
      } else if (
        payload &&
        typeof payload === "object" &&
        typeof (payload as { sequence?: unknown }).sequence === "string"
      ) {
        sequence = (payload as { sequence?: string }).sequence ?? null;
      }
      if (!sequence) return;

      // Optional debug logging for raw input bytes
      if (process.env.HARUYUKI_DEBUG_INPUT === "1") {
        const debugHex = [...sequence]
          .map((c) => `0x${c.charCodeAt(0).toString(16).padStart(2, "0")}`)
          .join(" ");
        // eslint-disable-next-line no-console
        console.error(
          `[debug:raw-input] len=${sequence.length} hex: ${debugHex}`,
        );
      }

      // Option+Enter (Alt+Enter): ESC + carriage return
      // On macOS with "Option as Meta" enabled, this sends \x1b\r
      // Also check for \x1b\n (ESC + newline) for compatibility
      if (sequence === "\x1b\r" || sequence === "\x1b\n") {
        insertNewlineAtCursor();
        return;
      }

      // VS Code/Cursor terminal keybinding style:
      // Often configured to send a literal "\\r" sequence for Shift+Enter.
      // Treat it as newline.
      if (sequence === "\\r") {
        insertNewlineAtCursor();
        return;
      }

      // CSI u modifier+Enter (ESC[13;Nu) is now handled by the CSI u fallback
      // in use-input.js, which parses it as return + shift/ctrl/meta flags.
      // The useInput handler at line 186 then handles the newline insertion.

      // Note: Arrow keys with modifiers are now handled natively by parseKeypress
      // since we use kitty protocol flag 1 only (no event types).
      // With flag 1, arrows come as ESC[1;modifierD which parseKeypress recognizes.
      // Previously we handled ESC[1;modifier:eventD format (with flag 7) here.

      // Home key: ESC[H (standard) or ESC[1~ (VT100/xterm) or ESCOH (xterm)
      if (
        sequence === "\x1b[H" ||
        sequence === "\x1b[1~" ||
        sequence === "\x1bOH"
      ) {
        moveCursorToStart();
        return;
      }

      // End key: ESC[F (standard) or ESC[4~ (VT100/xterm) or ESCOF (xterm)
      if (
        sequence === "\x1b[F" ||
        sequence === "\x1b[4~" ||
        sequence === "\x1bOF"
      ) {
        moveCursorToEnd();
        return;
      }

      // fn+Delete (forward delete): ESC[3~ - standard ANSI escape sequence
      // With kitty flag 1, modifiers come as ESC[3;modifier~ (no event type).
      // Use caretOffsetRef which is updated synchronously via onCursorOffsetChange
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ESC sequence matching
      if (sequence === "\x1b[3~" || /^\x1b\[3;\d+~$/.test(sequence)) {
        // Set timestamp so ink-text-input skips its delete handling
        globalThis.__haruyukiForwardDeleteTimestamp = Date.now();
        forwardDeleteAtCursor(caretOffsetRef.current);
        return;
      }

      // Option+Delete sequences (check first as they're exact matches)
      // - iTerm2/some terminals: ESC + DEL (\x1b\x7f)
      // - Some terminals: ESC + Backspace (\x1b\x08)
      // - Warp: Ctrl+W (\x17)
      // Note: macOS Terminal sends plain \x7f (same as regular delete) - no modifier info
      if (
        sequence === "\x1b\x7f" ||
        sequence === "\x1b\x08" ||
        sequence === "\x1b\b" ||
        sequence === "\x17"
      ) {
        deletePreviousWord();
        return;
      }

      // Option+Arrow navigation (only process escape sequences)
      if (sequence.length <= 32 && sequence.includes("\u001b")) {
        const parts = sequence.split("\u001b");
        for (let i = 1; i < parts.length; i++) {
          const dir = detectOptionWordDirection(`\u001b${parts[i]}`);
          if (dir === "left") {
            moveCursorToPreviousWord();
            return;
          }
          if (dir === "right") {
            moveCursorToNextWord();
            return;
          }
        }
      }
    };

    internal_eventEmitter.prependListener("input", handleRawInput);
    return () => {
      internal_eventEmitter.removeListener("input", handleRawInput);
    };
  }, [internal_eventEmitter, setDraft]);

  const handleChange = (newValue: string) => {
    // Bash mode entry: intercept "!" typed on empty input BEFORE updating state
    // This prevents any flicker since we never commit the "!" to displayValue
    if (displayValueRef.current === "" && newValue === "!") {
      if (onBangAtEmpty?.()) {
        // Parent handled it (entered bash mode) - don't update our state
        return;
      }
    }

    // Drop lone escape characters that Ink's text input would otherwise insert;
    // they are used as control keys for double-escape handling and should not
    // mutate the input value.
    const sanitizedValue = newValue.replaceAll("\u001b", "");
    if (sanitizedValue !== newValue) {
      // Keep caret in bounds after stripping control chars
      const nextCaret = Math.min(caretOffsetRef.current, sanitizedValue.length);
      setNudgeCursorOffset(nextCaret);
      caretOffsetRef.current = nextCaret;
      newValue = sanitizedValue;
      // If nothing actually changed after stripping, bail out early
      if (sanitizedValue === displayValueRef.current) {
        return;
      }
    }

    const previousValue = displayValueRef.current;
    const addedLen = newValue.length - previousValue.length;

    // Normal typing/edits - update display and compute actual by substituting placeholders
    setDraft(newValue, resolvePlaceholders(newValue));
    onChange(newValue);
    // Note: caretOffsetRef is updated by onCursorOffsetChange callback (called before onChange)

    // Fallback aggregation for a markerless paste delivered as many small
    // changes: extend the current run of rapid insertions, and collapse it to a
    // placeholder once it is paste-sized (see flushPasteBurst).
    if (addedLen <= 0) {
      resetPasteBurst();
      return;
    }
    const a = previousValue;
    const b = newValue;
    let lcp = 0;
    while (lcp < a.length && lcp < b.length && a[lcp] === b[lcp]) lcp++;
    let lcs = 0;
    while (
      lcs < a.length - lcp &&
      lcs < b.length - lcp &&
      a[a.length - 1 - lcs] === b[b.length - 1 - lcs]
    )
      lcs++;
    const inserted = b.slice(lcp, b.length - lcs);
    if (inserted.length === 0 || inserted.includes("\u001b")) {
      resetPasteBurst();
      return;
    }
    const burst = pasteBurstRef.current;
    if (
      burst.active &&
      lcp === burst.start + burst.text.length &&
      inserted.length > 1
    ) {
      burst.text += inserted;
    } else {
      resetPasteBurst();
      burst.active = true;
      burst.start = lcp;
      burst.text = inserted;
    }
    if (burst.timer) {
      clearTimeout(burst.timer);
    }
    burst.timer = setTimeout(
      flushPasteBurst,
      burst.text.length >= PASTE_FALLBACK_ESCALATE_AT
        ? PASTE_FALLBACK_PASTE_MS
        : PASTE_FALLBACK_NORMAL_MS,
    );
  };

  const handleSubmit = () => {
    if (onSubmit) {
      // Pass the display value (with placeholders) to onSubmit
      // The parent will handle conversion to content parts and cleanup
      onSubmit(displayValueRef.current);
    }
  };

  // Clear one-shot cursor nudge after it applies
  useEffect(() => {
    if (typeof nudgeCursorOffset === "number") {
      const t = setTimeout(() => setNudgeCursorOffset(undefined), 0);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [nudgeCursorOffset]);

  return (
    <TextInput
      value={displayValue}
      externalCursorOffset={nudgeCursorOffset}
      onCursorOffsetChange={(n: number) => {
        caretOffsetRef.current = n;
        onCursorMove?.(n);
      }}
      onChange={handleChange}
      onSubmit={handleSubmit}
      placeholder={placeholder}
      focus={focus}
    />
  );
}
