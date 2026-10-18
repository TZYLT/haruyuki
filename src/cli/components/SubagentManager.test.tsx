import { afterEach, describe, expect, test } from "bun:test";
import { SubagentManager } from "@/cli/components/SubagentManager";
import { mountInkTty, resetInkTtyState } from "@/test-utils/ink-tty";

/**
 * `/subagents` — the read-only listing.
 *
 * It has no cursor to move, so the only thing to verify is the frame and the way
 * out: it used to draw a bare title with no chrome and read three keys through
 * `useInput`, and it is now a frame plus a key table like every other overlay.
 *
 * The hint line names the global agents directory, which is an absolute path
 * resolved at import time, so the assertions below deliberately read that row by
 * its stable text rather than by its full contents.
 */

const ESCAPE = "\u001B";
const ENTER = "\r";
const CTRL_C = "\u0003";
const SOLID = "─";

afterEach(resetInkTtyState);

describe("SubagentManager", () => {
  test("paints the shared overlay frame, the title and the how-to-close hint", async () => {
    const tty = mountInkTty(<SubagentManager onClose={() => {}} />, {
      columns: 100,
      rows: 60,
    });
    try {
      expect((await tty.rows()).slice(0, 4)).toEqual([
        "> /subagents",
        SOLID.repeat(100),
        "",
        "Available Subagents",
      ]);

      const text = await tty.text();
      expect(text).toContain("Built-in");
      expect(text).toContain("To add custom subagents, create .md files in");
      expect(text).toContain("Press ESC or Enter to close");
    } finally {
      tty.stop();
    }
  });

  test("Escape, Enter and Ctrl+C each close it", async () => {
    let closed = 0;
    const tty = mountInkTty(
      <SubagentManager
        onClose={() => {
          closed += 1;
        }}
      />,
      { columns: 100, rows: 60 },
    );
    try {
      await tty.press(ESCAPE);
      await tty.press(ENTER);
      await tty.press(CTRL_C);
      expect(closed).toBe(3);
    } finally {
      tty.stop();
    }
  });
});
