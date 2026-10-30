/**
 * F-06 M2 · S2 user-activity markers (requirement R-5.8.2).
 *
 * The contract is "cheap, synchronous, never breaks the caller". The tests pin
 * the storage round-trip, the monotonic-stamp guard, and the come-back
 * comparison the run controller uses.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getDreamActivityPath,
  hasDreamActivitySince,
  markDreamActivity,
  readDreamActivity,
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
