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

  test("the request composition is a snapshot, so the last segment wins", () => {
    const stats = new SessionStats();
    stats.startTrajectory();
    stats.accumulateTrajectory({
      usageContext: { system: 8_000, messages: 20_000, tools: 30_000 },
    });
    stats.accumulateTrajectory({
      usageContext: { system: 8_000, messages: 21_000, tools: 30_000 },
    });
    expect(stats.getTrajectorySnapshot()?.contextBreakdown).toEqual({
      system: 8_000,
      messages: 21_000,
      tools: 30_000,
    });
    // A new turn starts without the previous composition.
    stats.endTrajectory();
    stats.startTrajectory();
    expect(stats.getTrajectorySnapshot()?.contextBreakdown).toBeUndefined();
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

describe("the session's own projections", () => {
  test("requests are counted from the usage reports, since step_count is not sent", () => {
    // The local backend never emits `step_count`, so `usage.stepCount` stays 0
    // and every surface that reads it showed "0 steps". The reports do arrive.
    const stats = new SessionStats();
    expect(stats.getSnapshot().usage.stepCount).toBe(0);

    stats.accumulateTrajectory({ usageSteps: 2 });
    stats.accumulateTrajectory({ usageSteps: 1 });
    const snapshot = stats.getSnapshot();
    expect(snapshot.requestCount).toBe(3);
    expect(snapshot.usage.stepCount).toBe(3);

    stats.endTrajectory();
    // Ending a turn does not forget the session's requests.
    expect(stats.getSnapshot().usage.stepCount).toBe(3);
  });

  test("a backend that does report steps keeps its own, larger count", () => {
    const stats = new SessionStats();
    const buffers = createBuffers();
    buffers.usage.stepCount = 9;
    stats.updateUsageFromBuffers(buffers);
    stats.accumulateTrajectory({ usageSteps: 1 });
    expect(stats.getSnapshot().usage.stepCount).toBe(9);
  });

  test("the composition outlives the turn that reported it", () => {
    const stats = new SessionStats();
    stats.startTrajectory();
    stats.accumulateTrajectory({
      usageContext: { system: 8_000, messages: 23_000, tools: 31_000 },
    });
    stats.endTrajectory();
    // The rail reads this between turns, so it cannot live in the trajectory.
    expect(stats.getSnapshot().contextBreakdown).toEqual({
      system: 8_000,
      messages: 23_000,
      tools: 31_000,
    });
    expect(stats.getSnapshot().contextBreakdown).not.toBe(
      stats.getSnapshot().contextBreakdown,
    );
  });
});

describe("the turn projection", () => {
  const beforeAnyTurn = {
    startedAtMs: null,
    wallMs: 0,
    steps: 0,
    inputTokens: 0,
    outputTokens: 0,
    active: false,
  };

  test("starts at zero, accumulates, keeps its final numbers, then clears", () => {
    const stats = new SessionStats();
    // "Nothing has run yet" is a zero, not a missing source.
    expect(stats.getSnapshot().turn).toEqual(beforeAnyTurn);

    stats.startTrajectory();
    const started = stats.getSnapshot().turn;
    expect(started?.active).toBe(true);
    expect(started?.startedAtMs).not.toBeNull();
    expect(started?.steps).toBe(0);
    expect(started?.inputTokens).toBe(0);
    expect(started?.outputTokens).toBe(0);
    expect(started?.wallMs).toBeLessThan(1_000);

    stats.accumulateTrajectory({
      usageDelta: usageDelta({ promptTokens: 900, completionTokens: 120 }),
      usageSteps: 2,
      wallMs: 1_500,
    });
    const running = stats.getSnapshot().turn;
    expect(running?.steps).toBe(2);
    expect(running?.inputTokens).toBe(900);
    expect(running?.outputTokens).toBe(120);
    // The live clock is at least the segments the turn has already banked.
    expect(running?.wallMs).toBeGreaterThanOrEqual(1_500);

    stats.endTrajectory();
    // The rail is read between turns, so the ended turn must not drop to zero.
    expect(stats.getTrajectorySnapshot()).toBeNull();
    const ended = stats.getSnapshot().turn;
    expect(ended?.active).toBe(false);
    expect(ended?.steps).toBe(2);
    expect(ended?.inputTokens).toBe(900);
    expect(ended?.outputTokens).toBe(120);
    expect(ended?.wallMs).toBeGreaterThanOrEqual(1_500);
    expect(ended?.startedAtMs).toBe(started?.startedAtMs ?? null);

    // The next user message opens a new turn, which starts at zero again.
    stats.startTrajectory();
    const next = stats.getSnapshot().turn;
    expect(next?.active).toBe(true);
    expect(next?.steps).toBe(0);
    expect(next?.inputTokens).toBe(0);
    expect(next?.outputTokens).toBe(0);
    expect(next?.wallMs).toBeLessThan(1_000);
  });

  test("the turn's steps reset while the session's request count accumulates", () => {
    const stats = new SessionStats();
    stats.startTrajectory();
    stats.accumulateTrajectory({ usageSteps: 3 });
    stats.endTrajectory();

    stats.startTrajectory();
    stats.accumulateTrajectory({ usageSteps: 1 });
    // The turn row answers "how many steps has this message taken"; the session
    // snapshot answers "how many requests has this session made".
    expect(stats.getSnapshot().turn?.steps).toBe(1);
    expect(stats.getSnapshot().usage.stepCount).toBe(4);
  });

  test("a backend that reports step_count deltas is counted too", () => {
    const stats = new SessionStats();
    const buffers = createBuffers();
    stats.startTrajectory();
    buffers.usage.stepCount = 2;
    stats.accumulateTrajectory({
      usageDelta: stats.updateUsageFromBuffers(buffers),
    });
    expect(stats.getSnapshot().turn?.steps).toBe(2);
  });

  test("an approval continuation does not wipe the turn it continues", () => {
    const stats = new SessionStats();
    stats.startTrajectory();
    stats.accumulateTrajectory({
      usageDelta: usageDelta({ promptTokens: 40, completionTokens: 4 }),
      usageSteps: 1,
    });
    // The approval flow calls `startTrajectory` again to time the tool batch;
    // the turn is already open, so this must not reset the row.
    stats.startTrajectory();
    expect(stats.getSnapshot().turn?.steps).toBe(1);
    expect(stats.getSnapshot().turn?.inputTokens).toBe(40);
    expect(stats.getSnapshot().turn?.active).toBe(true);
  });

  test("a session reset drops the previous turn", () => {
    const stats = new SessionStats();
    stats.startTrajectory();
    stats.accumulateTrajectory({ usageSteps: 2 });
    stats.endTrajectory();
    expect(stats.getSnapshot().turn?.steps).toBe(2);

    stats.reset();
    expect(stats.getSnapshot().turn).toEqual(beforeAnyTurn);
  });
});
