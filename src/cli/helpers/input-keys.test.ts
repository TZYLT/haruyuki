import { describe, expect, test } from "bun:test";
import {
  chordsEqual,
  describeChord,
  type KeyBinding,
  type KeyEvent,
  matchChord,
  matchingBindings,
  namedKeyChords,
  resolveBinding,
} from "@/cli/helpers/input-keys";
import { keyEventFrom, shieldKeyEvent } from "@/cli/helpers/input-sequence";

const CTRL_O = "\u000F";
const CTRL_G = "\u0007";
const TAB = "\t";
const SHIFT_TAB = "\u001b[Z";
const ESCAPE = "\u001b";
const DOUBLE_ESCAPE = "\u001b\u001b";
const PAGE_UP = "\u001b[5~";
const FORWARD_DELETE = "\u001b[3~";
const BACKSPACE = "\u007f";
const OPTION_DELETE = "\u001b\u007f";
const OPTION_LEFT = "\u001b[1;3D";
const OPTION_B = "\u001bb";
const END = "\u001b[F";

/**
 * Events built from real sequences, so chords are checked against the reading
 * the router actually routes on. Sequences the shield does not read (CSI-u
 * forms, pastes) are built from the pair Ink produces, which
 * `input-router.equivalence.test.tsx` pins against real `useInput` output.
 */
function event(sequence: string): KeyEvent {
  const shielded = shieldKeyEvent(sequence);
  if (!shielded) throw new Error(`not a shielded sequence: ${sequence}`);
  return shielded;
}

describe("matchChord", () => {
  test("matches the sequence the chord names", () => {
    expect(matchChord({ key: "o", ctrl: true }, event(CTRL_O))).toBe(true);
    expect(matchChord({ key: "g", ctrl: true }, event(CTRL_G))).toBe(true);
  });

  test("requires an omitted modifier to be absent", () => {
    // A chord that does not ask for ctrl must not fire on ctrl+o...
    expect(matchChord({ key: "o" }, event(CTRL_O))).toBe(false);
    // ...and one that asks for ctrl must not fire on a bare o.
    expect(matchChord({ key: "o", ctrl: true }, event("o"))).toBe(false);
    expect(matchChord({ key: "o", shift: true }, event("O"))).toBe(true);
    expect(matchChord({ key: "o" }, event("O"))).toBe(false);
  });

  test("tells ctrl+shift apart from ctrl", () => {
    // The CSI-u form of Ctrl+Shift+O, as Ink reads it (pinned against real
    // `useInput` output in the equivalence test).
    const ctrlShiftO = keyEventFrom("o", { ctrl: true, shift: true });
    expect(matchChord({ key: "o", ctrl: true }, ctrlShiftO)).toBe(false);
    expect(matchChord({ key: "o", ctrl: true, shift: true }, ctrlShiftO)).toBe(
      true,
    );
  });

  test("matches named keys", () => {
    expect(matchChord({ key: "pageUp" }, event(PAGE_UP))).toBe(true);
    expect(matchChord({ key: "pageDown" }, event(PAGE_UP))).toBe(false);
    expect(matchChord({ key: "delete" }, event(FORWARD_DELETE))).toBe(true);
    expect(matchChord({ key: "backspace" }, event(BACKSPACE))).toBe(true);
    expect(matchChord({ key: "delete" }, event(BACKSPACE))).toBe(false);
    expect(matchChord({ key: "end" }, event(END))).toBe(true);
    expect(matchChord({ key: "tab" }, event(TAB))).toBe(true);
    expect(matchChord({ key: "tab", shift: true }, event(SHIFT_TAB))).toBe(
      true,
    );
  });

  test("matches Escape even though a doubled Escape carries meta", () => {
    // Ink marks `ESC ESC` as escape + meta; the interrupt binding is a single
    // chord for both, which is what makes double-escape-to-clear work.
    expect(matchChord({ key: "escape" }, event(ESCAPE))).toBe(true);
    expect(matchChord({ key: "escape" }, event(DOUBLE_ESCAPE))).toBe(true);
    expect(matchChord({ key: "escape", meta: true }, event(ESCAPE))).toBe(
      false,
    );
  });

  test("matches modified arrows and backspace by their meta flag", () => {
    expect(
      matchChord({ key: "leftArrow", meta: true }, event(OPTION_LEFT)),
    ).toBe(true);
    expect(matchChord({ key: "leftArrow" }, event(OPTION_LEFT))).toBe(false);
    expect(matchChord({ key: "b", meta: true }, event(OPTION_B))).toBe(true);
    expect(
      matchChord({ key: "backspace", meta: true }, event(OPTION_DELETE)),
    ).toBe(true);
    expect(matchChord({ key: "backspace" }, event(OPTION_DELETE))).toBe(false);
  });

  test("does not match a multi-character paste against a one-character chord", () => {
    expect(matchChord({ key: "o" }, keyEventFrom("hello"))).toBe(false);
  });

  test("matches space by name and by character", () => {
    expect(matchChord({ key: "space" }, event(" "))).toBe(true);
    expect(matchChord({ key: " " }, event(" "))).toBe(true);
  });
});

