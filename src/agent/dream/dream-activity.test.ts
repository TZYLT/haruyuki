/**
 * F-06 M2 · S2 user-activity markers (requirement R-5.8.2).
 *
 * The contract is "cheap, synchronous, never breaks the caller". These tests
 * pin the storage round-trip, the monotonic-stamp guard, the dispatch-time
 * semantic (only a model request counts), the in-flight window that keeps a
 * long turn active, and the come-back comparison the run controller uses.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DREAM_TURN_IN_FLIGHT_STALE_MS,
  finishDreamTurn,
  getDreamActivityPath,
  hasDreamActivitySince,
  markDreamActivity,
  markDreamTurnInFlight,
  readDreamActivity,
  shouldRecordDreamActivity,
} from "@/agent/dream/dream-activity";

const previousHaruyukiHome = process.env.HARUYUKI_HOME;
const root = mkdtempSync(join(tmpdir(), "hryk-dream-activity-"));
process.env.HARUYUKI_HOME = root;

afterAll(() => {
  if (previousHaruyukiHome === undefined) delete process.env.HARUYUKI_HOME;
  else process.env.HARUYUKI_HOME = previousHaruyukiHome;
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(join(root, "dream"), { recursive: true, force: true });
});

function writeRawRecord(
  agentId: string,
  record: Record<string, unknown>,
): void {
  const path = getDreamActivityPath(agentId);
  mkdirSync(join(root, "dream", "activity"), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record)}\n`);
}

describe("dream activity markers", () => {
  test("a missing marker reads as null", () => {
    expect(readDreamActivity("agent-a")).toBeNull();
  });

  test("mark then read round-trips the timestamp", () => {
    markDreamActivity("agent-a", 1_700_000_000_000);
    expect(readDreamActivity("agent-a")).toBe(1_700_000_000_000);
  });

  test("a later stamp wins, an earlier one does not rewrite", () => {
    markDreamActivity("agent-a", 2_000);
    markDreamActivity("agent-a", 1_000);
    expect(readDreamActivity("agent-a")).toBe(2_000);
    markDreamActivity("agent-a", 3_000);
    expect(readDreamActivity("agent-a")).toBe(3_000);
  });

  test("agents are isolated from each other", () => {
    markDreamActivity("agent-a", 1_000);
    expect(readDreamActivity("agent-b")).toBeNull();
  });

  test("invalid input is ignored instead of throwing", () => {
    expect(() => markDreamActivity("", 1_000)).not.toThrow();
    expect(() => markDreamActivity("agent-a", Number.NaN)).not.toThrow();
    expect(readDreamActivity("agent-a")).toBeNull();
  });

  test("hasDreamActivitySince compares the way the run controller needs", () => {
    const runStartedAt = 10_000;
    expect(hasDreamActivitySince("agent-a", runStartedAt)).toBe(false);
    markDreamActivity("agent-a", 9_999);
    expect(hasDreamActivitySince("agent-a", runStartedAt)).toBe(false);
    markDreamActivity("agent-a", 10_000);
    expect(hasDreamActivitySince("agent-a", runStartedAt)).toBe(true);
  });

  test("a legacy version-1 record still reads", () => {
    writeRawRecord("agent-a", {
      version: 1,
      agentId: "agent-a",
      lastActiveAt: 12_345,
    });
    expect(readDreamActivity("agent-a")).toBe(12_345);
  });

  test("the marker lives under the configured harness home", () => {
    markDreamActivity("agent/a", 5_000);
    // Unsafe filename characters are folded, not used as path separators.
    expect(getDreamActivityPath("agent/a")).toContain(
      join(root, "dream", "activity"),
    );
    expect(getDreamActivityPath("agent/a")).not.toContain("agent/a");
    expect(readDreamActivity("agent/a")).toBe(5_000);
  });
});

describe("an in-flight turn keeps the silence window open", () => {
  test("a dispatched request reads as activity now, even if the stamp is old", () => {
    const runStartedAt = Date.now() - 60 * 60_000;
    markDreamActivity("agent-a", runStartedAt - 60_000);
    markDreamTurnInFlight("agent-a");
    // The old request is before the run start; the live turn must still count.
    expect(hasDreamActivitySince("agent-a", runStartedAt)).toBe(true);
    expect(readDreamActivity("agent-a")).toBeGreaterThanOrEqual(
      Date.now() - 1_000,
    );
  });

  test("finishing the turn falls back to the request/end stamp", () => {
    markDreamTurnInFlight("agent-a", 1_000);
    finishDreamTurn("agent-a", 2_000);
    expect(readDreamActivity("agent-a")).toBe(2_000);
    // No longer in flight: a much later `since` is not satisfied.
    expect(hasDreamActivitySince("agent-a", 2_001)).toBe(false);
  });

  test("overlapping requests keep the marker until the last one finishes", async () => {
    markDreamTurnInFlight("agent-a");
    markDreamTurnInFlight("agent-a");
    finishDreamTurn("agent-a");
    const whileOneStillRuns = readDreamActivity("agent-a");
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Still in flight: the answer tracks "now".
    expect(readDreamActivity("agent-a")).toBeGreaterThan(
      whileOneStillRuns as number,
    );

    finishDreamTurn("agent-a");
    const settled = readDreamActivity("agent-a");
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The last request finished: a fixed stamp, not moving "now".
    expect(readDreamActivity("agent-a")).toBe(settled);
  });

  test("a stale in-flight marker stops counting", () => {
    const old = Date.now() - DREAM_TURN_IN_FLIGHT_STALE_MS - 60_000;
    markDreamTurnInFlight("agent-a", old);
    expect(readDreamActivity("agent-a")).toBe(old);
    expect(hasDreamActivitySince("agent-a", old + 1)).toBe(false);
  });

  test("a dead owner's in-flight marker stops counting", () => {
    writeRawRecord("agent-a", {
      version: 2,
      agentId: "agent-a",
      lastActiveAt: 4_000,
      // A pid that cannot exist on any platform: liveness must fail closed.
      inFlight: { pid: Number.MAX_SAFE_INTEGER, startedAt: Date.now() },
    });
    expect(readDreamActivity("agent-a")).toBe(4_000);
  });

  test("marking activity directly preserves a live in-flight turn", () => {
    const now = Date.now();
    markDreamTurnInFlight("agent-a", now);
    markDreamActivity("agent-a", now - 1_000);
    expect(hasDreamActivitySince("agent-a", now - 500)).toBe(true);
  });
});

describe("turn-source classification (who may stamp the clock)", () => {
  test("an ordinary interactive turn records activity", () => {
    expect(shouldRecordDreamActivity({})).toBe(true);
    expect(
      shouldRecordDreamActivity({
        dreamRun: false,
        agentRole: null,
        automatedUsageSource: null,
        automatedTurn: false,
      }),
    ).toBe(true);
  });

  test("a dream run's own turn never counts", () => {
    expect(shouldRecordDreamActivity({ dreamRun: true })).toBe(false);
  });

  test("a subagent child (reflection/dream/scheduled) never counts", () => {
    expect(shouldRecordDreamActivity({ agentRole: "subagent" })).toBe(false);
    expect(
      shouldRecordDreamActivity({ automatedUsageSource: "reflection" }),
    ).toBe(false);
    expect(shouldRecordDreamActivity({ automatedUsageSource: "dream" })).toBe(
      false,
    );
    expect(shouldRecordDreamActivity({ automatedUsageSource: "cron" })).toBe(
      false,
    );
  });

  test("a scheduler/task-notification turn in the interactive process never counts", () => {
    expect(shouldRecordDreamActivity({ automatedTurn: true })).toBe(false);
  });
});
