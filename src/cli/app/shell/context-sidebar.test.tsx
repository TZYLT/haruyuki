// src/cli/app/shell/context-sidebar.test.tsx

import { afterEach, describe, expect, test } from "bun:test";
import { visibleWidth } from "@/cli/display/statusline/formatting";
import { mountInkTty, resetInkTtyState } from "@/test-utils/ink-tty";
import { ContextSidebar } from "./context-sidebar";
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

  test("paints the composition the projection carries", async () => {
    const frame = mount(24);
    try {
      const text = await frame.text();
      expect(text).toContain("sys 8k · tools 31k");
      expect(text).toContain("chat 23k");
    } finally {
      frame.stop();
    }
  });

  test("paints today's ledger, not a pending placeholder", async () => {
    const frame = mount(24, 30, {
      today: {
        tokens: 26_400,
        turns: 1,
        cacheReadTokens: 1_200,
        uncachedTokens: 3_400,
        writeTokens: 500,
        costUsd: 0.12,
      },
    });
    try {
      const text = await frame.text();
      expect(text).toContain("today 26k tok");
      expect(text).toContain("cost $ 0.12");
      expect(text).not.toContain("ledger pending");
    } finally {
      frame.stop();
    }
  });
});
