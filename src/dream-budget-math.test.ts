/**
 * Dream budget math (F-06 O-1 ruling, 2026-10-30).
 *
 * The two formulas are the user's, so the tests pin the exact arithmetic:
 * pressure discounts cache reads by 1/1000 and takes the maximum; budget
 * discounts them by 1/200 and sums. A change to either weight is a policy
 * change and must fail here first.
 */
import { describe, expect, test } from "bun:test";
import {
  computeDreamBudgetTokens,
  computeDreamPressure,
  hasReachedDreamPressure,
  resolveDreamBudgetTokens,
} from "@/dream-budget-math";

describe("computeDreamPressure", () => {
  test("takes the maximum of the three weighted classes", () => {
    expect(
      computeDreamPressure({
        outputTokens: 1_000,
        uncachedReadTokens: 100_000,
        cachedReadTokens: 1_000_000,
      }),
    ).toBe(25_000);
    expect(
      computeDreamPressure({
        outputTokens: 80_000,
        uncachedReadTokens: 100_000,
        cachedReadTokens: 1_000_000,
      }),
    ).toBe(80_000);
    expect(
      computeDreamPressure({
        outputTokens: 10,
        uncachedReadTokens: 100,
        cachedReadTokens: 90_000,
      }),
    ).toBe(90);
  });

  test("treats missing or unusable parts as zero", () => {
    expect(
      computeDreamPressure({
        outputTokens: -5,
        uncachedReadTokens: Number.NaN,
        cachedReadTokens: 2_000,
      }),
    ).toBe(2);
    expect(
      computeDreamPressure({
        outputTokens: 0,
        uncachedReadTokens: 0,
        cachedReadTokens: 0,
      }),
    ).toBe(0);
  });

  test("keeps fractions so the threshold comparison is not rounded early", () => {
    // 299,999 uncached / 4 = 74,999.75: below the default 75,000 threshold.
    expect(
      computeDreamPressure({
        outputTokens: 0,
        uncachedReadTokens: 299_999,
        cachedReadTokens: 0,
      }),
    ).toBeCloseTo(74_999.75, 6);
  });
});

describe("computeDreamBudgetTokens", () => {
  test("sums output + uncachedRead/4 + cachedRead/200, floored", () => {
    expect(
      computeDreamBudgetTokens({
        outputTokens: 1_000,
        uncachedReadTokens: 100_000,
        cachedReadTokens: 1_000_000,
      }),
    ).toBe(31_000);
    expect(
      computeDreamBudgetTokens({
        outputTokens: 0,
        uncachedReadTokens: 3,
        cachedReadTokens: 0,
      }),
    ).toBe(0);
  });
});

describe("resolveDreamBudgetTokens", () => {
  test("is min(pressure * factor, maxPerRun)", () => {
    expect(
      resolveDreamBudgetTokens({
        pressure: 100_000,
        factor: 0.8,
        maxPerRun: 100_000,
      }),
    ).toBe(80_000);
    expect(
      resolveDreamBudgetTokens({
        pressure: 1_000_000,
        factor: 0.8,
        maxPerRun: 100_000,
      }),
    ).toBe(100_000);
  });

  test("a manual override replaces the computed allowance", () => {
    expect(
      resolveDreamBudgetTokens({
        pressure: 100_000,
        factor: 0.8,
        maxPerRun: 100_000,
        overrideTokens: 5_000,
      }),
    ).toBe(5_000);
    // An unusable override falls back to the computed allowance, not to zero.
    expect(
      resolveDreamBudgetTokens({
        pressure: 100_000,
        factor: 0.8,
        maxPerRun: 100_000,
        overrideTokens: Number.NaN,
      }),
    ).toBe(80_000);
  });

  test("never returns a negative allowance", () => {
    expect(
      resolveDreamBudgetTokens({
        pressure: -1,
        factor: 0.8,
        maxPerRun: 100_000,
      }),
    ).toBe(0);
    expect(
      resolveDreamBudgetTokens({
        pressure: 100_000,
        factor: Number.NaN,
        maxPerRun: 100_000,
      }),
    ).toBe(0);
  });
});

describe("hasReachedDreamPressure", () => {
  test("compares against the configured threshold", () => {
    expect(hasReachedDreamPressure(74_999, 75_000)).toBe(false);
    expect(hasReachedDreamPressure(75_000, 75_000)).toBe(true);
    expect(hasReachedDreamPressure(75_001, 75_000)).toBe(true);
  });

  test("an invalid threshold never fires the gate", () => {
    expect(hasReachedDreamPressure(1_000_000, 0)).toBe(false);
    expect(hasReachedDreamPressure(1_000_000, -1)).toBe(false);
    expect(hasReachedDreamPressure(1_000_000, Number.NaN)).toBe(false);
  });
});
