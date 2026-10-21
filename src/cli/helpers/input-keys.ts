import type { Key } from "ink";

/**
 * The declarative half of the TUI input layer.
 *
 * A key binding is data, not a branch: `{ key: "o", ctrl: true }` in a table,
 * resolved by one dispatcher. The alternative it replaces is the one this
 * codebase grew — every component calling Ink's `useInput` with its own
 * `if (key.ctrl && input === "o")`, which is how one keystroke came to be
 * handled twice (Ink's emitter has no stopPropagation: every listener sees
 * every key) and how the same sequence came to be parsed in two raw stdin
 * listeners.
 *
 * Scopes are the priority chain from the design: an exclusive modal (an
 * approval, a mod dialog), an overlay (a selector or dialog route is open), a
 * page (Settings / Usage, which own the main area), the app layer (composer plus
 * transcript shortcuts), and a system layer that stays available to everyone
 * (suspend).
 *
 * **`page` is above `app`, and that is the whole point of it** (《38》§3.6): while a
 * page holds the main area its `↑↓`/`PgUp`/`Esc` are the page's, and the composer
 * behind it must not also act on the same keys. It sits *below* `overlay` because
 * a confirm or a text editor is popped on top of a page (《38》§12.3bis 6) and
 * takes the keyboard from it.
 */
export const INPUT_SCOPE_PRIORITY = [
  "modal",
  "overlay",
  "page",
  "app",
  "system",
] as const;

export type InputScope = (typeof INPUT_SCOPE_PRIORITY)[number];

/** Named (non-printable) keys a chord may target. */
export type NamedKey =
  | "escape"
  | "return"
  | "tab"
  | "backspace"
  | "delete"
  | "space"
  | "upArrow"
  | "downArrow"
  | "leftArrow"
  | "rightArrow"
  | "pageUp"
  | "pageDown"
  | "home"
  | "end";

const NAMED_KEY_FLAGS: Record<Exclude<NamedKey, "space">, keyof Key> = {
  escape: "escape",
  return: "return",
  tab: "tab",
  backspace: "backspace",
  delete: "delete",
  upArrow: "upArrow",
  downArrow: "downArrow",
  leftArrow: "leftArrow",
  rightArrow: "rightArrow",
  pageUp: "pageUp",
  pageDown: "pageDown",
  home: "home",
  end: "end",
};

/**
 * One key chord. Modifiers are explicit: an omitted modifier means "this
 * modifier must be absent", so `{ key: "o", ctrl: true }` cannot be triggered by
 * a bare `o` and `{ key: "o" }` cannot be triggered by Ctrl+O.
 */
export interface KeyChord {
  /** A printable character (matched case-insensitively) or a `NamedKey`. */
  key: NamedKey | string;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
}

/** What a key event looks like to a binding: Ink's normalized hook arguments. */
export interface KeyEvent {
  /** Ink's `input`: "" for named non-alphanumeric keys, the letter for Ctrl+letter. */
  input: string;
  key: Key;
}

/**
 * What a binding decided about the key it matched.
 *
 * Spelled out instead of the old `boolean | void`, where `undefined` *meant* consumed:
 * a handler that merely forgot to return anything silently swallowed the key, and a
 * callback documented as "return true to consume" (`onBackspaceAtEmpty`) consumed every
 * decline. "Who owns this key?" is now a question every binding answers, and the
 * compiler asks it — there is no third state to fall into.
 */
export type KeyOutcome = "consumed" | "declined";

/**
 * Adapt a handler still written as "return false to decline".
 *
 * The composer's handlers predate `KeyOutcome`, are shared with callers that are not
 * bindings, and live in a size-ratcheted file, so the old shape survives *there*. This is
 * the one place it is translated — which is the point: the rule ("only an explicit
 * `false` declines, anything else consumes") is stated once, by name, instead of being
 * re-derived at every binding, and a *new* binding cannot fall into it by forgetting to
 * return anything (the binding contract has no third state).
 */
export function consumeKey(handler: () => boolean | void): () => KeyOutcome {
  return () => (handler() === false ? "declined" : "consumed");
}

export interface KeyBinding {
  id: string;
  /**
   * Chords that trigger this binding. Omitted means "any key" — a catch-all,
   * which only runs when no chord in the same list matched.
   */
  chords?: readonly KeyChord[];
  /**
   * Handle the key. `DECLINED` means "matched but not consumed": the router keeps
   * looking, and finally hands the key to the legacy handlers, so a binding can claim a
   * key only in the state where it applies.
   */
  run: (event: KeyEvent) => KeyOutcome;
  /**
   * Reachable only as the second key of the leader prefix, and *only* while the
   * prefix is armed. A plain letter is normally the text editor's; behind the
   * leader it is a command, which is the whole point of the prefix — one more
   * usable key per entry, without taking anything away from typing.
   */
  leader?: boolean;
  /** What the leader hint and (later) the command palette show for this binding. */
  label?: string;
}

/** A binding list owned by one component, inside one scope. */
export interface KeyBindingTable {
  scope: InputScope;
  bindings: readonly KeyBinding[];
}

