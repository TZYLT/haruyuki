// Paste-aware text input wrapper that:
// 1. Detects large pastes (>5 lines or >500 chars) and replaces them with a
//    placeholder in the *display* value — the value the parent renders, stores and
//    submits; placeholders are resolved downstream
//    (`buildMessageContentFromDisplay`, `resolvePlaceholders`).
// 2. Supports image pasting (iTerm2 inline, data URLs, file paths, macOS clipboard)
//
// There is deliberately no second "actual" copy of the draft in here: every
// insertion below builds the display string, and the one resolution point is the
// submit path. Keeping a shadow copy invited offset arithmetic on a string whose
// placeholders make display and resolved offsets differ.

// Bracketed paste arrives on Ink's own channel; the key bindings live in the
// input router's table (see cli/helpers/keymap.ts).
import { usePaste } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  translatePasteForImages,
  tryImportClipboardImageMac,
} from "@/cli/helpers/clipboard";
import type { KeyBindingTable, KeyOutcome } from "@/cli/helpers/input-keys";
import { consumeKey } from "@/cli/helpers/input-keys";
import { forwardInputEvent } from "@/cli/helpers/input-router";
import { COMPOSER_KEY_CHORDS } from "@/cli/helpers/keymap";
import { allocatePaste } from "@/cli/helpers/paste-registry";
import { useKeyBindings } from "@/cli/hooks/use-input-router";
import { useInternalEventEmitter } from "@/cli/hooks/use-internal-event-emitter";
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

interface PasteAwareTextInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  placeholder?: string;
  focus?: boolean;
  /**
   * A single character repeated over the value, for a secret field. The draft
   * this component holds and reports is still the real value — only the paint is
   * masked — so an overlay's API-key field gets a caret and the paste channel
   * without the key becoming visible.
   */
  mask?: string;
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

