import type { Buffers } from "@/cli/helpers/accumulator";
import type { UsageContextBreakdown } from "@/utils/usage-context";
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

/**
 * One user turn's own numbers, projected for the rail's Turn section.
 *
 * A **turn** is one user message and everything the agent did to answer it; a
 * **step** is one model request inside that turn (the model gets the tool
 * results back, asks again, and that is the next step). The session snapshot
 * cannot answer either question — `usage` and `usage.stepCount` are cumulative
 * — so a section titled "Turn" that read them was a session row wearing a
 * turn's label.
 */
export interface TurnStatsSnapshot {
  /**
   * `performance.now()` when the turn's first segment opened, or `null` before
   * the first turn of the session.
   */
  startedAtMs: number | null;
  /**
   * Wall clock of the turn.
   *
   * Live while it runs — the closed segments are a floor and the open one is
   * timed up to the snapshot's own `now` — and the final number once it ends.
   */
  wallMs: number;
  /** Agent steps in this turn, not the session's request count. */
  steps: number;
  /** Input tokens this turn spent (summed over its segments). */
  inputTokens: number;
  /** Output tokens this turn produced (summed over its segments). */
  outputTokens: number;
  /** A turn is in flight; `false` on the turn that just ended, and before any. */
  active: boolean;
}

/**
 * The turn row before the first message: zeros, not an unknown dash.
 *
 * "No turn yet" is a measurement of zero, unlike a missing ledger read; the
 * rail says `0 steps` and the user reads "nothing has run", which is true.
 */
export function emptyTurnStats(): TurnStatsSnapshot {
  return {
    startedAtMs: null,
    wallMs: 0,
    steps: 0,
    inputTokens: 0,
    outputTokens: 0,
    active: false,
  };
}

