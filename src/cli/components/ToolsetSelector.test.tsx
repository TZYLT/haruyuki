import { afterEach, describe, expect, test } from "bun:test";
import { ToolsetSelector } from "@/cli/components/ToolsetSelector";
import {
  type InkTty,
  mountInkTty,
  resetInkTtyState,
} from "@/test-utils/ink-tty";

/**
 * The toolset overlay, judged on the frame and on where a key lands.
 *
 * This was the batch's hand-rolled face — its own header, its own row markup,
 * its own `useInput`. It is on the toolkit now, so both halves of that are
 * asserted: the frame still reads the way users have been reading it (`> /toolset`,
 * the solid line, the title, one row per preset, the hint), and the keys are the
 * toolkit's (arrows *and* j/k, Enter, Esc, Ctrl+C) rather than the arrows-only set
 * the face used to have.
 *
 * The motor is `Auto`: it is the one row whose marker is not `(current)`, because
 * the point of that row is to name the preset the preference resolves to.
 */

const DOWN = "\u001B[B";
const ENTER = "\r";
const ESCAPE = "\u001B";
const CTRL_C = "\u0003";

/** The row the cursor bar is on, or "" when nothing is highlighted. */
async function cursorRow(tty: InkTty): Promise<string> {
  const rows = await tty.rows();
  // Row 0 is the frame's `> /toolset` header, which shares the `> ` prefix.
  return (
    rows.find((row) => row.startsWith("> ") && !row.startsWith("> /")) ?? ""
  );
}

afterEach(resetInkTtyState);

describe("ToolsetSelector", () => {
  test("paints the frame, every preset and the shared hint", async () => {
    const tty = mountInkTty(
      <ToolsetSelector
        currentToolset="default"
        currentPreference="auto"
        onSelect={() => {}}
        onCancel={() => {}}
      />,
      { columns: 100 },
    );
    try {
      // The whole frame, because the chrome is the half a rewrite is most
      // likely to move without anyone noticing.
      expect(await tty.rows()).toEqual([
        "> /toolset",
        "─".repeat(100),
        "",
        "Swap your agent's toolset",
        "",
        "> Auto (current - Claude) · Auto-select based on the model",
        "  Haruyuki toolset · Experimental unified toolset for every model",
        "  None · Empty built-in preset; keeps connected tools",
        "  Claude toolset · Optimized for Anthropic models, recommended for all non-OpenAI models",
        "  Codex toolset · Optimized for GPT/Codex models",
        "",
        " Enter select · ↑↓/jk navigate · Esc cancel",
      ]);
    } finally {
      tty.stop();
    }
  });

  test("only the Auto row spells the current marker out, and only while it is current", async () => {
    const pinned = mountInkTty(
      <ToolsetSelector
        currentToolset="codex"
        currentPreference="codex"
        onSelect={() => {}}
        onCancel={() => {}}
      />,
      { columns: 100 },
    );
    try {
      const painted = await pinned.text();
      // `Auto` is not the current row any more, so it stops claiming to be …
      expect(painted).toContain("> Auto · Auto-select based on the model");
      expect(painted).not.toContain("(current -");
      // … and the preset the preference is pinned to takes the standard marker.
      expect(painted).toContain(
        "  Codex toolset (current) · Optimized for GPT/Codex models",
      );
    } finally {
      pinned.stop();
    }
  });

  test("j/k and the arrows move the cursor, Enter picks the preset under it", async () => {
    const chosen: string[] = [];
    const tty = mountInkTty(
      <ToolsetSelector
        currentToolset="default"
        currentPreference="auto"
        onSelect={(id) => chosen.push(id)}
        onCancel={() => {}}
      />,
      { columns: 100 },
    );
    try {
      await tty.press("j");
      expect(await cursorRow(tty)).toContain("Haruyuki toolset");

      await tty.press("j", "j");
      expect(await cursorRow(tty)).toContain("Claude toolset");

      await tty.press("k");
      expect(await cursorRow(tty)).toContain("None");

      await tty.press(DOWN);
      expect(await cursorRow(tty)).toContain("Claude toolset");

      await tty.press(ENTER);
      expect(chosen).toEqual(["default"]);
    } finally {
      tty.stop();
    }
  });

  test("Escape and Ctrl+C both cancel", async () => {
    let cancelled = 0;
    const tty = mountInkTty(
      <ToolsetSelector
        currentPreference="auto"
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
