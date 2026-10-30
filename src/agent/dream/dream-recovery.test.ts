/**
 * F-06 M2 · crash recovery (requirement R-5.8.4, route §2.6).
 *
 * Recovery is the idempotent repair of a run whose owner died: roll back to the
 * baseline, mark the record `unfinished`, write the one-line report + ledger
 * marker, and delete the lease. The tests inject every side effect so the
 * ordering and the "don't touch a live/busy run" rules are pinned without git or
 * a backend.
 */
import { describe, expect, test } from "bun:test";
import type { DreamRunLease } from "@/agent/dream/dream-lease";
import {
  type DreamRecoveryDeps,
  recoverStaleDreamRuns,
} from "@/agent/dream/dream-recovery";
import type { DreamRunMetadata } from "@/types/dream-run-metadata";

function lease(overrides: Partial<DreamRunLease> = {}): DreamRunLease {
  return {
    version: 1,
    agentId: "agent-a",
    runId: "run-1",
    taskId: "task-1",
    pid: 4_242,
    processStartedAt: "2026-10-30T00:00:00.000Z",
    processStartTicks: null,
    bootId: null,
    startedAt: 1_000,
    heartbeatAt: 2_000,
    status: "running",
    conversationId: "local-conv-1",
    baselineSha: "base-sha",
    ...overrides,
  };
}

function terminalMetadata(
  status: DreamRunMetadata["status"],
): DreamRunMetadata {
  return {
    runId: "run-1",
    triggerSource: "scheduled",
    agentId: "agent-a",
    conversationId: "local-conv-1",
    tierPlan: ["tidy"],
    tierReached: "tidy",
    startedAt: 1_000,
    endedAt: 5_000,
    baselineSha: "base-sha",
    budgetTokens: 100,
    spentTokens: 10,
    timeLimitMinutes: null,
    status,
    reportPath: "maintenance/dream-report.md",
    handoff: "finished",
  };
}

interface Recorded {
  rollbacks: Array<{ memoryDir: string; baselineSha: string }>;
  reports: Array<{ conversationId: string; body: string }>;
  metadata: Array<{ conversationId: string; metadata: DreamRunMetadata }>;
  markers: Array<{ runId: string; agentId: string; sessionId: string }>;
  finished: Array<{ agentId: string; outcome: string }>;
  deleted: string[];
  released: number;
  clearedOverrides: string[];
}

function makeDeps(overrides: Partial<DreamRecoveryDeps> = {}): {
  deps: DreamRecoveryDeps;
  recorded: Recorded;
} {
  const recorded: Recorded = {
    rollbacks: [],
    reports: [],
    metadata: [],
    markers: [],
    finished: [],
    deleted: [],
    released: 0,
    clearedOverrides: [],
  };
  const deps: DreamRecoveryDeps = {
    listLeases: () => [],
    isOwnerAlive: () => false,
    deleteLease: (agentId) => recorded.deleted.push(agentId),
    memoryDir: (agentId) => `/memory/${agentId}`,
    acquireMemoryLock: async () => async () => {
      recorded.released += 1;
    },
    rollbackBaseline: async (input) => {
      recorded.rollbacks.push(input);
      return { changed: true };
    },
    readRunMetadata: async () => ({
      runId: "run-1",
      triggerSource: "scheduled",
      agentId: "agent-a",
      conversationId: "local-conv-1",
      tierPlan: ["tidy"],
      tierReached: "tidy",
      startedAt: 1_000,
      endedAt: null,
      baselineSha: "base-sha",
      budgetTokens: 100,
      spentTokens: 10,
      timeLimitMinutes: null,
      status: "running",
      reportPath: null,
      handoff: null,
    }),
    writeRunMetadata: async (input) => {
      recorded.metadata.push(input);
    },
    writeReport: async (input) => {
      recorded.reports.push({
        conversationId: input.conversationId,
        body: input.body,
      });
      return { reportPath: "maintenance/dream-report.md", committed: true };
    },
    recordMarker: async (input) => {
      recorded.markers.push(input);
    },
    markRunFinished: (agentId, outcome) => {
      recorded.finished.push({ agentId, outcome });
    },
    clearBudgetOverride: (taskId) => {
      recorded.clearedOverrides.push(taskId);
    },
    now: () => new Date(9_000),
    ...overrides,
  };
  return { deps, recorded };
}

