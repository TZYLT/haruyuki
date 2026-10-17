import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import type { Block } from "@letta-ai/letta-client/resources/agents/blocks";
import { useState } from "react";
import { getBackend } from "@/backend";
import { MemoryTabViewer } from "@/cli/components/MemoryTabViewer";
import {
  type InkTty,
  mountInkTty,
  resetInkTtyState,
} from "@/test-utils/ink-tty";

/**
 * The tab-strip `/memory` viewer: the frame, the strip, and where each key lands.
 *
 * Two things about the setup are load-bearing.
 *
 * - **`HARUYUKI_HOME` is a fresh temp directory.** The viewer fetches the agent
 *   on mount through the process-global backend, so without redirecting the home
 *   the test would read (and, in the local backend's non-strict mode, *create*)
 *   agents in the operator's real harness root. The file is registered in
 *   `scripts/isolated-unit-tests.json` for the same reason: the backend singleton
 *   it creates points at that temp directory, and a later file in a shared worker
 *   must not inherit it.
 * - **The agent id is not in that backend**, so `retrieveAgent` throws and the
 *   viewer takes its documented fallback to the `blocks` prop. That is what makes
 *   the assertions below about *the passed blocks*; if the fetch ever starts
 *   succeeding with an empty agent, the strip disappears and these tests fail
 *   loudly rather than passing for the wrong reason.
 */

const NO_SUCH_AGENT = "agent-b2-memory-tab-viewer";

/** Distinct and fixed-width, so no row is a prefix of another. */
function lines(count: number): string {
  return Array.from(
    { length: count },
    (_, index) => `row-${String(index + 1).padStart(2, "0")}`,
  ).join("\n");
}

const LONG_VALUE = lines(20);

const BLOCKS: Block[] = [
  { id: "b1", label: "persona", value: LONG_VALUE, limit: 5000 },
  { id: "b2", label: "human", value: "short human block" },
];

const TAB = "\t";
const DOWN = "\u001B[B";
const UP = "\u001B[A";
const LEFT = "\u001B[D";
const RIGHT = "\u001B[C";
const ESCAPE = "\u001B";
const CTRL_C = "\u0003";

let home: string;
let savedHome: string | undefined;

