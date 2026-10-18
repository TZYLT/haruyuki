import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function readComponent(name: string): string {
  const path = fileURLToPath(new URL(`./${name}`, import.meta.url));
  return readFileSync(path, "utf-8");
}

describe("vim-style j/k navigation in list selectors", () => {
  // `ConversationSelector` used to bind bare `j`/`k` beside an always-live search
  // field, and Ink fans one stdin event out to every listener: one press moved
  // the cursor *and* typed the letter. On the toolkit the two are exclusive, and
  // this face takes the field's side (`vimKeys: false`) — so what a source-text
  // test can still pin is that the keys are no longer bound here at all. The
  // behaviour is judged on the frame in `ConversationSelector.test.tsx`.
  test("ConversationSelector.tsx leaves j/k to its search field", () => {
    const source = readComponent("ConversationSelector.tsx");
    expect(source).not.toContain('input === "k"');
    expect(source).not.toContain('input === "j"');
  });

  // The two pickers are the toolkit's now, so their j/k lives in one place: the
  // chords are asserted against the table (`overlay/list-bindings.test.ts`) and
  // through the real components on the rendered frame
  // (`overlay/adapters.test.tsx`). What is left for a source-text test to pin is
  // the part behaviour cannot see — that no picker binds keys of its own any
  // more, which is the rule the toolkit exists to hold.
  for (const picker of ["SingleSelectPicker.tsx", "MultiSelectPicker.tsx"]) {
    test(`${picker} binds no keys of its own`, () => {
      const source = readComponent(picker);
      expect(source).not.toContain("useInput");
      expect(source).toContain("@/cli/overlay/adapters");
    });
  }
});