function bindings(): KeyBinding[] {
  return [
    {
      id: "first",
      chords: [{ key: "o", ctrl: true }],
      run: () => "consumed",
    },
    {
      id: "declining",
      chords: [{ key: "o", ctrl: true }],
      run: () => "declined",
    },
    { id: "catch-all", run: () => "consumed" },
  ];
}

describe("matchingBindings", () => {
  test("yields every chord match before the catch-all", () => {
    const ids = [...matchingBindings(bindings(), event(CTRL_O))].map(
      (b) => b.id,
    );
    expect(ids).toEqual(["first", "declining", "catch-all"]);
  });

  test("resolves to the first chord match", () => {
    expect(resolveBinding(bindings(), event(CTRL_O))?.id).toBe("first");
  });

  test("falls back to the catch-all only when no chord matched", () => {
    expect(resolveBinding(bindings(), event("\u0012"))?.id).toBe("catch-all");
  });

  test("yields nothing when there is no match and no catch-all", () => {
    const chordOnly: KeyBinding[] = [
      {
        id: "only",
        chords: [{ key: "o", ctrl: true }],
        run: () => "consumed",
      },
    ];
    expect([...matchingBindings(chordOnly, event(CTRL_G))]).toEqual([]);
    expect(resolveBinding(chordOnly, event(CTRL_G))).toBeUndefined();
  });
});

describe("chord helpers", () => {
  test("describes a chord for messages and hints", () => {
    expect(describeChord({ key: "o", ctrl: true })).toBe("ctrl+o");
    expect(describeChord({ key: "g", ctrl: true, shift: true })).toBe(
      "ctrl+shift+g",
    );
    expect(describeChord({ key: "pageUp" })).toBe("pageUp");
  });

  test("compares chords by key and modifiers", () => {
    expect(
      chordsEqual({ key: "o", ctrl: true }, { key: "o", ctrl: true }),
    ).toBe(true);
    expect(
      chordsEqual({ key: "o", ctrl: true }, { key: "O", ctrl: true }),
    ).toBe(true);
    expect(chordsEqual({ key: "o", ctrl: true }, { key: "o" })).toBe(false);
  });
});

describe("namedKeyChords", () => {
  test("declares the key with and without the shift the faces ignored", () => {
    expect(namedKeyChords("tab")).toEqual([
      { key: "tab" },
      { key: "tab", shift: true },
    ]);
    expect(namedKeyChords("return")).toEqual([
      { key: "return" },
      { key: "return", shift: true },
    ]);
  });

  test("each chord answers to its own encoding and to nothing else", () => {
    // `ESC[Z` is the sequence a terminal sends for Shift+Tab, and the face this
    // replaced read `if (key.tab)` without looking at the modifier. Both halves
    // are asserted, because a helper that matched everything would be worse than
    // the strict chord it replaced.
    const [plain, shifted] = namedKeyChords("tab");
    expect(plain && matchChord(plain, event(TAB))).toBe(true);
    expect(shifted && matchChord(shifted, event(SHIFT_TAB))).toBe(true);
    expect(plain && matchChord(plain, event(SHIFT_TAB))).toBe(false);
    expect(shifted && matchChord(shifted, event(TAB))).toBe(false);
  });

  test("covers every named key, letters excluded", () => {
    // The helper takes the `NamedKey` type, so a face cannot hand it a letter and
    // silently acquire the case decision that belongs to that face (`/agents`
    // wants `D` for its delete and nothing for `d`).
    for (const key of ["escape", "return", "tab", "space"] as const) {
      expect(namedKeyChords(key)).toEqual([{ key }, { key, shift: true }]);
    }
  });

  test("takes several keys at once, as a face's binding usually covers", () => {
    // `/model` cycles its category on Tab, ← and →; one call keeps that a single
    // line in a file the size ratchet pins.
    expect(namedKeyChords("tab", "leftArrow")).toEqual([
      { key: "tab" },
      { key: "tab", shift: true },
      { key: "leftArrow" },
      { key: "leftArrow", shift: true },
    ]);
  });
});
