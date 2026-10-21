import { describe, expect, test } from "bun:test";
import { createBuffers } from "@/cli/helpers/accumulator";
import { emptyUsageCost } from "@/utils/usage-cost";
import { SessionStats } from "./stats";

function usageDelta(overrides: {
  promptTokens: number;
  completionTokens: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  contextTokens?: number;
}) {
  return {
    promptTokens: overrides.promptTokens,
    completionTokens: overrides.completionTokens,
    totalTokens: overrides.promptTokens + overrides.completionTokens,
    cachedInputTokens: overrides.cachedInputTokens ?? 0,
    cacheWriteTokens: overrides.cacheWriteTokens ?? 0,
    reasoningTokens: 0,
    contextTokens: overrides.contextTokens,
    stepCount: 0,
  };
}

describe("the trajectory folds every segment of one turn", () => {
  test("usage from a segment that ended in an approval is not lost", () => {
    const stats = new SessionStats();
    stats.startTrajectory();

    // Segment 1: the model asked for approval, so the turn continues.
    stats.accumulateTrajectory({
      apiDurationMs: 1200,
      usageDelta: usageDelta({
        promptTokens: 1000,
        completionTokens: 200,
        cachedInputTokens: 300,
        contextTokens: 4000,
      }),
      usageSteps: 2,
      usageCost: {
        input: 0.1,
        cacheRead: 0.02,
        cacheWrite: 0,
        output: 0.2,
        total: 0.32,
      },
    });
    // Segment 2: the approval came back and the turn finished.
    stats.accumulateTrajectory({
      apiDurationMs: 800,
      usageDelta: usageDelta({
        promptTokens: 400,
        completionTokens: 100,
        cacheWriteTokens: 50,
        contextTokens: 4800,
      }),
      usageSteps: 1,
      usageCost: {
        input: 0.04,
        cacheRead: 0,
        cacheWrite: 0.01,
        output: 0.1,
        total: 0.15,
      },
    });

    const snapshot = stats.endTrajectory();
    expect(snapshot?.usage.promptTokens).toBe(1400);
    expect(snapshot?.usage.completionTokens).toBe(300);
    expect(snapshot?.usage.cachedInputTokens).toBe(300);
    expect(snapshot?.usage.cacheWriteTokens).toBe(50);
    // The last reported occupancy is the turn's occupancy.
    expect(snapshot?.usage.contextTokens).toBe(4800);
    expect(snapshot?.usageSteps).toBe(3);
    expect(snapshot?.apiMs).toBe(2000);
    // Float addition: compare with a tolerance, not with exact equality.
    expect(snapshot?.cost.input).toBeCloseTo(0.14);
    expect(snapshot?.cost.cacheRead).toBeCloseTo(0.02);
    expect(snapshot?.cost.cacheWrite).toBeCloseTo(0.01);
    expect(snapshot?.cost.output).toBeCloseTo(0.3);
    expect(snapshot?.cost.total).toBeCloseTo(0.47);
  });

  test("ending the trajectory clears the turn's usage, not the session's", () => {
    const stats = new SessionStats();
    stats.startTrajectory();
    stats.accumulateTrajectory({
      usageDelta: usageDelta({ promptTokens: 10, completionTokens: 5 }),
      usageSteps: 1,
    });
    const ended = stats.endTrajectory();
    expect(ended?.usage.promptTokens).toBe(10);

    // A new turn starts empty even though the session total still holds both.
    expect(stats.getTrajectorySnapshot()).toBeNull();
    stats.startTrajectory();
    const next = stats.getTrajectorySnapshot();
    expect(next?.usage.promptTokens).toBe(0);
    expect(next?.usageSteps).toBe(0);
    expect(next?.cost).toEqual(emptyUsageCost());
    expect(stats.getSnapshot().usage.promptTokens).toBe(0);
  });

  test("a segment without usage still keeps its wall clock", () => {
    const stats = new SessionStats();
    stats.startTrajectory();
    stats.accumulateTrajectory({ wallMs: 500 });
    const snapshot = stats.getTrajectorySnapshot();
    expect(snapshot?.wallMs).toBe(500);
    expect(snapshot?.usage.promptTokens).toBe(0);
    expect(snapshot?.cost.total).toBe(0);
  });

  test("the buffers delta is what a segment reports", () => {
    const stats = new SessionStats();
    const buffers = createBuffers();
    buffers.usage.promptTokens = 100;
    buffers.usage.completionTokens = 20;
    buffers.usage.totalTokens = 120;
    expect(stats.updateUsageFromBuffers(buffers).promptTokens).toBe(100);

    buffers.usage.promptTokens = 150;
    buffers.usage.completionTokens = 40;
    buffers.usage.totalTokens = 190;
    const delta = stats.updateUsageFromBuffers(buffers);
    expect(delta.promptTokens).toBe(50);
    expect(delta.completionTokens).toBe(20);
  });
});
