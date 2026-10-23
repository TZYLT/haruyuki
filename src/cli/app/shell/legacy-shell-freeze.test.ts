// src/cli/app/shell/legacy-shell-freeze.test.ts

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The append shell stays frozen.
 *
 * `《32》§5.6` (v1.4 覆写) rules that `ui_v2=off` is a **compatibility mode**: it is
 * the shell the fork shipped before M6, and M6 adds nothing to it — no tab strip,
 * no rail, no page, no toast band, no message history, no diff face. `《33》`'s M7-2
 * asks for "command set / key bindings / output semantics equivalent", which can
 * only mean "legacy behaves as it did when it was frozen": §5.6 forbids the other
 * reading, where both shells grow the same features. That was settled with the
 * maintainer on 2026-10-23 (《39》§4.30 待裁 1 ＝ 甲).
 *
 * So the assertion is a *negative* one, and it is the one that keeps the decision
 * true without a browser: the append shell's own files may not reach for any M6
 * surface. A source read rather than a mount, because a mount would have to
 * fabricate `AppViewProps` — and a fabricated props object is exactly how a test
 * stops saying anything about the product (`switch-policy.test.ts` reads the two
 * shells the same way for the same reason).
 */
const SHELL_DIR = join(import.meta.dir);
const APP_DIR = join(import.meta.dir, "..");

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** The files that make the append shell: it is three files, by design. */
const LEGACY_FILES = [
  join(SHELL_DIR, "LegacyShell.tsx"),
  join(APP_DIR, "AppendTranscript.tsx"),
  join(APP_DIR, "StaticTranscript.tsx"),
];

/** Surfaces that belong to the full-screen shell only (§5.6's list). */
const M6_SURFACES = [
  "shell/tab-strip",
  "shell/context-sidebar",
  "shell/sidebar-sections",
  "app/ViewportTranscript",
  "app/ViewportPanel",
  "app/pages/",
  "components/Toasts",
  "faces/diff-face",
  "shell/use-message-history",
];

describe("the append shell is the frozen one", () => {
  test("it reaches for none of the surfaces M6 added", () => {
    for (const file of LEGACY_FILES) {
      const source = read(file);
      for (const surface of M6_SURFACES) {
        expect(source).not.toContain(surface);
      }
    }
    // The append transcript is what it says: an append-only `<Static>` tree.
    const transcript = read(join(APP_DIR, "AppendTranscript.tsx"));
    expect(transcript).toContain("StaticTranscript");
    expect(transcript).not.toContain("ViewportTranscript");
  });

  test("both shells compose the same core through the same seam", () => {
    for (const file of ["LegacyShell.tsx", "V2Shell.tsx"]) {
      const source = read(join(SHELL_DIR, file));
      // The shared chrome (title, the one input router, overlays) and the shared
      // view are the seam: a shell that stopped using either would be a second
      // implementation, which is what `shell/types.ts` forbids.
      expect(source).toContain("ShellFrame");
    }
    // And the one thing they are allowed to differ in is the transcript: the
    // full-screen shell swaps the append tree for the bounded viewport.
    const v2 = read(join(SHELL_DIR, "V2Shell.tsx"));
    expect(v2).toContain("V2Transcript");
    expect(v2).not.toContain("AppendTranscript");
  });

  test("the shell decision is made in exactly one place", () => {
    // `resolveUiV2Once` may be *read* by the few facts that hang off it (the alt
    // screen, the page commands, the diff face's destination), but the choice of
    // which shell renders is `AppShell`'s alone — a second chooser would be a
    // second place for the two shells to diverge (`《32》§5.7`).
    const appShell = read(join(SHELL_DIR, "AppShell.tsx"));
    expect(appShell).toContain("resolveUiV2Once");
    expect(appShell).toContain("LegacyShell");
    expect(appShell).toContain("V2Shell");
    // One branch, both sides of it. The count is the assertion: a third shell
    // would need this decision re-taken somewhere.
    expect(appShell.match(/return /g)?.length).toBe(1);
    expect(appShell.match(/<V2Shell|<LegacyShell/g)?.length).toBe(2);
  });
});
