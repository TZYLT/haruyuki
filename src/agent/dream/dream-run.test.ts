/**
 * F-06 M2 · dream run controller state machine (route §2.4, requirement §5.8).
 *
 * Every side effect is injected, so these tests drive the whole lifecycle —
 * locks, baseline, hidden session, tier turns, budget gate, rollback, report,
 * ledger marker, terminal record — without a backend, git or a child process.
 * That is the part of S1 that must not regress silently; the production wiring
 * is exercised by the offline probe recorded in the 46-6 handoff.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  markDreamTurnInFlight,
  readDreamActivity,
} from "@/agent/dream/dream-activity";
import { type DreamTurnResult, executeDreamRun } from "@/agent/dream/dream-run";
import {
  EMPTY_PARTS,
  makeHarness,
  makeSettings,
  makeTask,
  RUN_INPUT,
} from "@/agent/dream/dream-run-test-harness";
import { ScheduledTaskPreflightError } from "@/cron/task-run";

describe("executeDreamRun · happy path", () => {
  test("takes both locks in order, baselines, runs tiers and finishes cleanly", async () => {
    const harness = makeHarness();
    const result = await executeDreamRun(RUN_INPUT, harness.deps);

    expect(result.outcome).toBe("success");
    expect(result.conversationId).toBe("conv-run-1");

    // Lock order: dream before memory; release in reverse.
    expect(harness.events.slice(0, 2)).toEqual(["lock.dream", "lock.memory"]);
    expect(harness.events.at(-2)).toBe("unlock.memory");
    expect(harness.events.at(-1)).toBe("unlock.dream");
    expect(harness.events).toContain("baseline");
    expect(harness.events.indexOf("baseline")).toBeLessThan(
      harness.events.indexOf("session"),
    );

    // Two enabled tiers -> two child turns, each with its own prompt. The
    // first turn carries the shared manual and the seed; the second is the
    // short `<dream_run>` block.
    expect(harness.turns.map((turn) => turn.tier)).toEqual(["tidy", "think"]);
    expect(harness.turns[0]?.prompt).toContain("# Dream run — shared manual");
    expect(harness.turns[0]?.prompt).toContain("## This turn");
    expect(harness.turns[0]?.prompt).toContain("one tier only");
    expect(harness.turns[1]?.prompt.startsWith("<dream_run>")).toBe(true);
    expect(harness.turns[1]?.prompt).toContain("Dream run run-1, continuing");
    expect(harness.turns[1]?.prompt).toContain("tier 2 of 2");
    expect(harness.turns[0]?.permissionMode).toBe("acceptEdits");

    // Terminal record, report, no failure marker, no rollback.
    const final = harness.metadata.at(-1);
    expect(final).toMatchObject({
      status: "succeeded",
      tierReached: "think",
      reportPath: "maintenance/dream.md",
      endedAt: 1_700_000_000_000,
    });
    expect(final?.spentTokens).toBe(200);
    expect(harness.reports).toHaveLength(1);
    expect(harness.reports[0]?.body).toContain("report for think");
    expect(harness.markers).toHaveLength(0);
    expect(harness.rollbacks).toHaveLength(0);
    expect(harness.pressureBaselines).toEqual([1_700_000_000_000]);
    expect(harness.finished).toEqual(["agent-a:succeeded"]);
    expect(harness.deletedLeases).toBe(1);
    expect(harness.released).toEqual({ dream: 1, memory: 1 });
  });

  test("writes the running record before the first turn and reports the model", async () => {
    const harness = makeHarness();
    await executeDreamRun(RUN_INPUT, harness.deps);
    expect(harness.events).toContain("metadata.running");
    expect(harness.events.indexOf("metadata.running")).toBeLessThan(
      harness.events.indexOf("signal.active"),
    );
  });
});

describe("executeDreamRun · permission tier", () => {
  for (const mode of ["standard", "acceptEdits", "unrestricted"] as const) {
    test(`carries ${mode} into every turn and describes it in the prompt`, async () => {
      const harness = makeHarness({
        settings: makeSettings({ permissionMode: mode }),
      });
      await executeDreamRun(RUN_INPUT, harness.deps);

      expect(harness.turns.map((turn) => turn.permissionMode)).toEqual([
        mode,
        mode,
      ]);
      expect(harness.turns[0]?.prompt).toContain(
        `Permission tier: \`${mode}\``,
      );
      // Later turns are short but still restate the tier.
      expect(harness.turns[1]?.prompt).toContain(`Permission tier \`${mode}\``);
      if (mode === "standard") {
        expect(harness.turns[0]?.prompt).toContain(
          "`Write` and `Edit` are rejected",
        );
      }
      if (mode === "acceptEdits") {
        expect(harness.turns[0]?.prompt).toContain(
          "Not available: shell (`Bash` / `exec_command`)",
        );
      }
      if (mode === "unrestricted") {
        expect(harness.turns[0]?.prompt).toContain(
          "Do not use them for convenience",
        );
      }
    });
  }
});

describe("executeDreamRun · DreamDone", () => {
  test("a handoff written by the agent ends the plan after that turn", async () => {
    const harness = makeHarness({
      overrides: {
        readMetadata: async () => ({
          runId: "run-1",
          triggerSource: "scheduled",
          agentId: "agent-a",
          conversationId: "conv-run-1",
          tierPlan: ["tidy", "think"],
          tierReached: "tidy",
          startedAt: 1_700_000_000_000,
          endedAt: null,
          baselineSha: "baseline",
          budgetTokens: 80_000,
          spentTokens: 100,
          timeLimitMinutes: null,
          status: "running",
          reportPath: null,
          handoff: "Tidy is done; next run should start with think.",
        }),
      },
    });
    const result = await executeDreamRun(RUN_INPUT, harness.deps);
    expect(result.outcome).toBe("success");
    // The agent said it is done: the second tier is not started.
    expect(harness.turns.map((turn) => turn.tier)).toEqual(["tidy"]);
    const final = harness.metadata.at(-1);
    expect(final?.status).toBe("succeeded");
    expect(final?.handoff).toContain("next run should start with think");
    expect(harness.reports[0]?.body).toContain(
      "next run should start with think",
    );
    expect(harness.markers).toHaveLength(0);
  });
});

describe("executeDreamRun · budget", () => {
  test("stops as budget_exhausted, keeps work and writes the handoff", async () => {
    const harness = makeHarness({
      settings: makeSettings({ maxPerRun: 1_000 }),
      spawnedTurn: (input) => ({
        success: true,
        report: `report for ${input.tier}`,
        aborted: false,
        usage: { ...EMPTY_PARTS, outputTokens: 2_000 },
      }),
    });
    const result = await executeDreamRun(RUN_INPUT, harness.deps);

    // Budget exhaustion is a designed stop, not a failure for the scheduler.
    expect(result.outcome).toBe("success");
    expect(harness.turns).toHaveLength(1);
    const final = harness.metadata.at(-1);
    expect(final?.status).toBe("budget_exhausted");
    expect(final?.handoff).toContain("Budget exhausted");
    expect(harness.markers.map((marker) => marker.outcome)).toEqual([
      "budget_exhausted",
    ]);
    expect(harness.rollbacks).toHaveLength(0);
    // R-5.2.3: only a successful run moves the "since last success" boundary.
    expect(harness.pressureBaselines).toHaveLength(0);
    expect(final?.handoff).toContain("Remaining tiers not started: think");
    expect(harness.finished).toEqual(["agent-a:budget_exhausted"]);
  });

  test("the one pre-approved extension keeps a run inside 150% alive", async () => {
    let calls = 0;
    const harness = makeHarness({
      settings: makeSettings({ maxPerRun: 1_000, overBudgetApprovals: 1 }),
      spawnedTurn: (input) => {
        calls += 1;
        // 1,100 of 1,000 (110%): the extension lifts the allowance to 1,500.
        return {
          success: true,
          report: `report for ${input.tier}`,
          aborted: false,
          usage:
            calls === 1 ? { ...EMPTY_PARTS, outputTokens: 1_100 } : EMPTY_PARTS,
        };
      },
    });
    const result = await executeDreamRun(RUN_INPUT, harness.deps);
    expect(result.outcome).toBe("success");
    expect(harness.turns).toHaveLength(2);
    expect(harness.metadata.at(-1)?.status).toBe("succeeded");
  });
});

describe("executeDreamRun · manual runs", () => {
  test("manual pressure floor: pressure 0 uses the configured threshold", async () => {
    const harness = makeHarness({
      overrides: { readPressure: () => 0 },
    });
    const result = await executeDreamRun(
      { ...RUN_INPUT, manual: true },
      harness.deps,
    );
    expect(result.outcome).toBe("success");
    // 75,000 threshold x 0.8 factor = 60,000, capped at 100,000.
    const first = harness.metadata[0];
    expect(first?.budgetTokens).toBe(60_000);
    expect(first?.triggerSource).toBe("manual");
    expect(harness.metadata.at(-1)?.triggerSource).toBe("manual");
    expect(harness.turns).toHaveLength(2);
  });

  test("automatic runs keep the measured pressure (0 stays 0)", async () => {
    const harness = makeHarness({
      overrides: { readPressure: () => 0 },
    });
    const result = await executeDreamRun(RUN_INPUT, harness.deps);
    expect(result.outcome).toBe("success");
    const first = harness.metadata[0];
    expect(first?.budgetTokens).toBe(0);
    expect(first?.triggerSource).toBe("scheduled");
    expect(harness.turns).toHaveLength(0);
    expect(harness.metadata.at(-1)?.status).toBe("budget_exhausted");
  });
});

describe("executeDreamRun · last tier overrun", () => {
  test("a successful final tier that crossed 100% keeps the reminder text", async () => {
    const harness = makeHarness({
      settings: makeSettings({
        tiers: { tidy: true, think: false, task: false, wander: false },
      }),
      spawnedTurn: () => ({
        success: true,
        report: "tidied",
        aborted: false,
        // 200k against an 80k allowance: all three reminders crossed.
        usage: { ...EMPTY_PARTS, outputTokens: 200_000 },
      }),
    });
    const result = await executeDreamRun(RUN_INPUT, harness.deps);
    expect(result.outcome).toBe("success");
    const final = harness.metadata.at(-1);
    expect(final?.status).toBe("succeeded");
    // The 40/75/90/100 reminder text is not dropped when there is no next turn.
    expect(final?.handoff).toContain("budget reached");
    expect(final?.handoff).toContain("do not ask for approval");
    expect(harness.markers).toHaveLength(0);
    expect(harness.pressureBaselines).toHaveLength(1);
  });

  test("automatic runs never inherit a manual trigger source", async () => {
    const harness = makeHarness();
    await executeDreamRun(
      { ...RUN_INPUT, occurrence: "2026-10-30T23:00" },
      harness.deps,
    );
    expect(harness.metadata[0]?.triggerSource).toBe("scheduled");
  });
});

describe("executeDreamRun · user comes back", () => {
  test("activity after the start cancels gracefully and keeps commits", async () => {
    const harness = makeHarness({ activityAt: 1_700_000_000_001 });
    const result = await executeDreamRun(RUN_INPUT, harness.deps);
    expect(result.outcome).toBe("cancelled");
    expect(harness.turns).toHaveLength(0);
    expect(harness.rollbacks).toHaveLength(0);
    expect(harness.markers.map((marker) => marker.outcome)).toEqual([
      "cancelled",
    ]);
    const final = harness.metadata.at(-1);
    expect(final?.status).toBe("cancelled");
    expect(final?.handoff).toContain("came back");
    expect(harness.finished).toEqual(["agent-a:cancelled"]);
    // Pressure baseline only moves for completed runs.
    expect(harness.pressureBaselines).toHaveLength(0);
  });

  test("a live in-flight interactive turn cancels the run (real marker)", async () => {
    const previousHome = process.env.HARUYUKI_HOME;
    const home = mkdtempSync(join(tmpdir(), "hryk-dream-run-activity-"));
    process.env.HARUYUKI_HOME = home;
    try {
      // The user's turn dispatched a request and is still streaming: the
      // silence window must not be treated as expired.
      markDreamTurnInFlight("agent-a");
      const harness = makeHarness({
        overrides: { readActivity: (agentId) => readDreamActivity(agentId) },
      });
      const result = await executeDreamRun(RUN_INPUT, harness.deps);
      expect(result.outcome).toBe("cancelled");
      expect(harness.turns).toHaveLength(0);
      expect(harness.metadata.at(-1)?.status).toBe("cancelled");
    } finally {
      if (previousHome === undefined) delete process.env.HARUYUKI_HOME;
      else process.env.HARUYUKI_HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("executeDreamRun · time limit", () => {
  test("aborts the turn, rolls back to the baseline and reports timeout", async () => {
    const harness = makeHarness({
      settings: makeSettings({ timeLimitMinutes: 0.0005 }), // ~30 ms
      spawnedTurn: (input) =>
        new Promise<DreamTurnResult>((resolve) => {
          const finish = (): void =>
            resolve({
              success: false,
              error: "interrupted",
              aborted: input.signal.aborted,
              usage: EMPTY_PARTS,
            });
          if (input.signal.aborted) finish();
          else input.signal.addEventListener("abort", finish, { once: true });
        }),
    });
    const result = await executeDreamRun(RUN_INPUT, harness.deps);
    expect(result.outcome).toBe("timeout");
    expect(harness.rollbacks).toHaveLength(1);
    expect(harness.rollbacks[0]?.baselineSha).toContain("baseline-run-1");
    expect(harness.metadata.at(-1)?.status).toBe("timeout");
    expect(harness.markers.map((marker) => marker.outcome)).toEqual([
      "timeout",
    ]);
    expect(harness.finished).toEqual(["agent-a:timeout"]);
    expect(result.error).toContain("time limit");
  });

  test("a failed rollback becomes a visible failure and keeps the lease for repair", async () => {
    const harness = makeHarness({
      settings: makeSettings({ timeLimitMinutes: 0.0005 }),
      spawnedTurn: (input) =>
        new Promise<DreamTurnResult>((resolve) => {
          const finish = (): void =>
            resolve({
              success: false,
              aborted: input.signal.aborted,
              usage: EMPTY_PARTS,
            });
          if (input.signal.aborted) finish();
          else input.signal.addEventListener("abort", finish, { once: true });
        }),
      overrides: {
        rollbackBaseline: async () => {
          throw new Error("repo corrupt");
        },
      },
    });
    const result = await executeDreamRun(RUN_INPUT, harness.deps);
    expect(result.outcome).toBe("failed");
    expect(harness.metadata.at(-1)?.status).toBe("failed");
    expect(harness.reports[0]?.body).toContain("rollback: FAILED");
    expect(harness.deletedLeases).toBe(0);
    expect(harness.released).toEqual({ dream: 1, memory: 1 });
  });
});

describe("executeDreamRun · failure classes", () => {
  test("an unconfigured dream is F1 (throws the typed preflight error)", async () => {
    const harness = makeHarness({
      settings: makeSettings({ enabled: false }),
    });
    await expect(executeDreamRun(RUN_INPUT, harness.deps)).rejects.toThrow(
      ScheduledTaskPreflightError,
    );
    expect(harness.events).toHaveLength(0);
  });

  test("a malformed payload is F1, never a guessed budget", async () => {
    const harness = makeHarness();
    await expect(
      executeDreamRun(
        { ...RUN_INPUT, task: makeTask("not-json") },
        harness.deps,
      ),
    ).rejects.toThrow(ScheduledTaskPreflightError);
  });

  test("no enabled tier is F1", async () => {
    const harness = makeHarness({
      settings: makeSettings({
        tiers: { tidy: false, think: false, task: false, wander: false },
      }),
    });
    await expect(executeDreamRun(RUN_INPUT, harness.deps)).rejects.toThrow(
      ScheduledTaskPreflightError,
    );
  });

  test("a busy dream lock is F3 skip, not a failure", async () => {
    const harness = makeHarness({ dreamLockBusy: true });
    const result = await executeDreamRun(RUN_INPUT, harness.deps);
    expect(result.outcome).toBe("skipped");
    expect(harness.released).toEqual({ dream: 0, memory: 0 });
    expect(harness.metadata).toHaveLength(0);
  });

  test("a busy memory lock is F3 skip and releases the dream lock", async () => {
    const harness = makeHarness({ memoryLockBusy: true });
    const result = await executeDreamRun(RUN_INPUT, harness.deps);
    expect(result.outcome).toBe("skipped");
    expect(harness.released).toEqual({ dream: 1, memory: 0 });
  });

  test("a baseline failure is F1 and releases both locks", async () => {
    const harness = makeHarness({
      overrides: {
        createBaseline: async () => {
          throw new Error("no git");
        },
      },
    });
    await expect(executeDreamRun(RUN_INPUT, harness.deps)).rejects.toThrow(
      ScheduledTaskPreflightError,
    );
    expect(harness.released).toEqual({ dream: 1, memory: 1 });
    expect(harness.metadata).toHaveLength(0);
  });

  test("a session failure is F1", async () => {
    const harness = makeHarness({
      overrides: {
        createSession: async () => {
          throw new Error("backend down");
        },
      },
    });
    await expect(executeDreamRun(RUN_INPUT, harness.deps)).rejects.toThrow(
      ScheduledTaskPreflightError,
    );
  });

  test("a child failure after the first turn is F2, not a preflight error", async () => {
    let calls = 0;
    const harness = makeHarness({
      spawnedTurn: (_input) => {
        calls += 1;
        if (calls === 1) {
          return {
            success: true,
            report: "first tier",
            aborted: false,
            usage: EMPTY_PARTS,
          };
        }
        return {
          success: false,
          error: "model exploded",
          aborted: false,
          usage: EMPTY_PARTS,
        };
      },
    });
    const result = await executeDreamRun(RUN_INPUT, harness.deps);
    expect(result.outcome).toBe("failed");
    expect(result.error).toContain("model exploded");
    expect(harness.metadata.at(-1)?.status).toBe("failed");
    expect(harness.markers.map((marker) => marker.outcome)).toEqual(["failed"]);
    // A generic failure keeps already-committed work (no rollback).
    expect(harness.rollbacks).toHaveLength(0);
  });

  test("a first-turn spawn failure is F1", async () => {
    const harness = makeHarness({
      overrides: {
        spawnTurn: async () => {
          throw new Error("spawn exploded");
        },
      },
    });
    await expect(executeDreamRun(RUN_INPUT, harness.deps)).rejects.toThrow(
      ScheduledTaskPreflightError,
    );
    expect(harness.released).toEqual({ dream: 1, memory: 1 });
  });
});
