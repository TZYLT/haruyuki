import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recallIndexPath } from "@/backend/local/recall-index";
import {
  recordRecallDecision,
  resetRecallRuntime,
} from "@/reminders/recall-runtime";
import {
  collectRecallStatus,
  formatRecallStatus,
  type RecallStatusReport,
} from "@/reminders/recall-status";
import { settingsManager } from "@/settings-manager";
import { withRecallFixture } from "@/test-utils/recall-fixture";

/**
 * `/recall status`'s two halves: what it says, and whether the numbers behind it
 * are real. The copy is pure; the counts come from the same loader a turn uses,
 * with maintenance off, so the second half runs against the shared fixture.
 */

const originalHome = process.env.HOME;
let testHomeDir: string;

beforeEach(async () => {
  resetRecallRuntime();
  await settingsManager.reset();
  testHomeDir = await mkdtemp(join(tmpdir(), "haru-recall-status-"));
  process.env.HOME = testHomeDir;
});

afterEach(async () => {
  resetRecallRuntime();
  await settingsManager.reset();
  await rm(testHomeDir, { recursive: true, force: true });
  process.env.HOME = originalHome;
});

function report(
  overrides: Partial<RecallStatusReport> = {},
): RecallStatusReport {
  return {
    enabled: true,
    tripped: false,
    consecutiveFailures: 0,
    lastFailureReason: null,
    lastDecision: null,
    settings: {
      enabled: true,
      timeoutMs: 1000,
      dedupTurns: 10,
      limit: 3,
      excerptCharacters: 400,
      totalCharacters: 1200,
      minScoreRatio: 0.35,
      diversity: "none",
      excerptLines: 2,
      display: "summary",
    },
    index: {
      conversations: 4,
      ready: 3,
      stale: 0,
      missing: 1,
      exempt: 0,
      records: 120,
      missingKeys: ["conv-missing"],
    },
    ...overrides,
  };
}

describe("the status copy", () => {
  test("answers the six questions in order", () => {
    const lines = formatRecallStatus(report());
    expect(lines[0]).toBe("Recall: on");
    expect(lines[1]).toContain("Breaker: healthy");
    expect(lines[1]).toContain("0 consecutive failures");
    expect(lines[2]).toContain("Settings: limit 3");
    expect(lines[2]).toContain("timeout 1000ms");
    expect(lines[2]).toContain("display summary");
    expect(lines[3]).toContain("3/4 conversations indexed");
    expect(lines[3]).toContain("120 records");
    expect(lines[3]).toContain("1 without an index");
    // The one actionable line: what to do about the gap.
    expect(lines[4]).toContain("/recall build");
  });

  test("a trip names the count and how to undo it", () => {
    const lines = formatRecallStatus(
      report({
        tripped: true,
        consecutiveFailures: 3,
        lastFailureReason: "the recall deadline expired",
      }),
    );
    const breaker = lines.find((line) => line.startsWith("Breaker:")) ?? "";
    expect(breaker).toContain("tripped after 3 consecutive failures");
    expect(breaker).toContain("the recall deadline expired");
    expect(breaker).toContain("/recall on");
  });

  test("says nothing about a timeout it did not have", () => {
    const lines = formatRecallStatus(
      report({
        lastDecision: { status: "injected", entries: 2, timedOut: false },
      }),
    );
    const last = lines.find((line) => line.startsWith("Last turn:")) ?? "";
    expect(last).toBe("Last turn: injected (2 passages)");
  });

  test("a cut-short turn says so", () => {
    const lines = formatRecallStatus(
      report({
        lastDecision: { status: "no-match", entries: 0, timedOut: true },
      }),
    );
    const last = lines.find((line) => line.startsWith("Last turn:")) ?? "";
    expect(last).toContain("no-match");
    expect(last).toContain("cut short by the deadline");
  });

  test("timeout 0 reads as 'none', not as '0ms'", () => {
    const lines = formatRecallStatus(
      report({ settings: { ...report().settings, timeoutMs: 0 } }),
    );
    expect(lines[2]).toContain("timeout none");
  });

  test("an off feature still reports its parameters and its index", () => {
    const lines = formatRecallStatus(report({ enabled: false }));
    expect(lines[0]).toBe("Recall: off");
    expect(lines.some((line) => line.includes("Settings:"))).toBe(true);
  });

  test("a store with nothing in scope does not read as 0/0 coverage", () => {
    const lines = formatRecallStatus(
      report({
        index: {
          conversations: 0,
          ready: 0,
          stale: 0,
          missing: 0,
          exempt: 0,
          records: 0,
          missingKeys: [],
        },
      }),
    );
    expect(lines[3]).toContain("no conversations in scope");
    expect(lines.some((line) => line.includes("/recall build"))).toBe(false);
  });
});

describe("the status numbers", () => {
  test("counts the fixture's own index as ready", async () => {
    await withRecallFixture(async (fixture) => {
      const collected = collectRecallStatus({
        storageDir: fixture.storageDir,
        agentId: fixture.agentId,
      });

      expect(collected.enabled).toBe(true);
      expect(collected.tripped).toBe(false);
      expect(collected.index.conversations).toBeGreaterThanOrEqual(2);
      expect(collected.index.missing).toBe(0);
      expect(collected.index.records).toBeGreaterThan(0);
      expect(collected.index.missingKeys).toEqual([]);
    });
  });

  test("a removed sidecar shows up as a missing index, and is not rebuilt", async () => {
    await withRecallFixture(async (fixture) => {
      const historyDir = join(
        fixture.storageDir,
        "conversations",
        fixture.historyDirectory,
      );
      rmSync(recallIndexPath(historyDir), { force: true });

      const collected = collectRecallStatus({
        storageDir: fixture.storageDir,
        agentId: fixture.agentId,
      });
      expect(collected.index.missing).toBe(1);
      expect(collected.index.missingKeys).toEqual([fixture.historyDirectory]);

      // Asking for status must not write: the loader ran with maintenance off.
      const again = collectRecallStatus({
        storageDir: fixture.storageDir,
        agentId: fixture.agentId,
      });
      expect(again.index.missing).toBe(1);
    });
  });

  test("reports the breaker and the last decision from the runtime", async () => {
    await withRecallFixture(async (fixture) => {
      recordRecallDecision({
        entries: [],
        status: "failed",
        reason: "store unreadable",
        diagnostics: { threshold: 0, candidates: 0, sources: [] },
      });

      const collected = collectRecallStatus({
        storageDir: fixture.storageDir,
        agentId: fixture.agentId,
      });
      expect(collected.consecutiveFailures).toBe(1);
      expect(collected.lastFailureReason).toBe("store unreadable");
      expect(collected.lastDecision).toEqual({
        status: "failed",
        entries: 0,
        timedOut: false,
      });
    });
  });

  test("follows the settings the rest of the app writes", async () => {
    await settingsManager.initialize();
    settingsManager.updateSettings({ recallLimit: 9, recallDisplay: "full" });

    await withRecallFixture(async (fixture) => {
      const collected = collectRecallStatus({
        storageDir: fixture.storageDir,
        agentId: fixture.agentId,
      });
      expect(collected.settings.limit).toBe(9);
      expect(collected.settings.display).toBe("full");
      expect(formatRecallStatus(collected).join("\n")).toContain("limit 9");
    });
  });
});
