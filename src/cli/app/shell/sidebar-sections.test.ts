// src/cli/app/shell/sidebar-sections.test.ts

import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@/cli/display/statusline/formatting";
import {
  buildSidebarSections,
  fitSidebarSections,
  SIDEBAR_SECTIONS,
  type SidebarProjection,
  type SidebarScheduleRow,
  type SidebarSectionSpec,
  sidebarContentColumns,
  sidebarGeometry,
  sidebarWidth,
  transcriptColumns,
} from "./sidebar-sections";

function section(id: string, detailRows = 2): SidebarSectionSpec {
  return {
    id,
    title: id,
    detail: Array.from({ length: detailRows }, (_, index) => `${id}-${index}`),
    summary: `${id} summary`,
  };
}

/** The rows the fit will paint, the same arithmetic the module uses. */
function paintedRows(fitted: readonly { lines: readonly string[] }[]): number {
  if (fitted.length === 0) return 0;
  const bodies = fitted.reduce((sum, item) => sum + 1 + item.lines.length, 0);
  return bodies + (fitted.length - 1);
}

describe("sidebarWidth", () => {
  // 《38》§6.3's table, verbatim: 140 → 32, 120 → 32, 100 → 30,
  // 90 → 27, 80 → 24, and folded below 80 columns.
  test.each([
    [140, 32],
    [120, 32],
    [100, 30],
    [90, 27],
    [80, 24],
    [79, 0],
    [70, 0],
    [40, 0],
  ])("at %i columns the sidebar is %i wide", (columns, width) => {
    expect(sidebarWidth(columns, 30)).toBe(width);
  });

  test("folds below 26 rows even on a wide terminal", () => {
    expect(sidebarWidth(120, 26)).toBe(32);
    expect(sidebarWidth(120, 25)).toBe(0);
  });

  test("never wider than the terminal it sits in", () => {
    // 24 rows of clamp would be 24 columns; a 10-column terminal cannot host it.
    const width = sidebarWidth(10, 30);
    expect(width).toBeLessThanOrEqual(9);
  });
});

describe("transcriptColumns", () => {
  test("the row's widths sum to columns - 1, as the design table does", () => {
    for (const [columns, expected] of [
      [140, 107],
      [120, 87],
      [100, 69],
      [90, 62],
      [80, 55],
    ] as const) {
      const width = sidebarWidth(columns, 30);
      expect(transcriptColumns(columns, width)).toBe(expected);
    }
  });

  test("a folded sidebar gives the transcript the whole row", () => {
    expect(transcriptColumns(100, 0)).toBe(100);
  });
});

describe("sidebarContentColumns", () => {
  test("the divider and its space come out of the block", () => {
    expect(sidebarContentColumns(30)).toBe(28);
    expect(sidebarContentColumns(24)).toBe(22);
  });
});

describe("sidebarGeometry", () => {
  test("the band and the rail stop two columns short of the terminal", () => {
    const geometry = sidebarGeometry(100, 30);
    expect(geometry).toEqual({
      railWidth: 30,
      bandColumns: 67,
      junctionColumn: 69,
    });
    // The whole row's width: band + gutter + rail, two columns left empty so no
    // row ever reaches the terminal's last column.
    expect(geometry.bandColumns + 1 + geometry.railWidth).toBe(98);
  });

  test("a folded rail gives the band the usable width and no junction", () => {
    expect(sidebarGeometry(70, 30)).toEqual({
      railWidth: 0,
      bandColumns: 68,
      junctionColumn: 0,
    });
    expect(sidebarGeometry(120, 24)).toEqual({
      railWidth: 0,
      bandColumns: 118,
      junctionColumn: 0,
    });
  });

  test("the junction is where the rail's divider starts", () => {
    for (const columns of [80, 90, 100, 120, 140]) {
      const geometry = sidebarGeometry(columns, 30);
      expect(geometry.junctionColumn).toBe(geometry.bandColumns + 2);
    }
  });
});

