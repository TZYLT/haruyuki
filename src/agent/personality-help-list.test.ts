/**
 * Guard for the personality preset list that help and error text print.
 *
 * `src/index.ts`, `src/headless.ts` and `src/cli/args.ts` all advertise the
 * accepted `--personality` values. `index.ts` and `headless.ts` sit at their
 * 1,000-line ratchet baseline, so they carry the list as a literal instead of
 * importing `PERSONALITY_OPTIONS` — which means adding or renaming a preset
 * would otherwise leave their error message advertising a value that no longer
 * exists (or hiding one that does).
 *
 * This test reads those literals out of the source and compares them with the
 * preset table, so the copy cannot drift silently.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PERSONALITY_ID_LIST } from "@/agent/personality-presets";

const REPO_ROOT = join(import.meta.dir, "..", "..");

/** Files that inline the list, and the regex that isolates it. */
const INLINE_LIST_SOURCES: ReadonlyArray<readonly [string, RegExp]> = [
  ["src/index.ts", /Valid: ([a-z-]+(?:, [a-z-]+)+)`/],
  ["src/headless.ts", /Valid: ([a-z-]+(?:, [a-z-]+)+)`/],
];

test("the preset table is the expected shape", () => {
  expect(PERSONALITY_ID_LIST).toBe(
    "memo, coding, tutorial, blank, linus, kawaii, claude, codex",
  );
});

for (const [file, pattern] of INLINE_LIST_SOURCES) {
  test(`${file} advertises exactly the presets PERSONALITY_OPTIONS defines`, () => {
    const source = readFileSync(join(REPO_ROOT, file), "utf-8");
    const match = source.match(pattern);

    expect(match?.[1]).toBe(PERSONALITY_ID_LIST);
  });
}