export function PasteAwareTextInput({
  value,
  onChange,
  onSubmit,
  placeholder,
  focus = true,
  mask,
  cursorPosition,
  onCursorMove,
  onBangAtEmpty,
  onBackspaceAtEmpty,
  onPasteError,
}: PasteAwareTextInputProps) {
  // The paste channel needs the emitter to forward an unroutable paste to a raw
  // `TextInput`; the private name lives in one accessor module.
  const internalEventEmitter = useInternalEventEmitter();
  const [displayValue, setDisplayValue] = useState(value);
  const caretOffsetRef = useRef<number>((value || "").length);
  const [nudgeCursorOffset, setNudgeCursorOffset] = useState<
    number | undefined
  >(undefined);
  const displayValueRef = useRef(displayValue);
  const focusRef = useRef(focus);

  // Keep the draft in a ref as well as state: a sequence of edits can arrive before
  // React re-renders (back-to-back pastes, an IME commit split across reads), and each
  // one must read the previous result rather than a stale `displayValue` from the last
  // render.
  const setDraft = useCallback((nextDisplay: string) => {
    displayValueRef.current = nextDisplay;
    setDisplayValue(nextDisplay);
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
    setDraft(value);

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

  const insertNewlineAtCaret = useCallback(() => {
    const at = Math.max(
      0,
      Math.min(caretOffsetRef.current, displayValueRef.current.length),
    );

    // Insert actual \n for visual newline (cursor moves to new line)
    const newValue =
      displayValueRef.current.slice(0, at) +
      "\n" +
      displayValueRef.current.slice(at);

    setDraft(newValue); // A visual newline is one character in the draft too
    onChangeRef.current(newValue);

    const nextCaret = at + 1;
    setNudgeCursorOffset(nextCaret);
    caretOffsetRef.current = nextCaret;
  }, [setDraft]);

  // Native terminals do not send image data through bracketed paste, so the
  // clipboard is probed directly.
  const insertClipboardImage = useCallback(() => {
    void (async () => {
      const result = await tryImportClipboardImageMac();
      if (!result) return;
      if ("error" in result) {
        // Report the error via callback
        onPasteErrorRef.current?.(result.error);
        return;
      }
      // Success - insert the placeholder
      const placeholder = result.placeholder;
      const base = displayValueRef.current;
      const at = Math.max(0, Math.min(caretOffsetRef.current, base.length));
      const newDisplay = base.slice(0, at) + placeholder + base.slice(at);
      setDraft(newDisplay);
      onChangeRef.current(newDisplay);
      const nextCaret = at + placeholder.length;
      setNudgeCursorOffset(nextCaret);
      caretOffsetRef.current = nextCaret;
    })();
  }, [setDraft]);

  // macOS only: elsewhere the terminal owns Ctrl+V as a paste binding, so the
  // binding declines and the key travels the ordinary path.
  const pasteImageMac = useCallback((): boolean | void => {
    if (process.platform !== "darwin") return false;
    insertClipboardImage();
  }, [insertClipboardImage]);

  // Backspace on an empty draft is handled here because `handleChange` never
  // fires (the value does not change when backspacing on empty). The callback's
  // answer is what decides whether the key is consumed: the prop documents "return
  // true to consume", and returning `undefined` here made every decline a swallow.
  const backspaceAtEmpty = useCallback((): boolean | void => {
    if (displayValueRef.current !== "") return false;
    return onBackspaceAtEmptyRef.current?.();
  }, []);

  const caretPreviousWord = useCallback(() => {
    const newPos = findPreviousWordBoundary(
      displayValueRef.current,
      caretOffsetRef.current,
    );
    setNudgeCursorOffset(newPos);
    caretOffsetRef.current = newPos;
  }, []);

  const caretNextWord = useCallback(() => {
    const newPos = findNextWordBoundary(
      displayValueRef.current,
      caretOffsetRef.current,
    );
    setNudgeCursorOffset(newPos);
    caretOffsetRef.current = newPos;
  }, []);

  const deletePreviousWord = useCallback(() => {
    const curPos = caretOffsetRef.current;
    const wordStart = findPreviousWordBoundary(displayValueRef.current, curPos);
    if (wordStart === curPos) return;

    const newDisplay =
      displayValueRef.current.slice(0, wordStart) +
      displayValueRef.current.slice(curPos);
    setDraft(newDisplay);
    onChangeRef.current(newDisplay);
    setNudgeCursorOffset(wordStart);
    caretOffsetRef.current = wordStart;
  }, [setDraft]);

  // Forward delete: delete the character AFTER the cursor.
  const deleteNextChar = useCallback(() => {
    const cursorPos = caretOffsetRef.current;
    if (cursorPos >= displayValueRef.current.length) return;

    const newDisplay =
      displayValueRef.current.slice(0, cursorPos) +
      displayValueRef.current.slice(cursorPos + 1);
    setDraft(newDisplay);
    // Update refs synchronously for consecutive operations
    caretOffsetRef.current = cursorPos;
    onChangeRef.current(newDisplay);
    // Cursor stays in place, sync it
    setNudgeCursorOffset(cursorPos);
  }, [setDraft]);

  const caretToStart = useCallback(() => {
    setNudgeCursorOffset(0);
    caretOffsetRef.current = 0;
  }, []);

  const caretToEnd = useCallback(() => {
    const endPos = displayValueRef.current.length;
    setNudgeCursorOffset(endPos);
    caretOffsetRef.current = endPos;
  }, []);

  /** A binding that applies only while this input is the focused one. */
  const whileFocused = (run: () => void): (() => KeyOutcome) => {
    return () => {
      if (!focusRef.current) return "declined";
      run();
      return "consumed";
    };
  };

  // The text editor's own keys. They stay out of the app shortcut table because
  // they are not app-level actions: they apply whenever this input has focus and
  // decline otherwise, which is how the always-mounted composer stays out of the
  // way while an overlay's input is the focused one. Registered for the app and
  // the overlay layer alike, since selectors and dialogs use this component too.
  const textEditingTables: KeyBindingTable[] = (
    ["app", "overlay"] as const
  ).map((scope) => ({
    scope,
    bindings: [
      {
        id: `${scope}.editor.insertNewline`,
        chords: COMPOSER_KEY_CHORDS.insertNewline,
        run: whileFocused(insertNewlineAtCaret),
      },
      {
        id: `${scope}.editor.caretPreviousWord`,
        chords: COMPOSER_KEY_CHORDS.caretPreviousWord,
        run: whileFocused(caretPreviousWord),
      },
      {
        id: `${scope}.editor.caretNextWord`,
        chords: COMPOSER_KEY_CHORDS.caretNextWord,
        run: whileFocused(caretNextWord),
      },
      {
        id: `${scope}.editor.deletePreviousWord`,
        chords: COMPOSER_KEY_CHORDS.deletePreviousWord,
        run: whileFocused(deletePreviousWord),
      },
      {
        id: `${scope}.editor.deleteNextChar`,
        chords: COMPOSER_KEY_CHORDS.deleteNextChar,
        run: whileFocused(deleteNextChar),
      },
      {
        id: `${scope}.editor.caretToStart`,
        chords: COMPOSER_KEY_CHORDS.caretToStart,
        run: whileFocused(caretToStart),
      },
      {
        id: `${scope}.editor.caretToEnd`,
        chords: COMPOSER_KEY_CHORDS.caretToEnd,
        run: whileFocused(caretToEnd),
      },
      {
        id: `${scope}.editor.pasteImageMac`,
        chords: COMPOSER_KEY_CHORDS.pasteImageMac,
        run: () => {
          if (!focusRef.current) return "declined";
          return consumeKey(pasteImageMac)();
        },
      },
      {
        id: `${scope}.editor.pasteImage`,
        chords: COMPOSER_KEY_CHORDS.pasteImage,
        run: whileFocused(insertClipboardImage),
      },
      {
        // Claims Backspace only while the draft is empty; declines otherwise so
        // the text input still deletes.
        id: `${scope}.editor.backspaceAtEmpty`,
        chords: COMPOSER_KEY_CHORDS.backspaceAtEmpty,
        run: () => {
          if (!focusRef.current) return "declined";
          return consumeKey(backspaceAtEmpty)();
        },
      },
    ],
  }));

  useKeyBindings("composer-input", textEditingTables);

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
      forwardInputEvent(internalEventEmitter, text);
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
        setDraft(newDisplay);
        onChange(newDisplay);
        const nextCaret = at + placeholder.length;
        setNudgeCursorOffset(nextCaret);
        caretOffsetRef.current = nextCaret;
      } else {
        const displayText = sanitizeForDisplay(value);
        const newDisplay = base.slice(0, at) + displayText + base.slice(at);
        setDraft(newDisplay);
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

    if (countLines(translated) > 5 || translated.length > 500) {
      const pasteId = allocatePaste(translated);
      const placeholder = `[Pasted text #${pasteId} +${countLines(translated)} lines]`;
      const newDisplay =
        display.slice(0, start) +
        placeholder +
        display.slice(start + text.length);
      setDraft(newDisplay);
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
    setDraft(newDisplay);
    onChangeRef.current(newDisplay);
    const nextCaret = start + displayText.length;
    setNudgeCursorOffset(nextCaret);
    caretOffsetRef.current = nextCaret;
  }, [setDraft]);

  useEffect(() => resetPasteBurst, [resetPasteBurst]);

  const handleChange = (newValue: string): boolean | void => {
    // Bash mode entry: intercept "!" typed on empty input BEFORE updating state
    // This prevents any flicker since we never commit the "!" to displayValue.
    // `false` tells the leaf input the edit was refused, so it drops the "!" it
    // optimistically applied; without that the next keystroke built on it and the
    // first bash command came out as `!cmd`.
    if (displayValueRef.current === "" && newValue === "!") {
      if (onBangAtEmpty?.()) {
        // Parent handled it (entered bash mode) - don't update our state
        return false;
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

    // Normal typing/edits: the draft is the display string, placeholders and all.
    setDraft(newValue);
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
      mask={mask}
      focus={focus}
    />
  );
}
