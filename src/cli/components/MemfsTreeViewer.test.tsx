import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getScopedMemoryFilesystemRoot } from "@/agent/memory-filesystem";
import {
  getFileNodes,
  readFileContent,
  scanMemoryFilesystem,
} from "@/agent/memory-scanner";
import { MemfsTreeViewer } from "@/cli/components/MemfsTreeViewer";
import {
  type InkTty,
  mountInkTty,
  resetInkTtyState,
} from "@/test-utils/ink-tty";

/**
 * The tree/split `/memory` viewer: the frame, the two panes, and where each key
 * lands.
 *
 * The face reads a real memory filesystem, so the test builds one — under a temp
 * `HARUYUKI_HOME`, resolved through the same `getScopedMemoryFilesystemRoot` the
 * component uses, so the fixture and the viewer cannot disagree about where the
 * memory lives. Nothing here touches a network or a browser: the fixture has no
 * `.git`, which is what keeps the `O` binding declined, and the browser path is
 * left unverified on purpose (it opens a real viewer).
 */

const AGENT_ID = "agent-b2-memfs-tree-viewer";

const LINE_COUNT = 20;
/** Distinct and fixed-width, so no row is a prefix of another. */
const LONG_CONTENT = Array.from(
  { length: LINE_COUNT },
  (_, index) => `row-${String(index + 1).padStart(2, "0")}`,
).join("\n");
const SHORT_CONTENT = "short note";

const DOWN = "\u001B[B";
const UP = "\u001B[A";
const ENTER = "\r";
const ESCAPE = "\u001B";
const CTRL_C = "\u0003";

let home: string;
let savedHome: string | undefined;
let root: string;
/** The files in the order the viewer's own scanner walks them. */
let firstContent: string;
let secondContent: string;

beforeAll(() => {
  savedHome = process.env.HARUYUKI_HOME;
  home = mkdtempSync(join(tmpdir(), "haruyuki-b2-memfs-"));
  process.env.HARUYUKI_HOME = home;

  root = getScopedMemoryFilesystemRoot(AGENT_ID);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "notes.md"), SHORT_CONTENT);
  writeFileSync(join(root, "persona.md"), LONG_CONTENT);

  const files = getFileNodes(scanMemoryFilesystem(root));
  const [firstFile, secondFile] = files;
  if (!firstFile || !secondFile) {
    throw new Error("the fixture must have produced two files");
  }
  firstContent = readFileContent(firstFile.fullPath);
  secondContent = readFileContent(secondFile.fullPath);
});

afterAll(() => {
  if (savedHome === undefined) {
    delete process.env.HARUYUKI_HOME;
  } else {
    process.env.HARUYUKI_HOME = savedHome;
  }
  rmSync(home, { recursive: true, force: true });
});

afterEach(resetInkTtyState);

function mountViewer(
  options: { agentId?: string; onClose?: () => void } = {},
): InkTty {
  return mountInkTty(
    <MemfsTreeViewer
      agentId={options.agentId ?? AGENT_ID}
      onClose={options.onClose ?? (() => {})}
      conversationId="default"
    />,
    { columns: 80 },
  );
}

