import { describe, expect, test } from "bun:test";
import { addUsageCost, emptyUsageCost, isZeroUsageCost } from "./usage-cost";

describe("usage cost", () => {
  test("starts at zero in every bucket", () => {
    expect(emptyUsageCost()).toEqual({
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      total: 0,
    });
    expect(isZeroUsageCost(emptyUsageCost())).toBe(true);
  });

  test("accumulates in place", () => {
    const target = emptyUsageCost();
    const returned = addUsageCost(target, {
      input: 1,
      cacheRead: 2,
      cacheWrite: 3,
      output: 4,
      total: 10,
    });
    expect(returned).toBe(target);
    expect(target).toEqual({
      input: 1,
      cacheRead: 2,
      cacheWrite: 3,
      output: 4,
      total: 10,
    });
  });

  test("a missing report is a no-op, not a zero-update", () => {
    const target = emptyUsageCost();
    addUsageCost(target, undefined);
    expect(isZeroUsageCost(target)).toBe(true);
  });

  test("a partially priced report keeps the buckets it has", () => {
    const target = emptyUsageCost();
    addUsageCost(target, {
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 1.5,
      total: 1.5,
    });
    expect(isZeroUsageCost(target)).toBe(false);
    expect(target.output).toBe(1.5);
  });
});
