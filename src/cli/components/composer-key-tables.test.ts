import { describe, expect, test } from "bun:test";
import { chordsEqual } from "@/cli/helpers/input-keys";
import { APP_KEY_CHORDS, registeredKeyChords } from "@/cli/helpers/keymap";
import {
  type ComposerKeyHandlers,
  composerKeyTables,
} from "./composer-key-tables";

function handlers(
  overrides: Partial<ComposerKeyHandlers> = {},
): ComposerKeyHandlers {
  return {
    profileConfirm: () => {},
    profileCancel: () => {},
    toggleShellOutput: () => {},
    toggleSystemReminders: () => {},
    toggleThinking: () => {},
    interrupt: () => {},
    clearOrExit: () => {},
    cycleReasoningEffort: () => {},
    cyclePermissionMode: () => {},
    ...overrides,
  };
}

const allChords = (tables: ReturnType<typeof composerKeyTables>) =>
  tables.flatMap((table) =>
    table.bindings.flatMap((binding) => [...(binding.chords ?? [])]),
  );

describe("composerKeyTables", () => {
  test("owns nothing while the composer does not own input", () => {
    const tables = composerKeyTables(handlers(), {
      enabled: false,
      profileConfirmPending: true,
    });
    expect(tables).toEqual([]);
  });

  test("registers the app-level shortcuts in the app scope", () => {
    const tables = composerKeyTables(handlers(), {
      enabled: true,
      profileConfirmPending: false,
    });
    expect(tables.map((table) => table.scope)).toEqual(["app"]);
    expect(tables[0]?.bindings.map((binding) => binding.id)).toEqual([
      "transcript.toggleShellOutput",
      "transcript.toggleSystemReminders",
      "transcript.toggleThinking",
      "app.interrupt",
      "app.clearOrExit",
      "app.cycleReasoningEffort",
      "app.cyclePermissionMode",
    ]);
    expect(tables[0]?.bindings[0]?.chords).toEqual(
      APP_KEY_CHORDS.toggleShellOutput,
    );
  });

  test("a pending profile confirmation takes any key, in the modal scope", () => {
    const tables = composerKeyTables(handlers(), {
      enabled: true,
      profileConfirmPending: true,
    });
    const modal = tables.find((table) => table.scope === "modal");
    expect(modal?.bindings.map((binding) => binding.id)).toEqual([
      "profile.confirm",
      "profile.cancel",
    ]);
    expect(modal?.bindings[0]?.chords).toEqual([{ key: "return" }]);
    // The cancel binding is the catch-all: no chords, so it only runs when no
    // chord in the list matched.
    expect(modal?.bindings[1]?.chords).toBeUndefined();
  });

  test("no pending confirmation means no modal table", () => {
    const tables = composerKeyTables(handlers(), {
      enabled: true,
      profileConfirmPending: false,
    });
    expect(tables.some((table) => table.scope === "modal")).toBe(false);
  });

  test("every composer chord is one the declared table owns", () => {
    const declared = registeredKeyChords().map((entry) => entry.chord);
    const unknown = allChords(
      composerKeyTables(handlers(), {
        enabled: true,
        profileConfirmPending: true,
      }),
      // `return` belongs to the profile confirmation, which the keymap does not
      // declare (it is a composer mode, not a global shortcut).
    ).filter(
      (chord) =>
        chord.key !== "return" &&
        !declared.some((candidate) => chordsEqual(candidate, chord)),
    );
    expect(unknown).toEqual([]);
  });

  test("the composer does not claim one chord twice", () => {
    const chords = allChords(
      composerKeyTables(handlers(), {
        enabled: true,
        profileConfirmPending: true,
      }),
    );
    const seen: string[] = [];
    const duplicates: string[] = [];
    for (const chord of chords) {
      const key = `${chord.ctrl ?? false}|${chord.shift ?? false}|${chord.meta ?? false}|${chord.key}`;
      if (seen.includes(key)) duplicates.push(key);
      seen.push(key);
    }
    expect(duplicates).toEqual([]);
  });
});
