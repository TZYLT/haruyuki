/**
 * F-06 M2 · run-level budget accounting (requirement R-5.3, O-1 numbers).
 *
 * The tests pin the three behaviours the run controller relies on:
 * 40/80/100 reminders fire once each, the hard stop compares weighted spend
 * against the allowance, and the one pre-approved +50 % extension can rescue a
 * run that is between 100 % and 150 % — but never more.
 */
import { describe, expect, test } from "bun:test";
import {
  buildDreamBudgetReminder,
  DREAM_BUDGET_THRESHOLDS,
  DreamBudgetTracker,
  describeDreamBudgetStop,
  resolveDreamRunBudgetTokens,
} from "@/agent/dream/dream-budget";
import { DREAM_SETTINGS_DEFAULTS } from "@/dream-settings";

const EMPTY_PARTS = {
  outputTokens: 0,
  uncachedReadTokens: 0,
  cachedReadTokens: 0,
};

describe("resolveDreamRunBudgetTokens", () => {
  test("min(pressure x factor, maxPerRun) with the routing settings", () => {
    expect(
      resolveDreamRunBudgetTokens({
        settings: {
          ...DREAM_SETTINGS_DEFAULTS,
          budgetFactor: 0.8,
          maxPerRun: 100_000,
        },
        pressure: 75_000,
      }),
    ).toBe(60_000);
  });

  test("the per-run cap wins over a huge pressure", () => {
    expect(
      resolveDreamRunBudgetTokens({
        settings: DREAM_SETTINGS_DEFAULTS,
        pressure: 10_000_000,
      }),
    ).toBe(DREAM_SETTINGS_DEFAULTS.maxPerRun);
  });

  test("a manual override replaces the computed allowance", () => {
    expect(
      resolveDreamRunBudgetTokens({
        settings: DREAM_SETTINGS_DEFAULTS,
        pressure: 0,
        overrideTokens: 80_000,
      }),
    ).toBe(80_000);
  });
});

describe("DreamBudgetTracker thresholds", () => {
  test("40/80/100 each cross exactly once", () => {
    const tracker = new DreamBudgetTracker({
      budgetTokens: 100_000,
      overBudgetApprovals: 0,
    });
    const crossed: number[] = [];
    // 39 % -> nothing.
    crossed.push(
      ...tracker
        .addTurn({ ...EMPTY_PARTS, outputTokens: 39_000 })
        .map((entry) => entry.threshold),
    );
    expect(crossed).toEqual([]);
    // 41 % -> 40 only.
    crossed.push(
      ...tracker
        .addTurn({ ...EMPTY_PARTS, outputTokens: 2_000 })
        .map((entry) => entry.threshold),
    );
    expect(crossed).toEqual([0.4]);
    // 81 % -> 80 only.
    crossed.push(
      ...tracker
        .addTurn({ ...EMPTY_PARTS, outputTokens: 40_000 })
        .map((entry) => entry.threshold),
    );
    expect(crossed).toEqual([0.4, 0.8]);
    // 101 % -> 100 only.
    crossed.push(
      ...tracker
        .addTurn({ ...EMPTY_PARTS, outputTokens: 20_000 })
        .map((entry) => entry.threshold),
    );
    expect(crossed).toEqual([0.4, 0.8, 1]);
    expect(DREAM_BUDGET_THRESHOLDS).toEqual([0.4, 0.8, 1]);
  });

  test("cache reads are weighted, not counted raw", () => {
    const tracker = new DreamBudgetTracker({
      budgetTokens: 1_000,
      overBudgetApprovals: 0,
    });
    // 200,000 cached read tokens weigh 1/200 => 1,000 budget tokens.
    tracker.addTurn({ ...EMPTY_PARTS, cachedReadTokens: 200_000 });
    expect(tracker.spentTokens).toBe(1_000);
    expect(tracker.isExhausted()).toBe(true);
  });

  test("zero allowance always stops (a run with no pressure has no budget)", () => {
    const tracker = new DreamBudgetTracker({
      budgetTokens: 0,
      overBudgetApprovals: 1,
    });
    expect(tracker.isExhausted()).toBe(true);
  });
});

describe("DreamBudgetTracker extension", () => {
  test("one +50% extension rescues a run below 150%", () => {
    const tracker = new DreamBudgetTracker({
      budgetTokens: 1_000,
      overBudgetApprovals: 1,
    });
    tracker.addTurn({ ...EMPTY_PARTS, outputTokens: 1_200 });
    expect(tracker.isExhausted()).toBe(true);
    expect(tracker.requestExtension()).toBe(true);
    expect(tracker.allowanceTokens).toBe(1_500);
    expect(tracker.isExhausted()).toBe(false);
    // The approval is once-only.
    tracker.addTurn({ ...EMPTY_PARTS, outputTokens: 400 });
    expect(tracker.isExhausted()).toBe(true);
    expect(tracker.requestExtension()).toBe(false);
  });

  test("no extension is granted when the config allows none", () => {
    const tracker = new DreamBudgetTracker({
      budgetTokens: 100,
      overBudgetApprovals: 0,
    });
    tracker.addTurn({ ...EMPTY_PARTS, outputTokens: 150 });
    expect(tracker.requestExtension()).toBe(false);
  });
});

describe("reminder text", () => {
  test("40% reminder names the ratio and the tier, and stays a user reminder", () => {
    const tracker = new DreamBudgetTracker({
      budgetTokens: 10_000,
      overBudgetApprovals: 1,
    });
    const [crossing] = tracker.addTurn({ ...EMPTY_PARTS, outputTokens: 4_500 });
    expect(crossing).toBeDefined();
    const text = buildDreamBudgetReminder({
      crossing: crossing ?? {
        threshold: 0.4,
        ratio: 0.45,
        spentTokens: 4_500,
        budgetTokens: 10_000,
      },
      allowanceTokens: tracker.allowanceTokens,
      tier: "think",
    });
    expect(text.startsWith("<system-reminder>")).toBe(true);
    expect(text.endsWith("</system-reminder>")).toBe(true);
    expect(text).toContain("40%");
    expect(text).toContain("think");
  });

  test("100% reminder tells the unattended agent to hand off without asking", () => {
    const text = buildDreamBudgetReminder({
      crossing: {
        threshold: 1,
        ratio: 1.01,
        spentTokens: 10_100,
        budgetTokens: 10_000,
      },
      allowanceTokens: 10_000,
    });
    expect(text).toContain("budget reached");
    expect(text).toContain("do not ask for approval");
    expect(text).toContain("handoff");
  });

  test("the stop description says what was and was not reached", () => {
    const tracker = new DreamBudgetTracker({
      budgetTokens: 10_000,
      overBudgetApprovals: 1,
    });
    tracker.addTurn({ ...EMPTY_PARTS, outputTokens: 11_000 });
    const text = describeDreamBudgetStop(tracker, "tidy");
    expect(text).toContain("Budget exhausted");
    expect(text).toContain("tidy");
  });
});
