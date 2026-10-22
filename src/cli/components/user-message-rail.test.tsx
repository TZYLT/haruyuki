import { afterEach, describe, expect, test } from "bun:test";
import { UserMessage } from "@/cli/components/UserMessageRich";
import { mountInkTty, resetInkTtyState } from "@/test-utils/ink-tty";

/**
 * The user message block's accent rail (P7, 《38》§11.9 ③).
 *
 * The block is a tinted rectangle with a `┃` down its left edge, and the rail is
 * *the block's* — it runs through the blank tinted rows above and below the text,
 * not only the rows that carry words. That is the judgement: a rail painted per
 * text row stops where the text does, and what the design asks for is an edge.
 *
 * The column it costs is paid out of the text's own budget, not the block's: the
 * rows still end at the terminal's edge, which is what `row-model.ts` mirrors when
 * it predicts the height (see `row-model.fidelity.test.tsx` for the height lock).
 */

afterEach(resetInkTtyState);

async function frame(text: string, columns = 20): Promise<string[]> {
  const tty = mountInkTty(
    <UserMessage line={{ kind: "user", id: "u", text }} />,
    { columns, rows: 12 },
  );
  try {
    return await tty.rows();
  } finally {
    tty.stop();
  }
}

describe("the user message rail", () => {
  test("runs down both blank rows and the text row", async () => {
    const rows = await frame("hi");
    // blank tinted row, the text, blank tinted row — every one of them edged.
    expect(rows).toHaveLength(3);
    expect(rows[0]?.trim()).toBe("┃");
    expect(rows[1]?.trim()).toBe("┃› hi");
    expect(rows[2]?.trim()).toBe("┃");
  });

  test("the prompt glyph is kept, one column inside the rail", async () => {
    const rows = await frame("hi");
    const body = rows[1] ?? "";
    expect(body).toStartWith("┃› ");
    // The rail is the first column; the prompt is the text's own marker.
    expect(body.indexOf("┃")).toBe(0);
    expect(body.indexOf("›")).toBe(1);
  });

  test("a wrapped block keeps the rail on every row it paints", async () => {
    const rows = await frame("x".repeat(60), 20);
    const painted = rows.filter((row) => row.length > 0);
    // Every non-empty row of the block starts with the rail — including the
    // continuation rows, which have no prompt glyph of their own.
    expect(painted.length).toBeGreaterThan(3);
    for (const row of painted) {
      expect(row).toStartWith("┃");
    }
    // The paragraph separator is still the only row without one… which is the
    // blank *between* blocks, not one of these rows: a single block paints none.
    expect(painted.some((row) => row.trim() === "┃")).toBe(true);
  });
});
