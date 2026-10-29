// src/cli/app/shell/context-sidebar.test.tsx

import { afterEach, describe, expect, test } from "bun:test";
import type { SessionStatsSnapshot, TurnStatsSnapshot } from "@/agent/stats";
import { visibleWidth } from "@/cli/display/statusline/formatting";
import { mountInkTty, resetInkTtyState } from "@/test-utils/ink-tty";
import type { UsageSummary } from "@/usage/summary";
import { emptyUsageCost } from "@/utils/usage-cost";
import { ContextSidebar, sidebarProjectionFrom } from "./context-sidebar";
import type { SidebarProjection } from "./sidebar-sections";

/**
 * The rail as it is painted (`src/cli/AGENTS.md`: a frame can be laid out
 * perfectly and still paint nothing). The width table and the folding are unit
 * tests; here the questions are the ones only a frame answers — does the divider
 * stand for the whole band, are the sections actually on screen, and is any line
 * wider than the rail it lives in.
 */

function projection(
  overrides: Partial<Omit<SidebarProjection, "width">> = {},
): Omit<SidebarProjection, "width"> {
  return {
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

function mount(height: number, width = 30, projectionOverrides = {}) {
  return mountInkTty(
    <ContextSidebar
      height={height}
      width={width}
      projection={projection(projectionOverrides)}
    />,
    { columns: 60, rows: 40 },
  );
}

afterEach(() => resetInkTtyState());

describe("ContextSidebar", () => {
  test("paints its sections, plain text, behind a divider", async () => {
    const frame = mount(20);
    try {
      const rows = await frame.rows();
      const text = rows.join("\n");
      expect(text).toContain("Context");
      expect(text).toContain("Turn");
      expect(text).toContain("Usage");
      expect(text).toContain("MemFS");
      // No bar: the composition is text, per the 2026-10-20 supplement.
      expect(text).not.toMatch(/[█░]/);
      // Every painted row begins at the divider.
      expect(rows.every((row) => row.startsWith("│"))).toBe(true);
    } finally {
      frame.stop();
    }
  });

  test("the divider holds the whole band, not just the content", async () => {
    const frame = mount(14);
    try {
      const rows = await frame.rows();
      expect(rows).toHaveLength(14);
      expect(rows.at(-1)?.startsWith("│")).toBe(true);
    } finally {
      frame.stop();
    }
  });

  test("nothing is painted wider than the rail", async () => {
    const frame = mount(20, 30);
    try {
      for (const row of await frame.rows()) {
        expect(visibleWidth(row)).toBeLessThanOrEqual(30);
      }
    } finally {
      frame.stop();
    }
  });

  test("a short band keeps Context and drops the sections below it", async () => {
    const frame = mount(3);
    try {
      const text = (await frame.rows()).join("\n");
      expect(text).toContain("Context");
      expect(text).not.toContain("Turn");
      expect(text).not.toContain("MemFS");
    } finally {
      frame.stop();
    }
  });

  test("an empty agent list paints no Agents heading", async () => {
    const frame = mount(20);
    try {
      expect(await frame.text()).not.toContain("Agents");
    } finally {
      frame.stop();
    }
  });

  test("paints the composition the projection carries, system and tools apart", async () => {
    const frame = mount(24);
    try {
      const text = (await frame.rows()).join("\n");
      expect(text).toContain("sys 8k");
      expect(text).toContain("tools 31k");
      expect(text).toContain("chat 23k");
      // The two leader parts no longer share a row.
      expect(text).not.toContain("sys 8k · tools 31k");
    } finally {
      frame.stop();
    }
  });

  test("paints the turn's own steps, clock and tokens", async () => {
    const frame = mount(24);
    try {
      const text = await frame.text();
      expect(text).toContain("12 steps · 00:42");
      expect(text).toContain("1.2k out · 3.4k in");
    } finally {
      frame.stop();
    }
  });

  test("paints today's ledger, hit above miss and the day's output", async () => {
    const frame = mount(24, 30, {
      today: {
        tokens: 26_400,
        turns: 1,
        cacheReadTokens: 1_200,
        uncachedTokens: 3_400,
        outputTokens: 1_234,
        hitRate: 1_200 / 4_600,
        costUsd: 0.12,
      },
    });
    try {
      const text = await frame.text();
      expect(text).toContain("today 26k tok");
      expect(text).toContain("hit 1.2k (26.1%)");
      expect(text).toContain("miss 3.4k");
      expect(text).toContain("out 1.2k");
      expect(text).toContain("cost $ 0.12");
      expect(text).not.toContain("ledger pending");
      // The cache-fill bucket is an input price; it is not the output row.
      expect(text).not.toContain("write");
    } finally {
      frame.stop();
    }
  });
});

describe("sidebarProjectionFrom", () => {
  const TURN: TurnStatsSnapshot = {
    startedAtMs: 5_000,
    wallMs: 12_000,
    steps: 3,
    inputTokens: 4_500,
    outputTokens: 600,
    active: true,
  };

  const SNAPSHOT: SessionStatsSnapshot = {
    sessionStartMs: 0,
    totalWallMs: 60_000,
    totalApiMs: 10_000,
    usage: {
      promptTokens: 999_999,
      completionTokens: 888_888,
      totalTokens: 1_888_887,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 42,
      stepCount: 77,
    },
    requestCount: 77,
    turn: TURN,
  };

  function inputs(
    overrides: Partial<Parameters<typeof sidebarProjectionFrom>[0]> = {},
  ): Parameters<typeof sidebarProjectionFrom>[0] {
    return {
      stats: SNAPSHOT,
      usedContextTokens: null,
      contextWindowSize: null,
      agents: [],
      today: null,
      memfs: null,
      schedules: null,
      ...overrides,
    };
  }

  test("the Turn row reads the snapshot's turn, not the session totals", () => {
    const view = sidebarProjectionFrom(inputs());
    expect(view.turn).toEqual(TURN);
    // The session has 77 steps and 888,888 output tokens; the turn does not.
    expect(view.turn.steps).toBe(3);
    expect(view.turn.outputTokens).toBe(600);
  });

  test("the out row is today's completion, not the cache-write bucket", () => {
    const today: UsageSummary["today"] = {
      tokens: 10_000,
      turns: 2,
      prompt: 3_000,
      cachedInput: 7_000,
      cacheWrite: 555,
      completion: 1_234,
      cost: 0.5,
      costBreakdown: emptyUsageCost(),
      cacheHitRate: 0.7,
    };
    const view = sidebarProjectionFrom(inputs({ today }));
    expect(view.today?.outputTokens).toBe(1_234);
    expect(view.today?.outputTokens).not.toBe(today.cacheWrite);
    expect(view.today?.cacheReadTokens).toBe(7_000);
    expect(view.today?.uncachedTokens).toBe(3_000);
    expect(view.today?.hitRate).toBe(0.7);
  });

  test("an unread ledger stays absent rather than becoming zeros", () => {
    const view = sidebarProjectionFrom(inputs());
    expect(view.today).toBeNull();
  });

  test("a schedule read failure reaches the rail's projection (M3 #17)", () => {
    const view = sidebarProjectionFrom(
      inputs({ schedules: [], schedulesError: "版本 99" }),
    );
    expect(view.schedulesError).toBe("版本 99");
    // No error means the rail sees the empty list, not a stale message.
    expect(sidebarProjectionFrom(inputs()).schedulesError).toBeNull();
  });
});
