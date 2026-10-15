import type { Key } from "ink";
import type { KeyEvent } from "./input-keys";

/**
 * The raw-sequence shield: which raw stdin strings the router can read on its
 * own, before Ink's `useInput` handlers run.
 *
 * Why it exists: Ink fans one stdin event out to every `useInput` listener with
 * no stopPropagation, so "one key, one action" can only be *guaranteed* by a
 * listener that runs first and can decide not to pass the event on. Ink does not
 * export the parser `useInput` uses (`ink/build/parse-keypress.js` is not in its
 * `exports` map), so the shield recognizes a **deliberately small,
 * sound-by-construction** set:
 *
 * - single-character sequences, whose reading is unambiguous (a control
 *   character below 0x1b is Ctrl+letter, anything printable is itself),
 * - an exact-match table of the multi-character sequences the app binds, and
 * - a short table of terminal/editor workarounds, each carrying its reason.
 *
 * Everything else returns `undefined`, and the caller lets the event travel the
 * ordinary path: Ink parses it and the router's own `useInput` fallback routes
 * it. Incomplete coverage therefore costs nothing (the key still works, it is
 * just not shielded from legacy handlers); what matters is that the shield never
 * claims a sequence it read *differently* from Ink. The first two tables are
 * pinned against real `useInput` output, and the third is checked to be
 * disjoint from them, in `input-sequence.equivalence.test.tsx`.
 *
 * The single-character rule is also the seed of the raw layer the mouse
 * milestone needs, where the question is the same one: is this raw input a key
 * the app owns, or something else entirely?
 */

/** A raw sequence with the `(input, key)` pair Ink would produce for it. */
interface SequenceShape {
  input: string;
  key: Partial<Key>;
}

const ESC = "\u001B";

/**
 * Exact multi-character sequences the app binds. Every entry is an exact string
 * on purpose: no attempt at the general CSI grammar, so no chance of reading a
 * sequence differently than Ink would.
 */
const EXACT_SEQUENCES: ReadonlyMap<string, SequenceShape> = new Map([
  [ESC, { input: "", key: { escape: true } }],
  // Ink reads a doubled Escape as escape + meta, and strips only one escape
  // prefix, so its `input` keeps a bare ESC. Listed separately so the shield
  // does not have to guess.
  [`${ESC}${ESC}`, { input: ESC, key: { escape: true, meta: true } }],
  ["\r", { input: "\r", key: { return: true } }],
  ["\t", { input: "", key: { tab: true } }],
  ["\u007F", { input: "", key: { backspace: true } }],
  ["\b", { input: "", key: { backspace: true } }],
  [" ", { input: " ", key: {} }],
  [`${ESC}[Z`, { input: "", key: { tab: true, shift: true } }],
  [`${ESC}[3~`, { input: "", key: { delete: true } }],
  [`${ESC}[5~`, { input: "", key: { pageUp: true } }],
  [`${ESC}[6~`, { input: "", key: { pageDown: true } }],
  // Shift+PageUp / Shift+PageDown: the classic form, and the pair the transcript
  // scrolls to either end of the history with.
  [`${ESC}[5;2~`, { input: "", key: { pageUp: true, shift: true } }],
  [`${ESC}[6;2~`, { input: "", key: { pageDown: true, shift: true } }],
  [`${ESC}[H`, { input: "", key: { home: true } }],
  [`${ESC}[1~`, { input: "", key: { home: true } }],
  [`${ESC}OH`, { input: "", key: { home: true } }],
  [`${ESC}[F`, { input: "", key: { end: true } }],
  [`${ESC}[4~`, { input: "", key: { end: true } }],
  [`${ESC}OF`, { input: "", key: { end: true } }],
  // Option+Arrow: CSI 1;3 (meta) + final letter.
  [`${ESC}[1;3C`, { input: "", key: { rightArrow: true, meta: true } }],
  [`${ESC}[1;3D`, { input: "", key: { leftArrow: true, meta: true } }],
  // Option+Delete, in the two shapes terminals send.
  [`${ESC}\u007F`, { input: "", key: { backspace: true, meta: true } }],
  [`${ESC}\b`, { input: "", key: { backspace: true, meta: true } }],
  // Option+Enter.
  [`${ESC}\r`, { input: "\r", key: { return: true, meta: true } }],
  // Option+B / Option+F: word motion on terminals that use the older form.
  [`${ESC}b`, { input: "b", key: { meta: true } }],
  [`${ESC}f`, { input: "f", key: { meta: true } }],
]);

