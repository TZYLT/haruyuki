import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { render } from "ink";
import type { AppViewProps } from "@/cli/app/AppView";
import { parseUnifiedDiff } from "@/cli/helpers/diff-patch";
import { resetInputScopes } from "@/cli/helpers/focus-ledger";
import { resetBindingOwners } from "@/cli/helpers/input-router";
import { resetMouseTrackingForTests } from "@/cli/helpers/mouse-tracking";
import { DiffFaceHost } from "./diff-face";
import { resetDiffFaceForTests, setDiffFaceSource } from "./diff-face-store";

/**
 * The diff face's frame, on a real TTY.
 *
 * `src/cli/AGENTS.md` is the reason: this face can be wired perfectly and paint
 * nothing, and the things worth pinning are the ones only a frame can show — the
 * two-column split, the breadcrumb, the fold stand-in, and that `[` / `]` and
 * `Space` really change what is under them.
 *
 * The patch deliberately overflows the body: a diff that fits entirely would make
 * every scroll assertion pass without the scroll code doing anything.
 */

class CaptureStream extends Writable {
  columns = 100;
  rows = 30;
  isTTY = true;
  chunks: string[] = [];

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.chunks.push(String(chunk));
    callback();
  }

  frame(): string {
    return this.chunks.join("");
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
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
  const stdout = new CaptureStream();
  stdout.columns = columns;
  const stdin = new Readable({ read() {} }) as NodeJS.ReadStream;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;

  let closed = 0;
  const closeOverlay = (): void => {
    closed += 1;
  };
  const instance = render(<DiffFaceHost {...view(columns, closeOverlay)} />, {
    stdin,
    stdout: stdout as unknown as NodeJS.WriteStream,
    debug: false,
    patchConsole: false,
    exitOnCtrlC: false,
  });

  return {
    frame: () => stdout.frame(),
    closed: () => closed,
    async press(...keys: string[]) {
      for (const key of keys) {
        stdin.push(key);
        await tick();
      }
    },
    async frameAfter(keys: string[]) {
      stdout.chunks = [];
      for (const key of keys) {
        stdin.push(key);
        await tick();
      }
      return stdout.frame();
    },
    stop() {
      instance.unmount();
      instance.cleanup();
    },
  };
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
  resetBindingOwners();
  resetInputScopes();
  resetMouseTrackingForTests();
});

describe("the diff face", () => {
  test("names itself, counts the work and shows the rail beside the content", async () => {
    const face = mount(100);
    await tick();
    try {
      const frame = face.frame();
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
      face.stop();
    }
  });

  test("] moves to the next file and the breadcrumb follows", async () => {
    const face = mount(100);
    await tick();
    try {
      const next = await face.frameAfter([NEXT_FILE]);
      expect(next).toContain("[2/2] src/b.ts");
      expect(next).toContain("@@ -10,3 +10,4 @@");
      expect(next).toContain("added here;");
    } finally {
      face.stop();
    }
  });

  test("Space opens every fold of the hunk the screen starts in", async () => {
    const face = mount(100);
    await tick();
    try {
      expect(face.frame()).toContain("… 3 lines");

      const after = await face.frameAfter([SPACE]);
      expect(after).not.toContain("… 3 lines");
      expect(after).toContain("const five = 5;");
    } finally {
      face.stop();
    }
  });

  test("the arrows scroll the body", async () => {
    const face = mount(100);
    await tick();
    try {
      expect(face.frame()).toContain("@@ -1,7 +1,7 @@");
      const after = await face.frameAfter([DOWN]);
      expect(after).not.toContain("@@ -1,7 +1,7 @@");
      expect(after).toContain("↓");
    } finally {
      face.stop();
    }
  });

  test("} jumps to the next hunk", async () => {
    const face = mount(100);
    await tick();
    try {
      const next = await face.frameAfter([NEXT_HUNK]);
      expect(next).toContain("@@ -30,1 +30,21 @@");
      expect(next).not.toContain("@@ -1,7 +1,7 @@");
    } finally {
      face.stop();
    }
  });

  test("a click on a file row is that row's `]`", async () => {
    const face = mount(100);
    await tick();
    try {
      // Row 1 is the title, row 2 the rule, row 3 the rail's own header, so the
      // second file's row is row 5 — the click is offered the same way `[` / `]` is.
      const after = await face.frameAfter([press(4, 5), release(4, 5)]);
      expect(after).toContain("[2/2] src/b.ts");
    } finally {
      face.stop();
    }
  });

  test("a click on a fold row opens it, and a plain diff line takes nothing", async () => {
    const face = mount(100);
    await tick();
    try {
      // Row 3 is the rail's header and the pane's breadcrumb; the two row blocks
      // start together at row 4 (hunk header / first file), so the pane's first fold
      // stand-in is row 5.
      const opened = await face.frameAfter([press(40, 5), release(40, 5)]);
      // Two folds start collapsed in this file; opening the first leaves one.
      expect(occurrences(opened, "… 3 lines")).toBe(1);
      expect(opened).toContain("const one = 1;");

      // Row 6 is now a context line: not a row this face acts on, exactly as it has
      // no key of its own.
      const onALine = await face.frameAfter([press(40, 6), release(40, 6)]);
      expect(onALine).toBe("");
    } finally {
      face.stop();
    }
  });

  test("narrow terminals fold the rail away and keep the breadcrumb", async () => {
    const face = mount(80);
    await tick();
    try {
      const frame = face.frame();
      expect(frame).toContain("[1/2] src/a.ts");
      expect(frame).not.toContain("Files");
      expect(frame).not.toContain("src/b.ts");
    } finally {
      face.stop();
    }
  });

  test("Escape closes the face", async () => {
    const face = mount(100);
    await tick();
    try {
      await face.press(ESCAPE);
      expect(face.closed()).toBe(1);
    } finally {
      face.stop();
    }
  });

  test("an empty payload says what happened instead of drawing nothing", async () => {
    setDiffFaceSource({
      label: "feat/tui-v2",
      files: [],
      note: "Could not read the diff: not a git repository",
    });
    const face = mount(100);
    await tick();
    try {
      const frame = face.frame();
      expect(frame).toContain("Could not read the diff");
      expect(frame).toContain("0 files");
    } finally {
      face.stop();
    }
  });
});