export function matchChord(chord: KeyChord, event: KeyEvent): boolean {
  const { key } = event;
  if ((chord.ctrl ?? false) !== Boolean(key.ctrl)) return false;
  if ((chord.shift ?? false) !== Boolean(key.shift)) return false;

  // Ink reports `meta` for every ESC-prefixed sequence, including a doubled
  // Escape (`ESC ESC` is escape + meta). A chord that did not ask for meta must
  // still match a bare Escape, or the double-escape-to-clear binding would only
  // ever fire on the second press.
  const wantsMeta = chord.meta ?? false;
  if (wantsMeta !== Boolean(key.meta) && !(key.escape === true && !wantsMeta)) {
    return false;
  }

  if (chord.key === "space") return event.input === " ";

  const flag = NAMED_KEY_FLAGS[chord.key as Exclude<NamedKey, "space">];
  if (flag) return Boolean(key[flag]);

  if (chord.key.length !== 1) return false;
  return event.input.toLowerCase() === chord.key.toLowerCase();
}

/**
 * A named key's chords in the meaning the overlay faces had before the toolkit:
 * the key's own flag decides, and `shift` is not consulted.
 *
 * The chord syntax is deliberately strict — an omitted modifier means "this
 * modifier must be absent" (see `KeyChord`) — and that strictness is what keeps
 * `{ key: "o" }` away from Ctrl+O and lets a list sit beside a live editor. But
 * the faces this toolkit replaced tested the flag alone (`if (key.tab)`,
 * `if (key.return)`, and a bare `input === " "` for space), so a terminal that
 * reports the shift for a sequence the old code therefore accepted loses the key
 * when the strict reading is applied to it: `ESC[Z` *is* Shift+Tab, and a
 * kitty-protocol terminal sends Shift+Enter as CSI-u. Six faces stopped cycling
 * their tabs and every list stopped confirming on Shift+Enter — behaviour no
 * frame-equivalence script covered, because none of them pressed Shift+Tab.
 *
 * So a named key that means "this key, however the terminal encodes the shift"
 * says so once, here, instead of every face spelling out a second chord. It takes
 * several keys because a face's binding usually covers more than one (`Tab`,
 * `←` and `→` cycle the same category in `/model`), and that keeps the call to
 * one line in the files the size ratchet pins. Three things are deliberately
 * outside it:
 *
 * - **Letters.** Case is the letter's own business (`/agents` wants `D` for its
 *   destructive delete and nothing for `d`), and a generated shift variant would
 *   make that decision for every face.
 * - **Keys a face genuinely splits.** `/search` gives Tab and Shift+Tab two
 *   different jobs, and the autocomplete declines the shift variants outright
 *   (`use-autocomplete-navigation.ts`) — those declare their chords explicitly,
 *   which is the whole point of the strict default.
 * - **The keys the toolkit itself added.** `pageUp`/`pageDown`/`home`/`end` were
 *   never bound by these faces, so there is no meaning to restore, and leaving
 *   them strict keeps `Shift+PageUp`/`Shift+PageDown` from becoming a second
 *   spelling of an app-level jump while an overlay happens to be open.
 */
export function namedKeyChords(...keys: readonly NamedKey[]): KeyChord[] {
  return keys.flatMap((key) => [{ key }, { key, shift: true }]);
}

/**
 * Whether `value` names a non-printable key this module can match.
 *
 * `Object.hasOwn`, not `in`: `in` walks the prototype chain, so `constructor`,
 * `toString` and friends would pass a validation meant to catch a misspelled key name
 * — and `matchChord` would then index a non-flag and match nothing.
 */
export function isNamedKey(value: string): value is NamedKey {
  return value === "space" || Object.hasOwn(NAMED_KEY_FLAGS, value);
}

/**
 * Candidate bindings in the order they should be tried: every chord match in
 * order, then the first catch-all. A catch-all only runs when no chord matched
 * anywhere in the list, so "any key cancels" cannot shadow the bindings around
 * it.
 *
 * It is a generator because a binding may decline a key it matched (the
 * empty-draft Backspace is one: it leaves bash mode only when there is nothing
 * to delete and must let the text input have the key otherwise), and the router
 * then has to keep looking.
 */ export function* matchingBindings(
  bindings: readonly KeyBinding[],
  event: KeyEvent,
): Generator<KeyBinding, void, void> {
  let catchAll: KeyBinding | undefined;
  for (const binding of bindings) {
    if (!binding.chords) {
      catchAll ??= binding;
      continue;
    }
    for (const chord of binding.chords) {
      if (matchChord(chord, event)) {
        yield binding;
        break;
      }
    }
  }
  if (catchAll) yield catchAll;
}

/** The binding that would claim this event first, if any. Tests and diagnostics. */
export function resolveBinding(
  bindings: readonly KeyBinding[],
  event: KeyEvent,
): KeyBinding | undefined {
  for (const binding of matchingBindings(bindings, event)) return binding;
  return undefined;
}

/** Human-readable chord, for conflict messages and statusline hints. */
export function describeChord(chord: KeyChord): string {
  const parts: string[] = [];
  if (chord.ctrl) parts.push("ctrl");
  if (chord.meta) parts.push("alt");
  if (chord.shift) parts.push("shift");
  parts.push(chord.key);
  return parts.join("+");
}

/** Two chords are the same chord when every modifier and the key agree. Tests. */
export function chordsEqual(a: KeyChord, b: KeyChord): boolean {
  return (
    a.key.toLowerCase() === b.key.toLowerCase() &&
    (a.ctrl ?? false) === (b.ctrl ?? false) &&
    (a.shift ?? false) === (b.shift ?? false) &&
    (a.meta ?? false) === (b.meta ?? false)
  );
}