beforeAll(async () => {
  savedHome = process.env.HARUYUKI_HOME;
  home = mkdtempSync(join(tmpdir(), "haruyuki-b2-memory-tab-"));
  process.env.HARUYUKI_HOME = home;
  // Pay the local backend's construction cost once. The first mount otherwise
  // spends it inside the viewer's own loading frame, and every assertion below
  // would be reading "Loading memory..." instead of the state under test.
  await getBackend()
    .retrieveAgent(NO_SUCH_AGENT)
    .catch(() => {});
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

/**
 * The frame once the mount fetch has settled.
 *
 * The viewer paints `Loading memory…` until its `retrieveAgent` call comes back,
 * so an assertion taken on the first frame would read the loading state on a slow
 * machine and the real one on a fast one. This waits the loading line out; a
 * stuck fetch is a failure, not a silent pass.
 */
async function settled(tty: InkTty): Promise<string> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const painted = await tty.text();
    if (!painted.includes("Loading memory")) return painted;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the viewer never left its loading state");
}

function mountViewer(
  overrides: { blocks?: Block[]; onClose?: () => void } = {},
): InkTty {
  return mountInkTty(
    <MemoryTabViewer
      blocks={overrides.blocks ?? BLOCKS}
      agentId={NO_SUCH_AGENT}
      onClose={overrides.onClose ?? (() => {})}
    />,
    { columns: 80 },
  );
}

describe("MemoryTabViewer", () => {
  test("a shell that keeps re-rendering does not refetch the agent", async () => {
    // The fetch is counted by wrapping the singleton's own method — object-level
    // stubbing, not a module mock — and the wrapper still calls the real one, so
    // the failing fetch the viewer falls back from is the real one.
    const backend = getBackend();
    const realRetrieve = backend.retrieveAgent;
    let fetches = 0;
    backend.retrieveAgent = ((...args: Parameters<typeof realRetrieve>) => {
      fetches += 1;
      return realRetrieve.apply(backend, args);
    }) as typeof realRetrieve;

    // A shell shaped like the real call site: the agent state may be missing, and
    // the blocks come straight off it.
    let bump: () => void = () => {};
    function Shell({ agentState }: { agentState?: AgentState }) {
      const [, setRenders] = useState(0);
      bump = () => setRenders((renders) => renders + 1);
      return (
        <MemoryTabViewer
          blocks={agentState?.memory?.blocks}
          agentId={NO_SUCH_AGENT}
          onClose={() => {}}
        />
      );
    }

    const tty = mountInkTty(<Shell />, { columns: 80 });
    try {
      expect(await settled(tty)).toContain("No memory attached to this agent.");
      expect(fetches).toBe(1);

      // Each of these is another render of the shell, which is what the effect's
      // dependency has to survive: the shell paints on every streaming chunk.
      for (let render = 0; render < 3; render += 1) {
        bump();
        await tty.rows();
      }
      expect(fetches).toBe(1);
    } finally {
      tty.stop();
      backend.retrieveAgent = realRetrieve;
    }
  });

  test("paints the frame, the strip and the value pane", async () => {
    const tty = mountViewer();
    try {
      const painted = await settled(tty);
      const rows = painted.split("\n");

      expect(rows[0]).toBe("> /memory");
      expect(rows[1]).toBe("─".repeat(80));
      expect(rows[2]).toBe("");
      expect(rows[3]).toBe("View your agent's memory");

      // The strip: a space of padding either side of every label, and no gap —
      // which is the shape `TabBar` reproduces rather than a new look.
      expect(painted).toContain("persona  human");

      // The pane's first window, with the count of what is below it.
      expect(painted).toContain("│ row-01");
      expect(painted).toContain("│ row-12");
      expect(painted).not.toContain("row-13");
      expect(painted).toContain("↓ 8 more lines below");

      // The footer: the char count against the block's limit, then the hint.
      expect(painted).toContain(
        `${LONG_VALUE.length.toLocaleString()} / ${(5000).toLocaleString()} chars`,
      );
      expect(painted).toContain("· read/write");
      expect(painted).toContain("←→/Tab switch · ↑↓ scroll ·");
      expect(painted).toContain("Edit in ADE");
      expect(painted).toContain("· Esc cancel");
    } finally {
      tty.stop();
    }
  });

  test("Tab and the arrows switch tabs, wrapping in both directions", async () => {
    const tty = mountViewer();
    try {
      expect(await settled(tty)).toContain("│ row-01");

      await tty.press(TAB);
      let painted = await settled(tty);
      expect(painted).toContain("│ short human block");
      expect(painted).not.toContain("row-01");

      // Forward from the last tab wraps to the first.
      await tty.press(TAB);
      expect(await settled(tty)).toContain("│ row-01");

      await tty.press(RIGHT);
      expect(await settled(tty)).toContain("│ short human block");

      // Backward from the first tab wraps to the last.
      await tty.press(LEFT);
      await tty.press(LEFT);
      painted = await settled(tty);
      expect(painted).toContain("│ short human block");
      expect(painted).not.toContain("row-01");
    } finally {
      tty.stop();
    }
  });

  test("↑/↓ scroll the pane and the indicator counts the lines below", async () => {
    const tty = mountViewer();
    try {
      expect(await settled(tty)).toContain("↓ 8 more lines below");

      await tty.press(DOWN);
      let painted = await settled(tty);
      expect(painted).toContain("│ row-02");
      expect(painted).toContain("│ row-13");
      expect(painted).not.toContain("row-01");
      expect(painted).toContain("↓ 7 more lines below");

      await tty.press(UP);
      painted = await settled(tty);
      expect(painted).toContain("│ row-01");
      expect(painted).toContain("↓ 8 more lines below");

      // The clamp at the top: a key at the edge changes nothing.
      await tty.press(UP, UP);
      expect(await settled(tty)).toContain("│ row-01");
    } finally {
      tty.stop();
    }
  });

  test("the pane stops at the end instead of scrolling past it", async () => {
    const tty = mountViewer();
    try {
      await settled(tty);
      // Twelve presses for eight scrollable lines: the last four are the clamp.
      for (let press = 0; press < 12; press += 1) {
        await tty.press(DOWN);
      }

      const painted = await settled(tty);
      expect(painted).toContain("│ row-09");
      expect(painted).toContain("│ row-20");
      // Nothing left below, so the indicator gives way to the phantom row that
      // keeps the overlay's measured height steady.
      expect(painted).not.toContain("more line");
    } finally {
      tty.stop();
    }
  });

  test("switching tabs resets the scroll", async () => {
    const tty = mountViewer();
    try {
      await settled(tty);
      await tty.press(DOWN, DOWN);
      expect(await settled(tty)).toContain("↓ 6 more lines below");

      await tty.press(TAB);
      await tty.press(TAB);
      expect(await settled(tty)).toContain("↓ 8 more lines below");
    } finally {
      tty.stop();
    }
  });

  test("the strip wraps instead of running past the frame", async () => {
    // Eight labels is more than an 80-column overlay holds on one line, which is
    // the whole reason this face asks `TabBar` for a wrapping row: an agent's real
    // block labels overflow the same way.
    const many: Block[] = Array.from({ length: 8 }, (_, index) => ({
      id: `wide-${index}`,
      label: `block-number-${index}`,
      value: `value ${index}`,
    }));
    const tty = mountViewer({ blocks: many });
    try {
      const rows = (await settled(tty)).split("\n");
      const stripRows = rows.filter((row) => row.includes("block-number-"));
      expect(stripRows.length).toBeGreaterThan(1);

      // Wrapped, not clipped: every label is still on screen.
      const painted = rows.join("\n");
      for (let index = 0; index < many.length; index += 1) {
        expect(painted).toContain(`block-number-${index}`);
      }
    } finally {
      tty.stop();
    }
  });

  test("Escape and Ctrl+C both close", async () => {
    let closed = 0;
    const tty = mountViewer({
      onClose: () => {
        closed += 1;
      },
    });
    try {
      await tty.press(ESCAPE);
      await tty.press(CTRL_C);
      expect(closed).toBe(2);
    } finally {
      tty.stop();
    }
  });

  test("paints the empty state, and it can still be left", async () => {
    let closed = 0;
    const tty = mountViewer({
      blocks: [],
      onClose: () => {
        closed += 1;
      },
    });
    try {
      const painted = await settled(tty);
      const rows = painted.split("\n");

      expect(rows[0]).toBe("> /memory");
      expect(rows[3]).toBe("View your agent's memory");

      expect(painted).toContain("No memory attached to this agent.");
      expect(painted).toContain("Esc cancel");
      // No strip and no pane: there is nothing to switch to or scroll.
      expect(painted).not.toContain("←→/Tab switch");

      await tty.press(ESCAPE);
      expect(closed).toBe(1);
    } finally {
      tty.stop();
    }
  });
});
