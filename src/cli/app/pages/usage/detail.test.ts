import { describe, expect, test } from "bun:test";
import type { PageRow } from "@/cli/app/pages/page-model";
import type { UsageRecord } from "@/usage/ledger";
import {
  bucketTokens,
  buildDetailRows,
  latestContextTokens,
  recentDays,
} from "./detail";
import { summarizeUsage } from "./ledger-view";

function record(
  tsHour: string,
  overrides: Partial<UsageRecord> = {},
): UsageRecord {
  return {
    tsHour,
    agentId: "agent-1",
    model: "openai/gpt-5.5",
    prompt: 400,
    cachedInput: 100,
    cacheWrite: 50,
    completion: 50,
    reasoning: 0,
    steps: 1,
    wallMs: 1,
    apiMs: 1,
    ...overrides,
  };
}

const NOW = new Date(2026, 9, 22, 12);

function texts(rows: readonly PageRow[]): string[] {
  return rows.map((row) =>
    row.kind === "text" || row.kind === "header" || row.kind === "note"
      ? row.text
      : `[${row.kind}]`,
  );
}

function detailOf(records: UsageRecord[]): string[] {
  return texts(
    buildDetailRows({
      summary: summarizeUsage(records, NOW),
      records,
      now: NOW,
      width: 80,
    }),
  );
}

describe("bucketTokens", () => {
  test("adds the four billed buckets", () => {
    expect(bucketTokens([record("2026-10-22T09")])).toEqual({
      miss: 400,
      hit: 100,
      write: 50,
      output: 50,
      total: 600,
    });
  });
});

describe("latestContextTokens", () => {
  test("takes the newest hour that reported occupancy", () => {
    expect(
      latestContextTokens([
        record("2026-10-21T09", { contextTokens: 1_000 }),
        record("2026-10-22T09", { contextTokens: 2_000 }),
      ]),
    ).toBe(2_000);
  });

  test("is undefined when nothing reported it", () => {
    expect(latestContextTokens([record("2026-10-22T09")])).toBeUndefined();
  });
});

describe("recentDays", () => {
  test("keeps only days inside the window, newest first", () => {
    const records = [
      record("2026-10-22T09"),
      record("2026-10-20T09"),
      record("2026-09-01T09"),
    ];
    expect(recentDays(records, NOW)).toEqual(["2026-10-22", "2026-10-20"]);
  });

  test("a gap day is not invented", () => {
    expect(recentDays([record("2026-10-22T09")], NOW)).toEqual(["2026-10-22"]);
  });
});

describe("buildDetailRows", () => {
  test("draws the four sections the spec names", () => {
    const rows = detailOf([record("2026-10-22T09")]);
    const joined = rows.join("\n");
    expect(joined).toContain("成本（估算");
    expect(joined).toContain("输入 miss");
    expect(joined).toContain("输入 hit");
    expect(joined).toContain("缓存写");
    expect(joined).toContain("上下文");
    expect(joined).toContain("按模型");
    expect(joined).toContain("历史消耗（近 14 天）");
  });

  test("percentages are one decimal and share one denominator", () => {
    const rows = detailOf([record("2026-10-22T09")]);
    // 400 / 600 = 66.7%, 100 / 600 = 16.7%, 50 / 600 = 8.3% twice.
    const buckets = rows.filter((row) => row.includes("¥"));
    expect(buckets[0]).toContain("66.7%");
    expect(buckets[1]).toContain("16.7%");
    expect(buckets[2]).toContain("8.3%");
    expect(buckets[3]).toContain("8.3%");
  });

  test("an unpriced ledger shows a dash for every cost", () => {
    const rows = detailOf([record("2026-10-22T09")]);
    const joined = rows.join("\n");
    expect(joined).toContain("成本（估算 —）");
    expect(joined).not.toContain("¥ 0.00");
  });

  test("costs are printed when the records carry them", () => {
    const cost = {
      input: 0.1,
      cacheRead: 0.2,
      cacheWrite: 0.3,
      output: 0.4,
      total: 1,
    };
    const rows = detailOf([record("2026-10-22T09", { cost })]);
    const joined = rows.join("\n");
    expect(joined).toContain("成本（估算 ¥ 1.00）");
    expect(joined).toContain("¥ 0.10");
    expect(joined).toContain("¥ 0.40");
  });

  test("an empty ledger says so", () => {
    expect(detailOf([])[0]).toBe("还没有用量记录。");
  });

  test("the history table carries one row per active day, with its cost", () => {
    const rows = detailOf([
      record("2026-10-22T09", {
        cost: {
          input: 1,
          cacheRead: 0,
          cacheWrite: 0,
          output: 0,
          total: 1,
        },
      }),
      record("2026-10-21T09"),
    ]);
    const history = rows.filter((row) => row.startsWith("  10-"));
    expect(history).toHaveLength(2);
    expect(history[0]).toContain("10-22");
    expect(history[1]).toContain("10-21");
    // 10-22 has a price, 10-21 does not.
    expect(history[0]).toContain("¥ 1.00");
    expect(history[1]).toContain("—");
  });
});
