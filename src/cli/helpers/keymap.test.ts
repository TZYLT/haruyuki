import { describe, expect, test } from "bun:test";
import {
  chordsEqual,
  isNamedKey,
  type KeyChord,
  resolveBinding,
} from "@/cli/helpers/input-keys";
import {
  APP_KEY_CHORDS,
  LEADER_KEY_CHORDS,
  RESERVED_FUTURE_CHORDS,
  RESERVED_TEXT_CHORDS,
  registeredKeyChords,
} from "@/cli/helpers/keymap";

/**
 * The chords a binding may shadow on purpose, with the reason. Everything else
 * colliding is a bug: one keystroke reaching two consumers is exactly what the
 * declarative table exists to make impossible.
 */
const INTENTIONAL_SHADOWS: { chord: KeyChord; reason: string }[] = [
  {
    chord: { key: "backspace" },
    reason:
      "claimed only while the draft is empty (leave bash mode); the binding returns unhandled otherwise so the text input still deletes",
  },
];

function isIntentionalShadow(chord: KeyChord): boolean {
  return INTENTIONAL_SHADOWS.some((entry) => chordsEqual(entry.chord, chord));
}

describe("keymap", () => {
  test("no two registered chords are the same", () => {
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const { id, chord } of registeredKeyChords()) {
      const key = `${chord.ctrl ?? false}|${chord.shift ?? false}|${chord.meta ?? false}|${chord.key.toLowerCase()}`;
      const previous = seen.get(key);
      if (previous) {
        collisions.push(`${previous} and ${id} both claim ${key}`);
        continue;
      }
      seen.set(key, id);
    }
    expect(collisions).toEqual([]);
  });

  test("no registered chord takes a key the text editor owns", () => {
    const collisions = registeredKeyChords()
      .filter(({ chord }) =>
        RESERVED_TEXT_CHORDS.some((reserved) => chordsEqual(reserved, chord)),
      )
      .filter(({ chord }) => !isIntentionalShadow(chord))
      .map(({ id, chord }) => `${id} takes ${JSON.stringify(chord)}`);
    expect(collisions).toEqual([]);
  });

  test("no registered chord takes a key reserved by a later milestone", () => {
    const collisions = registeredKeyChords()
      .filter(({ chord }) =>
        RESERVED_FUTURE_CHORDS.some((reserved) => chordsEqual(reserved, chord)),
      )
      .map(({ id }) => id);
    expect(collisions).toEqual([]);
  });

  test("every chord names a real key", () => {
    // A chord with a typo in the key name would silently never fire, and no
    // test that presses a working key would notice.
    const malformed = registeredKeyChords()
      .filter(({ chord }) => !isNamedKey(chord.key) && chord.key.length !== 1)
      .map(({ id, chord }) => `${id} names ${JSON.stringify(chord.key)}`);
    expect(malformed).toEqual([]);
  });

  test("pins the ruling that split Ctrl+O and Ctrl+G", () => {
    // Ctrl+O used to reach two consumers at once (the last shell output and the
    // subagent group). One key, one target: the group answers to Ctrl+G.
    expect(APP_KEY_CHORDS.toggleShellOutput).toEqual([
      { key: "o", ctrl: true },
    ]);
    expect(APP_KEY_CHORDS.toggleSubagents).toEqual([{ key: "g", ctrl: true }]);
  });

  test("the leader's help answers to every encoding of Shift+/", () => {
    // The first report from real hardware was "[Ctrl+X] then ? opens the slash
    // command panel instead": `?` is Shift+/ on a US layout, and a terminal in
    // the Kitty protocol reports that as a *modified slash*, not as `?`, so a
    // chord spelled `{ key: "?" }` alone never fired and the key fell through to
    // the input — which opened `/` autocomplete. All three encodings are bound.
    //
    // Plain `?` with shift absent covers classic terminals, `?` with the shift
    // flag covers terminals that report the composed character, and `/` with
    // shift covers the Kitty form.
    const encodings = [
      { input: "?", key: {} },
      { input: "?", key: { shift: true } },
      { input: "/", key: { shift: true } },
    ];
    const unresolved = encodings
      .filter(
        (event) =>
          !resolveBinding(
            [
              {
                id: "leader.help",
                leader: true,
                chords: LEADER_KEY_CHORDS.help,
                run: () => "consumed",
              },
            ],
            event as never,
          ),
      )
      .map((event) => `${event.input} shift=${event.key.shift === true}`);
    expect(unresolved).toEqual([]);
  });
});
