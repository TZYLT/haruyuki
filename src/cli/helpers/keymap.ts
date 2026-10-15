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
  /** Scroll the transcript up one screen. */
  scrollPageUp: [{ key: "pageUp" }],
  /** Scroll the transcript down one screen. */
  scrollPageDown: [{ key: "pageDown" }],
  /**
   * Jump to the newest row and resume following.
   *
   * Ctrl+D was the first choice and is gone: this machine's GPU vendor registers
   * it as a global hotkey, so the key never reaches the terminal. Shift+PageDown
   * is the pair a pager would use, and the alternate screen keeps the terminal
   * from taking it for its own scrollback.
   */
  scrollToNewest: [{ key: "pageDown", shift: true }],
  /** Jump to the oldest loaded row (the far end of the history). */
  scrollToOldest: [{ key: "pageUp", shift: true }],
} as const satisfies Record<string, KeyChordList>;

/**
 * Composer editing, which the raw stdin layer used to own.
 *
 * Several of these carry more than one chord because terminals disagree about
 * how to encode them, and the old raw handler accepted a family of sequences for
 * each: "Option+Left" arrived as `ESC b`, `CSI 1;3D`, and (on terminals in the
 * older xterm mode) `CSI 7D` / `CSI 8D` / `CSI 1;4D`. Ink decodes all of those to
 * a left arrow with meta held, so the variants reduce to the modifier
 * combinations here. A sequence the shield does not read exactly still reaches
 * these chords through the router's Ink-parsed fallback.
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
    { key: "leftArrow", meta: true, shift: true },
    { key: "leftArrow", meta: true, ctrl: true },
    { key: "leftArrow", meta: true, ctrl: true, shift: true },
    { key: "b", meta: true },
  ],
  /** Option+Right: caret to the next word boundary. */
  caretNextWord: [
    { key: "rightArrow", meta: true },
    { key: "rightArrow", meta: true, shift: true },
    { key: "rightArrow", meta: true, ctrl: true },
    { key: "rightArrow", meta: true, ctrl: true, shift: true },
    { key: "f", meta: true },
  ],
  /** Option+Delete / Ctrl+W: delete the word before the caret. */
  deletePreviousWord: [
    { key: "backspace", meta: true },
    { key: "w", ctrl: true },
  ],
  /** fn+Delete: delete the character after the caret. */
  deleteNextChar: [
    { key: "delete" },
    { key: "delete", shift: true },
    { key: "delete", ctrl: true },
    { key: "delete", ctrl: true, shift: true },
  ],
  /** Home: caret to the start of the draft. */
  caretToStart: [{ key: "home" }],
  /** End: caret to the end of the draft. */
  caretToEnd: [{ key: "end" }],
  /**
   * macOS Ctrl+V: the terminal cannot deliver an image through bracketed paste,
   * so the key probes the clipboard. Elsewhere the terminal owns Ctrl+V, and the
   * binding declines so the key travels the ordinary path.
   */
  pasteImageMac: [{ key: "v", ctrl: true }],
  /** Option+V / Ctrl+Shift+V: the explicit image-paste keys other terminals send. */
  pasteImage: [
    { key: "v", meta: true },
    { key: "v", ctrl: true, shift: true },
  ],
  /**
   * Backspace on an empty draft: leave bash mode. Claimed only while the draft is
   * empty — the binding declines otherwise, so the text input still deletes.
   */
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

/**
 * The leader prefix and the keys behind it.
 *
 * `activate` is an ordinary app chord; `help` and anything added later are
 * *second* keys — reachable only while the prefix is armed, so a plain letter
 * costs typing nothing (`KeyBinding.leader`). M3-3 ships the mechanism with one
 * entry on purpose: the table's contents are the command palette's job (M6),
 * which must read the command registry rather than a list hard-coded here.
 *
 * `Ctrl+X` is free (see `RESERVED_FUTURE_CHORDS`), mnemonic for "eXecute", and
 * the same shape as Emacs' `C-x`, tmux's `Ctrl+B`, and VS Code's `Ctrl+K`.
 */
export const LEADER_KEY_CHORDS = {
  /** Arm the leader prefix: the next key is a command. */
  activate: [{ key: "x", ctrl: true }],
  /**
   * List what the prefix can do.
   *
   * Three chords, one key: `?` is Shift+/ on most layouts, and terminals report
   * that as a modified `/` (Kitty protocol) or as a plain `?` (classic mode, with
   * or without the shift flag). The first entry is the one the hint prints; the
   * rest are the same keystroke in another encoding.
   */
  help: [{ key: "?" }, { key: "?", shift: true }, { key: "/", shift: true }],
} as const satisfies Record<string, KeyChordList>;

/** Reserved by later milestones so no M3 binding can claim them by accident. */
export const RESERVED_FUTURE_CHORDS: KeyChordList = [
  { key: "p", ctrl: true }, // command palette (M6)
];

/** Every chord the app currently registers, flattened for conflict checks. */
export function registeredKeyChords(): { id: string; chord: KeyChord }[] {
  const tables: Record<string, Record<string, KeyChordList>> = {
    app: APP_KEY_CHORDS,
    composer: COMPOSER_KEY_CHORDS,
    system: SYSTEM_KEY_CHORDS,
    leader: LEADER_KEY_CHORDS,
  };
  const chords: { id: string; chord: KeyChord }[] = [];
  for (const [table, bindings] of Object.entries(tables)) {
    for (const [name, list] of Object.entries(bindings)) {
      for (const chord of list) chords.push({ id: `${table}.${name}`, chord });
    }
  }
  return chords;
}
