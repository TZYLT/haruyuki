import { describe, expect, test } from "bun:test";
import type { PageRow } from "@/cli/app/pages/page-model";
import type { UsageRecord } from "@/usage/ledger";
import { summarizeUsage } from "@/usage/summary";
import {
  bucketTokens,
  buildDetailRows,
  latestContextTokens,
  recentDays,
} from "./detail";

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

function detailOf(records: UsageRecord[], contextWindow?: number): string[] {
  return texts(
    buildDetailRows({
      summary: summarizeUsage(records, NOW),
      records,
      now: NOW,
      width: 80,
      contextWindow,
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
  test("draws the four sections the spec names, in English", () => {
    const rows = detailOf([record("2026-10-22T09")]);
    const joined = rows.join("\n");
    expect(joined).toContain("Cost (est.");
    expect(joined).toContain("Input miss");
    expect(joined).toContain("Input hit");
    expect(joined).toContain("Cache write");
    expect(joined).toContain("Output");
    expect(joined).toContain("Context composition (latest request)");
    expect(joined).toContain("By model");
    expect(joined).toContain("History (last 14 days)");
  });

  test("percentages are two decimals and share one denominator", () => {
    const rows = detailOf([record("2026-10-22T09")]);
    // 400 / 600 = 66.67%, 100 / 600 = 16.67%, 50 / 600 = 8.33% twice.
    const buckets = rows.filter((row) =>
      /Input (miss|hit)|Cache write|Output/.test(row),
    );
    expect(buckets).toHaveLength(4);
    expect(buckets[0]).toContain("66.67%");
    expect(buckets[1]).toContain("16.67%");
    expect(buckets[2]).toContain("8.33%");
    expect(buckets[3]).toContain("8.33%");
  });

  test("an unpriced ledger shows a dash for every cost", () => {
    const rows = detailOf([record("2026-10-22T09")]);
    const joined = rows.join("\n");
    expect(joined).toContain("Cost (est. —)");
    expect(joined).not.toContain("$ 0.00");
  });

  test("costs are printed with five decimals", () => {
    // The whole point of the fifth decimal: a normal turn costs a fraction of a
    // cent, and at two decimals every bucket on this screen reads `$ 0.00`.
    const cost = {
      input: 0.0001,
      cacheRead: 0.0002,
      cacheWrite: 0.0003,
      output: 0.0004,
      total: 0.001,
    };
    const rows = detailOf([record("2026-10-22T09", { cost })]);
    const joined = rows.join("\n");
    expect(joined).toContain("Cost (est. $ 0.00100)");
    expect(joined).toContain("$ 0.00010");
    expect(joined).toContain("$ 0.00040");
  });

  test("the composition is drawn with two-decimal shares and the window", () => {
    const withComposition = record("2026-10-22T09", {
      contextTokens: 84_000,
      contextBreakdown: {
        system: 8_000,
        messages: 23_000,
        tools: 31_000,
      },
    });
    const rows = detailOf([withComposition], 128_000);
    const joined = rows.join("\n");
    expect(joined).toContain("84k / 128k");
    expect(joined).toContain("65.63%");
    // 8k / 62k = 12.90%, 31k = 50.00%, 23k = 37.10%.
    expect(joined).toContain("system");
    expect(joined).toContain("12.90%");
    expect(joined).toContain("tools");
    expect(joined).toContain("50.00%");
    expect(joined).toContain("messages");
    expect(joined).toContain("37.10%");
    // Memory cannot be separated locally; the screen must say so.
    expect(joined).toContain("memory is folded into the system prompt locally");
  });

  test("without a composition the section falls back to the occupancy", () => {
    const rows = detailOf([record("2026-10-22T09", { contextTokens: 84_000 })]);
    const joined = rows.join("\n");
    expect(joined).toContain(
      "the latest turn used 84k tokens, with no composition",
    );
    expect(joined).not.toContain("memory is folded");
  });

  test("an empty ledger says so", () => {
    expect(detailOf([])[0]).toBe("No usage recorded yet.");
  });

  test("every section opens after exactly one blank row", () => {
    // The 2026-10-23 pass: four dim titles on consecutive lines read as one long
    // list, so each section now starts after a row of air — the first one
    // included, otherwise its title touches the page header.
    const rows = detailOf([record("2026-10-22T09")]);
    const titles = [
      "Cost (est.",
      "Context composition (latest request)",
      "By model",
      "History (last 14 days)",
    ];
    for (const title of titles) {
      const index = rows.findIndex((row) => row.startsWith(title));
      expect(index).toBeGreaterThan(0);
      expect(rows[index - 1]).toBe("");
    }
    // One blank per section: a doubled blank is a design bug the frame would
    // happily paint, so the count is pinned rather than only the position.
    expect(rows.filter((row) => row === "")).toHaveLength(titles.length);
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
    expect(history[0]).toContain("$ 1.00000");
    expect(history[1]).toContain("—");
    // The bucket counts are still there, and they are columns.
    expect(history[0]).toContain("400");
    expect(history[0]).toContain("100");
  });

  test("the history columns are labelled once, above the rows", () => {
    const rows = detailOf([record("2026-10-22T10"), record("2026-10-21T10")]);
    const index = rows.findIndex((row) => row.startsWith("  day"));
    expect(index).toBeGreaterThan(0);
    expect(rows[index]).toContain("write");
    expect(rows[index + 1]).toContain("10-22");
  });
});
