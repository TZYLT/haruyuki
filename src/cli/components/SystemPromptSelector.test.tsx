import { afterEach, describe, expect, test } from "bun:test";
import { SystemPromptSelector } from "@/cli/components/SystemPromptSelector";
import {
  type InkTty,
  mountInkTty,
  resetInkTtyState,
} from "@/test-utils/ink-tty";

/**
 * The system-prompt overlay: featured prompts first, the rest behind one row.
 *
 * Two things here are only visible on the frame. The header used to say
 * `> /prompt`, a command that does not exist — the registry's is `/system`, and
 * that is what the user typed to get here. And "Show all prompts" is a control
 * wearing a row: pressing Enter on it must expand the list *in place* instead of
 * selecting it, so the assertion is that the newly visible prompts appear and the
 * control row is gone.
 */

const DOWN = "\u001B[B";
const ENTER = "\r";
const ESCAPE = "\u001B";
const CTRL_C = "\u0003";

/** The row the cursor bar is on, or "" when nothing is highlighted. */
async function cursorRow(tty: InkTty): Promise<string> {
  const rows = await tty.rows();
  // Row 0 is the frame's `> /system` header, which shares the `> ` prefix.
  return (
    rows.find((row) => row.startsWith("> ") && !row.startsWith("> /")) ?? ""
  );
}

afterEach(resetInkTtyState);

describe("SystemPromptSelector", () => {
  test("the header names the command that opens it", async () => {
    const tty = mountInkTty(
      <SystemPromptSelector onSelect={() => {}} onCancel={() => {}} />,
      { columns: 100 },
    );
    try {
      const rows = await tty.rows();
      expect(rows[0]).toBe("> /system");
      expect(rows.join("\n")).not.toContain("/prompt");
      expect(rows[1]).toBe("─".repeat(100));
      expect(rows.join("\n")).toContain("Swap your agent's system prompt");
    } finally {
      tty.stop();
    }
  });

  test("lists the featured prompts, marks the active one, and hides the rest behind one row", async () => {
    const tty = mountInkTty(
      <SystemPromptSelector
        currentPromptId="letta"
        onSelect={() => {}}
        onCancel={() => {}}
      />,
      { columns: 100 },
    );
    try {
      const painted = await tty.text();
      expect(await cursorRow(tty)).toContain("Default · Alias for haruyuki");
      expect(painted).toContain(
        "Haruyuki (current) · Full Haruyuki system prompt",
      );
      expect(painted).toContain("Show all prompts");
      // The unfeatured prompts are not on screen until asked for.
      expect(painted).not.toContain("Claude Code");
    } finally {
      tty.stop();
    }
  });

  test("Enter on the show-all row expands the list instead of selecting it", async () => {
    const chosen: string[] = [];
    const tty = mountInkTty(
      <SystemPromptSelector
        onSelect={(id) => chosen.push(id)}
        onCancel={() => {}}
      />,
      { columns: 100 },
    );
    try {
      await tty.press(DOWN, DOWN);
      expect(await cursorRow(tty)).toContain("Show all prompts");

      await tty.press(ENTER);
      const painted = await tty.text();
      expect(painted).toContain(
        "Claude Code · Source-faithful Claude Code prompt (for benchmarking)",
      );
      expect(painted).toContain("Gemini CLI");
      expect(painted).not.toContain("Show all prompts");
      // A control is not an answer.
      expect(chosen).toEqual([]);
    } finally {
      tty.stop();
    }
  });

  test("Enter on a prompt row selects its id", async () => {
    const chosen: string[] = [];
    const tty = mountInkTty(
      <SystemPromptSelector
        currentPromptId="letta"
        onSelect={(id) => chosen.push(id)}
        onCancel={() => {}}
      />,
    );
    try {
      await tty.press(DOWN);
      expect(await cursorRow(tty)).toContain("Haruyuki (current)");
      await tty.press(ENTER);
      expect(chosen).toEqual(["letta"]);
    } finally {
      tty.stop();
    }
  });

  test("Escape and Ctrl+C both cancel", async () => {
    let cancelled = 0;
    const tty = mountInkTty(
      <SystemPromptSelector
        onSelect={() => {}}
        onCancel={() => {
          cancelled += 1;
        }}
      />,
    );
    try {
      await tty.press(ESCAPE);
      await tty.press(CTRL_C);
      expect(cancelled).toBe(2);
    } finally {
      tty.stop();
    }
  });
});
