import { describe, expect, test } from "bun:test";
import {
  formatCost,
  formatCostAmount,
  formatGrouped,
  formatPercent,
  formatRate,
  UNKNOWN_VALUE,
} from "./cost";

describe("formatCost", () => {
  test("prints yuan with two decimals", () => {
    expect(formatCost(12.4)).toBe("¥ 12.40");
    expect(formatCost(0.82)).toBe("¥ 0.82");
  });

  test("an unpriced model is a dash, not a zero", () => {
    expect(formatCost(undefined)).toBe(UNKNOWN_VALUE);
    expect(formatCost(Number.NaN)).toBe(UNKNOWN_VALUE);
  });

  test("the amount alone drops the currency mark", () => {
    expect(formatCostAmount(1.5)).toBe("1.50");
    expect(formatCostAmount(undefined)).toBe(UNKNOWN_VALUE);
  });
});

describe("formatPercent", () => {
  test("always one decimal", () => {
    expect(formatPercent(65.34, 100)).toBe("65.3%");
    expect(formatPercent(1, 3)).toBe("33.3%");
    expect(formatPercent(0, 10)).toBe("0.0%");
  });

  test("a zero denominator is unknown, not 0%", () => {
    expect(formatPercent(0, 0)).toBe(UNKNOWN_VALUE);
    expect(formatPercent(5, 0)).toBe(UNKNOWN_VALUE);
  });
});

describe("formatRate", () => {
  test("whole percent for the overview", () => {
    expect(formatRate(0.78)).toBe("78%");
    expect(formatRate(0)).toBe("0%");
  });

  test("an unknown rate is a dash", () => {
    expect(formatRate(undefined)).toBe(UNKNOWN_VALUE);
  });
});

describe("formatGrouped", () => {
  test("groups thousands for readability", () => {
    expect(formatGrouped(1258291)).toBe("1,258,291");
    expect(formatGrouped(42)).toBe("42");
  });
});
