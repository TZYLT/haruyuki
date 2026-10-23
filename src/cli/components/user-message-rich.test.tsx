import { afterEach, describe, expect, test } from "bun:test";
import { Box } from "ink";
import { UserMessage } from "@/cli/components/UserMessageRich";
import { terminalTextWidth } from "@/cli/helpers/char-width";
import { TranscriptColumnsScope } from "@/cli/hooks/transcript-columns";
import { mountInkTty, resetInkTtyState } from "@/test-utils/ink-tty";

/**
 * The user message wraps at the width it is *drawn* in.
 *
 * In the full-screen shell that is the transcript band, not the terminal: the band
 * sits beside the context rail and keeps two columns of right margin, so it is
 * narrower (`transcript-columns.ts`). The block used to pre-wrap at
 * `process.stdout.columns` while the box holding it was the band's, so every
 * wrapped row overflowed its container and Ink answered with `truncate-end` — the
 * `…` a user saw in the middle of their own sentence in the main view
 * (2026-10-23).
 *
 * The tell is not just "the text is there": a row that is too wide is *silently*
 * cut and then repaired with an ellipsis, so these tests assert the full text
 * comes back and that no row is wider than the band. The no-band case is the
 * append shell, whose whole appearance is frozen — it must still lay out at the
 * terminal's own width.
 */

afterEach(resetInkTtyState);

const CHINESE =
  "这是一段很长的中文消息，用来确认输入内容按可用宽度自动折行，而不是被省略号截断。";
const LONG_WORD = "averyverylongwordwithnospacesatall".repeat(3);

async function frame(
  text: string,
  options: { band?: number; columns: number },
): Promise<string[]> {
  const message = <UserMessage line={{ kind: "user", id: "u1", text }} />;
  const tty = mountInkTty(
    options.band === undefined ? (
      message
    ) : (
      <TranscriptColumnsScope.Provider value={options.band}>
        <Box width={options.band}>{message}</Box>
      </TranscriptColumnsScope.Provider>
    ),
    { columns: options.columns, rows: 16 },
  );
  try {
    return await tty.rows();
  } finally {
    tty.stop();
  }
}

/** Rows with the rail, the prompt glyph and the continuation indent removed. */
function bodyRows(rows: readonly string[]): string[] {
  return rows.map((row) => row.replace("┃", "").replace("›", "").trim());
}

describe("a user message inside the full-screen band", () => {
  test("wraps long Chinese at the band, with no ellipsis", async () => {
    const rows = await frame(CHINESE, { band: 40, columns: 80 });
    expect(rows.join("")).not.toContain("…");
    for (const row of rows) {
      expect(terminalTextWidth(row)).toBeLessThanOrEqual(40);
    }
    // Nothing is dropped or truncated: the whole message is on screen.
    expect(bodyRows(rows).join("")).toBe(CHINESE);
  });

  test("wraps a word with no spaces at the band, with no ellipsis", async () => {
    const rows = await frame(LONG_WORD, { band: 40, columns: 80 });
    expect(rows.join("")).not.toContain("…");
    for (const row of rows) {
      expect(terminalTextWidth(row)).toBeLessThanOrEqual(40);
    }
    expect(bodyRows(rows).join("")).toBe(LONG_WORD);
  });

  test("uses the band even though the terminal is much wider", async () => {
    // A single line that would fit the terminal and not the band: if the pre-wrap
    // ran at the terminal's width this would stay on one row.
    const rows = await frame("x".repeat(60), { band: 40, columns: 200 });
    const painted = bodyRows(rows).filter((row) => row.length > 0);
    expect(painted.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect(terminalTextWidth(row)).toBeLessThanOrEqual(40);
    }
  });

  test("the block still ends at the band's right edge", async () => {
    // The highlighted block pads to `columns`; that has to be the band's width, not
    // the terminal's, or the tint runs past the box and Ink truncates each padded
    // row (and marks the cut with an ellipsis).
    const rows = await frame("hi", { band: 40, columns: 80 });
    expect(rows.join("")).not.toContain("…");
    // blank tinted row, the text row, blank tinted row
    expect(rows).toHaveLength(3);
    expect(terminalTextWidth(rows[1] ?? "")).toBeLessThanOrEqual(40);
  });
});

describe("a user message with no band (the append shell)", () => {
  test("lays out at the terminal's width", async () => {
    const rows = await frame(CHINESE, { columns: 20 });
    expect(rows.join("")).not.toContain("…");
    for (const row of rows) {
      expect(terminalTextWidth(row)).toBeLessThanOrEqual(20);
    }
    expect(bodyRows(rows).join("")).toBe(CHINESE);
  });

  test("keeps a short message on one row", async () => {
    const rows = await frame("hi there", { columns: 40 });
    const painted = bodyRows(rows).filter((row) => row.length > 0);
    expect(painted).toHaveLength(1);
  });
});