describe("recoverStaleDreamRuns", () => {
  test("a dead run is rolled back, marked unfinished, reported and unleased", async () => {
    const { deps, recorded } = makeDeps({
      listLeases: () => [lease()],
    });
    const result = await recoverStaleDreamRuns(deps);
    expect(result).toMatchObject({ recovered: 1, live: 0, deferred: 0 });
    expect(recorded.rollbacks).toEqual([
      { memoryDir: "/memory/agent-a", baselineSha: "base-sha" },
    ]);
    expect(recorded.metadata).toHaveLength(1);
    expect(recorded.metadata[0]?.metadata).toMatchObject({
      status: "unfinished",
      endedAt: 9_000,
    });
    expect(recorded.metadata[0]?.metadata.handoff).toContain("rolled back");
    expect(recorded.reports[0]?.body).toContain("did not finish");
    expect(recorded.markers).toEqual([
      { runId: "run-1", agentId: "agent-a", sessionId: "local-conv-1" },
    ]);
    expect(recorded.finished).toEqual([
      { agentId: "agent-a", outcome: "unfinished" },
    ]);
    expect(recorded.deleted).toEqual(["agent-a"]);
    expect(recorded.released).toBe(1);
  });

  test("a live owner is left alone (F3 territory, not recovery)", async () => {
    const { deps, recorded } = makeDeps({
      listLeases: () => [lease()],
      isOwnerAlive: () => true,
    });
    const result = await recoverStaleDreamRuns(deps);
    expect(result).toMatchObject({ recovered: 0, live: 1, deferred: 0 });
    expect(recorded.rollbacks).toHaveLength(0);
    expect(recorded.deleted).toHaveLength(0);
  });

  test("a busy memory lock defers the repair instead of rolling under a writer", async () => {
    const { deps, recorded } = makeDeps({
      listLeases: () => [lease()],
      acquireMemoryLock: async () => null,
    });
    const result = await recoverStaleDreamRuns(deps);
    expect(result).toMatchObject({ recovered: 0, deferred: 1 });
    expect(recorded.rollbacks).toHaveLength(0);
    expect(recorded.deleted).toHaveLength(0);
  });

  test("a lease that died before the session existed is just dropped", async () => {
    const { deps, recorded } = makeDeps({
      listLeases: () => [
        lease({ conversationId: null, baselineSha: null, status: "running" }),
      ],
    });
    const result = await recoverStaleDreamRuns(deps);
    expect(result.recovered).toBe(1);
    expect(recorded.rollbacks).toHaveLength(0);
    expect(recorded.deleted).toEqual(["agent-a"]);
  });

  test("recovery is idempotent: a second scan of the same lease finds nothing to do", async () => {
    let leases = [lease()];
    const { deps } = makeDeps({
      listLeases: () => leases,
      deleteLease: () => {
        leases = [];
      },
    });
    const first = await recoverStaleDreamRuns(deps);
    expect(first.recovered).toBe(1);
    const second = await recoverStaleDreamRuns(deps);
    expect(second.recovered).toBe(0);
  });

  test("a broken rollback keeps the checkout but still records the crash", async () => {
    const { deps, recorded } = makeDeps({
      listLeases: () => [lease()],
      rollbackBaseline: async () => {
        throw new Error("repo corrupt");
      },
    });
    const result = await recoverStaleDreamRuns(deps);
    expect(result.recovered).toBe(1);
    expect(recorded.rollbacks).toHaveLength(0);
    // The record must say the rollback did not happen instead of pretending it did.
    expect(recorded.metadata[0]?.metadata.status).toBe("unfinished");
    expect(recorded.metadata[0]?.metadata.handoff).toContain("inspection");
  });

  test("a failed metadata write keeps the lease for the next attempt", async () => {
    const { deps, recorded } = makeDeps({
      listLeases: () => [lease()],
      writeRunMetadata: async () => {
        throw new Error("backend down");
      },
    });
    const result = await recoverStaleDreamRuns(deps);
    expect(result.deferred).toBe(1);
    expect(recorded.deleted).toHaveLength(0);
  });

  test("a terminal record is only cleaned up: no rollback, no record rewrite", async () => {
    for (const status of [
      "succeeded",
      "cancelled",
      "budget_exhausted",
      "timeout",
      "failed",
      "unfinished",
    ] as const) {
      const { deps, recorded } = makeDeps({
        listLeases: () => [lease()],
        readRunMetadata: async () => ({
          ...terminalMetadata(status),
        }),
      });
      const result = await recoverStaleDreamRuns(deps);
      expect(result.recovered).toBe(1);
      expect(recorded.rollbacks).toHaveLength(0);
      expect(recorded.metadata).toHaveLength(0);
      expect(recorded.reports).toHaveLength(0);
      expect(recorded.markers).toHaveLength(0);
      expect(recorded.finished).toEqual([
        { agentId: "agent-a", outcome: status },
      ]);
      expect(recorded.deleted).toEqual(["agent-a"]);
      expect(recorded.clearedOverrides).toEqual(["task-1"]);
    }
  });

  test("a terminal record that has no lease task id is still cleaned up", async () => {
    const { deps, recorded } = makeDeps({
      listLeases: () => [lease({ taskId: null })],
      readRunMetadata: async () => terminalMetadata("succeeded"),
    });
    const result = await recoverStaleDreamRuns(deps);
    expect(result.recovered).toBe(1);
    expect(recorded.rollbacks).toHaveLength(0);
    expect(recorded.clearedOverrides).toHaveLength(0);
  });

  test("the repaired record gets the report path the writer returned", async () => {
    const { deps, recorded } = makeDeps({ listLeases: () => [lease()] });
    await recoverStaleDreamRuns(deps);
    expect(recorded.metadata[0]?.metadata.reportPath).toBe(
      "maintenance/dream-report.md",
    );
  });

  test("a running run clears the stale budget override while repairing", async () => {
    const { deps, recorded } = makeDeps({ listLeases: () => [lease()] });
    await recoverStaleDreamRuns(deps);
    expect(recorded.clearedOverrides).toEqual(["task-1"]);
  });

  test("the repair never throws, even when listing blows up", async () => {
    const { deps } = makeDeps({
      listLeases: () => {
        throw new Error("unreadable");
      },
    });
    const result = await recoverStaleDreamRuns(deps);
    expect(result.unreadable).toBe(1);
    expect(result.recovered).toBe(0);
  });
});
