import { describe, expect, test } from "bun:test";
import type { SessionStats, TrajectoryStatsSnapshot } from "@/agent/stats";
import type { Buffers } from "@/cli/helpers/accumulator";
import {
  liveTrajectoryElapsedMs,
  tokenCountDelta,
  trajectorySummary,
} from "./turn-metrics";

function snapshotOf(overrides: Partial<TrajectoryStatsSnapshot>) {
  return {
    trajectoryStartMs: 0,
    wallMs: 0,
    workMs: 0,
    apiMs: 0,
    localMs: 0,
    stepCount: 0,
    tokens: 0,
    usage: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      contextTokens: undefined,
      stepCount: 0,
    },
    usageSteps: 0,
    cost: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 },
    ...overrides,
  } satisfies TrajectoryStatsSnapshot;
}

function statsWith(snapshot: TrajectoryStatsSnapshot | null) {
  return {
    getTrajectorySnapshot: () => snapshot,
  } as unknown as SessionStats;
}

describe("liveTrajectoryElapsedMs", () => {
  test("returns the closed segments when nothing is running", () => {
    expect(
      liveTrajectoryElapsedMs(statsWith(snapshotOf({ wallMs: 250 })), null),
    ).toBe(250);
  });

  test("adds the running segment", () => {
    const start = performance.now();
    const elapsed = liveTrajectoryElapsedMs(
      statsWith(snapshotOf({ wallMs: 250 })),
      start,
    );
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(250 + 50);
  });

  test("a turn with no snapshot yet counts from zero", () => {
    expect(liveTrajectoryElapsedMs(statsWith(null), null)).toBe(0);
  });
});

describe("trajectorySummary", () => {
  test("a slow turn is summarised regardless of step count", () => {
    expect(trajectorySummary(snapshotOf({ wallMs: 61_000 }), 0)).toEqual({
      wallMs: 61_000,
      shouldShow: true,
    });
  });

  test("a short turn with few steps is not", () => {
    expect(trajectorySummary(snapshotOf({ stepCount: 3 }), 9_000)).toEqual({
      wallMs: 9_000,
      shouldShow: false,
    });
  });

  test("many steps plus a few seconds is worth a line", () => {
    expect(trajectorySummary(snapshotOf({ stepCount: 4 }), 11_000)).toEqual({
      wallMs: 11_000,
      shouldShow: true,
    });
  });

  test("the reported wall time is the larger of the two sources", () => {
    // The snapshot's own wall clock can exceed the live estimate when the last
    // segment was already closed; the summary must not shrink.
    expect(trajectorySummary(snapshotOf({ wallMs: 5_000 }), 1_000).wallMs).toBe(
      5_000,
    );
  });
});

describe("tokenCountDelta", () => {
  test("counts what the turn added", () => {
    const buffers = { tokenCount: 10 } as unknown as Buffers;
    expect(tokenCountDelta(buffers, 3)).toBe(7);
  });

  test("never goes negative when a compaction drops lines", () => {
    const buffers = { tokenCount: 3 } as unknown as Buffers;
    expect(tokenCountDelta(buffers, 10)).toBe(0);
  });
});
