import { afterEach, describe, expect, test } from "bun:test";
import { PersonalitySelector } from "@/cli/components/PersonalitySelector";
import {
  type InkTty,
  mountInkTty,
  resetInkTtyState,
} from "@/test-utils/ink-tty";

/**
 * The personality overlay: a frame plus the toolkit's single-select list.
 *
 * It was already a `SingleSelectPicker` consumer before this batch, so the
 * migration is the shell swap — which is exactly why it is worth a frame test:
 * the face must still paint the same rows, mark the active personality, and put
 * Enter on the id under the cursor.
 */

const DOWN = "\u001B[B";
const ENTER = "\r";
const ESCAPE = "\u001B";
const CTRL_C = "\u0003";

/** The row the cursor bar is on, or "" when nothing is highlighted. */
async function cursorRow(tty: InkTty): Promise<string> {
  const rows = await tty.rows();
  // Row 0 is the frame's `> /personality` header, which shares the `> ` prefix.
  return (
    rows.find((row) => row.startsWith("> ") && !row.startsWith("> /")) ?? ""
  );
}

afterEach(resetInkTtyState);

describe("PersonalitySelector", () => {
  test("paints the frame, every personality, and marks the active one", async () => {
    const tty = mountInkTty(
      <PersonalitySelector
        currentPersonalityId="linus"
        onSelect={() => {}}
        onCancel={() => {}}
      />,
      { columns: 120 },
    );
    try {
      const rows = await tty.rows();
      const painted = rows.join("\n");

      expect(rows[0]).toBe("> /personality");
      expect(rows[1]).toBe("─".repeat(120));
      expect(painted).toContain("Swap your agent personality");

      // The cursor starts at the top of the list …
      expect(await cursorRow(tty)).toContain(
        "Haruyuki · The memory-first agent",
      );
      // … and the active personality is marked, not just highlighted.
      expect(painted).toContain("  Linus (current) · Code with a stern hand");
      expect(painted).toContain("Haruyuki-Chan");
      expect(painted).toContain(" Enter select · ↑↓/jk navigate · Esc cancel");
    } finally {
      tty.stop();
    }
  });

  test("j/k and the arrows move the cursor, Enter picks the id under it", async () => {
    const chosen: string[] = [];
    const tty = mountInkTty(
      <PersonalitySelector
        onSelect={(id) => chosen.push(id)}
        onCancel={() => {}}
      />,
      { columns: 120 },
    );
    try {
      await tty.press("j", "j", "j");
      expect(await cursorRow(tty)).toContain("Linus");

      await tty.press(DOWN);
      expect(await cursorRow(tty)).toContain("Haruyuki-Chan");

      await tty.press("k");
      expect(await cursorRow(tty)).toContain("Linus");

      await tty.press(ENTER);
      expect(chosen).toEqual(["linus"]);
    } finally {
      tty.stop();
    }
  });

  test("Escape and Ctrl+C both cancel", async () => {
    let cancelled = 0;
    const tty = mountInkTty(
      <PersonalitySelector
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
