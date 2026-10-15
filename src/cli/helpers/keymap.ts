import type { KeyChord } from "./input-keys";

/**
 * The app's key table.
 *
 * Every chord the input router owns is declared here, once, so that "who has
 * this key" is answerable by reading one file — and so a test can prove that no
 * two bindings claim the same chord (`keymap.test.ts`). Handlers stay with the
 * context that owns the behaviour; only the chords are data.
 *
 * Values are lists so one binding can answer to several sequences (the raw layer
 * saw Option+Delete as `ESC DEL`, `ESC BS`, or Ctrl+W depending on terminal).
 */
export type KeyChordList = readonly KeyChord[];

/** Transcript and app-level shortcuts. Active whenever a modal or overlay does not own input. */
export const APP_KEY_CHORDS = {
  /** Expand/collapse the output of the last shell tool call. */
  toggleShellOutput: [{ key: "o", ctrl: true }],
  /** Expand/collapse the live subagent group. */
  toggleSubagents: [{ key: "g", ctrl: true }],
  /** Show/hide system reminders (and recall summaries with them). */
  toggleSystemReminders: [{ key: "r", ctrl: true }],
  /** Expand/collapse thinking blocks. */
  toggleThinking: [{ key: "t", ctrl: true }],
  /** Clear the draft; a second press within the window exits. */
  clearOrExit: [{ key: "c", ctrl: true }],
  /** Interrupt a running turn, else arm/perform the double-escape draft clear. */
  interrupt: [{ key: "escape" }],
  /** Cycle the reasoning-effort tier for the current model. */
  cycleReasoningEffort: [{ key: "tab" }],
  /** Cycle the permission mode. */
  cyclePermissionMode: [{ key: "tab", shift: true }],
} as const satisfies Record<string, KeyChordList>;

/**
 * Composer editing the raw stdin layer used to own, because Ink's parsed event
 * was not enough to tell which sequence arrived. Registered as normal chords now
 * that one router parses every sequence.
 */
export const COMPOSER_KEY_CHORDS = {
  /** Insert a newline instead of submitting. */
  insertNewline: [
    { key: "return", shift: true },
    { key: "return", meta: true },
  ],
  /** Option+Left: caret to the previous word boundary. */
  caretPreviousWord: [
    { key: "leftArrow", meta: true },
    { key: "b", meta: true },
  ],
  /** Option+Right: caret to the next word boundary. */
  caretNextWord: [
    { key: "rightArrow", meta: true },
    { key: "f", meta: true },
  ],
  /** Option+Delete / Ctrl+W: delete the word before the caret. */
  deletePreviousWord: [
    { key: "backspace", meta: true },
    { key: "w", ctrl: true },
  ],
  /** fn+Delete: delete the character after the caret. */
  deleteNextChar: [{ key: "delete" }],
  /** Home: caret to the start of the draft. */
  caretToStart: [{ key: "home" }],
  /** End: caret to the end of the draft. */
  caretToEnd: [{ key: "end" }],
  /**
   * Import an image from the clipboard where the terminal cannot paste it.
   * Ctrl+V is the macOS probe; Option+V and Ctrl+Shift+V are the explicit
   * bindings other terminals send.
   */
  pasteImage: [
    { key: "v", ctrl: true },
    { key: "v", meta: true },
    { key: "v", ctrl: true, shift: true },
  ],
  /** Backspace on an empty draft: leave bash mode (second press). */
  backspaceAtEmpty: [{ key: "backspace" }],
} as const satisfies Record<string, KeyChordList>;

/** Keys that stay reachable no matter which scope owns input. */
export const SYSTEM_KEY_CHORDS = {
  /** Suspend the process (Ctrl+Z / `fg` to resume). */
  suspend: [{ key: "z", ctrl: true }],
} as const satisfies Record<string, KeyChordList>;

/**
 * Chords the leaf text editor owns inside `TextInput`. Nothing else may bind
 * them: they are the character-level editing set, and taking one would silently
 * remove a keystroke from typing.
 */
export const RESERVED_TEXT_CHORDS: KeyChordList = [
  { key: "return" },
  { key: "backspace" },
  { key: "leftArrow" },
  { key: "rightArrow" },
  { key: "upArrow" },
  { key: "downArrow" },
  { key: "a", ctrl: true },
  { key: "e", ctrl: true },
  { key: "k", ctrl: true },
  { key: "u", ctrl: true },
  { key: "y", ctrl: true },
];

/** Reserved by later milestones so no M3 binding can claim them by accident. */
export const RESERVED_FUTURE_CHORDS: KeyChordList = [
  { key: "x", ctrl: true }, // leader key (M3-3)
  { key: "p", ctrl: true }, // command palette (M6)
];

/** Every chord the app currently registers, flattened for conflict checks. */
export function registeredKeyChords(): { id: string; chord: KeyChord }[] {
  const tables: Record<string, Record<string, KeyChordList>> = {
    app: APP_KEY_CHORDS,
    composer: COMPOSER_KEY_CHORDS,
    system: SYSTEM_KEY_CHORDS,
  };
  const chords: { id: string; chord: KeyChord }[] = [];
  for (const [table, bindings] of Object.entries(tables)) {
    for (const [name, list] of Object.entries(bindings)) {
      for (const chord of list) chords.push({ id: `${table}.${name}`, chord });
    }
  }
  return chords;
}
