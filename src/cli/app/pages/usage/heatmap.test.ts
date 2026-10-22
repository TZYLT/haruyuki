import { describe, expect, test } from "bun:test";
import { terminalTextWidth } from "@/cli/helpers/char-width";
import type { UsageRecord } from "@/usage/ledger";
import { buildHeatmap, heatmapLines, startOfWeek, weekLabel } from "./heatmap";

function record(tsHour: string, tokens = 1000): UsageRecord {
  return {
    tsHour,
    agentId: "agent-1",
    model: "openai/gpt-5.5",
    prompt: tokens,
    cachedInput: 0,
    cacheWrite: 0,
    completion: 0,
    reasoning: 0,
    steps: 1,
    wallMs: 1,
    apiMs: 1,
  };
}

// 2026-10-22 is a Thursday; the week of 2026-10-19 is the current one.
const NOW = new Date(2026, 9, 22, 12);

describe("startOfWeek", () => {
  test("anchors on Monday", () => {
    expect(startOfWeek(NOW).getDay()).toBe(1);
    expect(startOfWeek(NOW).getDate()).toBe(19);
  });

  test("a Monday is its own start", () => {
    expect(startOfWeek(new Date(2026, 9, 19, 23, 59)).getDate()).toBe(19);
  });

  test("a Sunday belongs to the week that began six days earlier", () => {
    const sunday = startOfWeek(new Date(2026, 9, 25, 8));
    expect(sunday.getDate()).toBe(19);
  });
});

describe("buildHeatmap", () => {
  test("is four weeks of seven days ending in the current week", () => {
    const grid = buildHeatmap([], NOW);
    expect(grid.weeks).toHaveLength(4);
    for (const week of grid.weeks) expect(week).toHaveLength(7);
    expect(grid.weeks[0]?.[0]?.dayKey).toBe("2026-09-28");
    expect(grid.weeks[3]?.[6]?.dayKey).toBe("2026-10-25");
  });

  test("puts a day's tokens in its own weekday cell", () => {
    const grid = buildHeatmap([record("2026-10-21T14")], NOW);
    const currentWeek = grid.weeks[3]!;
    // Wednesday is column 2 (Monday = 0).
    expect(currentWeek[2]?.dayKey).toBe("2026-10-21");
    expect(currentWeek[2]?.tokens).toBe(1000);
    expect(currentWeek[2]?.level).toBe(4);
    expect(currentWeek[1]?.tokens).toBe(0);
  });

  test("levels are quartiles of the busiest day", () => {
    const grid = buildHeatmap(
      [
        record("2026-10-19T09", 4000),
        record("2026-10-20T09", 2000),
        record("2026-10-21T09", 1000),
      ],
      NOW,
    );
    const week = grid.weeks[3]!;
    expect(week[0]?.level).toBe(4);
    expect(week[1]?.level).toBe(2);
    expect(week[2]?.level).toBe(1);
    expect(week[3]?.level).toBe(0);
  });

  test("a quiet window has no levels at all", () => {
    const grid = buildHeatmap([], NOW);
    expect(grid.maxTokens).toBe(0);
    for (const week of grid.weeks) {
      for (const day of week) expect(day.level).toBe(0);
    }
  });

  test("sums all four billed buckets into the cell's tokens", () => {
    const grid = buildHeatmap(
      [
        {
          ...record("2026-10-22T10", 0),
          prompt: 10,
          cachedInput: 20,
          cacheWrite: 30,
          completion: 40,
        },
      ],
      NOW,
    );
    expect(grid.weeks[3]?.[3]?.tokens).toBe(100);
  });
});

describe("heatmapLines", () => {
  const lines = heatmapLines(buildHeatmap([record("2026-10-21T14")], NOW));

  test("labels the newest week first", () => {
    expect(lines.rows).toHaveLength(4);
    expect(lines.rows[0]?.startsWith("now")).toBe(true);
    expect(lines.rows[3]?.startsWith("-3w")).toBe(true);
  });

  test("every row is the same width as the block", () => {
    expect(lines.width).toBe(17);
    for (const row of lines.rows) {
      expect(terminalTextWidth(row)).toBe(lines.width);
    }
    expect(terminalTextWidth(lines.header)).toBe(lines.width);
  });

  test("the caption is English, like the rest of the panel", () => {
    expect(lines.title).toBe("Last 4 weeks");
  });

  test("draws the cell glyph for the day's level", () => {
    // Wednesday of the current week is the only active cell.
    expect(lines.rows[0]?.split(" ").slice(1).join(" ")).toContain("█");
  });

  test("week labels go back four weeks", () => {
    expect(weekLabel(0)).toBe("now");
    expect(weekLabel(3)).toBe("-3w");
  });
});
