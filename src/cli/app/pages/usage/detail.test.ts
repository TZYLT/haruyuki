import { describe, expect, test } from "bun:test";
import type { PageRow } from "@/cli/app/pages/page-model";
import type { UsageRecord } from "@/usage/ledger";
import { summarizeUsage } from "@/usage/summary";
import {
  automatedUsageRows,
  automatedUsageTotal,
  bucketTokens,
  buildDetailRows,
  latestContextTokens,
  recentDays,
} from "./detail";
import {
  AUTOMATED_TABLE_FULL_WIDTH,
  automatedTableColumns,
  automatedTableNaturalWidth,
  modelTableColumns,
  renderDetailTable,
} from "./detail-tables";

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

function detailOf(
  records: UsageRecord[],
  contextWindow?: number,
  options: { width?: number; fullTable?: boolean } = {},
): string[] {
  return texts(
    buildDetailRows({
      summary: summarizeUsage(records, NOW),
      records,
      now: NOW,
      width: options.width ?? 80,
      contextWindow,
      fullTable: options.fullTable,
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
  test("draws the five sections the spec names, in English", () => {
    const rows = detailOf([record("2026-10-22T09")]);
    const joined = rows.join("\n");
    expect(joined).toContain("Cost (est.");
    expect(joined).toContain("Input miss");
    expect(joined).toContain("Input hit");
    expect(joined).toContain("Cache write");
    expect(joined).toContain("Output");
    expect(joined).toContain("Context composition (latest request)");
    expect(joined).toContain("By model");
    expect(joined).toContain("Automated tasks");
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

  test("the composition is marked as an estimate, with the measured total unmarked", () => {
    // T-05 / R-05.3–R-05.6: the components are estimates (4 bytes/token) and the
    // shares derived from them inherit the `~`; the total is the provider's
    // `context_tokens` and is what the rail's ctx% shows, so it must NOT be
    // marked. The denominator is that total, not the component sum: the estimate
    // is allowed to miss it, and marking each share is the honest way to say so.
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
    // 8k / 84k = 9.5% -> ~10%, 31k = 36.9% -> ~37%, 23k = 27.4% -> ~27%.
    expect(joined).toContain("sys+mem");
    expect(joined).toContain("~8k");
    expect(joined).toContain("~10%");
    expect(joined).toContain("tools");
    expect(joined).toContain("~31k");
    expect(joined).toContain("~37%");
    expect(joined).toContain("messages");
    expect(joined).toContain("~23k");
    expect(joined).toContain("~27%");
    // The moving parts are marked; the measured total is not.
    expect(joined).not.toContain("~84k");
    expect(joined).not.toContain("~128k");
    // Memory is compiled into the system prompt locally, and the label now says
    // so: the separate "memory is folded" note row is gone (R-05.5).
    expect(joined).not.toContain("memory is folded");
    expect(rows.some((row) => row.includes("system"))).toBe(false);
  });

  test("an old ledger row keeps its components and may exceed 100%", () => {
    // R-05.7 / Q-30: old rows are not recomputed. Their components were stored
    // under the old anchoring, so against the provider total they can sum past
    // it; the screen reports that rather than clamping or dividing by the sum.
    const old = record("2026-10-22T09", {
      contextTokens: 50_000,
      contextBreakdown: {
        system: 8_000,
        messages: 23_000,
        tools: 31_000,
      },
    });
    const joined = detailOf([old], 128_000).join("\n");
    // 8/50 = 16%, 31/50 = 62%, 23/50 = 46%: the rows add up to 124%.
    expect(joined).toContain("~16%");
    expect(joined).toContain("~62%");
    expect(joined).toContain("~46%");
    // The stored component values are drawn as-is, with the estimate marker.
    expect(joined).toContain("~8k");
    expect(joined).toContain("~31k");
    expect(joined).toContain("~23k");
  });

  test("a composition without a provider total falls back to the estimated sum", () => {
    const withComposition = record("2026-10-22T09", {
      contextBreakdown: {
        system: 8_000,
        messages: 23_000,
        tools: 31_000,
      },
    });
    const joined = detailOf([withComposition]).join("\n");
    // 62k is the component sum, so it is itself an estimate and carries `~`.
    expect(joined).toContain("~62k tokens (estimated)");
    // With no provider total the sum is the only denominator: 100% in total.
    expect(joined).toContain("sys+mem");
    expect(joined).toContain("~13%"); // 8 / 62
    expect(joined).toContain("~50%"); // 31 / 62
    expect(joined).toContain("~37%"); // 23 / 62
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
      "Automated tasks",
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

describe("the automated tasks section", () => {
  const automated: UsageRecord[] = [
    record("2026-10-22T09", {
      source: "reflection",
      prompt: 800,
      cachedInput: 200,
      cacheWrite: 0,
      completion: 100,
      cost: {
        input: 0.1,
        cacheRead: 0.2,
        cacheWrite: 0,
        output: 0.2,
        total: 0.5,
      },
    }),
    record("2026-10-22T10", {
      source: "reflection",
      prompt: 200,
      cachedInput: 0,
      cacheWrite: 0,
      completion: 100,
    }),
    record("2026-10-21T09", {
      source: "dream",
      prompt: 100,
      cachedInput: 0,
      cacheWrite: 0,
      completion: 0,
    }),
  ];

  test("splits the spend by source and totals it", () => {
    const rows = automatedUsageRows(automated);
    expect(rows.map((row) => row.source)).toEqual(["dream", "reflection"]);
    const reflection = rows[1];
    expect(reflection?.runs).toBe(2);
    // in = prompt + cacheWrite, hit = cachedInput, out = completion.
    expect(reflection?.in).toBe(1_000);
    expect(reflection?.hit).toBe(200);
    expect(reflection?.out).toBe(200);
    // The split loses nothing: in + hit + out is the old four-bucket total.
    expect(
      (reflection?.in ?? 0) + (reflection?.hit ?? 0) + (reflection?.out ?? 0),
    ).toBe(1_400);
    expect(reflection?.cost).toBeCloseTo(0.5);
    // The hit rate stays the ledger's input-only rate:
    // cachedInput / (prompt + cachedInput), not hit / (in + hit).
    expect(reflection?.hitRate).toBeCloseTo(200 / 1_200);

    const total = automatedUsageTotal(automated);
    expect(total?.runs).toBe(3);
    expect(total?.in).toBe(1_100);
    expect(total?.hit).toBe(200);
    expect(total?.out).toBe(200);
    expect((total?.in ?? 0) + (total?.hit ?? 0) + (total?.out ?? 0)).toBe(
      1_500,
    );
    expect(total?.cost).toBeCloseTo(0.5);
    expect(total?.hitRate).toBeCloseTo(200 / 1_300);
  });

  test("interactive turns are not automated runs", () => {
    const mixed = [...automated, record("2026-10-22T11", { prompt: 999 })];
    expect(automatedUsageRows(mixed).map((row) => row.source)).toEqual([
      "dream",
      "reflection",
    ]);
    // Interactive spend must not move the automated total.
    expect(automatedUsageTotal(mixed)?.in).toBe(1_100);
  });

  test("the screen lists the sources and their total between By model and History", () => {
    const rows = detailOf(automated);
    const joined = rows.join("\n");
    expect(joined).toContain("Automated tasks");
    const byModel = rows.findIndex((row) => row.startsWith("By model"));
    const automatedTitle = rows.findIndex((row) =>
      row.startsWith("Automated tasks"),
    );
    const history = rows.findIndex((row) => row.startsWith("History (last"));
    expect(byModel).toBeGreaterThan(0);
    expect(automatedTitle).toBeGreaterThan(byModel);
    expect(history).toBeGreaterThan(automatedTitle);

    const table = rows.filter((row) =>
      /^ {2}(dream|reflection|total)\b/.test(row),
    );
    expect(table).toHaveLength(3);
    // The full table at 80 columns: source 2..12, runs 12..18, in 18..25,
    // hit 25..32, out 32..39, cost 39..50, hit% 50..58 (O-05's 58).
    const reflection = table.find((row) => row.startsWith("  reflection"));
    expect(reflection?.slice(2, 12)).toBe("reflection");
    expect(reflection?.slice(12, 18).trim()).toBe("2");
    expect(reflection?.slice(18, 25).trim()).toBe("1k"); // in
    expect(reflection?.slice(25, 32).trim()).toBe("200"); // hit
    expect(reflection?.slice(32, 39).trim()).toBe("200"); // out
    expect(reflection?.slice(39, 50).trim()).toBe("$ 0.50000");
    expect(reflection?.slice(50, 58).trim()).toBe("16.67%");
    const total = table.find((row) => row.startsWith("  total"));
    expect(total?.slice(12, 18).trim()).toBe("3");
    expect(joined).toContain("16.67%");
    expect(joined).toContain("$ 0.50000");
  });

  test("a narrow band hides runs and hit%, keeps the rest, and f restores them", () => {
    // R-05.8 / O-05: the complete table's natural width is 58 columns (80-column
    // terminal + rail leaves ~51), so below it the default column set is
    // source/in/hit/out/cost. `f` passes `fullTable` through to buildDetailRows.
    const narrow = detailOf(automated, undefined, { width: 51 });
    const narrowHeader = narrow.find((row) =>
      row.trimStart().startsWith("source"),
    );
    expect(narrowHeader).toBeDefined();
    expect(narrowHeader).toContain("in");
    expect(narrowHeader).toContain("hit");
    expect(narrowHeader).toContain("out");
    expect(narrowHeader).toContain("cost");
    expect(narrowHeader).not.toContain("runs");
    expect(narrowHeader).not.toContain("hit%");
    // The hidden columns' data is gone too, not merely their labels.
    expect(narrow.join("\n")).not.toContain("16.67%");

    const expanded = detailOf(automated, undefined, {
      width: 51,
      fullTable: true,
    });
    const expandedHeader = expanded.find((row) =>
      row.trimStart().startsWith("source"),
    );
    expect(expandedHeader).toContain("runs");
    // A full table forced into a narrow band is still cut at the band's edge
    // (there is no horizontal scroll, R-05.8): the leftmost new column survives.
    expect(expandedHeader).toContain("in");
  });

  test("a wide band draws the complete table without asking", () => {
    const rows = detailOf(automated, undefined, { width: 80 });
    const header = rows.find((row) => row.trimStart().startsWith("source"));
    expect(header).toContain("runs");
    expect(header).toContain("hit%");
    expect(header).toHaveLength(58);
  });

  test("an all-interactive ledger says there is nothing automated", () => {
    const rows = detailOf([record("2026-10-22T09")]);
    expect(rows.join("\n")).toContain("no automated runs recorded");
  });

  test("a section with automated records has no empty-state line", () => {
    const rows = detailOf(automated);
    expect(rows.join("\n")).not.toContain("no automated runs recorded");
  });
});

describe("the by model table", () => {
  test("is a fixed-width table: model/in/hit/out/cost, numbers right-aligned", () => {
    const rows = detailOf([record("2026-10-22T09")]);
    const index = rows.findIndex((row) => row.startsWith("By model"));
    expect(index).toBeGreaterThan(0);
    const header = rows[index + 1];
    // indent 2 + model 24 + in 7 + hit 7 + out 7 + cost 11 = 58.
    expect(header?.slice(2, 26).trim()).toBe("model");
    expect(header?.slice(26, 33).trim()).toBe("in");
    expect(header?.slice(33, 40).trim()).toBe("hit");
    expect(header?.slice(40, 47).trim()).toBe("out");
    expect(header?.slice(47, 58).trim()).toBe("cost");

    const row = rows[index + 2];
    expect(row?.slice(2, 26)).toBe("openai/gpt-5.5".padEnd(24));
    // in = prompt + cacheWrite (400 + 50), hit = cachedInput, out = completion.
    expect(row?.slice(26, 33).trim()).toBe("450");
    expect(row?.slice(33, 40).trim()).toBe("100");
    expect(row?.slice(40, 47).trim()).toBe("50");
    // Unpriced: a dash, never a false zero.
    expect(row?.slice(47, 58).trim()).toBe("—");
  });

  test("a long model name is ellipsized, not allowed to shift the numbers", () => {
    const rows = detailOf([
      record("2026-10-22T09", {
        model: "anthropic/claude-sonnet-4-5-20260101-preview",
      }),
    ]);
    const index = rows.findIndex((row) => row.startsWith("By model"));
    const row = rows[index + 2] ?? "";
    expect(row.slice(2, 26)).toHaveLength(24);
    expect(row.slice(2, 26)).toContain("...");
    expect(row.slice(26, 33).trim()).toBe("450");
  });
});

describe("detail table layout", () => {
  test("the complete automated table's natural width is 58 columns", () => {
    // O-05 / R-05.8: 2 + 10 + 6 + 7 + 7 + 7 + 11 + 8.
    expect(AUTOMATED_TABLE_FULL_WIDTH).toBe(58);
    expect(automatedTableNaturalWidth()).toBe(58);
    // A wider cost cell moves the threshold by exactly its growth, so the full
    // table never wraps (R-05.9).
    expect(automatedTableNaturalWidth(13)).toBe(60);
    expect(automatedTableNaturalWidth(3)).toBe(58);
  });

  test("the narrow column set keeps source/in/hit/out/cost", () => {
    expect(
      automatedTableColumns({ full: false }).map((column) => column.key),
    ).toEqual(["source", "in", "hit", "out", "cost"]);
  });

  test("the full column set is the spec's seven", () => {
    expect(
      automatedTableColumns({ full: true }).map((column) => column.key),
    ).toEqual(["source", "runs", "in", "hit", "out", "cost", "hit%"]);
  });

  test("renders a header and right-aligned numeric cells under a left source", () => {
    const lines = renderDetailTable(automatedTableColumns({ full: true }), [
      ["reflection", "2", "1k", "200", "200", "$ 0.50000", "16.67%"],
    ]);
    expect(lines[0]).toHaveLength(58);
    expect(lines[0]?.trimStart().startsWith("source")).toBe(true);
    expect(lines[1]).toHaveLength(58);
    expect(lines[1]?.slice(2, 12)).toBe("reflection");
    // Right-aligned: the runs cell fills its six columns from the right.
    expect(lines[1]?.slice(12, 18)).toBe("     2");
    expect(lines[1]?.slice(50, 58).trim()).toBe("16.67%");
  });

  test("an overlong source is ellipsized inside its own column", () => {
    // The cost width is decided by the caller from its own cells (R-05.9); 12
    // here is what `$ 1234.50000` needs, so the table grows to 59 columns.
    const lines = renderDetailTable(
      automatedTableColumns({ full: true, costWidth: 12 }),
      [
        [
          "a-very-long-source-name",
          "12",
          "1.2k",
          "300",
          "400",
          "$ 1234.50000",
          "66.67%",
        ],
      ],
    );
    expect(lines[1]?.slice(2, 12)).toHaveLength(10);
    expect(lines[1]?.slice(2, 12)).toContain("...");
    // The cost column adapts to its widest cell (12, not the old hard-coded 11),
    // so the table is 59 wide and nothing to the left moved by a single cell.
    expect(lines[0]).toHaveLength(59);
    expect(lines[1]?.slice(18, 25).trim()).toBe("1.2k");
    expect(lines[1]?.slice(25, 32).trim()).toBe("300");
    expect(lines[1]?.slice(39, 51).trim()).toBe("$ 1234.50000");
    expect(lines[1]?.slice(51, 59).trim()).toBe("66.67%");
  });

  test("the model column shrinks to fit a narrow band and stops at its floor", () => {
    expect(modelTableColumns({ availableWidth: 80 })[0]?.width).toBe(24);
    // Band 49 - indent 2 - numeric 21 - cost 11 = 15: still aligned, just cut.
    expect(modelTableColumns({ availableWidth: 49 })[0]?.width).toBe(15);
    // Below the floor the row is truncated as a whole rather than misaligned.
    expect(modelTableColumns({ availableWidth: 40 })[0]?.width).toBe(10);
  });
});
