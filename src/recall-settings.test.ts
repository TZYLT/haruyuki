/**
 * Feature ②'s ten knobs (《26》§6.9).
 *
 * Two claims matter. An unusable value must never reach a reader — a negative
 * timeout would arm a budget that expires before the first checkpoint, and a
 * typo'd diversity has no meaning at all — and `0` must survive as "off" rather
 * than being read as "unset". The settings file is the only write path, so one
 * test drives a knob through it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RECALL_SETTING_DEFAULTS,
  readRecallSettings,
  recallOptionsFromSettings,
  resolveRecallSettings,
} from "@/recall-settings";
import { RECALL_DEFAULTS } from "@/reminders/recall-port";
import { settingsManager } from "@/settings-manager";
import { appHomeDirName } from "@/utils/app-paths";

const originalHome = process.env.HOME;
let testHomeDir: string;

beforeEach(async () => {
  await settingsManager.reset();
  testHomeDir = await mkdtemp(join(tmpdir(), "haru-recall-settings-"));
  process.env.HOME = testHomeDir;
});

afterEach(async () => {
  await settingsManager.reset();
  await rm(testHomeDir, { recursive: true, force: true });
  process.env.HOME = originalHome;
});

function writeSettings(record: Record<string, unknown>): void {
  mkdirSync(join(testHomeDir, appHomeDirName()), { recursive: true });
  writeFileSync(
    join(testHomeDir, appHomeDirName(), "settings.json"),
    JSON.stringify(record, null, 2),
  );
}

describe("resolveRecallSettings", () => {
  test("falls back to the documented defaults", () => {
    expect(resolveRecallSettings(undefined)).toEqual(RECALL_SETTING_DEFAULTS);
    expect(resolveRecallSettings({})).toEqual(RECALL_SETTING_DEFAULTS);
    expect(RECALL_SETTING_DEFAULTS).toEqual({
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
    });
  });

  test("keeps 0 as 'off' for every count", () => {
    const resolved = resolveRecallSettings({
      recallTimeoutMs: 0,
      recallDedupTurns: 0,
      recallLimit: 0,
      recallExcerptCharacters: 0,
      recallTotalCharacters: 0,
      recallExcerptLines: 0,
      recallMinScoreRatio: 0,
    });
    expect(resolved.timeoutMs).toBe(0);
    expect(resolved.dedupTurns).toBe(0);
    expect(resolved.limit).toBe(0);
    expect(resolved.excerptCharacters).toBe(0);
    expect(resolved.totalCharacters).toBe(0);
    expect(resolved.excerptLines).toBe(0);
    expect(resolved.minScoreRatio).toBe(0);
  });

  test("ignores values a reader could not use", () => {
    expect(
      resolveRecallSettings({
        recallTimeoutMs: -3,
        recallDedupTurns: Number.NaN,
        recallLimit: Number.POSITIVE_INFINITY,
        recallExcerptCharacters: "400",
        recallTotalCharacters: -1,
        recallMinScoreRatio: -0.5,
        recallExcerptLines: null,
        recallDiversity: "every-file",
        recallDisplay: "quiet",
        recallEnabled: "false",
      }),
    ).toEqual(RECALL_SETTING_DEFAULTS);
  });

  test("truncates fractional counts", () => {
    expect(
      resolveRecallSettings({
        recallTimeoutMs: 1500.9,
        recallDedupTurns: 11.7,
        recallLimit: 4.2,
      }),
    ).toMatchObject({ timeoutMs: 1500, dedupTurns: 11, limit: 4 });
  });

  test("only an explicit false switches recall off", () => {
    expect(resolveRecallSettings({ recallEnabled: false }).enabled).toBe(false);
    expect(resolveRecallSettings({ recallEnabled: true }).enabled).toBe(true);
    // A hand-edited file must not disable a feature the user never turned off.
    expect(resolveRecallSettings({ recallEnabled: 0 }).enabled).toBe(true);
    expect(resolveRecallSettings({ recallEnabled: "no" }).enabled).toBe(true);
  });

  test("accepts every documented enum value and rejects the rest", () => {
    for (const diversity of ["none", "file", "split"] as const) {
      expect(
        resolveRecallSettings({ recallDiversity: diversity }).diversity,
      ).toBe(diversity);
    }
    for (const display of ["silent", "summary", "full"] as const) {
      expect(resolveRecallSettings({ recallDisplay: display }).display).toBe(
        display,
      );
    }
  });
});

describe("recallOptionsFromSettings", () => {
  test("carries every user-facing knob and leaves the internal ones alone", () => {
    const options = recallOptionsFromSettings(
      resolveRecallSettings({
        recallLimit: 5,
        recallExcerptCharacters: 120,
        recallTotalCharacters: 500,
        recallMinScoreRatio: 0.5,
        recallDiversity: "split",
        recallExcerptLines: 3,
        recallDedupTurns: 4,
        recallTimeoutMs: 250,
      }),
    );

    expect(options).toEqual({
      ...RECALL_DEFAULTS,
      limit: 5,
      excerptCharacters: 120,
      totalCharacters: 500,
      minScoreRatio: 0.5,
      diversity: "split",
      excerptLines: 3,
      dedupTurns: 4,
      timeoutMs: 250,
    });
    // No command reaches these two, so they stay at the port defaults.
    expect(options.candidateLimit).toBe(RECALL_DEFAULTS.candidateLimit);
    expect(options.neighbors).toBe(RECALL_DEFAULTS.neighbors);
  });
});

describe("readRecallSettings", () => {
  test("returns the defaults when settings are not loaded yet", () => {
    expect(readRecallSettings()).toEqual(RECALL_SETTING_DEFAULTS);
  });

  test("reads the knobs from the settings file", async () => {
    writeSettings({
      recallEnabled: false,
      recallTimeoutMs: 0,
      recallDedupTurns: 25,
      recallLimit: 2,
      recallExcerptCharacters: 200,
      recallTotalCharacters: 900,
      recallMinScoreRatio: 0.6,
      recallDiversity: "file",
      recallExcerptLines: 1,
      recallDisplay: "full",
    });
    await settingsManager.initialize();

    expect(readRecallSettings()).toEqual({
      enabled: false,
      timeoutMs: 0,
      dedupTurns: 25,
      limit: 2,
      excerptCharacters: 200,
      totalCharacters: 900,
      minScoreRatio: 0.6,
      diversity: "file",
      excerptLines: 1,
      display: "full",
    });
  });

  test("a knob written through updateSettings is read back", async () => {
    await settingsManager.initialize();
    settingsManager.updateSettings({ recallDisplay: "silent", recallLimit: 7 });
    expect(readRecallSettings().display).toBe("silent");
    expect(readRecallSettings().limit).toBe(7);
  });
});
