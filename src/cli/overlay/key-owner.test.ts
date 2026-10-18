import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The toolkit's first rule, as a check rather than a convention: **one key
 * owner** (`overlay/README.md` rule 1). Inside `overlay`/`modal`, an overlay
 * declares its keys through the router — `useOverlayList` for a list, a
 * `useKeyBindings` table for anything else — never through Ink's `useInput`,
 * which fans one event out to every listener and cannot be told "this key is
 * mine".
 *
 * Behaviour cannot see this: a face with its own `useInput` can still paint the
 * right frame in a test that drives only that face. What it cannot survive is
 * being mounted next to anything else that reads keys — which is the app.
 *
 * It is also not only about which listener wins. Migrating `/hooks` measured the
 * same freeze `ApprovalOptions.test.tsx` records: under React 19.2.8 with
 * `react-reconciler` 0.33.0 (Ink 7.1.1) a **`memo`-wrapped component's
 * `useInput` handler keeps the state of its first render**. A counter
 * incremented from that handler reads `[0,0,0]` behind `memo` and `[0,1,2]`
 * without it, and the old `/hooks` face logged `screen=events index=0` on every
 * dispatch, so under a bare mount its ladder never leaves the root step — while
 * the same file with `memo(` removed walks all six screens. A face that reads
 * its own state inside `useInput` is reading a stale one, and the router's
 * tables are read at event time instead.
 *
 * **The set is derived, not listed.** It used to be a hand-maintained array of
 * "the faces this batch migrated", and by the end of M5 it had drifted both ways:
 * ten migrated faces were missing (so re-adding `useInput` to `/help`, `/model`,
 * `/toolset`, either `/memory` viewer, `/subagents` or any of the four inline
 * approvals would have failed nothing), three entries had never bound a key in
 * the first place, and a face split across files was only guarded in one of them
 * (`ProviderSelector`'s step modules, `AgentSelectorViews`). Walking the
 * directory cannot drift: a new file, a split, or a rename is covered the moment
 * it lands, and the only way to add a raw reader is to add it to the exception
 * map below — with a reason, in a diff, on purpose.
 */

/** `src/cli` — the TUI layer, and the only place Ink is rendered. */
const CLI_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** `import { … } from "ink"` — the only way a file can get the raw hook. */
const INK_IMPORT = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*"ink"/g;

/**
 * The only places Ink's raw `useInput` may be read, each with the reason it is
 * an exception to the rule rather than a place the rule was forgotten.
 */
const ALLOWED_USE_INPUT = new Map<string, string>([
  [
    "components/ApprovalOptions.tsx",
    "README rule 1's named exception: the custom-denial row is a live text editor, and a chord-less catch-all binding would decline the keys it does not want and drop them on the composer behind the approval",
  ],
  [
    "components/InputRich.tsx",
    "the composer's own layer (↑/↓ for wrapped-line movement and history), which is not one of the 41 overlay faces",
  ],
  [
    "components/TextInput.tsx",
    "the leaf editor's character keys, which `RESERVED_TEXT_CHORDS` declares as the editor's",
  ],
  [
    "hooks/use-input-router.ts",
    "the router's own fallback, for sequences the raw shield does not claim",
  ],
]);

/** Every non-test `.ts`/`.tsx` file under `src/cli`, as `src/cli`-relative paths. */
function cliSources(dir = ""): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(join(CLI_ROOT, dir), {
    withFileTypes: true,
  })) {
    const path = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...cliSources(path));
      continue;
    }
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) {
      continue;
    }
    files.push(path);
  }
  return files;
}

function readsInkInput(path: string): boolean {
  // Matched on the **import**, not on the call. A substring search for
  // `useInput(` also hits this tree's own `useMouseInput(` (the wheel and drag
  // listener, which is a different thing entirely) and any comment that names the
  // hook — and it is the import that decides which reader owns a key.
  const source = readFileSync(join(CLI_ROOT, path), "utf-8");
  for (const match of source.matchAll(INK_IMPORT)) {
    if (/\buseInput\b/.test(match[1] ?? "")) return true;
  }
  return false;
}

describe("one key owner", () => {
  test("nothing under src/cli reads Ink's useInput except the named exceptions", () => {
    const offenders = cliSources().filter(
      (path) => readsInkInput(path) && !ALLOWED_USE_INPUT.has(path),
    );
    expect(offenders).toEqual([]);
  });

  test("every exception still is one, so the list cannot rot into an alibi", () => {
    const stale = [...ALLOWED_USE_INPUT.keys()].filter(
      (path) => !readsInkInput(path),
    );
    expect(stale).toEqual([]);
  });
});