describe("fitSidebarSections", () => {
  test("everything fits when there is room", () => {
    const specs = [
      "context",
      "session",
      "queue",
      "agents",
      "connection",
      "workspace",
    ].map((id) => section(id));
    const fitted = fitSidebarSections(specs, 40);
    expect(fitted.map((item) => item.spec.id)).toEqual(specs.map((s) => s.id));
    expect(fitted.every((item) => item.state === "detail")).toBe(true);
  });

  test("the lowest priority gives way first, to one summary row", () => {
    const specs = [
      "context",
      "session",
      "queue",
      "agents",
      "connection",
      "workspace",
    ].map((id) => section(id));
    // Six three-row sections plus five gaps is 23; 22 has to shed exactly one row.
    const fitted = fitSidebarSections(specs, 22);
    expect(fitted).toHaveLength(6);
    expect(fitted[fitted.length - 1]?.spec.id).toBe("workspace");
    expect(fitted[fitted.length - 1]?.state).toBe("summary");
    expect(paintedRows(fitted)).toBe(22);
  });

  test("a section goes entirely before the one above it is touched", () => {
    const specs = [
      "context",
      "session",
      "queue",
      "agents",
      "connection",
      "workspace",
    ].map((id) => section(id));
    // One row short of "summary only": workspace leaves, the rest stay whole.
    const fitted = fitSidebarSections(specs, 21);
    expect(fitted.map((item) => item.spec.id)).toEqual([
      "context",
      "session",
      "queue",
      "agents",
      "connection",
    ]);
    expect(fitted.every((item) => item.state === "detail")).toBe(true);
    expect(paintedRows(fitted)).toBeLessThanOrEqual(21);
  });

  test("the order of the survivors never changes", () => {
    const specs = ["a", "b", "c"].map((id) => section(id, 4));
    const fitted = fitSidebarSections(specs, 6);
    expect(fitted.map((item) => item.spec.id)).toEqual(["a"]);
  });

  test("never paints past the band, for any budget", () => {
    const specs = [
      "context",
      "session",
      "queue",
      "agents",
      "connection",
      "workspace",
    ].map((id) => section(id));
    for (let budget = 0; budget <= 30; budget += 1) {
      expect(
        paintedRows(fitSidebarSections(specs, budget)),
      ).toBeLessThanOrEqual(budget);
    }
  });

  test("a section with only a summary never claims detail rows", () => {
    const alone = { ...section("x"), detail: [] };
    const fitted = fitSidebarSections([alone], 2);
    expect(fitted[0]?.state).toBe("summary");
    expect(fitted[0]?.lines).toEqual(["x summary"]);
    expect(fitSidebarSections([alone], 1)).toEqual([]);
  });

  test("no room is no sections, not a clipped one", () => {
    expect(fitSidebarSections([section("context")], 0)).toEqual([]);
    expect(fitSidebarSections([], 30)).toEqual([]);
  });
});

function projection(
  overrides: Partial<SidebarProjection> = {},
): SidebarProjection {
  return {
    width: 28,
    usedContextTokens: 84_000,
    contextWindowSize: 128_000,
    contextBreakdown: { system: 8_000, messages: 23_000, tools: 31_000 },
    turn: {
      startedAtMs: 1_000,
      wallMs: 42_000,
      steps: 12,
      inputTokens: 3_400,
      outputTokens: 1_200,
      active: false,
    },
    reasoningTokens: 800,
    agents: null,
    today: null,
    memfs: null,
    schedules: null,
    ...overrides,
  };
}

