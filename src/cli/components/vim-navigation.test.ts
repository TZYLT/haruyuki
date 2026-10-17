import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function readComponent(name: string): string {
  const path = fileURLToPath(new URL(`./${name}`, import.meta.url));
  return readFileSync(path, "utf-8");
}

describe("vim-style j/k navigation in list selectors", () => {
  // Pure-list pickers (no inline text field), so binding bare j/k as
  // down/up aliases cannot clash with typing. Filter-based selectors
  // (AgentSelector, ProviderSelector, ...) deliberately avoid bare
  // letter shortcuts and are intentionally excluded here.
  test('ConversationSelector.tsx maps "k" to up and "j" to down', () => {
    const source = readComponent("ConversationSelector.tsx");
    expect(source).toContain('key.upArrow || input === "k"');
    expect(source).toContain('key.downArrow || input === "j"');
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
