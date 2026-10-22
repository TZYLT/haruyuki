import { describe, expect, test } from "bun:test";
import type { UsageRecord } from "@/usage/ledger";
import { countStreak, summarizeUsage } from "./summary";

function record(
  tsHour: string,
  overrides: Partial<UsageRecord> = {},
): UsageRecord {
  return {
    tsHour,
    agentId: "agent-1",
    model: "openai/gpt-5.5",
    prompt: 100,
    cachedInput: 300,
    cacheWrite: 10,
    completion: 50,
    reasoning: 0,
    steps: 1,
    wallMs: 1,
    apiMs: 1,
    ...overrides,
  };
}

const NOW = new Date(2026, 9, 22, 12);

describe("summarizeUsage", () => {
  test("adds all four buckets into the headline number", () => {
    const summary = summarizeUsage([record("2026-10-22T09")], NOW);
    expect(summary.totals.tokens).toBe(460);
    expect(summary.totals.turns).toBe(1);
    expect(summary.recordCount).toBe(1);
  });

  test("keeps the buckets apart, so one denominator serves every share", () => {
    const summary = summarizeUsage(
      [record("2026-10-22T09"), record("2026-10-22T10")],
      NOW,
    );
    expect(summary.today.prompt).toBe(200);
    expect(summary.today.cachedInput).toBe(600);
    expect(summary.today.cacheWrite).toBe(20);
    expect(summary.today.completion).toBe(100);
    expect(
      summary.today.prompt +
        summary.today.cachedInput +
        summary.today.cacheWrite +
        summary.today.completion,
    ).toBe(summary.today.tokens);
  });

  test("cost is absent when nothing was priced, not zero", () => {
    const summary = summarizeUsage([record("2026-10-22T09")], NOW);
    expect(summary.totals.cost).toBeUndefined();
    expect(summary.today.cost).toBeUndefined();
  });

  test("cost is summed when records carry one", () => {
    const cost = {
      input: 0.1,
      cacheRead: 0.2,
      cacheWrite: 0.3,
      output: 0.4,
      total: 1,
    };
    const summary = summarizeUsage(
      [
        record("2026-10-22T09", { cost }),
        record("2026-10-21T09", { cost: { ...cost, total: 2 } }),
      ],
      NOW,
    );
    expect(summary.totals.cost).toBeCloseTo(3);
    expect(summary.totals.costBreakdown.input).toBeCloseTo(0.2);
  });

  test("today is split out from the total", () => {
    const summary = summarizeUsage(
      [
        record("2026-10-22T09"),
        record("2026-10-22T10", {
          prompt: 0,
          cachedInput: 0,
          cacheWrite: 0,
          completion: 0,
        }),
        record("2026-10-21T09"),
      ],
      NOW,
    );
    expect(summary.totals.turns).toBe(3);
    expect(summary.today.turns).toBe(2);
    expect(summary.today.tokens).toBe(460);
    // 300 cached of 100 miss + 300 cached.
    expect(summary.today.cacheHitRate).toBeCloseTo(0.75);
    expect(summary.firstDay).toBe("2026-10-21");
    expect(summary.lastDay).toBe("2026-10-22");
  });

  test("an empty ledger has no dates and no rates", () => {
    const summary = summarizeUsage([], NOW);
    expect(summary.totals.turns).toBe(0);
    expect(summary.totals.tokens).toBe(0);
    expect(summary.today.cacheHitRate).toBeUndefined();
    expect(summary.firstDay).toBeUndefined();
    expect(summary.lastDay).toBeUndefined();
    expect(summary.streakDays).toBe(0);
  });
});

describe("countStreak", () => {
  const days = (...keys: string[]) => new Set(keys);

  test("counts consecutive days ending today", () => {
    expect(
      countStreak(
        days("2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22"),
        NOW,
      ),
    ).toBe(4);
  });

  test("a gap ends the streak", () => {
    expect(
      countStreak(days("2026-10-19", "2026-10-20", "2026-10-22"), NOW),
    ).toBe(1);
  });

  test("a quiet today does not break yesterday's streak", () => {
    expect(countStreak(days("2026-10-20", "2026-10-21"), NOW)).toBe(2);
  });

  test("a quiet today and yesterday is no streak", () => {
    expect(countStreak(days("2026-10-20"), NOW)).toBe(0);
  });
});
