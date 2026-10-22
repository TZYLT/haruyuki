import { describe, expect, test } from "bun:test";
import type { PageRow } from "@/cli/app/pages/page-model";
import { terminalTextWidth } from "@/cli/helpers/char-width";
import type { UsageRecord } from "@/usage/ledger";
import { summarizeUsage } from "@/usage/summary";
import { blockText, blockWordmark } from "./font";
import {
  buildOverviewRows,
  centerBlock,
  centerLine,
  heroWidth,
  OVERVIEW_BLOCK_MIN_HEIGHT,
  OVERVIEW_BLOCK_MIN_WIDTH,
  overviewTier,
  rangeLabel,
  streakLabel,
  summaryItems,
  twoColumnBlock,
} from "./overview";

function record(
  tsHour: string,
  overrides: Partial<UsageRecord> = {},
): UsageRecord {
  return {
    tsHour,
    agentId: "agent-1",
    model: "openai/gpt-5.5",
    prompt: 100_000,
    cachedInput: 300_000,
    cacheWrite: 10_000,
    completion: 50_000,
    reasoning: 0,
    steps: 1,
    wallMs: 1,
    apiMs: 1,
    ...overrides,
  };
}

const NOW = new Date(2026, 9, 22, 12);

function texts(rows: readonly PageRow[]): string[] {
  return rows.map((row) => (row.kind === "text" ? row.text : `[${row.kind}]`));
}

/** Leading blanks of a row. */
function lead(line: string): number {
  return line.length - line.trimStart().length;
}

/** The width a row actually draws: its advance less the centring margin. */
function drawnWidth(line: string): number {
  return terminalTextWidth(line) - lead(line);
}

function summaryOf(records: UsageRecord[]) {
  return summarizeUsage(records, NOW);
}

describe("overviewTier", () => {
  test("the block tier needs both the width and the height", () => {
    expect(
      overviewTier({
        width: OVERVIEW_BLOCK_MIN_WIDTH,
        height: OVERVIEW_BLOCK_MIN_HEIGHT,
      }),
    ).toBe("block");
    expect(
      overviewTier({
        width: OVERVIEW_BLOCK_MIN_WIDTH - 1,
        height: OVERVIEW_BLOCK_MIN_HEIGHT,
      }),
    ).toBe("line");
    expect(
      overviewTier({
        width: OVERVIEW_BLOCK_MIN_WIDTH,
        height: OVERVIEW_BLOCK_MIN_HEIGHT - 1,
      }),
    ).toBe("line");
  });

  test("the height minimum is exactly what the block draws", () => {
    // Five rows of wordmark, a blank, five of hero, the unit, and the
    // two-column block's six. Anything less would scroll the block.
    const rows = buildOverviewRows({
      summary: summaryOf([record("2026-10-22T09")]),
      records: [record("2026-10-22T09")],
      now: NOW,
      width: 60,
      height: OVERVIEW_BLOCK_MIN_HEIGHT,
    });
    expect(rows).toHaveLength(OVERVIEW_BLOCK_MIN_HEIGHT);
  });
});

