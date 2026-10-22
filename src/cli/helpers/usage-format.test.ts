import { describe, expect, test } from "bun:test";
import {
  COST_DECIMALS,
  CURRENCY,
  DETAIL_COST_DECIMALS,
  formatCost,
  formatCostAmount,
  formatPercent,
  formatRate,
  UNKNOWN_VALUE,
} from "./usage-format";

describe("formatCost", () => {
  test("prints dollars with two decimals", () => {
    expect(formatCost(12.4)).toBe("$ 12.40");
    expect(formatCost(0.82)).toBe("$ 0.82");
    expect(formatCost(0)).toBe("$ 0.00");
  });

  test("a sub-cent amount is not rounded into a false zero", () => {
    // The common case: one turn costs a fraction of a cent.
    expect(formatCost(0.00042)).toBe("$ <0.01");
    expect(formatCost(0.0049)).toBe("$ <0.01");
    // At the smallest digit it is a real number again.
    expect(formatCost(0.005)).toBe("$ 0.01");
  });

  test("the detail screen's five decimals resolve the small amounts", () => {
    expect(formatCost(1, DETAIL_COST_DECIMALS)).toBe("$ 1.00000");
    expect(formatCost(0.00042, DETAIL_COST_DECIMALS)).toBe("$ 0.00042");
    // Even there the false-zero guard holds.
    expect(formatCost(0.0000001, DETAIL_COST_DECIMALS)).toBe("$ <0.00001");
  });

  test("an unpriced model is a dash, not a zero", () => {
    expect(formatCost(undefined)).toBe(UNKNOWN_VALUE);
    expect(formatCost(Number.NaN)).toBe(UNKNOWN_VALUE);
  });

  test("the amount alone drops the currency mark", () => {
    expect(formatCostAmount(1.5)).toBe("1.50");
    expect(formatCostAmount(1.5, DETAIL_COST_DECIMALS)).toBe("1.50000");
    expect(formatCostAmount(undefined)).toBe(UNKNOWN_VALUE);
  });

  test("the constants the screens share", () => {
    expect(CURRENCY).toBe("$");
    expect(COST_DECIMALS).toBe(2);
    expect(DETAIL_COST_DECIMALS).toBe(5);
  });
});

describe("formatPercent", () => {
  test("two decimals, the detail screen's contract", () => {
    expect(formatPercent(65.34, 100)).toBe("65.34%");
    expect(formatPercent(1, 3)).toBe("33.33%");
    expect(formatPercent(0, 10)).toBe("0.00%");
  });

  test("a zero denominator is unknown, not 0%", () => {
    expect(formatPercent(0, 0)).toBe(UNKNOWN_VALUE);
    expect(formatPercent(5, 0)).toBe(UNKNOWN_VALUE);
  });
});

describe("formatRate", () => {
  test("two decimals, the same as every other percentage", () => {
    expect(formatRate(0.78)).toBe("78.00%");
    expect(formatRate(0.65625)).toBe("65.63%");
    expect(formatRate(0)).toBe("0.00%");
  });

  test("an unknown rate is a dash", () => {
    expect(formatRate(undefined)).toBe(UNKNOWN_VALUE);
  });
});