describe("MemfsTreeViewer", () => {
  test("paints the frame, both panes and the hint", async () => {
    const tty = mountViewer();
    try {
      const painted = await tty.text();
      const rows = painted.split("\n");

      expect(rows[0]).toBe("> /memory");
      expect(rows[1]).toBe("─".repeat(80));
      expect(rows[2]).toBe("");
      expect(rows[3]).toBe("View your agent's memory");

      // The tree, with the separator and the preview beside it.
      expect(painted).toContain("├── notes.md");
      expect(painted).toContain("└── persona.md");
      // The cursor starts on the first file, and the preview is that file.
      expect(painted).toContain(`│ ${firstContent.split("\n")[0]}`);

      // The dotted rules the split view is framed by.
      expect(painted).toContain("╌".repeat(80));

      expect(painted).toContain("↑↓ navigate · Enter view ·");
      expect(painted).toContain("Edit in ADE");
      expect(painted).toContain("· Esc close");
      // No git-backed memory here, so the browser key is not offered.
      expect(painted).not.toContain("O open in browser");
    } finally {
      tty.stop();
    }
  });

  test("↑/↓ walk the files, the preview follows, and the ends do nothing", async () => {
    const tty = mountViewer();
    try {
      expect(await tty.text()).toContain(`│ ${firstContent.split("\n")[0]}`);

      await tty.press(DOWN);
      expect(await tty.text()).toContain(`│ ${secondContent.split("\n")[0]}`);

      // Already on the last file: the key is not ours, and nothing moves.
      await tty.press(DOWN);
      expect(await tty.text()).toContain(`│ ${secondContent.split("\n")[0]}`);

      await tty.press(UP);
      expect(await tty.text()).toContain(`│ ${firstContent.split("\n")[0]}`);

      // And at the top with the tree's own window already at its start.
      await tty.press(UP);
      expect(await tty.text()).toContain(`│ ${firstContent.split("\n")[0]}`);
    } finally {
      tty.stop();
    }
  });

  test("Enter opens the full view, and Escape steps back before it closes", async () => {
    let closed = 0;
    const tty = mountViewer({
      onClose: () => {
        closed += 1;
      },
    });
    try {
      await tty.press(DOWN, ENTER);
      let rows = (await tty.text()).split("\n");

      // The title becomes the file, the panes give way to the content, and the
      // hint changes with the mode.
      expect(rows[3]).toBe("persona.md");
      expect(await tty.text()).toContain("│ row-01");
      const painted = await tty.text();
      expect(painted).toContain(`${LONG_CONTENT.length} chars`);
      expect(painted).toContain("↑↓ scroll · Esc back");
      expect(painted).not.toContain("Enter view");

      // Escape means "back" in this mode, not "close".
      await tty.press(ESCAPE);
      rows = (await tty.text()).split("\n");
      expect(rows[3]).toBe("View your agent's memory");
      expect(closed).toBe(0);

      await tty.press(ESCAPE);
      expect(closed).toBe(1);
    } finally {
      tty.stop();
    }
  });

  test("↑/↓ scroll the full view and the indicator counts what is below", async () => {
    const tty = mountViewer();
    try {
      await tty.press(DOWN, ENTER);

      // 20 lines of content in a 16-line pane.
      expect(await tty.text()).toContain("↓ 4 more lines below");

      await tty.press(DOWN);
      expect(await tty.text()).toContain("↓ 3 more lines below");
      expect(await tty.text()).toContain("│ row-02");

      await tty.press(DOWN, DOWN, DOWN);
      const painted = await tty.text();
      expect(painted).not.toContain("more line");
      expect(painted).toContain("│ row-20");
    } finally {
      tty.stop();
    }
  });

  test("Ctrl+C closes from either mode", async () => {
    let closed = 0;
    const tty = mountViewer({
      onClose: () => {
        closed += 1;
      },
    });
    try {
      await tty.press(CTRL_C);
      expect(closed).toBe(1);

      await tty.press(DOWN, ENTER);
      expect((await tty.text()).split("\n")[3]).toBe("persona.md");

      await tty.press(CTRL_C);
      expect(closed).toBe(2);
    } finally {
      tty.stop();
    }
  });

  test("the browser key does nothing without a git-backed memory", async () => {
    let closed = 0;
    const tty = mountViewer({
      onClose: () => {
        closed += 1;
      },
    });
    try {
      await tty.press("o");
      await tty.press("O");

      const painted = await tty.text();
      expect(painted).not.toContain("Opening in browser");
      expect(painted).not.toContain("Opened in browser");
      expect(painted).toContain("↑↓ navigate · Enter view ·");
      expect(closed).toBe(0);
    } finally {
      tty.stop();
    }
  });

  test("paints the no-memfs state, and it can still be left", async () => {
    let closed = 0;
    const tty = mountViewer({
      agentId: `${AGENT_ID}-without-memory`,
      onClose: () => {
        closed += 1;
      },
    });
    try {
      const painted = await tty.text();
      const rows = painted.split("\n");

      expect(rows[0]).toBe("> /memory");
      expect(rows[3]).toBe("View your agent's memory");
      expect(painted).toContain("Memory filesystem not found at");
      expect(painted).toContain("Run /memfs enable to set up.");
      expect(painted).toContain("Esc cancel");

      await tty.press(ESCAPE);
      expect(closed).toBe(1);
    } finally {
      tty.stop();
    }
  });
});