/**
 * Sequences the fork already treated as a key, which Ink reads differently (or
 * not at all). They are listed apart from `EXACT_SEQUENCES` precisely because
 * they are **not** Ink-equivalent: each is a terminal or editor configuration
 * that sends something else for a key, carried over from the raw stdin handler
 * this table replaces. The reason is part of the entry so the list cannot grow
 * silently.
 */
const TERMINAL_WORKAROUNDS: ReadonlyMap<
  string,
  { input: string; key: Partial<Key>; reason: string }
> = new Map([
  [
    `${ESC}\n`,
    {
      input: "\r",
      key: { return: true, meta: true },
      reason:
        "some terminals send ESC LF for Option+Enter; Ink reads it as an unnamed sequence",
    },
  ],
  [
    "\\r",
    {
      input: "\r",
      key: { return: true, meta: true },
      reason:
        'VS Code/Cursor keybindings are commonly configured to send a literal "\\r" for Shift+Enter',
    },
  ],
]);

/** The workaround sequences and why each exists, for tests and diagnostics. */
export function terminalWorkaroundSequences(): {
  sequence: string;
  reason: string;
}[] {
  return [...TERMINAL_WORKAROUNDS.entries()].map(([sequence, entry]) => ({
    sequence,
    reason: entry.reason,
  }));
}

/**
 * A single character, read the way Ink reads it.
 *
 * The exclusions matter and are the reason this is not a one-liner: Ink handles
 * `\r` (return), `\n` (a name of its own, `enter`), `\t` (tab) and `\b`
 * (backspace) *before* its control-character rule, so none of them is Ctrl+letter.
 * `\r`, `\t` and `\b` come from the exact table; `\n` Ink names `enter` and gives
 * it no flag this table can express, so it is left to Ink.
 */
function singleCharacterShape(char: string): SequenceShape | undefined {
  const code = char.charCodeAt(0);
  if (code === 8 || code === 9 || code === 10 || code === 13 || code === 27) {
    return undefined;
  }
  if (code >= 1 && code <= 26) {
    return { input: String.fromCharCode(code + 96), key: { ctrl: true } };
  }
  if (code >= 32 && code !== 127) {
    return { input: char, key: /[A-Z]/.test(char) ? { shift: true } : {} };
  }
  return undefined;
}

const KEY_DEFAULTS: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  super: false,
  hyper: false,
  capsLock: false,
  numLock: false,
};

/** A `KeyEvent` with every flag defaulted, for callers that have the pair already. */
export function keyEventFrom(input: string, key?: Partial<Key>): KeyEvent {
  return { input, key: { ...KEY_DEFAULTS, ...key } };
}

/**
 * Read a raw stdin string, or `undefined` when this module does not understand
 * it (the caller must then let Ink parse it).
 */
export function shieldKeyEvent(raw: string): KeyEvent | undefined {
  const exact = EXACT_SEQUENCES.get(raw);
  if (exact) return keyEventFrom(exact.input, exact.key);
  const workaround = TERMINAL_WORKAROUNDS.get(raw);
  if (workaround) return keyEventFrom(workaround.input, workaround.key);
  if (raw.length !== 1) return undefined;
  const shape = singleCharacterShape(raw);
  return shape ? keyEventFrom(shape.input, shape.key) : undefined;
}

/** The exact sequences the shield understands, for tests and diagnostics. */
export function shieldedSequences(): string[] {
  return [...EXACT_SEQUENCES.keys()];
}
