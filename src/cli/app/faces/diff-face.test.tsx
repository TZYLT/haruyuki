import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AppViewProps } from "@/cli/app/AppView";
import { parseUnifiedDiff } from "@/cli/helpers/diff-patch";
import { resetMouseHandlers } from "@/cli/helpers/mouse-router";
import { resetMouseTrackingForTests } from "@/cli/helpers/mouse-tracking";
import { mountInkTty, resetInkTtyState } from "@/test-utils/ink-tty";
import { DiffFaceHost } from "./diff-face";
import { resetDiffFaceForTests, setDiffFaceSource } from "./diff-face-store";

/**
 * The diff face's frame, on a real TTY.
 *
 * `src/cli/AGENTS.md` is the reason: this face can be wired perfectly and paint
 * nothing, and the things worth pinning are the ones only a frame can show — the
 * two-column split, the breadcrumb, the fold stand-in, and that `[` / `]`, `Space`
 * and a click really change what is under them.
 *
 * The patch deliberately overflows the body: a diff that fits entirely would make
 * every scroll assertion pass without the scroll code doing anything. The harness
 * is the shared one (`mountInkTty`) rather than a local copy, because this face
 * reads its height from `process.stdout` — a hand-rolled mount that pinned only the
 * stream it handed to Ink laid itself out for whatever size the *previous test
 * file* left behind, which is how three of these failed in the full run while
 * passing alone.
 */

const ESCAPE = "\u001B";
const SPACE = " ";
const DOWN = "\u001B[B";
const NEXT_FILE = "]";
const NEXT_HUNK = "}";
/** SGR mouse reports: press/release at a column and row (1-based, like the terminal). */
const press = (column: number, row: number) => `${ESCAPE}[<0;${column};${row}M`;
const release = (column: number, row: number) =>
  `${ESCAPE}[<0;${column};${row}m`;

/** How many times `text` appears in a frame. */
const occurrences = (frame: string, text: string): number =>
  frame.split(text).length - 1;

const ADDED_BLOCK = Array.from(
  { length: 20 },
  (_, index) => `+added line ${index + 1};`,
);

const PATCH = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,7 +1,7 @@",
  " const one = 1;",
  " const two = 2;",
  " const three = 3;",
  "-const four = 4;",
  "+const four = 44;",
  " const five = 5;",
  " const six = 6;",
  " const seven = 7;",
  "@@ -30,1 +30,21 @@",
  " const thirty = 30;",
  ...ADDED_BLOCK,
  "diff --git a/src/b.ts b/src/b.ts",
  "--- a/src/b.ts",
  "+++ b/src/b.ts",
  "@@ -10,3 +10,4 @@",
  " keep;",
  " ",
  "+added here;",
  " tail;",
].join("\n");

function view(columns: number, closeOverlay: () => void): AppViewProps {
  return {
    columns,
    closeOverlay,
    currentApproval: undefined,
    currentApprovalContext: undefined,
    precomputedDiffsRef: { current: new Map() },
    handleApproveCurrent: async () => {},
    handleApproveAlways: async () => {},
    handleDenyCurrent: async () => {},
    handleCancelApprovals: () => {},
    showApprovalPreview: false,
    openOverlay: () => ({
      id: "cmd-test",
      input: "/test",
      update: () => {},
      finish: () => {},
      fail: () => {},
    }),
  } as unknown as AppViewProps;
}

function mount(columns: number) {
  let closed = 0;
  const shell = mountInkTty(
    <DiffFaceHost
      {...view(columns, () => {
        closed += 1;
      })}
    />,
    { columns, rows: 30 },
  );
  return { shell, closed: () => closed };
}

beforeEach(() => {
  setDiffFaceSource({
    label: "feat/tui-v2",
    files: parseUnifiedDiff(PATCH),
    path: "J:/tmp/wt",
  });
});

afterEach(() => {
  resetDiffFaceForTests();
  resetMouseHandlers();
  resetMouseTrackingForTests();
  resetInkTtyState();
});