describe("buildSidebarSections", () => {
  test("the rail is plain text: no bar, no glyph meter", () => {
    const context = buildSidebarSections(projection()).find(
      (item) => item.id === "context",
    );
    expect(context?.detail.join("\n")).not.toMatch(/[█░]/);
    expect(context?.detail[0]).toBe("ctx 66% · 84k / 128k");
  });

  test("the context composition is read, not guessed", () => {
    const context = buildSidebarSections(projection()).find(
      (item) => item.id === "context",
    );
    // Four parts, each a measurement of the last request. System and tools get
    // a row each: the split is the point, and `sys 31k · tools 4k` on a narrow
    // rail reads as a single number.
    expect(context?.detail[1]).toBe("sys 8k");
    expect(context?.detail[2]).toBe("tools 31k");
    expect(context?.detail[3]).toBe("chat 23k");
    expect(context?.detail[4]).toBe("reasoning 800");
  });

  test("before the first turn the composition is a dash, not a zero", () => {
    const context = buildSidebarSections(
      projection({ contextBreakdown: null }),
    ).find((item) => item.id === "context");
    expect(context?.detail[1]).toBe("sys —");
    expect(context?.detail[2]).toBe("tools —");
    expect(context?.detail[3]).toBe("chat —");
  });

  test("the Turn section reads the turn projection, not the session", () => {
    const turn = buildSidebarSections(projection()).find(
      (item) => item.id === "turn",
    );
    expect(turn?.title).toBe("Turn");
    expect(turn?.detail).toEqual(["12 steps · 00:42", "1.2k out · 3.4k in"]);
  });

  test("a turn that has not started is zero, not the session's running totals", () => {
    const turn = buildSidebarSections(
      projection({
        turn: {
          startedAtMs: null,
          wallMs: 0,
          steps: 0,
          inputTokens: 0,
          outputTokens: 0,
          active: false,
        },
      }),
    ).find((item) => item.id === "turn");
    expect(turn?.detail).toEqual(["0 steps · 00:00", "0 out · 0 in"]);
    expect(turn?.summary).toBe("0 steps · 00:00");
  });

  test("an empty agent list hides its section instead of printing zero", () => {
    const ids = buildSidebarSections(projection()).map((item) => item.id);
    // `schedules` is present even when empty: R-5.12.5 asks for a placeholder
    // rather than a missing section, so it is the one section an empty source
    // still draws.
    expect(ids).toEqual(["context", "turn", "usage", "schedules", "memfs"]);
  });

  test("three agents are named and the rest become +N", () => {
    const agents = buildSidebarSections(
      projection({
        agents: [
          { type: "Task", durationMs: 12_000 },
          { type: "Grep", durationMs: 4_000 },
          { type: "Read", durationMs: 1_000 },
          { type: "Edit", durationMs: 900 },
        ],
      }),
    ).find((item) => item.id === "agents");
    expect(agents?.detail).toEqual([
      "• Task 12s",
      "• Grep 4s",
      "• Read 1s",
      "+1",
    ]);
  });

  test("today's usage comes from the ledger, and says so while it is absent", () => {
    const placeholder = buildSidebarSections(projection()).find(
      (item) => item.id === "usage",
    );
    expect(placeholder?.detail).toEqual(["today — (ledger pending)"]);

    const wired = buildSidebarSections(
      projection({
        today: {
          tokens: 26_400,
          turns: 1,
          cacheReadTokens: 1_200,
          uncachedTokens: 3_400,
          outputTokens: 540,
          // hit / (hit + miss) = 1200 / 4600.
          hitRate: 1_200 / 4_600,
          costUsd: 0.12,
        },
      }),
    ).find((item) => item.id === "usage");
    // Hit above miss, one decimal on the share; the output row reads the day's
    // completion count, not the cache-fill bucket.
    expect(wired?.detail).toEqual([
      "today 26k tok",
      "hit 1.2k (26.1%)",
      "miss 3.4k",
      "out 540",
      "cost $ 0.12",
    ]);
    expect(wired?.summary).toBe("today 26k tok");
  });

  test("a day with no input has no hit rate to print, not a zero percent", () => {
    const usage = buildSidebarSections(
      projection({
        today: {
          tokens: 540,
          turns: 1,
          cacheReadTokens: 0,
          uncachedTokens: 0,
          outputTokens: 540,
        },
      }),
    ).find((item) => item.id === "usage");
    expect(usage?.detail[1]).toBe("hit 0");
    expect(usage?.detail[2]).toBe("miss 0");
  });

  test("an unpriced day shows a dash, not a free turn", () => {
    const usage = buildSidebarSections(
      projection({
        today: {
          tokens: 900,
          turns: 2,
          cacheReadTokens: 0,
          uncachedTokens: 900,
          outputTokens: 100,
          hitRate: 0,
        },
      }),
    ).find((item) => item.id === "usage");
    expect(usage?.detail[4]).toBe("cost —");
  });

  test("a sub-cent day is not rounded into a false free", () => {
    const usage = buildSidebarSections(
      projection({
        today: {
          tokens: 900,
          turns: 1,
          cacheReadTokens: 0,
          uncachedTokens: 900,
          outputTokens: 100,
          hitRate: 0,
          costUsd: 0.0004,
        },
      }),
    ).find((item) => item.id === "usage");
    expect(usage?.detail[4]).toBe("cost $ <0.01");
  });

  test("memfs says what is missing, and counts bytes rather than megabytes", () => {
    const placeholder = buildSidebarSections(projection()).find(
      (item) => item.id === "memfs",
    );
    expect(placeholder?.detail).toEqual(["7d — commits", "— lines", "total —"]);

    const wired = buildSidebarSections(
      projection({
        memfs: { commits7d: 12, changedLines7d: 340, totalBytes: 1_258_291 },
      }),
    ).find((item) => item.id === "memfs");
    expect(wired?.detail).toEqual([
      "7d 12 commits",
      "+340 lines",
      "total 1,258,291 B",
    ]);
  });

  test("every line a caller gets already fits the rail", () => {
    const wide = projection({
      width: 18,
      turn: {
        startedAtMs: 1_000,
        wallMs: 3_600_000,
        steps: 999,
        inputTokens: 12_345_678,
        outputTokens: 9_876_543,
        active: false,
      },
      agents: [{ type: "Workflow", durationMs: 61_000 }],
      today: {
        tokens: 787_776,
        turns: 9,
        cacheReadTokens: 123_456,
        uncachedTokens: 654_321,
        outputTokens: 77_777,
        hitRate: 0.1588,
        costUsd: 12.34,
      },
      memfs: { commits7d: 123, changedLines7d: -4_567, totalBytes: 987_654 },
    });
    for (const section of buildSidebarSections(wide)) {
      expect(visibleWidth(section.title)).toBeLessThanOrEqual(18);
      for (const line of section.detail) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(18);
      }
    }
    // The turn's clock stays inside the rail too: an hour-long turn is still
    // `100:00`, not a growing number of digits that pushes the row wide.
    const turn = buildSidebarSections(wide).find((item) => item.id === "turn");
    expect(turn?.detail[0]).toBe("999 steps · 60:00");
  });

  test("the registry is the extension seam and keeps its order", () => {
    expect(SIDEBAR_SECTIONS.map((item) => item.id)).toEqual([
      "context",
      "turn",
      "usage",
      "schedules",
      "agents",
      "memfs",
    ]);
    // A caller can hand in its own list (the future settings filter), and the
    // build honours that order rather than the registry's.
    const onlyTurn = SIDEBAR_SECTIONS.filter((item) => item.id === "turn");
    expect(
      buildSidebarSections(projection(), onlyTurn).map((item) => item.id),
    ).toEqual(["turn"]);
  });
});

