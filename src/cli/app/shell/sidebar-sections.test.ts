// src/cli/app/shell/sidebar-sections.test.ts

import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@/cli/display/statusline/formatting";
import {
  buildSidebarSections,
  fitSidebarSections,
  SIDEBAR_SECTIONS,
  type SidebarProjection,
  type SidebarSectionSpec,
  sidebarContentColumns,
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
    stepCount: 12,
    inputTokens: 3_400,
    outputTokens: 1_200,
    reasoningTokens: 800,
    sessionWallMs: 42_000,
    agents: null,
    today: null,
    memfs: null,
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

  test("the context composition is a placeholder, not a guess", () => {
    const context = buildSidebarSections(projection()).find(
      (item) => item.id === "context",
    );
    expect(context?.detail[1]).toBe("系统 — · 对话 84k");
    expect(context?.detail[2]).toBe("思考 800 · 12 轮");
  });

  test("the session section is titled Turn", () => {
    const turn = buildSidebarSections(projection()).find(
      (item) => item.id === "turn",
    );
    expect(turn?.title).toBe("Turn");
    expect(turn?.detail).toEqual(["12 步 · 00:42", "1.2k out · 3.4k in"]);
  });

  test("an empty agent list hides its section instead of printing zero", () => {
    const ids = buildSidebarSections(projection()).map((item) => item.id);
    expect(ids).toEqual(["context", "turn", "usage", "memfs"]);
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

  test("today's usage says it is not wired, and shows the ledger when it is", () => {
    const placeholder = buildSidebarSections(projection()).find(
      (item) => item.id === "usage",
    );
    expect(placeholder?.detail).toEqual(["今日 —（台账未接）"]);

    const wired = buildSidebarSections(
      projection({
        today: {
          cacheReadTokens: 1_200,
          uncachedTokens: 3_400,
          writeTokens: 500,
          costUsd: 0.12,
        },
      }),
    ).find((item) => item.id === "usage");
    expect(wired?.detail).toEqual([
      "缓存读 1.2k",
      "非缓存 3.4k",
      "写入 500",
      "成本 $0.12",
    ]);
  });

  test("memfs says what is missing, and formats the totals when present", () => {
    const placeholder = buildSidebarSections(projection()).find(
      (item) => item.id === "memfs",
    );
    expect(placeholder?.detail).toEqual(["近 7 天 —", "改动 —", "总量 —"]);

    const wired = buildSidebarSections(
      projection({
        memfs: { commits7d: 12, changedLines7d: 340, totalBytes: 1_258_291 },
      }),
    ).find((item) => item.id === "memfs");
    expect(wired?.detail).toEqual([
      "7 天 12 提交",
      "改动 +340 行",
      "总量 1.2 MB",
    ]);
  });

  test("every line a caller gets already fits the rail", () => {
    const wide = projection({
      width: 18,
      agents: [{ type: "Workflow", durationMs: 61_000 }],
      today: {
        cacheReadTokens: 123_456,
        uncachedTokens: 654_321,
        writeTokens: 9_999,
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
  });

  test("the registry is the extension seam and keeps its order", () => {
    expect(SIDEBAR_SECTIONS.map((item) => item.id)).toEqual([
      "context",
      "turn",
      "usage",
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
