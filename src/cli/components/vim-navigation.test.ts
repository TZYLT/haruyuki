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
  // this face takes the field's side — so what a source-text test can still pin
  // is that the opt-out is the one the frame test assumes, and that no local
  // handler crept back. The behaviour itself is judged on the frame in
  // `ConversationSelector.test.tsx`.
  test("ConversationSelector.tsx leaves j/k to its search field", () => {
    const source = readComponent("ConversationSelector.tsx");
    expect(source).toContain("vimKeys: false");
    expect(source).not.toContain('input === "k"');
    expect(source).not.toContain('input === "j"');
  });

  // The two pickers are the toolkit's now (`overlay/adapters.tsx`), so their j/k
  // lives in one place: the chords are asserted against the table
  // (`overlay/list-bindings.test.ts`) and through the real components on the
  // rendered frame (`overlay/adapters.test.tsx`). Nothing is left for a
  // source-text test here, and the file this file used to read — a ten-line
  // re-export shim — is gone with the last face that imported it.
  // `key-owner.test.ts` is the guard that an overlay binds no keys of its own.
});
