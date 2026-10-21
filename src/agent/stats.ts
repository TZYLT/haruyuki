import type { Buffers } from "@/cli/helpers/accumulator";
import {
  addUsageCost,
  emptyUsageCost,
  type UsageCost,
} from "@/utils/usage-cost";

export interface UsageStats {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  contextTokens?: number;
  stepCount: number;
}

export type UsageStatsDelta = UsageStats;

function emptyUsage(): UsageStats {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    contextTokens: undefined,
    stepCount: 0,
  };
}

export interface SessionStatsSnapshot {
  sessionStartMs: number;
  totalWallMs: number;
  totalApiMs: number;
  usage: UsageStats;
}

export interface TrajectoryStatsSnapshot {
  trajectoryStartMs: number;
  wallMs: number;
  workMs: number;
  apiMs: number;
  localMs: number;
  stepCount: number;
  tokens: number;
  /**
   * Token usage folded over every segment of the turn, not just the last one.
   *
   * The per-drain delta (`updateUsageFromBuffers`) is consumed once per stream,
   * and a turn that needs approvals has several streams, so the deltas have to
   * be summed somewhere if the turn total is to mean anything. This snapshot is
   * where: the usage ledger reads it when the turn ends.
   */
  usage: UsageStats;
  /** Model requests over the turn (one per `usage_statistics` report). */
  usageSteps: number;
  /** Provider-reported cost folded over the turn's segments. */
  cost: UsageCost;
}

export class SessionStats {
  private sessionStartMs: number;
  private totalApiMs: number;
  private usage: UsageStats;
  private lastUsageSnapshot: UsageStats;
  private trajectoryStartMs: number | null;
  private trajectoryApiMs: number;
  private trajectoryLocalMs: number;
  private trajectoryWallMs: number;
  private trajectoryStepCount: number;
  private trajectoryTokens: number;
  private trajectoryUsage: UsageStats;
  private trajectoryUsageSteps: number;
  private trajectoryCost: UsageCost;

  constructor() {
    this.sessionStartMs = performance.now();
    this.totalApiMs = 0;
    this.usage = emptyUsage();
    this.lastUsageSnapshot = { ...this.usage };
    this.trajectoryStartMs = null;
    this.trajectoryApiMs = 0;
    this.trajectoryLocalMs = 0;
    this.trajectoryWallMs = 0;
    this.trajectoryStepCount = 0;
    this.trajectoryTokens = 0;
    this.trajectoryUsage = emptyUsage();
    this.trajectoryUsageSteps = 0;
    this.trajectoryCost = emptyUsageCost();
  }

  endTurn(apiDurationMs: number): void {
    this.totalApiMs += apiDurationMs;
  }

  updateUsageFromBuffers(buffers: Buffers): UsageStatsDelta {
    const nextUsage = { ...buffers.usage };
    const prevUsage = this.lastUsageSnapshot;

    const delta: UsageStatsDelta = {
      promptTokens: Math.max(
        0,
        nextUsage.promptTokens - prevUsage.promptTokens,
      ),
      completionTokens: Math.max(
        0,
        nextUsage.completionTokens - prevUsage.completionTokens,
      ),
      totalTokens: Math.max(0, nextUsage.totalTokens - prevUsage.totalTokens),
      cachedInputTokens: Math.max(
        0,
        nextUsage.cachedInputTokens - prevUsage.cachedInputTokens,
      ),
      cacheWriteTokens: Math.max(
        0,
        nextUsage.cacheWriteTokens - prevUsage.cacheWriteTokens,
      ),
      reasoningTokens: Math.max(
        0,
        nextUsage.reasoningTokens - prevUsage.reasoningTokens,
      ),
      contextTokens: nextUsage.contextTokens,
      stepCount: Math.max(0, nextUsage.stepCount - prevUsage.stepCount),
    };

    this.usage = nextUsage;
    this.lastUsageSnapshot = nextUsage;
    return delta;
  }

  startTrajectory(): void {
    if (this.trajectoryStartMs === null) {
      this.trajectoryStartMs = performance.now();
    }
  }

  accumulateTrajectory(options: {
    apiDurationMs?: number;
    localToolMs?: number;
    wallMs?: number;
    usageDelta?: UsageStatsDelta;
    /** Provider-reported cost for this segment. */
    usageCost?: UsageCost;
    /** Model requests reported by this segment. */
    usageSteps?: number;
    tokenDelta?: number;
  }): void {
    this.startTrajectory();

    if (options.apiDurationMs) {
      this.trajectoryApiMs += options.apiDurationMs;
    }
    if (options.localToolMs) {
      this.trajectoryLocalMs += options.localToolMs;
    }
    if (options.wallMs) {
      this.trajectoryWallMs += options.wallMs;
    }
    if (options.usageDelta) {
      const delta = options.usageDelta;
      this.trajectoryStepCount += delta.stepCount;
      this.trajectoryUsage.promptTokens += delta.promptTokens;
      this.trajectoryUsage.completionTokens += delta.completionTokens;
      this.trajectoryUsage.totalTokens += delta.totalTokens;
      this.trajectoryUsage.cachedInputTokens += delta.cachedInputTokens;
      this.trajectoryUsage.cacheWriteTokens += delta.cacheWriteTokens;
      this.trajectoryUsage.reasoningTokens += delta.reasoningTokens;
      if (delta.contextTokens !== undefined) {
        this.trajectoryUsage.contextTokens = delta.contextTokens;
      }
    }
    if (options.usageSteps) {
      this.trajectoryUsageSteps += options.usageSteps;
    }
    if (options.usageCost) {
      addUsageCost(this.trajectoryCost, options.usageCost);
    }
    if (options.tokenDelta) {
      this.trajectoryTokens += options.tokenDelta;
    }
  }

  getTrajectorySnapshot(): TrajectoryStatsSnapshot | null {
    if (this.trajectoryStartMs === null) return null;
    const workMs = this.trajectoryApiMs + this.trajectoryLocalMs;
    return {
      trajectoryStartMs: this.trajectoryStartMs,
      wallMs: this.trajectoryWallMs,
      workMs,
      apiMs: this.trajectoryApiMs,
      localMs: this.trajectoryLocalMs,
      stepCount: this.trajectoryStepCount,
      tokens: this.trajectoryTokens,
      usage: { ...this.trajectoryUsage },
      usageSteps: this.trajectoryUsageSteps,
      cost: { ...this.trajectoryCost },
    };
  }

  endTrajectory(): TrajectoryStatsSnapshot | null {
    const snapshot = this.getTrajectorySnapshot();
    this.resetTrajectory();
    return snapshot;
  }

  resetTrajectory(): void {
    this.trajectoryStartMs = null;
    this.trajectoryApiMs = 0;
    this.trajectoryLocalMs = 0;
    this.trajectoryWallMs = 0;
    this.trajectoryStepCount = 0;
    this.trajectoryTokens = 0;
    this.trajectoryUsage = emptyUsage();
    this.trajectoryUsageSteps = 0;
    this.trajectoryCost = emptyUsageCost();
  }

  getSnapshot(): SessionStatsSnapshot {
    const now = performance.now();
    return {
      sessionStartMs: this.sessionStartMs,
      totalWallMs: now - this.sessionStartMs,
      totalApiMs: this.totalApiMs,
      usage: { ...this.usage },
    };
  }

  reset(): void {
    this.sessionStartMs = performance.now();
    this.totalApiMs = 0;
    this.usage = emptyUsage();
    this.lastUsageSnapshot = { ...this.usage };
    this.resetTrajectory();
  }
}
