/**
 * F-06 M2 · S3 dream pressure (requirement R-5.2.3, route §2.3).
 *
 * Pressure is what decides *whether* a run is due: the budget formula is
 * consumed from `dream-budget-math`, the interval is read from the usage ledger
 * synchronously, and the memFS increment is a bounded, documented bonus.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DREAM_MEMFS_BONUS_TOKENS_PER_FILE,
  getDreamPressureMarkerPath,
  readDreamMemfsBonus,
  readDreamPressure,
  readDreamPressureMarker,
  readDreamPressureRecords,
  recordDreamPressureBaseline,
} from "@/agent/dream/dream-pressure";
import { computeDreamPressure } from "@/dream-budget-math";
import { usageHourKey, usageLedgerPath } from "@/usage/ledger";

const previousEnv = {
  HARUYUKI_HOME: process.env.HARUYUKI_HOME,
  LETTA_LOCAL_BACKEND_DIR: process.env.LETTA_LOCAL_BACKEND_DIR,
  HARUYUKI_LOCAL_BACKEND_EXPERIMENTAL:
    process.env.HARUYUKI_LOCAL_BACKEND_EXPERIMENTAL,
};
const root = mkdtempSync(join(tmpdir(), "hryk-dream-pressure-"));
process.env.HARUYUKI_HOME = root;
process.env.LETTA_LOCAL_BACKEND_DIR = join(root, "lb");
process.env.HARUYUKI_LOCAL_BACKEND_EXPERIMENTAL = "1";

afterAll(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(join(root, "dream"), { recursive: true, force: true });
  rmSync(join(root, "lb"), { recursive: true, force: true });
  rmSync(usageLedgerPath(), { force: true });
});

function writeLedger(records: Array<Record<string, unknown>>): void {
  const path = usageLedgerPath();
  mkdirSync(join(path, ".."), { recursive: true });
  rmSync(path, { force: true });
  for (const record of records) {
    appendFileSync(path, `${JSON.stringify(record)}\n`);
  }
}

function record(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    tsHour: usageHourKey(new Date()),
    agentId: "agent-a",
    model: "local/default",
    prompt: 0,
    cachedInput: 0,
    cacheWrite: 0,
    completion: 0,
    reasoning: 0,
    steps: 1,
    wallMs: 10,
    apiMs: 5,
    ...overrides,
  };
}

describe("dream pressure interval", () => {
  test("sums this agent's conversation rows with the budget weights", () => {
    writeLedger([
      record({ agentId: "agent-a", completion: 2_000, prompt: 400 }),
      // Dream's own spend must not count as conversation growth.
      record({ agentId: "agent-a", completion: 99_999, source: "dream" }),
      // Another agent's spend is not this agent's pressure.
      record({ agentId: "agent-b", completion: 50_000 }),
    ]);
    const interval = readDreamPressureRecords("agent-a", null);
    expect(interval).toHaveLength(1);
    expect(readDreamPressure("agent-a")).toBe(
      computeDreamPressure({
        outputTokens: 2_000,
        uncachedReadTokens: 400,
        cachedReadTokens: 0,
      }),
    );
  });

  test("the marker moves the interval forward by ledger hour", () => {
    const oldHour = usageHourKey(new Date(Date.now() - 3 * 60 * 60_000));
    writeLedger([
      record({ tsHour: oldHour, completion: 10_000 }),
      record({ completion: 1_000 }),
    ]);
    recordDreamPressureBaseline("agent-a", Date.now() - 60 * 60_000);
    const interval = readDreamPressureRecords(
      "agent-a",
      readDreamPressureMarker("agent-a"),
    );
    expect(interval.map((entry) => entry.completion)).toEqual([1_000]);
  });

  test("a corrupt ledger line does not hide the rest of the interval", () => {
    const path = usageLedgerPath();
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify(record({ completion: 5 }))}\nnot-json\n${JSON.stringify(record({ completion: 6 }))}\n`,
    );
    expect(readDreamPressureRecords("agent-a", null)).toHaveLength(2);
  });

  test("a missing ledger means zero pressure, not an error", () => {
    expect(readDreamPressure("agent-a")).toBe(0);
  });
});

describe("memFS bonus", () => {
  test("dirty memory files add the provisional bonus", () => {
    const memoryDir = join(root, "lb", "memfs", "agent-a", "memory");
    mkdirSync(memoryDir, { recursive: true });
    const git = (...args: string[]): string =>
      execFileSync("git", ["-C", memoryDir, ...args], { encoding: "utf-8" });
    git("init", "-q");
    git(
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    );
    writeFileSync(join(memoryDir, "MEMORY.md"), "# memory\n");
    writeFileSync(join(memoryDir, "notes.md"), "note\n");
    const bonus = readDreamMemfsBonus("agent-a", Date.now() + 10 * 60_000);
    expect(bonus).toBe(2 * DREAM_MEMFS_BONUS_TOKENS_PER_FILE);
    // And it is part of the pressure the signal compares.
    expect(readDreamPressure("agent-a")).toBeGreaterThanOrEqual(bonus);
  });

  test("a missing memory repo contributes nothing", () => {
    expect(readDreamMemfsBonus("agent-without-memory", Date.now())).toBe(0);
  });

  test("the marker path stays inside the configured harness home", () => {
    expect(getDreamPressureMarkerPath("agent-a")).toContain(
      join(root, "dream", "pressure"),
    );
  });
});