describe("the diff face", () => {
  test("names itself, counts the work and shows the rail beside the content", async () => {
    const { shell } = mount(100);
    try {
      const frame = await shell.text();
      expect(frame).toContain("Diff · feat/tui-v2");
      expect(frame).toContain("2 files");
      expect(frame).toContain("+22");
      expect(frame).toContain("−1");
      expect(frame).toContain("Files");
      expect(frame).toContain("[1/2] src/a.ts");
      expect(frame).toContain("src/b.ts");
      expect(frame).toContain("@@ -1,7 +1,7 @@");
      expect(frame).toContain("… 3 lines");
      expect(frame).toContain("Space fold");
      // The rail and the content are two columns on one line, with the divider
      // between them: the file's counts, then the pane's first row. The divider has
      // to be on **every** row of the region, not just its first.
      expect(frame).toMatch(/src\/a\.ts\s+\+21 −1\s*│\s*@@ -1,7 \+1,7 @@/);
      expect(frame).toMatch(/src\/b\.ts\s+\+1 −0\s*│\s*… 3 lines/);
    } finally {
      shell.stop();
    }
  });

  test("] moves to the next file and the breadcrumb follows", async () => {
    const { shell } = mount(100);
    try {
      await shell.press(NEXT_FILE);
      const frame = await shell.text();
      expect(frame).toContain("[2/2] src/b.ts");
      expect(frame).toContain("@@ -10,3 +10,4 @@");
      expect(frame).toContain("added here;");
    } finally {
      shell.stop();
    }
  });

  test("Space opens every fold of the hunk the screen starts in", async () => {
    const { shell } = mount(100);
    try {
      expect(await shell.text()).toContain("… 3 lines");

      await shell.press(SPACE);
      const after = await shell.text();
      expect(after).not.toContain("… 3 lines");
      expect(after).toContain("const five = 5;");
    } finally {
      shell.stop();
    }
  });

  test("the arrows scroll the body", async () => {
    const { shell } = mount(100);
    try {
      expect(await shell.text()).toContain("@@ -1,7 +1,7 @@");
      await shell.press(DOWN);
      const after = await shell.text();
      expect(after).not.toContain("@@ -1,7 +1,7 @@");
      expect(after).toContain("↓");
    } finally {
      shell.stop();
    }
  });

  test("} jumps to the next hunk", async () => {
    const { shell } = mount(100);
    try {
      await shell.press(NEXT_HUNK);
      const next = await shell.text();
      expect(next).toContain("@@ -30,1 +30,21 @@");
      expect(next).not.toContain("@@ -1,7 +1,7 @@");
    } finally {
      shell.stop();
    }
  });

  test("a click on a file row is that row's `]`", async () => {
    const { shell } = mount(100);
    try {
      // Row 1 is the title, row 2 the rule, row 3 the rail's own header, so the
      // second file's row is row 5 — offered the same way `[` / `]` is.
      await shell.press(press(4, 5), release(4, 5));
      expect(await shell.text()).toContain("[2/2] src/b.ts");
    } finally {
      shell.stop();
    }
  });

  test("a click on a fold row opens it, and a plain diff line takes nothing", async () => {
    const { shell } = mount(100);
    try {
      // Row 3 is the rail's header and the pane's breadcrumb; the two row blocks
      // start together at row 4 (hunk header / first file), so the pane's first fold
      // stand-in is row 5.
      await shell.press(press(40, 5), release(40, 5));
      const opened = await shell.text();
      // Two folds start collapsed in this file; opening the first leaves one.
      expect(occurrences(opened, "… 3 lines")).toBe(1);
      expect(opened).toContain("const one = 1;");

      // Row 6 is now a context line: not a row this face acts on, exactly as it has
      // no key of its own — so the frame does not move.
      await shell.press(press(40, 6), release(40, 6));
      expect(await shell.text()).toBe(opened);
    } finally {
      shell.stop();
    }
  });

  test("narrow terminals fold the rail away and keep the breadcrumb", async () => {
    const { shell } = mount(80);
    try {
      const frame = await shell.text();
      expect(frame).toContain("[1/2] src/a.ts");
      expect(frame).not.toContain("Files");
      expect(frame).not.toContain("src/b.ts");
    } finally {
      shell.stop();
    }
  });

  test("Escape closes the face", async () => {
    const { shell, closed } = mount(100);
    try {
      await shell.press(ESCAPE);
      expect(closed()).toBe(1);
    } finally {
      shell.stop();
    }
  });

  test("an empty payload says what happened instead of drawing nothing", async () => {
    setDiffFaceSource({
      label: "feat/tui-v2",
      files: [],
      note: "Could not read the diff: not a git repository",
    });
    const { shell } = mount(100);
    try {
      const frame = await shell.text();
      expect(frame).toContain("Could not read the diff");
      expect(frame).toContain("0 files");
    } finally {
      shell.stop();
    }
  });
});