describe("buildOverviewRows (block tier)", () => {
  const records = [record("2026-10-22T09"), record("2026-10-21T09")];
  const summary = summaryOf(records);
  const rows = texts(
    buildOverviewRows({ summary, records, now: NOW, width: 60, height: 22 }),
  );

  test("the two block texts are separated by a blank row", () => {
    // The wordmark is the first five rows, then one empty row, then the hero.
    // This is the row Ink used to swallow (an empty <Text> is zero height).
    expect(rows[4]).toContain("█");
    expect(rows[5]).toBe("");
    expect(rows[6]).toContain("█");
  });

  test("the wordmark, the number and its unit are centred", () => {
    const wordmark = blockWordmark();
    for (const [index, line] of wordmark.entries()) {
      expect(rows[index]).toBe(centerLine(line, 60));
    }
    const hero = blockText("920k");
    for (const [index, line] of hero.entries()) {
      expect(rows[6 + index]).toBe(centerLine(line, 60));
    }
    expect(rows[11]).toBe(centerLine("tokens", 60));
  });

  test("the grid and the numbers are centred as one rectangle", () => {
    const start = lead(rows[12] ?? "");
    // One left margin for the whole block; the weekday header is indented inside
    // it by the label column, which is why it is not in this list.
    for (const index of [12, 14, 15, 16, 17]) {
      expect(lead(rows[index] ?? "")).toBe(start);
    }
    const widest = Math.max(...rows.slice(12).map((row) => drawnWidth(row)));
    expect(start).toBe(Math.floor((60 - widest) / 2));
  });

  test("the grid and the numbers share one two-column block", () => {
    expect(rows[12]).toContain("Last 4 weeks");
    expect(rows[12]).toContain("cost (est.)");
    expect(rows[17]).toContain("-3w");
  });

  test("the unit and the captions are dim, the numbers are not", () => {
    const dimmed = buildOverviewRows({
      summary,
      records,
      now: NOW,
      width: 60,
      height: 22,
    }).map((row) => (row.kind === "text" ? row.dim === true : false));
    expect(dimmed[0]).toBe(true); // wordmark
    expect(dimmed[6]).toBe(false); // hero
    expect(dimmed[11]).toBe(true); // "tokens"
    expect(dimmed[12]).toBe(false); // grid and numbers
  });

  test("the numbers the page is for are on screen", () => {
    const joined = rows.join("\n");
    expect(joined).toContain("Last 4 weeks");
    expect(joined).toContain("cost (est.)");
    expect(joined).toContain("total turns");
    expect(joined).toContain("today hit");
    expect(joined).toContain("75.00%");
    expect(joined).toContain("2 days");
    expect(joined).toContain("tokens");
  });
});

describe("buildOverviewRows (line tier)", () => {
  const records = [record("2026-10-22T09"), record("2026-10-21T09")];
  const summary = summaryOf(records);

  test("drops the art but keeps the number and the summary", () => {
    const rows = texts(
      buildOverviewRows({ summary, records, now: NOW, width: 40, height: 22 }),
    );
    expect(rows[0]).toBe("920k tokens");
    expect(rows.join("\n")).not.toContain("███");
    expect(rows.join("\n")).toContain("cost (est.)");
  });

  test("an empty ledger says so instead of drawing zeros", () => {
    const rows = texts(
      buildOverviewRows({
        summary: summaryOf([]),
        records: [],
        now: NOW,
        width: 60,
        height: 22,
      }),
    );
    expect(rows[0]).toBe("No usage recorded yet.");
    expect(rows.join("\n")).not.toContain("0 tokens");
  });

  test("the summary keeps one item per line when it has to wrap", () => {
    const items = summaryItems(summary);
    expect(items).toHaveLength(5);
    const narrow = texts(
      buildOverviewRows({ summary, records, now: NOW, width: 30, height: 22 }),
    );
    expect(narrow).toEqual(expect.arrayContaining(items));
  });
});

describe("centring", () => {
  test("a line is padded so its own text sits on the axis", () => {
    expect(centerLine("ab", 10)).toBe("    ab");
    expect(centerLine("ab", 3)).toBe("ab");
    // No room to centre: never negative padding.
    expect(centerLine("abcdef", 2)).toBe("abcdef");
  });

  test("a block keeps one margin, so its columns stay aligned", () => {
    expect(centerBlock(["aaa", "a"], 9)).toEqual(["   aaa", "   a"]);
  });
});

describe("twoColumnBlock", () => {
  test("pads the left block so the right column starts at one cell", () => {
    expect(twoColumnBlock(["a", "bb"], ["12", "34"], 4, 2)).toEqual([
      "a     12",
      "bb    34",
    ]);
  });

  test("a right column taller than the left does not pad the short side", () => {
    expect(twoColumnBlock(["a"], ["x", "y"], 3)).toEqual(["a    x", "     y"]);
  });
});

describe("streakLabel", () => {
  test("one day is singular", () => {
    expect(streakLabel(0)).toBe("0 days");
    expect(streakLabel(1)).toBe("1 day");
    expect(streakLabel(4)).toBe("4 days");
  });
});

describe("rangeLabel", () => {
  test("spans four weeks ending today", () => {
    expect(rangeLabel(NOW)).toBe("2026-09-28 – 2026-10-22");
  });
});

describe("heroWidth", () => {
  test("is what the font says for the compact number", () => {
    expect(
      heroWidth(summaryOf([record("2026-10-22T09"), record("2026-10-21T09")])),
    ).toBe(4 * 3 + 3 * 1); // "920k": four 3-wide glyphs
  });
});