describe("the 计划任务 section (M-16)", () => {
  function schedulesSection(
    rows: readonly SidebarScheduleRow[] | null,
    options: { schedulesError?: string | null; width?: number } = {},
  ) {
    const spec = buildSidebarSections(
      projection({
        width: options.width ?? 28,
        schedules: rows,
        schedulesError: options.schedulesError ?? null,
      }),
    ).find((item) => item.id === "schedules");
    return spec;
  }

  test("shows at most three runs, name, next due and status", () => {
    const spec = schedulesSection([
      { id: "a", name: "晨报", when: "09:00", status: "active" },
      { id: "b", name: "周报", when: "10-30", status: "paused" },
      { id: "c", name: "抓取", when: "11:00", status: "paused · auto" },
      { id: "d", name: "第四条", when: "12:00", status: "active" },
    ]);
    expect(spec?.title).toBe("计划任务");
    expect(spec?.detail).toHaveLength(4);
    expect(spec?.detail[0]).toBe("• 晨报 09:00");
    expect(spec?.detail[1]).toContain("暂停");
    // The reason a task stopped is never abbreviated away.
    expect(spec?.detail[2]).toContain("自动暂停");
    // The surplus is a count, not a fourth task.
    expect(spec?.detail[3]).toBe("+1");
    expect(spec?.detail.join("\n")).not.toContain("第四条");
  });

  test("an empty store paints a placeholder, not a missing section", () => {
    const spec = schedulesSection([]);
    expect(spec?.detail).toEqual(["暂无计划任务"]);
    expect(spec?.summary).toBe("计划任务 0");
  });

  test("an unread store says so instead of pretending there are none", () => {
    const spec = schedulesSection(null);
    expect(spec?.detail).toEqual(["读取中…"]);
  });

  test("a failed read says so instead of painting an empty store (M3 #17)", () => {
    const spec = schedulesSection([], { schedulesError: "版本 99" });
    expect(spec?.detail.join("\n")).toContain("读取失败");
    expect(spec?.detail.join("\n")).toContain("版本 99");
    expect(spec?.detail.join("\n")).not.toContain("暂无计划任务");
    expect(spec?.summary).toBe("计划任务 —");
  });

  test("the section gives way before the transcript's own numbers", () => {
    const specs = buildSidebarSections(
      projection({
        schedules: [{ id: "a", name: "晨报", when: "09:00", status: "active" }],
      }),
    );
    const fitted = fitSidebarSections(specs, 9);
    const order = fitted.map((item) => item.spec.id);
    // It survives a short band that already dropped MemFS; when the band gets
    // shorter still, the rail degrades whole sections from the bottom.
    expect(order).not.toContain("memfs");
    expect(fitSidebarSections(specs, 4).length).toBeLessThan(fitted.length);
  });

  test("a long task name is trimmed to the rail, never wrapped", () => {
    const spec = schedulesSection(
      [
        {
          id: "a",
          name: "一个非常非常长的计划任务名称会撑破侧栏",
          when: "09:00",
          status: "active",
        },
      ],
      { width: 18 },
    );
    for (const line of spec?.detail ?? []) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(18);
    }
  });
});
