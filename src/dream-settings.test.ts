/**
 * Dream settings (F-06 Q-51).
 *
 * Three claims matter: the defaults are the user's 2026-10-30 budget ruling
 * (O-1 closed), an unusable value never reaches a reader (a negative silence or
 * a zero budget would silently disable dreaming), and a per-agent override wins
 * field by field without pinning the fields it did not touch.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearDreamSettingsForAgent,
  DEFAULT_DREAM_MAX_PER_RUN,
  DEFAULT_DREAM_PRESSURE_THRESHOLD,
  DREAM_SETTINGS_DEFAULTS,
  normalizeDreamIdleWindows,
  readDreamSettings,
  resolveDreamSettings,
  updateDreamSettings,
} from "@/dream-settings";
import { settingsManager } from "@/settings-manager";

const originalHome = process.env.HOME;
let testHomeDir: string;

beforeEach(async () => {
  await settingsManager.reset();
  testHomeDir = await mkdtemp(join(tmpdir(), "haruyuki-dream-settings-"));
  process.env.HOME = testHomeDir;
});

afterEach(async () => {
  await settingsManager.reset();
  await rm(testHomeDir, { recursive: true, force: true });
  process.env.HOME = originalHome;
});

function writeSettings(record: Record<string, unknown>): void {
  mkdirSync(join(testHomeDir, ".haruyuki"), { recursive: true });
  writeFileSync(
    join(testHomeDir, ".haruyuki", "settings.json"),
    JSON.stringify(record, null, 2),
  );
}

describe("dream settings defaults", () => {
  test("match the user's O-1 ruling", () => {
    expect(DREAM_SETTINGS_DEFAULTS).toEqual({
      enabled: false,
      permissionMode: "acceptEdits",
      idleWindows: [{ start: "22:00", end: "07:00" }],
      silenceMinutes: 30,
      pressureThreshold: 75_000,
      budgetFactor: 0.8,
      maxPerRun: 100_000,
      maxPerDay: null,
      timeLimitMinutes: null,
      tiers: { tidy: true, think: true, task: true, wander: true },
      autoTrigger: true,
      overBudgetApprovals: 1,
    });
    expect(DEFAULT_DREAM_PRESSURE_THRESHOLD).toBe(75_000);
    expect(DEFAULT_DREAM_MAX_PER_RUN).toBe(100_000);
  });

  test("resolve(undefined) is the defaults, including a fresh window copy", () => {
    const resolved = resolveDreamSettings(undefined);
    expect(resolved).toEqual(DREAM_SETTINGS_DEFAULTS);
    if (resolved.idleWindows[0]) resolved.idleWindows[0].start = "01:00";
    expect(DREAM_SETTINGS_DEFAULTS.idleWindows[0]?.start).toBe("22:00");
  });
});

describe("normalizeDreamIdleWindows", () => {
  test("keeps multiple segments including cross-midnight ones", () => {
    expect(
      normalizeDreamIdleWindows([
        { start: "12:30", end: "13:30" },
        { start: "22:00", end: "07:00" },
      ]),
    ).toEqual([
      { start: "12:30", end: "13:30" },
      { start: "22:00", end: "07:00" },
    ]);
  });

  test("drops unusable segments and falls back when none survive", () => {
    expect(
      normalizeDreamIdleWindows([
        { start: "9:00", end: "10:00" },
        { start: "10:00", end: "10:00" },
        { start: "25:00", end: "26:00" },
        "nope",
        null,
      ]),
    ).toEqual([...DREAM_SETTINGS_DEFAULTS.idleWindows]);
    expect(normalizeDreamIdleWindows([])).toEqual([
      ...DREAM_SETTINGS_DEFAULTS.idleWindows,
    ]);
    expect(normalizeDreamIdleWindows("22:00-07:00")).toEqual([
      ...DREAM_SETTINGS_DEFAULTS.idleWindows,
    ]);
  });
});

describe("resolveDreamSettings", () => {
  test("ignores values a reader could not use", () => {
    const resolved = resolveDreamSettings({
      dreamEnabled: "yes",
      dreamPermissionMode: "root",
      dreamSilenceMinutes: -5,
      dreamPressureThreshold: 0,
      dreamBudgetFactor: Number.NaN,
      dreamMaxPerRun: 0,
      dreamMaxPerDay: -1,
      dreamTimeLimitMinutes: 0,
      dreamOverBudgetApprovals: -2,
      dreamAutoTrigger: "1",
    });
    expect(resolved).toEqual(DREAM_SETTINGS_DEFAULTS);
  });

  test("keeps the values that are legal, including explicit nulls", () => {
    const resolved = resolveDreamSettings({
      dreamEnabled: true,
      dreamPermissionMode: "standard",
      dreamSilenceMinutes: 0,
      dreamPressureThreshold: 1,
      dreamBudgetFactor: 2,
      dreamMaxPerRun: 1,
      dreamMaxPerDay: null,
      dreamTimeLimitMinutes: null,
      dreamAutoTrigger: false,
      dreamOverBudgetApprovals: 0,
    });
    expect(resolved).toMatchObject({
      enabled: true,
      permissionMode: "standard",
      silenceMinutes: 0,
      pressureThreshold: 1,
      budgetFactor: 2,
      maxPerRun: 1,
      maxPerDay: null,
      timeLimitMinutes: null,
      autoTrigger: false,
      overBudgetApprovals: 0,
    });
  });

  test("closes disabled tiers only when the toggle is explicitly false", () => {
    expect(
      resolveDreamSettings({ dreamTiers: { task: false, wander: false } })
        .tiers,
    ).toEqual({ tidy: true, think: true, task: false, wander: false });
    expect(resolveDreamSettings({ dreamTiers: "all" }).tiers).toEqual(
      DREAM_SETTINGS_DEFAULTS.tiers,
    );
  });

  test("per-agent overrides win field by field", () => {
    const record = {
      dreamEnabled: true,
      dreamSilenceMinutes: 45,
      dreamSettingsByAgent: {
        "agent-a": { enabled: false, silenceMinutes: 10 },
        "agent-b": { timeLimitMinutes: 90 },
      },
    };
    expect(resolveDreamSettings(record, "agent-a")).toMatchObject({
      enabled: false,
      silenceMinutes: 10,
      permissionMode: "acceptEdits",
    });
    expect(resolveDreamSettings(record, "agent-b")).toMatchObject({
      enabled: true,
      silenceMinutes: 45,
      timeLimitMinutes: 90,
    });
    expect(resolveDreamSettings(record, "agent-c")).toMatchObject({
      enabled: true,
      silenceMinutes: 45,
      timeLimitMinutes: null,
    });
  });

  test("an agent override with null beats a global value", () => {
    const record = {
      dreamTimeLimitMinutes: 20,
      dreamSettingsByAgent: { "agent-a": { timeLimitMinutes: null } },
    };
    expect(resolveDreamSettings(record, "agent-a").timeLimitMinutes).toBeNull();
  });
});

describe("read/update through the settings manager", () => {
  test("reads global knobs from the settings file", async () => {
    writeSettings({
      dreamEnabled: true,
      dreamIdleWindows: [{ start: "23:00", end: "06:30" }],
      dreamPressureThreshold: 10_000,
      dreamBudgetFactor: 0.5,
      dreamMaxPerDay: 500_000,
    });
    await settingsManager.initialize();

    expect(readDreamSettings()).toMatchObject({
      enabled: true,
      idleWindows: [{ start: "23:00", end: "06:30" }],
      pressureThreshold: 10_000,
      budgetFactor: 0.5,
      maxPerDay: 500_000,
      maxPerRun: DEFAULT_DREAM_MAX_PER_RUN,
    });
  });

  test("updateDreamSettings writes the global layer", async () => {
    await settingsManager.initialize();
    updateDreamSettings({ enabled: true, silenceMinutes: 12 });
    expect(readDreamSettings()).toMatchObject({
      enabled: true,
      silenceMinutes: 12,
    });
    expect(settingsManager.getSettings().dreamEnabled).toBe(true);
  });

  test("updateDreamSettings writes and clears a per-agent override", async () => {
    await settingsManager.initialize();
    updateDreamSettings({ enabled: true, pressureThreshold: 1_000 }, "agent-a");
    updateDreamSettings({ silenceMinutes: 5 }, "agent-a");

    expect(readDreamSettings("agent-a")).toMatchObject({
      enabled: true,
      pressureThreshold: 1_000,
      silenceMinutes: 5,
    });
    // The global layer is untouched by an agent-scoped write.
    expect(readDreamSettings()).toMatchObject({
      enabled: false,
      pressureThreshold: DEFAULT_DREAM_PRESSURE_THRESHOLD,
    });
    expect(
      Object.keys(settingsManager.getSettings().dreamSettingsByAgent ?? {}),
    ).toEqual(["agent-a"]);

    clearDreamSettingsForAgent("agent-a");
    expect(settingsManager.getSettings().dreamSettingsByAgent).toBeUndefined();
    expect(readDreamSettings("agent-a")).toEqual(DREAM_SETTINGS_DEFAULTS);
  });

  test("falls back to defaults when settings are not initialized", () => {
    expect(readDreamSettings("agent-a")).toEqual(DREAM_SETTINGS_DEFAULTS);
  });
});
