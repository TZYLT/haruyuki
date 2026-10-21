import { describe, expect, test } from "bun:test";
import type { PageRow } from "@/cli/app/pages/page-model";
import type { UsageRecord } from "@/usage/ledger";
import { summarizeUsage } from "./ledger-view";
import {
  buildOverviewRows,
  columns,
  footerItems,
  heroWidth,
  OVERVIEW_BLOCK_MIN_HEIGHT,
  OVERVIEW_BLOCK_MIN_WIDTH,
  overviewTier,
  rangeLabel,
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
});

describe("buildOverviewRows", () => {
  const records = [record("2026-10-22T09"), record("2026-10-21T09")];
  const summary = summaryOf(records);

  test("the block tier draws the wordmark, the hero and the grid", () => {
    const rows = texts(
      buildOverviewRows({ summary, records, now: NOW, width: 60, height: 22 }),
    );
    const joined = rows.join("\n");
    // Wordmark and hero are block art: the line of a glyph row is dense with █.
    expect(joined).toContain("█");
    expect(joined).toContain("近 4 周");
    expect(joined).toContain("总成本(API 估算)");
    expect(joined).toContain("总回合");
    expect(rows.at(-1)).toContain("今日缓存率");
  });

  test("the line tier drops the art but keeps the number and the summary", () => {
    const rows = texts(
      buildOverviewRows({ summary, records, now: NOW, width: 40, height: 22 }),
    );
    expect(rows[0]).toBe("920k tokens");
    expect(rows.join("\n")).not.toContain("███");
    expect(rows.join("\n")).toContain("总成本");
    expect(rows.at(-1)).toContain("今日缓存率");
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
    expect(rows[0]).toBe("还没有用量记录。");
    expect(rows.join("\n")).not.toContain("0 tokens");
  });

  test("the footer keeps the three items even when it has to wrap", () => {
    const items = footerItems(summary);
    expect(items).toHaveLength(3);
    const narrow = texts(
      buildOverviewRows({ summary, records, now: NOW, width: 30, height: 22 }),
    );
    expect(narrow).toEqual(expect.arrayContaining(items));
  });

  test("the hero width is what the font says for the compact number", () => {
    expect(heroWidth(summary)).toBe(4 * 3 + 3 * 1); // "920k": four 3-wide glyphs
  });
});

describe("columns", () => {
  test("pads the left block so the right column starts at one cell", () => {
    const lines = columns(["a", "bb"], ["12", "34"], 4, 2);
    expect(lines).toEqual(["a     12", "bb    34"]);
  });

  test("a right column taller than the left does not pad the short side", () => {
    expect(columns(["a"], ["x", "y"], 3)).toEqual(["a    x", "     y"]);
  });
});

describe("rangeLabel", () => {
  test("spans four weeks ending today", () => {
    expect(rangeLabel(NOW)).toBe("2026-09-28 – 2026-10-22");
  });
});
