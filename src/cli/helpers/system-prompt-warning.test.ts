import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  buildStartupWarnings,
  resetRejectedEnvToggleReporting,
} from "@/cli/helpers/system-prompt-warning.ts";

const TOGGLE_ENV_VARS = [
  "HARUYUKI_ARTIFACTS",
  "HARUYUKI_MEMORY_PALACE",
  "HARUYUKI_UI_V2",
] as const;

const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const name of TOGGLE_ENV_VARS) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
  resetRejectedEnvToggleReporting();
});

afterEach(() => {
  for (const name of TOGGLE_ENV_VARS) {
    const value = saved.get(name);
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  saved.clear();
  resetRejectedEnvToggleReporting();
});

describe("buildStartupWarnings", () => {
  test("is empty when nothing is wrong", () => {
    expect(buildStartupWarnings(null)).toEqual([]);
  });

  test("explains a rejected on-word, then stays quiet", () => {
    process.env.HARUYUKI_UI_V2 = "on";

    const first = buildStartupWarnings(null);
    expect(first).toHaveLength(1);
    expect(first[0]).toContain("HARUYUKI_UI_V2=on");
    // `ui_v2` is on by default now, so a rejected spelling does not leave it off —
    // it turns it off. The sentence has to say so.
    expect(first[0]).toContain("`ui_v2` is read as off");
    expect(first[0]).toContain("`1`, `true` or `yes`");

    // One-off: the next conversation's status block does not repeat it.
    expect(buildStartupWarnings(null)).toEqual([]);
  });

  test("reports each env var once, independently", () => {
    process.env.HARUYUKI_UI_V2 = "on";
    process.env.HARUYUKI_MEMORY_PALACE = "enabled";

    expect(buildStartupWarnings(null)).toHaveLength(2);
    expect(buildStartupWarnings(null)).toEqual([]);
  });

  test("does not warn for accepted or deliberately-off values", () => {
    process.env.HARUYUKI_UI_V2 = "1";
    process.env.HARUYUKI_ARTIFACTS = "off";
    expect(buildStartupWarnings(null)).toEqual([]);
  });
});
