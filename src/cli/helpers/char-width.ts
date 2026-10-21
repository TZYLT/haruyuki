// src/cli/helpers/char-width.ts

import { eastAsianWidth } from "get-east-asian-width";
import stringWidth from "string-width";
import stripAnsi from "strip-ansi";

/**
 * How wide the terminal draws the characters Unicode calls **ambiguous**.
 *
 * `— … ≥ → · “ ” ± × ÷ ← ≤ ① °` and their kin have no width of their own in
 * Unicode: East Asian Width class `A` means *the terminal decides*. A Western
 * monospace font draws them one column; a CJK font — or the same character falling
 * back to a CJK font because the primary font has no glyph for it — draws them
 * **two**. Nothing in the string tells the two apart.
 *
 * Measured on the machine this is developed on (2026-10-21, the user's own report):
 * **Consolas aligns, 等宽楷体 does not**, i.e. the same build is wrong for one of
 * them whichever number we hard-code. `string-width` says one, so every row we
 * lay out, pad or truncate drifts by one column per such character on the wide
 * side — and this tree has already paid for that twice with the ellipsis alone
 * (`formatting.ts`'s history of the 2026-10-20 wrap).
 *
 * So the class is **resolved at runtime** (`resolve.ts` on the probe side) and
 * every width question in the tree asks this module. Two numbers are read here:
 *
 * - `getAmbiguousWidthMode()` — what the user asked for: `auto` (probe), `narrow`,
 *   or `wide`;
 * - `getAmbiguousWidth()` — what the terminal answered, i.e. the number the rows
 *   are actually laid out with. It falls back to `1` (the width table's own
 *   default) until something resolves it, which is why every exact-width row in
 *   this tree also leaves `ROW_SAFETY_COLUMNS`.
 *
 * **`inkStringWidth` is deliberately not this function.** It must stay on Ink's
 * own rules, because it predicts how many rows *Ink* will wrap a paragraph into,
 * and the row model reserves rows with it. This module answers the different
 * question: how many columns will the *terminal* draw.
 */
export type AmbiguousWidth = 1 | 2;

/** The user's request: probe the terminal, or take a number as given. */
export type AmbiguousWidthMode = "auto" | "narrow" | "wide";

/**
 * Where the current number came from.
 *
 * `default` is the fallback (narrow, the width table's own answer), `mode` is a
 * value the user or the settings file fixed, `probe` is the terminal's own answer.
 * It exists so `/font-width` and the session log can say what is in force instead
 * of the user having to guess.
 */
export type AmbiguousWidthSource = "default" | "mode" | "probe";

let mode: AmbiguousWidthMode = "auto";
let width: AmbiguousWidth = 1;
let source: AmbiguousWidthSource = "default";

export function getAmbiguousWidthMode(): AmbiguousWidthMode {
  return mode;
}

export function getAmbiguousWidth(): AmbiguousWidth {
  return width;
}

export function getAmbiguousWidthSource(): AmbiguousWidthSource {
  return source;
}

/**
 * Ask for a mode. `narrow` and `wide` take effect immediately; `auto` keeps the
 * current number until the probe answers (so asking for `auto` never regresses a
 * terminal that was already resolved).
 */
export function setAmbiguousWidthMode(next: AmbiguousWidthMode): void {
  mode = next;
  if (next === "narrow") {
    width = 1;
    source = "mode";
  } else if (next === "wide") {
    width = 2;
    source = "mode";
  }
  publish();
}

/** The probe's answer, or a mode's own number. */
export function setAmbiguousWidth(
  next: AmbiguousWidth,
  from: AmbiguousWidthSource = "probe",
): void {
  width = next;
  source = from;
  publish();
}

/** Test seam: back to the unresolved default. */
export function resetAmbiguousWidthForTests(): void {
  mode = "auto";
  width = 1;
  source = "default";
  publish();
}

/**
 * Repaint without changing the number.
 *
 * An unanswered probe still has to erase the glyph it printed, and the only way it
 * can ask for that is the same store the answer would move — so it repaints
 * without touching the width. Setting the number a terminal already answered for
 * back to the fallback would make every unanswered resize downgrade a wide
 * terminal.
 */
export function repaintForAmbiguousWidth(): void {
  publish();
}

/**
 * A number that changes when the resolved width does.
 *
 * The answer arrives **after** the first frame (the probe is armed by the shell's
 * mount), so the screen has already been laid out with the fallback. This is what
 * tells React to lay it out again — a module store rather than a state setter
 * because the value is a terminal capability, not app state, and the frames that
 * read it are spread across the tree.
 */
let version = 0;
const listeners = new Set<() => void>();

export function getAmbiguousWidthVersion(): number {
  return version;
}

export function subscribeToAmbiguousWidth(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function publish(): void {
  version += 1;
  for (const listener of listeners) listener();
}

/**
 * Strings whose width cannot be answered one code point at a time.
 *
 * Combining marks add zero columns, and an emoji sequence (`👨‍👩‍👧`) is one glyph
 * however many code points it carries — `string-width` segments graphemes and
 * knows both, a per-code-point table does not. Variation selectors and the keycap
 * mark are the same story. Those strings take the slow, exact path; a code point
 * that is merely *Wide* (an emoji without a sequence, CJK, fullwidth forms) needs
 * no clustering and stays on the fast one.
 *
 * The zero-width joiner and the variation selectors are alternatives, not members
 * of one character class: they *combine* with what they follow, so a class
 * containing them claims to match a single character (`noMisleadingCharacterClass`)
 * — and "the string contains one" is the whole test anyway.
 */
const NEEDS_CLUSTERING = /\p{Mn}|\p{Mc}|\p{Me}|\u200d|\ufe0e|\ufe0f|\u20e3/u;

/**
 * Columns the terminal will draw `value` in.
 *
 * ANSI is stripped first (colours, OSC 8 links), because a caller measures the
 * text it is about to paint, not the escape bytes around it.
 *
 * The fast path is a single pass of `get-east-asian-width`'s table with the
 * resolved ambiguous class — measured on this machine at **~3 µs for 174 mixed
 * characters against ~750 µs for `string-width`**, which is why it is the default
 * rather than an optimisation on top of it.
 */
export function terminalTextWidth(value: string): number {
  const plain = stripAnsi(value);
  if (plain.length === 0) return 0;
  if (NEEDS_CLUSTERING.test(plain)) return stringWidth(plain);
  const ambiguousAsWide = width === 2;
  let columns = 0;
  for (const character of plain) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    columns += eastAsianWidth(codePoint, { ambiguousAsWide });
  }
  return columns;
}

/** One character's columns, for callers that walk a string themselves. */
export function terminalCharWidth(character: string): number {
  return terminalTextWidth(character);
}

/**
 * Whether a character's width is the *terminal's* decision.
 *
 * Only used for diagnostics and the probe's own log line: the answer itself is
 * `terminalTextWidth`.
 */
export function isAmbiguousCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) return false;
  return (
    eastAsianWidth(codePoint) !==
    eastAsianWidth(codePoint, {
      ambiguousAsWide: true,
    })
  );
}
