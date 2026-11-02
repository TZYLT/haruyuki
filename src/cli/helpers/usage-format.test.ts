import { describe, expect, test } from "bun:test";
import {
  COST_DECIMALS,
  CURRENCY,
  costColumnWidth,
  DETAIL_COST_DECIMALS,
  DETAIL_COST_MIN_WIDTH,
  formatCost,
  formatCostAmount,
  formatEstimatedCompact,
  formatEstimatedPercent,
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

  test("two decimals is the hit-rate contract the rail and the page share", () => {
    // R-05.9 / R-06.4: `hit%` is the only percentage that keeps two decimals.
    expect(formatRate(1 / 6)).toBe("16.67%");
    expect(formatRate(0.9999)).toBe("99.99%");
  });
});

describe("formatEstimatedCompact", () => {
  test("marks the estimate and keeps the compact magnitude", () => {
    expect(formatEstimatedCompact(20_000)).toBe("~20k");
    expect(formatEstimatedCompact(8_000)).toBe("~8k");
    expect(formatEstimatedCompact(31_500)).toBe("~32k");
    expect(formatEstimatedCompact(999)).toBe("~999");
  });

  test("an impossible count is unknown, not a negative estimate", () => {
    expect(formatEstimatedCompact(-5)).toBe("~0"); // clamped, not `~-5`
    expect(formatEstimatedCompact(Number.NaN)).toBe(UNKNOWN_VALUE);
    expect(formatEstimatedCompact(Number.POSITIVE_INFINITY)).toBe(
      UNKNOWN_VALUE,
    );
  });
});

describe("formatEstimatedPercent", () => {
  test("marks the estimate, whole percent", () => {
    expect(formatEstimatedPercent(0.43)).toBe("~43%");
    expect(formatEstimatedPercent(0.0952)).toBe("~10%");
    expect(formatEstimatedPercent(0)).toBe("~0%");
  });

  test("an old ledger row may exceed 100% and is reported as it is", () => {
    // R-05.7 / Q-30: no clamping to 100 — the shares are what the stored
    // components and the provider total say, even when they disagree.
    expect(formatEstimatedPercent(1.24)).toBe("~124%");
    expect(formatEstimatedPercent(0.62)).toBe("~62%");
  });

  test("a non-finite ratio is unknown and a negative one cannot be a share", () => {
    expect(formatEstimatedPercent(Number.NaN)).toBe(UNKNOWN_VALUE);
    expect(formatEstimatedPercent(-0.2)).toBe("~0%");
  });
});

describe("costColumnWidth", () => {
  test("is never narrower than the eleven columns of a five-decimal cost", () => {
    expect(DETAIL_COST_MIN_WIDTH).toBe(11);
    expect(costColumnWidth([])).toBe(11);
    expect(costColumnWidth(["$ 0.50000", "—"])).toBe(11);
  });

  test("grows to the widest formatted cell instead of assuming eleven", () => {
    // R-05.9: the old `padStart(11)` silently shifted every column after cost.
    expect(costColumnWidth(["$ 1234.50000"])).toBe(12);
    expect(costColumnWidth(["$ 123456.50000"])).toBe(14);
    // The caller may ask for a wider floor (e.g. a right-aligned header).
    expect(costColumnWidth(["$ 0.50000"], 13)).toBe(13);
  });
});