export interface SessionStatsSnapshot {
  sessionStartMs: number;
  totalWallMs: number;
  totalApiMs: number;
  usage: UsageStats;
  /**
   * Model requests the session made, counted from `usage_statistics` reports.
   *
   * `usage.stepCount` only moves when a backend sends `step_count` chunks, and
   * the local path never does — so the session's own count is the honest one,
   * and `getSnapshot` folds it into `usage.stepCount` (see below).
   */
  requestCount: number;
  /** Composition of the last request the session assembled, when known. */
  contextBreakdown?: UsageContextBreakdown;
  /**
   * The current turn, or the one that just ended.
   *
   * Optional only because a few surfaces build this snapshot by hand in tests
   * without running a turn; `getSnapshot()` always fills it in.
   */
  turn?: TurnStatsSnapshot;
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
  /** What the last request of the turn was made of (a snapshot). */
  contextBreakdown?: UsageContextBreakdown;
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
  private trajectoryContext: UsageContextBreakdown | undefined;
  /** Requests the whole session made (`usage_statistics` reports). */
  private requestCount: number;
  /**
   * The last request the session assembled, kept **outside** the trajectory.
   *
   * The trajectory is a per-turn accumulator that is reset at the end of every
   * turn, and the rail reads this between turns: "what is my context made of"
   * is a session question about the most recent request, so it has to outlive
   * the turn that answered it.
   */
  private lastContext: UsageContextBreakdown | undefined;
  /**
   * The turn that just ended, kept so its numbers stay on screen.
   *
   * `resetTrajectory` clears the live accumulators (an ended turn must not feed
   * the next one), but the rail is read *between* turns too, so the final row
   * has to be remembered instead of decaying to zero. The next
   * `startTrajectory` — a new user message — drops it.
   */
  private lastTurn: TurnStatsSnapshot | null;

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
    this.trajectoryContext = undefined;
    this.requestCount = 0;
    this.lastContext = undefined;
    this.lastTurn = null;
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
      // A new turn begins with the user's message: the Turn section starts at
      // zero. Clearing here (and not in `resetTrajectory`) is what lets the
      // ended turn keep its final numbers until the next message arrives; an
      // approval continuation also calls this, but the trajectory is already
      // open then, so it cannot wipe the turn it is continuing.
      this.lastTurn = null;
    }
  }

  accumulateTrajectory(options: {
    apiDurationMs?: number;
    localToolMs?: number;
    wallMs?: number;
    usageDelta?: UsageStatsDelta;
    /** Provider-reported cost for this segment. */
    usageCost?: UsageCost;
    /** Composition of this segment's request; the last report wins. */
    usageContext?: UsageContextBreakdown;
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
      this.requestCount += options.usageSteps;
    }
    if (options.usageCost) {
      addUsageCost(this.trajectoryCost, options.usageCost);
    }
    if (options.usageContext) {
      this.trajectoryContext = { ...options.usageContext };
      this.lastContext = { ...options.usageContext };
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
      ...(this.trajectoryContext
        ? { contextBreakdown: { ...this.trajectoryContext } }
        : {}),
    };
  }

  endTrajectory(): TrajectoryStatsSnapshot | null {
    const snapshot = this.getTrajectorySnapshot();
    if (snapshot) {
      const turn = this.liveTurn(performance.now());
      this.lastTurn = turn ? { ...turn, active: false } : null;
    }
    this.resetTrajectory();
    return snapshot;
  }

  /**
   * The open turn as the rail reads it, or `null` when nothing is running.
   *
   * `steps` takes the larger of the two per-turn sources, for the same reason
   * the session snapshot does: `usageSteps` counts `usage_statistics` reports
   * and is the count that actually moves on the local path, while a backend
   * that reports `step_count` chunks counts the same unit one step ahead. The
   * session's cumulative `usage.stepCount` is deliberately not consulted — a
   * turn row that grows with the session is the bug this projection exists to
   * fix.
   */
  private liveTurn(now: number): TurnStatsSnapshot | null {
    if (this.trajectoryStartMs === null) return null;
    return {
      startedAtMs: this.trajectoryStartMs,
      wallMs: Math.max(this.trajectoryWallMs, now - this.trajectoryStartMs),
      steps: Math.max(this.trajectoryStepCount, this.trajectoryUsageSteps),
      inputTokens: this.trajectoryUsage.promptTokens,
      outputTokens: this.trajectoryUsage.completionTokens,
      active: true,
    };
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
    this.trajectoryContext = undefined;
    // `requestCount`, `lastContext` and `lastTurn` outlive the turn: the first
    // two are session facts, and `lastTurn` is what the rail keeps showing
    // between turns (`endTrajectory` stores it before calling this, and only
    // `startTrajectory`/`reset` may drop it).
  }

  getSnapshot(): SessionStatsSnapshot {
    const now = performance.now();
    return {
      sessionStartMs: this.sessionStartMs,
      totalWallMs: now - this.sessionStartMs,
      totalApiMs: this.totalApiMs,
      // `max`, not a replacement: a backend that *does* report `step_count` is
      // the better source, and the buffers' count is then usually ahead of the
      // reports (they arrive once per stream, the chunks once per step).
      usage: {
        ...this.usage,
        stepCount: Math.max(this.usage.stepCount, this.requestCount),
      },
      requestCount: this.requestCount,
      ...(this.lastContext
        ? { contextBreakdown: { ...this.lastContext } }
        : {}),
      turn: this.liveTurn(now) ?? this.lastTurn ?? emptyTurnStats(),
    };
  }

  reset(): void {
    this.sessionStartMs = performance.now();
    this.totalApiMs = 0;
    this.usage = emptyUsage();
    this.lastUsageSnapshot = { ...this.usage };
    this.requestCount = 0;
    this.lastContext = undefined;
    // A fresh session has no turn to show. `resetTrajectory` keeps the ended
    // turn on purpose, so it has to be dropped here, after.
    this.lastTurn = null;
    this.resetTrajectory();
  }
}
